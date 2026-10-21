// Predictions use only enumerated scenario features. Scenario content stays local.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { followupDelayMs } from './agentRun.mjs';
import { DEFAULT_MIN_ROUNDS, PRIOR_LOG_RATIO_SD, pairsNeeded, detectableRatio } from './benchVerdict.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHAPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FEATURES = {
  client: ['claude-code', 'codex'], cacheMarkers: ['client', 'none'],
  mcp: ['none', 'some', 'many'], requests: ['short', 'single', 'medium', 'long'],
  pause: [true, false], outcome: ['check', 'citations', 'keyFacts'],
};
const map = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (x, keys) => map(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const positive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const roundsValid = (x) => Number.isInteger(x) && x >= 0;
const bandValid = (lo, hi) => positive(lo) && positive(hi) && lo <= hi;
const matches = (shape, features) => Object.entries(shape.match).every(([k, v]) => features[k] === v);

export function shapeFeatures(scenario, client) {
  const followups = scenario.followups ?? [];
  const turns = 1 + followups.length;
  const n = scenario.mcpTools ?? 0;
  return {
    client, cacheMarkers: client === 'claude-code' ? 'client' : 'none',
    mcp: n === 0 ? 'none' : n < 100 ? 'some' : 'many',
    requests: Number.isInteger(scenario.maxTurns) && scenario.maxTurns <= 8 ? 'short'
      : turns >= 3 || Object.keys(scenario.pastes ?? {}).length > 0 ? 'long' : turns === 2 ? 'medium' : 'single',
    pause: followups.some((_, i) => followupDelayMs(scenario, i) >= 300000),
    outcome: FEATURES.outcome.find((key) => Object.hasOwn(scenario, key)),
  };
}

/** A bad committed catalog is an implementation error, never a client refusal. */
export function loadCatalog() {
  const catalog = parseYaml(readFileSync(join(ROOT, 'predictions.yaml'), 'utf8'));
  const bad = () => { throw new Error('Invalid predictions catalog'); };
  if (!keysAre(catalog, ['version', 'shapes']) || catalog.version !== 1 || !Array.isArray(catalog.shapes) || !catalog.shapes.length) bad();
  const ids = new Set();
  for (const s of catalog.shapes) {
    if (!keysAre(s, ['id', 'match', 'expect', 'band', 'rounds', 'source']) || typeof s.id !== 'string' || !SHAPE_ID.test(s.id) || ids.has(s.id)
        || !map(s.match) || !Object.keys(s.match).length
        || !Object.entries(s.match).every(([k, v]) => Object.hasOwn(FEATURES, k) && FEATURES[k].includes(v))
        || !['saving', 'parity'].includes(s.expect) || !keysAre(s.band, ['lo', 'hi']) || !bandValid(s.band.lo, s.band.hi)
        || !roundsValid(s.rounds) || typeof s.source !== 'string' || !s.source.trim()) bad();
    ids.add(s.id);
  }
  // Enumerate runnable feature combinations to reject duplicates and shadowed shapes,
  // including impossible combinations such as Codex with client cache markers.
  const reached = new Set();
  for (const client of FEATURES.client) for (const mcp of FEATURES.mcp) for (const requests of FEATURES.requests) {
    for (const pause of FEATURES.pause) for (const outcome of FEATURES.outcome) {
      if (requests === 'single' && pause) continue;
      const features = { client, cacheMarkers: client === 'claude-code' ? 'client' : 'none', mcp, requests, pause, outcome };
      const s = catalog.shapes.find((s) => matches(s, features));
      if (s) reached.add(s.id);
    }
  }
  if (reached.size !== catalog.shapes.length) bad();
  return catalog;
}

export function classify(scenario, client, catalog) {
  const features = shapeFeatures(scenario, client);
  const shape = catalog.shapes.find((s) => matches(s, features));
  const prediction = !shape ? { status: 'none', reason: 'unknown_shape' }
    : shape.rounds < DEFAULT_MIN_ROUNDS ? { status: 'none', reason: 'too_few_rounds', rounds: shape.rounds }
      : { status: 'band', expect: shape.expect, lo: shape.band.lo, hi: shape.band.hi, rounds: shape.rounds };
  return { features, shapeId: shape?.id ?? null, prediction };
}

/** Strict lock allowlist: no catalog source text or scenario content can ride along. */
export function predictionValid(p) {
  if (!map(p)) return false;
  if (p.status === 'band') return keysAre(p, ['status', 'expect', 'lo', 'hi', 'rounds'])
    && ['saving', 'parity'].includes(p.expect) && bandValid(p.lo, p.hi) && roundsValid(p.rounds) && p.rounds >= DEFAULT_MIN_ROUNDS;
  if (p.status !== 'none') return false;
  return p.reason === 'unknown_shape' ? keysAre(p, ['status', 'reason'])
    : p.reason === 'too_few_rounds' && keysAre(p, ['status', 'reason', 'rounds']) && roundsValid(p.rounds) && p.rounds < DEFAULT_MIN_ROUNDS;
}

export function budgetPlan(scenarios, { budgetUsd, sessionCostUsd }) {
  const pairCostUsd = 2 * sessionCostUsd;
  const pairsAffordable = Math.floor(budgetUsd / scenarios.length / pairCostUsd);
  const planned = scenarios.map((s) => {
    const band = s.prediction.status === 'band';
    const target = band ? (s.prediction.lo + s.prediction.hi) / 2 : null;
    const needed = band ? pairsNeeded(target) : null;
    return { ...s, target, pairsNeeded: needed, pairsPlanned: needed === null ? pairsAffordable : Math.min(needed, pairsAffordable),
      resolvable: band ? needed !== null && pairsAffordable >= needed : null };
  });
  const bands = planned.filter((s) => s.prediction.status === 'band');
  return {
    sd: { value: PRIOR_LOG_RATIO_SD, source: 'prior' }, alpha: 0.05, power: 0.8,
    budgetUsd, sessionCostUsd, pairCostUsd, pairsAffordable, detectableRatio: detectableRatio(pairsAffordable),
    spendCeilingUsd: planned.reduce((sum, s) => sum + s.pairsPlanned, 0) * pairCostUsd,
    resolvable: bands.length > 0 && bands.every((s) => s.resolvable === true), scenarios: planned,
  };
}

export function formatPlan(answer) {
  return [
    ...answer.scenarios.map((s) => `${s.id}: ${s.prediction.status === 'none' ? 'prediction: none'
      : `prediction: ${s.prediction.expect} ${s.prediction.lo}-${s.prediction.hi}; pairs needed: ${s.pairsNeeded ?? 'no finite count'}`}; pairs planned: ${s.pairsPlanned}`),
    answer.detectableRatio === null ? 'At this budget fewer than two pairs detect no effect.'
      : `At this budget you can detect at least ${((1 - answer.detectableRatio) * 100).toFixed(1)}% saving (prior SD, 80% power, two-sided 95%).`,
    `Spend ceiling: $${answer.spendCeilingUsd.toFixed(2)}`,
    `Budget resolves the bands: ${answer.resolvable ? 'yes' : 'no'}`,
  ].join('\n') + '\n';
}

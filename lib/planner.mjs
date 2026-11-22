// Predictions use only enumerated scenario features. Scenario content stays local.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import { followupDelayMs } from './agentRun.mjs';
import { DEFAULT_MIN_ROUNDS, PRIOR_LOG_RATIO_SD, pairsNeeded, detectableRatio } from './benchVerdict.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The noise command's default and minimum rounds; each is two direct sessions per scenario. */
export const NOISE_ROUNDS = 6;
export const SHAPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const calibrationFields = {
  rounds: z.number().int().nonnegative(), results: z.number().int().nonnegative(), hits: z.number().int().nonnegative(),
  hitRate: z.number().finite().min(0).max(1).nullable(),
  misses: z.array(z.object({
    plan: z.string().regex(/^[0-9a-f]{8}$/), median: z.number().finite().positive(),
    band: z.custom((b) => keysAre(b, ['lo', 'hi']) && bandValid(b.lo, b.hi), { message: 'Invalid calibration band' }),
    side: z.enum(['below', 'above']),
  }).strict().refine((m) => !bandValid(m.band?.lo, m.band?.hi)
    || m.side === (m.median < m.band.lo ? 'below' : m.median > m.band.hi ? 'above' : null), { path: ['side'] })),
};
// The same entry rules apply to an imported shape and its committed catalog block.
function checkCalibration(entry, ctx) {
  const issue = (key) => ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid calibration' });
  if (entry.hits > entry.results) issue('hits');
  if (entry.rounds < DEFAULT_MIN_ROUNDS ? entry.hitRate !== null
    : entry.results < 1 || entry.hitRate === null || Math.abs(entry.hitRate - entry.hits / entry.results) > 1e-9) issue('hitRate');
  if (entry.misses.length !== entry.results - entry.hits) issue('misses');
}
export const calibrationEntrySchema = z.object(calibrationFields).strict().superRefine(checkCalibration);
export const calibrationDocumentSchema = z.object({
  version: z.literal(1), generatedAt: z.iso.datetime(), minRounds: z.literal(DEFAULT_MIN_ROUNDS),
  shapes: z.array(z.object({ shapeId: z.string().regex(SHAPE_ID), ...calibrationFields }).strict().superRefine(checkCalibration)),
}).strict().superRefine((doc, ctx) => {
  const ids = new Set();
  doc.shapes.forEach((s, i) => {
    if (ids.has(s.shapeId)) ctx.addIssue({ code: 'custom', path: ['shapes', i, 'shapeId'], message: 'Duplicate shape' });
    ids.add(s.shapeId);
  });
});
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
    if (!keysAre(s, ['id', 'match', 'expect', 'band', 'rounds', 'source', ...(map(s) && Object.hasOwn(s, 'calibration') ? ['calibration'] : [])]) || typeof s.id !== 'string' || !SHAPE_ID.test(s.id) || ids.has(s.id)
        || !map(s.match) || !Object.keys(s.match).length
        || !Object.entries(s.match).every(([k, v]) => Object.hasOwn(FEATURES, k) && FEATURES[k].includes(v))
        || !['saving', 'parity'].includes(s.expect) || !keysAre(s.band, ['lo', 'hi']) || !bandValid(s.band.lo, s.band.hi)
        || !roundsValid(s.rounds) || typeof s.source !== 'string' || !s.source.trim()) bad();
    if (Object.hasOwn(s, 'calibration') && !calibrationEntrySchema.safeParse(s.calibration).success) bad();
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

export function predictedHitRate(shape, prediction) {
  return prediction.status === 'band' && shape?.calibration?.rounds >= DEFAULT_MIN_ROUNDS ? shape.calibration.hitRate : null;
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

// Noise is paid before any pair, so it comes off the budget first and stays in the ceiling.
export function budgetPlan(scenarios, { budgetUsd, sessionCostUsd }) {
  const pairCostUsd = sessionCostUsd === undefined ? null : 2 * sessionCostUsd;
  const noiseCostUsd = pairCostUsd === null ? null : NOISE_ROUNDS * scenarios.length * pairCostUsd;
  const pairsAffordable = pairCostUsd === null ? null : Math.max(0, Math.floor((budgetUsd - noiseCostUsd) / scenarios.length / pairCostUsd));
  const planned = scenarios.map((s) => {
    const band = s.prediction.status === 'band';
    const target = band ? (s.prediction.lo + s.prediction.hi) / 2 : null;
    const needed = band ? pairsNeeded(target) : null;
    return { ...s, target, pairsNeeded: needed, pairsPlanned: pairsAffordable === null || needed === null ? pairsAffordable : Math.min(needed, pairsAffordable),
      resolvable: band && pairsAffordable !== null ? needed !== null && pairsAffordable >= needed : null };
  });
  const bands = planned.filter((s) => s.prediction.status === 'band');
  return {
    sd: { value: PRIOR_LOG_RATIO_SD, source: 'prior' }, alpha: 0.05, power: 0.8,
    budgetUsd, sessionCostUsd, pairCostUsd, noiseRounds: NOISE_ROUNDS, noiseSessions: NOISE_ROUNDS * 2 * scenarios.length, noiseCostUsd,
    minimumBudgetUsd: pairCostUsd === null ? null : noiseCostUsd + scenarios.length * pairCostUsd, pairsAffordable, detectableRatio: pairsAffordable === null ? null : detectableRatio(pairsAffordable),
    spendCeilingUsd: pairCostUsd === null ? budgetUsd : noiseCostUsd + planned.reduce((sum, s) => sum + s.pairsPlanned, 0) * pairCostUsd,
    resolvable: bands.length > 0 && bands.every((s) => s.resolvable === true), scenarios: planned,
  };
}

const pairsPlanned = (answer) => answer.scenarios.reduce((sum, s) => sum + s.pairsPlanned, 0);

export function formatPlan(answer, catalog) {
  const deferred = answer.pairsAffordable === null;
  return [
    ...answer.scenarios.map((s) => {
      const calibration = s.predictedHitRate == null ? null : catalog.shapes.find((shape) => shape.id === s.shapeId).calibration;
      return `${s.id}: ${s.prediction.status === 'none' ? 'prediction: none'
        : `prediction: ${s.prediction.expect} ${s.prediction.lo}-${s.prediction.hi}; pairs needed: ${s.pairsNeeded ?? 'no finite count'}`}; pairs planned: ${deferred ? 'after noise' : s.pairsPlanned}${calibration
          ? `; band right in ${calibration.hits} of ${calibration.results} earlier tests` : ''}`;
    }),
    ...(deferred ? [
      'Pairs: set after the noise rounds measure your session cost',
      `Noise alone is ${answer.noiseSessions} sessions (${answer.noiseRounds} rounds of two direct sessions${answer.scenarios.length > 1 ? ` for each of ${answer.scenarios.length} scenarios` : ''}): the budget must cover them before any pair runs.`,
      `Spend ceiling: $${answer.spendCeilingUsd.toFixed(2)}`] : [
      answer.detectableRatio === null ? 'At this budget fewer than two pairs detect no effect.'
        : `At this budget you can detect at least ${((1 - answer.detectableRatio) * 100).toFixed(1)}% saving (prior SD, 80% power, two-sided 95%).`,
      `Spend ceiling: $${answer.spendCeilingUsd.toFixed(2)} (noise: ${answer.noiseRounds} rounds, $${answer.noiseCostUsd.toFixed(2)}; paired runs: ${pairsPlanned(answer)} pairs, $${(pairsPlanned(answer) * answer.pairCostUsd).toFixed(2)})`,
      `Budget resolves the bands: ${answer.resolvable ? 'yes' : 'no'}`,
    ]),
  ].join('\n') + '\n';
}

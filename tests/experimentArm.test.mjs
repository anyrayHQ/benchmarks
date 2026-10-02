// A --compare gateway run whose treatment is a gateway RULE, not a header: arm B alone
// carries an experiment tag (--experiment-b), bench-rule adds a params-only rule keyed on
// it, and each round says which kind the gateway's session gate held out of each arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { armLabel, armsFor, heldOutRecord, parseArgs, requestRecord, roundTags, runPairWithRedraw } from '../run_agent.mjs';
import { followupDelayMs, pauseBudgetMs, tokenOutlastsPauses } from '../lib/agentRun.mjs';
import { earlyHoldout, formatKindTally, heldOutKinds, parseOptimizationResult, tallyKinds } from '../lib/optimizationKinds.mjs';
import {
  experimentRules,
  paramsRuleLabel,
  removeParamsRule,
  restChanged,
  setParamsRule,
  unknownParams,
  validExperimentName,
  otherRulesChanged,
} from '../lib/benchRule.mjs';
import { traceRecord } from '../lib/traces.mjs';
import { coldTurnReport, formatColdTurnReport } from '../lib/coldTurns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gw = (...more) => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask,relevance_filter', ...more]);

// ---- --experiment-b -----------------------------------------------------------------

test('parseArgs: --experiment-b tags arm B only, and only under --compare gateway', () => {
  assert.equal(gw('--experiment-b', 'exp-b').experimentB, 'exp-b');
  assert.equal(gw().experimentB, null);
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--experiment-b', 'x']), /--experiment-b needs --compare gateway/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--experiment-b', 'x']), /--experiment-b needs --compare gateway/);
});

test('parseArgs: --experiment-b must be a plain name, differ from --experiment, and not ride --strategy', () => {
  assert.throws(() => gw('--experiment-b', 'a*'), /--experiment-b must be/);
  assert.throws(() => gw('--experiment-b'), /--experiment-b must be/);
  assert.throws(() => gw('--experiment', 'same', '--experiment-b', 'same'), /must differ from --experiment/);
  assert.throws(
    () => parseArgs(['--scenario', 's', '--compare', 'gateway', '--strategy', 'thinking_trim', '--experiment-b', 'x']),
    /--experiment-b and --strategy/
  );
});

test('roundTags: B carries its own experiment, A keeps --experiment (or none); session ids stay apart', () => {
  const t = roundTags(gw('--experiment-b', 'exp-b'), 1, 7);
  assert.equal(t.a.experiment, undefined);
  assert.equal(t.b.experiment, 'exp-b');
  assert.equal(t.a.sessionId, 'anyray-bench-s-gateway-r1-7-a');
  assert.equal(t.b.sessionId, 'anyray-bench-s-gateway-r1-7-b');
  const both = roundTags(gw('--experiment', 'exp-a', '--experiment-b', 'exp-b'), 1, 7);
  assert.equal(both.a.experiment, 'exp-a');
  assert.equal(both.b.experiment, 'exp-b');
  // Without the flag nothing changes: both slots carry the same tag but the session id.
  const plain = roundTags(gw('--experiment', 'e'), 1, 7);
  assert.equal(plain.a.experiment, 'e');
  assert.equal(plain.b.experiment, 'e');
});

test('requestRecord and armLabel name the B-only experiment; absent, the record is unchanged', () => {
  const args = { ...gw('--experiment-b', 'exp-b'), extraHeaders: [] };
  assert.equal(requestRecord(args).experimentB, 'exp-b');
  assert.equal('experimentB' in requestRecord({ ...gw(), extraHeaders: [] }), false);
  const arms = armsFor('gateway');
  assert.equal(armLabel(args, arms, 'a'), 'anyray (baseline)');
  assert.equal(armLabel(args, arms, 'b'), 'anyray + experiment=exp-b');
  assert.equal(armLabel({ ...args, extraHeaders: ['x-e: 1'] }, arms, 'b'), 'anyray + x-e + experiment=exp-b');
});

// ---- which kind the session gate held out of each arm --------------------------------

const header = (skipped, applied = []) => JSON.stringify({ status: 'applied', applied, skipped });

test('parseOptimizationResult keeps the guard a safety_gate skip names, and only a well-formed one', () => {
  const r = parseOptimizationResult(header([
    { kind: 'observation_mask', reason: 'safety_gate', guard: 'session_gate_holdout' },
    { kind: 'code_graph', reason: 'no_change' },
    { kind: 'relevance_filter', reason: 'safety_gate', guard: 'not a guard id' },
  ]));
  assert.deepEqual(r.skipped, [
    { kind: 'observation_mask', reason: 'safety_gate', guard: 'session_gate_holdout' },
    { kind: 'code_graph', reason: 'no_change' },
    { kind: 'relevance_filter', reason: 'safety_gate' },
  ]);
});

test('tallyKinds counts guards per kind; heldOutKinds lists the kinds a holdout withheld', () => {
  const kinds = ['observation_mask', 'code_graph', 'relevance_filter'];
  const results = [
    parseOptimizationResult(header([{ kind: 'observation_mask', reason: 'safety_gate', guard: 'session_gate_holdout' }, { kind: 'code_graph', reason: 'no_change' }], ['relevance_filter'])),
    parseOptimizationResult(header([{ kind: 'observation_mask', reason: 'safety_gate', guard: 'session_gate_holdout' }, { kind: 'code_graph', reason: 'safety_gate', guard: 'pin_thrash' }], ['relevance_filter'])),
  ];
  const t = tallyKinds(results, kinds);
  assert.deepEqual(t.byKind.observation_mask.guards, { session_gate_holdout: 2 });
  assert.deepEqual(t.byKind.code_graph.guards, { pin_thrash: 1 });
  assert.equal(t.byKind.relevance_filter.guards, undefined); // no guard named: the tally keeps its old shape
  assert.deepEqual(t.byKind.observation_mask.skipped, { safety_gate: 2 }); // the reason tally is as before
  assert.deepEqual(heldOutKinds(t), ['observation_mask']);
  assert.deepEqual(heldOutKinds(tallyKinds([], kinds)), []);
  assert.deepEqual(heldOutKinds(null), []);
  assert.match(formatKindTally(t), /observation_mask: applied 0 · skipped 2 \(safety_gate 2: session_gate_holdout 2\)/);
});

test('heldOutRecord: per arm, and whether the arms differ (a round to discard)', () => {
  const kinds = ['observation_mask', 'code_graph'];
  const held = tallyKinds([parseOptimizationResult(header([{ kind: 'code_graph', reason: 'safety_gate', guard: 'session_gate_holdout' }]))], kinds);
  const clean = tallyKinds([parseOptimizationResult(header([{ kind: 'code_graph', reason: 'no_change' }]))], kinds);
  assert.deepEqual(heldOutRecord({ a: held, b: clean }), { a: ['code_graph'], b: [], differs: true });
  assert.deepEqual(heldOutRecord({ a: held, b: held }), { a: ['code_graph'], b: ['code_graph'], differs: false });
  assert.deepEqual(heldOutRecord({ a: clean, b: clean }), { a: [], b: [], differs: false });
  // One arm only (--compare anyray): nothing to differ from.
  assert.deepEqual(heldOutRecord({ b: held }), { b: ['code_graph'], differs: false });
});

// ---- bench-rule params <experiment> ---------------------------------------------------

const OTHER = { label: 'someone-elses-rule', when: { models: ['gpt-*'] }, params: { observation_mask: { mintPaybackTurns: 6 } } };
const BENCH = { label: 'anyray-bench: strategies on for benchmark traffic only', when: { metadata: { tool: ['anyray-bench'] } }, enable: ['thinking_trim'] };
const CONFIG = { strategies: [{ kind: 'observation_mask', enabled: true }], overrides: { byEndpoint: { '/v1/embeddings': { disable: ['observation_mask'] } }, rules: [OTHER, BENCH] } };
const PARAMS = { observation_mask: { mintPaybackRatio: 0 }, relevance_filter: { minChars: 2000 } };

test('validExperimentName: plain ids only (a rule value is a glob, so * or ? would match other runs)', () => {
  for (const ok of ['cold-write-exp-b', 'a', 'A1_b.c']) assert.equal(validExperimentName(ok), true, ok);
  for (const bad of ['', 'a*', 'a?', 'a b', '*', undefined, null, 'x'.repeat(65), '-a']) assert.equal(validExperimentName(bad), false, String(bad));
});

test('setParamsRule adds one params-only rule keyed on tool AND experiment, and touches nothing else', () => {
  const next = setParamsRule(CONFIG, 'exp-b', PARAMS);
  const rule = next.overrides.rules.at(-1);
  assert.deepEqual(rule, {
    label: paramsRuleLabel('exp-b'),
    when: { metadata: { tool: ['anyray-bench'], experiment: ['exp-b'] } },
    params: PARAMS,
  });
  assert.equal('enable' in rule, false); // params only: the arm's strategy set is the baseline's
  assert.equal('disable' in rule, false);
  assert.deepEqual(next.overrides.rules.slice(0, 2), [OTHER, BENCH]);
  assert.deepEqual(next.overrides.byEndpoint, CONFIG.overrides.byEndpoint);
  assert.deepEqual(next.strategies, CONFIG.strategies);
  assert.deepEqual(CONFIG.overrides.rules, [OTHER, BENCH]); // the input is not mutated
  // The label is not one `bench-rule remove` / `per-experiment` treats as theirs to delete.
  assert.equal(rule.label.includes(' alone for experiment='), false);
  assert.notEqual(rule.label, BENCH.label);
});

test('setParamsRule replaces its own rule in place; removeParamsRule removes exactly that rule', () => {
  const once = setParamsRule(CONFIG, 'exp-b', PARAMS);
  const other = setParamsRule(once, 'other-exp', { observation_mask: { mintPaybackTurns: 1 } });
  const twice = setParamsRule(other, 'exp-b', { observation_mask: { mintPaybackRatio: 1 } });
  assert.deepEqual(twice.overrides.rules.map((r) => r.label), [OTHER.label, BENCH.label, paramsRuleLabel('exp-b'), paramsRuleLabel('other-exp')]);
  assert.deepEqual(twice.overrides.rules[2].params, { observation_mask: { mintPaybackRatio: 1 } });
  const removed = removeParamsRule(twice, 'exp-b');
  assert.deepEqual(removed.overrides.rules.map((r) => r.label), [OTHER.label, BENCH.label, paramsRuleLabel('other-exp')]);
  assert.deepEqual(removeParamsRule(CONFIG, 'exp-b').overrides.rules, [OTHER, BENCH]); // absent: a no-op
  assert.deepEqual(setParamsRule({ strategies: [] }, 'e', PARAMS).overrides.rules.length, 1); // no overrides yet
});

test('setParamsRule refuses a bad name or an empty/ill-shaped params object', () => {
  assert.throws(() => setParamsRule(CONFIG, 'a*', PARAMS), /experiment name/);
  assert.throws(() => setParamsRule(CONFIG, 'e', null), /--params/);
  assert.throws(() => setParamsRule(CONFIG, 'e', {}), /--params/);
  assert.throws(() => setParamsRule(CONFIG, 'e', { observation_mask: true }), /--params/);
  assert.throws(() => setParamsRule(CONFIG, 'e', { observation_mask: {} }), /--params/);
});

test('otherRulesChanged: every rule but ours must be byte-identical before and after', () => {
  const next = setParamsRule(CONFIG, 'exp-b', PARAMS);
  assert.deepEqual(otherRulesChanged(CONFIG, next, 'exp-b'), []);
  const lost = { ...next, overrides: { ...next.overrides, rules: next.overrides.rules.filter((r) => r.label !== OTHER.label) } };
  assert.deepEqual(otherRulesChanged(CONFIG, lost, 'exp-b'), [`removed: ${OTHER.label}`]);
  const edited = { ...next, overrides: { ...next.overrides, rules: next.overrides.rules.map((r) => (r.label === OTHER.label ? { ...r, params: {} } : r)) } };
  assert.deepEqual(otherRulesChanged(CONFIG, edited, 'exp-b'), [`changed: ${OTHER.label}`]);
  const added = { ...next, overrides: { ...next.overrides, rules: [...next.overrides.rules, { label: 'new', enable: ['x'] }] } };
  assert.deepEqual(otherRulesChanged(CONFIG, added, 'exp-b'), ['added: new']);
});

test('restChanged: a rule write leaves strategies, byEndpoint and every other field as read', () => {
  const next = setParamsRule(CONFIG, 'exp-b', PARAMS);
  assert.deepEqual(restChanged(CONFIG, next), []);
  assert.deepEqual(restChanged(CONFIG, { ...next, strategies: [{ kind: 'observation_mask', enabled: false }] }), ['strategies']);
  assert.deepEqual(restChanged(CONFIG, { ...next, overrides: { ...next.overrides, byEndpoint: {} }, guard: { enabled: true } }), ['guard', 'overrides.byEndpoint']);
});

test('unknownParams: a kind or param name the deployed optimizer does not list is refused before the write', () => {
  const capabilities = {
    kinds: [
      { kind: 'observation_mask', defaultParams: { minChars: 600 }, doc: { params: { mintPaybackRatio: {}, mintPaybackTurns: {} } } },
      { kind: 'relevance_filter', defaultParams: { minChars: 1500 } },
      { kind: 'code_graph', defaultParams: { minChars: 200 } },
    ],
  };
  assert.deepEqual(unknownParams(capabilities, PARAMS), []);
  assert.deepEqual(unknownParams(capabilities, { observation_mask: { minChars: 1, mintPaybakRatio: 0 }, nope: { a: 1 }, code_graph: { mintPaybackRatio: 0 } }), [
    'observation_mask.mintPaybakRatio',
    'nope (unknown strategy)',
    'code_graph.mintPaybackRatio',
  ]);
  assert.deepEqual(unknownParams(undefined, PARAMS), null); // no catalogue from this gateway: cannot check
  assert.deepEqual(unknownParams({ kinds: [] }, PARAMS), null);
});

test('experimentRules: the rules a tag matches, for the round record', () => {
  const cfg = { overrides: setParamsRule(CONFIG, 'exp-b', PARAMS).overrides };
  assert.deepEqual(experimentRules(cfg, 'exp-b'), [{ label: paramsRuleLabel('exp-b'), params: PARAMS }]);
  assert.deepEqual(experimentRules(cfg, 'exp-a'), []);
  assert.deepEqual(experimentRules({ unavailable: '403' }, 'exp-b'), null);
  assert.deepEqual(experimentRules(null, 'exp-b'), null);
});

// ---- the seat token must outlast a pause scenario --------------------------------------

test('pauseBudgetMs sums the idle gaps; tokenOutlastsPauses needs them plus working time', () => {
  const scn = { followups: ['a', 'b', 'c'], followupDelaySec: [0, 3720, 3720] };
  assert.equal(pauseBudgetMs(scn), 7440_000);
  assert.equal(pauseBudgetMs({ followups: ['a', 'b'], followupDelaySec: 60 }), 120_000);
  assert.equal(pauseBudgetMs({ task: 't' }), 0);
  const now = 1_000_000;
  assert.deepEqual(tokenOutlastsPauses(scn, { expiresAtMs: now + 7440_000 + 16 * 60_000, nowMs: now }), { ok: true });
  const short = tokenOutlastsPauses(scn, { expiresAtMs: now + 7440_000, nowMs: now });
  assert.equal(short.ok, false);
  assert.match(short.why, /expires in 124 min.*pauses.*124 min/);
  // No pauses, or no readable expiry (ANYRAY_UPSTREAM_TOKEN): nothing to check.
  assert.deepEqual(tokenOutlastsPauses({ task: 't' }, { expiresAtMs: now + 1, nowMs: now }), { ok: true });
  assert.deepEqual(tokenOutlastsPauses(scn, { expiresAtMs: null, nowMs: now }), { ok: true });
});

// ---- the cold-turn scenario ------------------------------------------------------------

test('saltstack-long-session-cold: three pauses past a 1h cache lifetime, and a timeout that covers them', () => {
  const scn = yaml.load(readFileSync(join(ROOT, 'scenarios', 'saltstack-long-session-cold', 'scenario.yaml'), 'utf8'));
  const base = yaml.load(readFileSync(join(ROOT, 'scenarios', 'saltstack-long-session', 'scenario.yaml'), 'utf8'));
  // Same repo, task and follow-ups as the warm scenario: only the pauses differ.
  assert.deepEqual(scn.repo, base.repo);
  assert.equal(scn.task, base.task);
  assert.deepEqual(scn.followups, base.followups);
  assert.deepEqual(scn.citations, base.citations);
  const gaps = scn.followups.map((_, i) => followupDelayMs(scn, i) / 1000);
  const cold = gaps.filter((g) => g > 0);
  assert.equal(cold.length, 3);
  for (const g of cold) assert.ok(g >= 3660, `a cold gap must clear 60 min + the gateway's slack with room to spare, got ${g}s`);
  assert.ok(scn.timeoutMin * 60 >= gaps.reduce((a, b) => a + b, 0) + 30 * 60, 'timeoutMin covers the pauses plus working time');
  assert.ok(scn.gatewaySettleSec >= 30 * 60, 'the ping cost is read after the keep-warm idle window');
});

// ---- trace rows keep what the gateway withheld -----------------------------------------

test('traceRecord keeps suppression, declines and the subagent flag from trace metadata', () => {
  const row = { id: 't1', timestamp: '2026-01-01T00:00:00Z' };
  const detail = {
    metadata: {
      endpoint: '/v1/messages', promptTokens: 10, cacheWriteTokens: 4, cacheReadTokens: 6, optimizationStatus: 'applied', subagent: false,
      optimizationSuppressed: [{ kind: 'observation_mask', reason: 'session_gate_holdout' }],
      strategyDeclines: { code_graph: { payback_premium: 1 } },
    },
    observations: [{ name: 'optimizer', output: { decisions: [{ kind: 'mint_economics', metric: { name: 'cache_expired', value: 1 } }] } }],
  };
  const t = traceRecord(row, detail);
  assert.deepEqual(t.suppressed, [{ kind: 'observation_mask', reason: 'session_gate_holdout' }]);
  assert.deepEqual(t.declines, { code_graph: { payback_premium: 1 } });
  assert.equal(t.subagent, false);
  assert.equal(t.cacheWriteTokens, 4);
  assert.equal(t.decisions.length, 1);
  const bare = traceRecord(row, { metadata: {} });
  assert.deepEqual([bare.suppressed, bare.declines, bare.decisions], [null, null, []]);
});

// ---- reading a round: what happened at each cold turn ----------------------------------

const metric = (kind, name, value) => ({ kind: 'mint_economics', summary: `${kind} mint admission estimate`, estimatedTokensSaved: 0, metric: { name, value } });
const trace = (timestamp, more = {}) => ({ timestamp, subagent: false, cacheWriteTokens: 0, cacheReadTokens: 1000, decisions: [], suppressed: null, declines: null, ...more });
const armTraces = (cold) => ({
  traces: [
    trace('2026-01-01T00:00:00Z', { cacheWriteTokens: 9000, cacheReadTokens: 0 }),
    trace('2026-01-01T00:01:00Z'),
    trace('2026-01-01T00:01:30Z', { subagent: true }), // a subagent request never starts a main-thread turn
    trace('2026-01-01T01:04:00Z', cold),
    trace('2026-01-01T01:05:00Z'),
  ],
});
const totals = (costUsd, more = {}) => ({ costUsd, clientCostUsd: costUsd - 0.1, gatewayPingCount: 7, gatewayPingCostUsd: 0.1, turns: 20, requests: 5, cacheBreaks: 1, retrieveCalls: 0, retrieveOk: 0, ...more });
const RECORD = {
  scenario: { name: 's', followupDelaySec: [3720] },
  request: { experimentB: 'exp-b' },
  rounds: [{
    round: 1,
    ratio: 0.9,
    quality: { a: true, b: true },
    heldOut: { a: [], b: [], differs: false },
    sessions: { a: { totals: totals(2) }, b: { totals: totals(1.8, { retrieveCalls: 2, retrieveOk: 2 }) } },
    tracesA: armTraces({
      cacheWriteTokens: 50000, cacheReadTokens: 0,
      decisions: [metric('observation_mask', 'cache_expired', 1), metric('observation_mask', 'rewrite_premium_usd', 0)],
      declines: { observation_mask: { payback_retrieval: 1 } },
    }),
    traces: armTraces({
      cacheWriteTokens: 41000, cacheReadTokens: 0,
      decisions: [
        metric('observation_mask', 'cache_expired', 1),
        metric('observation_mask', 'cold_write_saving_usd', 0.03),
        { kind: 'observation_mask', estimatedTokensSaved: 8000 },
        { kind: 'relevance_filter', estimatedTokensSaved: 1000 },
        { kind: 'content_census', estimatedTokensSaved: 0 },
      ],
    }),
  }],
};

test('coldTurnReport: per arm, the turns after a long idle gap with attestation, removal and credit', () => {
  const rep = coldTurnReport(RECORD);
  assert.equal(rep.gapSec, 1860); // half the scenario's shortest pause: what counts as a cold turn
  const [r] = rep.rounds;
  assert.deepEqual(r.arms.a.cost, { costUsd: 2, clientCostUsd: 1.9, pings: 7, pingCostUsd: 0.1, turns: 20, requests: 5, cacheBreaks: 1, retrieveCalls: 0, retrieveOk: 0, solved: true });
  assert.equal(r.arms.a.coldTurns.length, 1);
  assert.deepEqual(r.arms.a.coldTurns[0], {
    at: '2026-01-01T01:04:00Z', idleMin: 63, attested: ['observation_mask'], refused: [], stoodDown: [], creditUsd: {}, removed: {}, removedTokens: 0,
    cacheWriteTokens: 50000, cacheReadTokens: 0, declines: { observation_mask: { payback_retrieval: 1 } },
  });
  assert.deepEqual(r.arms.b.coldTurns[0].creditUsd, { observation_mask: 0.03 });
  assert.deepEqual(r.arms.b.coldTurns[0].removed, { observation_mask: 8000, relevance_filter: 1000 });
  assert.equal(r.arms.b.coldTurns[0].removedTokens, 9000);
  assert.deepEqual(r.problems, []);
});

test('coldTurnReport names what makes a round unreadable', () => {
  const bad = structuredClone(RECORD);
  bad.rounds[0].heldOut = { a: ['observation_mask'], b: [], differs: true };
  bad.rounds[0].tracesA.traces[3].decisions = []; // A never attested
  bad.rounds[0].tracesA.traces[3].suppressed = [{ kind: 'prompt_cache_expiry', reason: 'expiry_refused_ping_horizon' }];
  bad.rounds[0].traces.traces[3].decisions = bad.rounds[0].traces.traces[3].decisions.filter((d) => d.metric?.name !== 'cold_write_saving_usd');
  bad.rounds[0].gatewayRestarted = true;
  bad.rounds[0].experimentRule = { before: [{ label: 'x', params: {} }], after: [], stable: false };
  const [r] = coldTurnReport(bad).rounds;
  assert.deepEqual(r.arms.a.coldTurns[0].attested, []);
  assert.deepEqual(r.arms.a.coldTurns[0].refused, ['expiry_refused_ping_horizon']);
  assert.deepEqual(r.problems, [
    'the gateway restarted during the round',
    'the session gate held out different kinds: A observation_mask, B none',
    "arm B's rule changed during the round",
    'A: cold turn 1 was not attested (expiry_refused_ping_horizon)',
    'B: no cold turn shows the credit (cold_write_saving_usd)',
  ]);
  const text = formatColdTurnReport(coldTurnReport(bad));
  assert.match(text, /DISCARD/);
  assert.match(formatColdTurnReport(coldTurnReport(RECORD)), /cold turn 1 .*attested observation_mask.*credit \$0\.0300/);
});

test('coldTurnReport: traces unavailable, or a failed round, are reported instead of guessed', () => {
  const none = structuredClone(RECORD);
  none.rounds[0].traces = { unavailable: '403' };
  const [r] = coldTurnReport(none).rounds;
  assert.equal(r.arms.b.coldTurns, null);
  assert.ok(r.problems.includes('B: traces unavailable (403)'));
  assert.deepEqual(coldTurnReport({ scenario: {}, rounds: [{ round: 2, error: 'boom' }] }).rounds, [{ round: 2, error: 'boom' }]);
});

// ---- --redraw-holdout: start the pair again when the gateway holds a kind out ------------

test('parseArgs: --redraw-holdout is off by default, takes a count, and needs a gateway arm', () => {
  assert.equal(gw().redrawHoldout, 0);
  assert.equal(gw('--redraw-holdout', '4').redrawHoldout, 4);
  assert.throws(() => gw('--redraw-holdout', 'x'), /--redraw-holdout needs a positive integer/);
  assert.throws(() => gw('--redraw-holdout', '0'), /--redraw-holdout needs a positive integer/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--redraw-holdout', '2']), /--redraw-holdout needs --compare anyray or gateway/);
});

test('earlyHoldout: a holdout on one of the first responses, and only there', () => {
  const kinds = ['observation_mask', 'code_graph'];
  const clean = parseOptimizationResult(header([{ kind: 'code_graph', reason: 'no_change' }]));
  const held = parseOptimizationResult(header([{ kind: 'code_graph', reason: 'safety_gate', guard: 'session_gate_holdout' }]));
  const cooloff = parseOptimizationResult(header([{ kind: 'code_graph', reason: 'safety_gate', guard: 'pin_thrash' }]));
  assert.deepEqual(earlyHoldout([held], kinds), ['code_graph']);
  assert.deepEqual(earlyHoldout([clean, held], kinds), ['code_graph']);
  assert.deepEqual(earlyHoldout([clean], kinds), []);
  assert.deepEqual(earlyHoldout([cooloff], kinds), []); // a cooloff is not the session's control draw
  assert.deepEqual(earlyHoldout([clean, clean, clean, held], kinds), []); // past the first three: too late to restart cheaply
  assert.deepEqual(earlyHoldout([{ status: 'unconfirmed', why: 'missing' }, held], kinds), ['code_graph']);
});

test('runPairWithRedraw: a pair that drew a holdout is started again, up to the cap, and the draws are kept', async () => {
  const starts = [];
  // Attempt 1: B reports a holdout. Attempt 2: clean.
  const startPair = async (redraw) => {
    starts.push(redraw);
    if (starts.length === 1) {
      redraw.report('b')(['code_graph']);
      assert.equal(redraw.signal.aborted, true);
      return { settled: [{ status: 'rejected' }, { status: 'rejected' }], n: 1 };
    }
    return { settled: [{ status: 'fulfilled', value: 'A' }, { status: 'fulfilled', value: 'B' }], n: 2 };
  };
  const seen = [];
  const out = await runPairWithRedraw(startPair, 3, (drawn, n) => seen.push([drawn, n]));
  assert.equal(out.n, 2);
  assert.deepEqual(out.redraws, [{ b: ['code_graph'] }]);
  assert.deepEqual(seen, [[{ b: ['code_graph'] }, 1]]);
  assert.notEqual(starts[0].signal, starts[1].signal); // each attempt has its own stop signal
});

test('runPairWithRedraw: out of redraws, the last attempt stands (and fails the round); off, nothing is watched', async () => {
  let n = 0;
  const always = async (redraw) => {
    n++;
    redraw.report('a')(['observation_mask']);
    return { settled: [{ status: 'rejected', reason: new Error('held out') }, { status: 'rejected' }] };
  };
  const out = await runPairWithRedraw(always, 2);
  assert.equal(n, 3); // the first try and two redraws
  assert.equal(out.redraws.length, 2);
  assert.equal(out.settled[0].status, 'rejected');
  const off = await runPairWithRedraw(async (redraw) => ({ settled: [], redraw }), 0);
  assert.equal(off.redraw, null);
  assert.deepEqual(off.redraws, []);
});

// ---- cold turns: the same kinds must be standing in both arms ----------------------------

test('coldTurnReport: kinds a gate stood down at a cold turn, and a problem when the arms differ there', () => {
  const rec = structuredClone(RECORD);
  rec.rounds[0].tracesA.traces[3].suppressed = [
    { kind: 'relevance_filter', reason: 'regret_guard' },
    { kind: 'first_appearance_shadow', reason: 'fa_no_marker' }, // a measurement, not a stand-down
  ];
  const [r] = coldTurnReport(rec).rounds;
  assert.deepEqual(r.arms.a.coldTurns[0].stoodDown, ['relevance_filter:regret_guard']);
  assert.deepEqual(r.arms.b.coldTurns[0].stoodDown, []);
  assert.deepEqual(r.problems, ['cold turn 1: different kinds stood down (A relevance_filter:regret_guard; B none)']);
  assert.match(formatColdTurnReport(coldTurnReport(rec)), /stood down relevance_filter:regret_guard/);
  // The same stand-down in both arms is not a problem: both ran without that kind.
  rec.rounds[0].traces.traces[3].suppressed = [{ kind: 'relevance_filter', reason: 'regret_guard' }];
  assert.deepEqual(coldTurnReport(rec).rounds[0].problems, []);
});

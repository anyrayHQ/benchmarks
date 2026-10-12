// --compare gateway: A = the gateway arm without the treatment, B = the same gateway arm
// with ANYRAY_BENCH_EXTRA_HEADERS. Everything else is identical, except per-arm session ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armsFor,
  armSetups,
  gatewaySlots,
  parallelToolTurns,
  parseArgs,
  requestRecord,
  resultFileName,
  roundRatio,
  roundTags,
  scoredRounds,
  slotOptions,
} from '../run_agent.mjs';

const GW = 'https://gateway.test.invalid';
const RUN = { model: 'm', gatewayUrl: GW };
const SCN = { maxTurns: 40 };
const gw = (...more) => parseArgs(['--scenario', 's', '--compare', 'gateway', '--strategy', 'thinking_trim', ...more]);

test('parseArgs: --compare gateway is accepted and, like anyray, needs --kinds or --strategy', () => {
  assert.equal(gw().compare, 'gateway');
  assert.deepEqual(gw().kinds, ['thinking_trim']);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway']), /--compare gateway needs --kinds/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'bogus']), /--compare anyray\|control\|gateway/);
});

test('parseArgs: gateway-arm flags are allowed under --compare gateway, still refused under control', () => {
  assert.equal(gw('--read-trim').readTrim, true);
  assert.equal(parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask', '--experiment', 'x']).experiment, 'x');
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--strategy', 'thinking_trim']), /--strategy needs --compare anyray or gateway/);
});

test('armsFor: gateway puts the anyray arm in both slots', () => {
  assert.deepEqual(armsFor('anyray'), { a: 'direct', b: 'anyray' });
  assert.deepEqual(armsFor('control'), { a: 'direct', b: 'direct' });
  assert.deepEqual(armsFor('gateway'), { a: 'anyray', b: 'anyray' });
  assert.deepEqual(gatewaySlots(armsFor('gateway')), ['a', 'b']);
  assert.deepEqual(gatewaySlots(armsFor('anyray')), ['b']);
  assert.deepEqual(gatewaySlots(armsFor('control')), []);
});

test('slotOptions: under gateway both slots get kinds and read trim, only B gets the extra headers', () => {
  const args = { ...gw('--read-trim'), extraHeaders: ['x-anyray-tool-defer: on'] };
  const arms = armsFor('gateway');
  const a = slotOptions(args, arms, 'a');
  const b = slotOptions(args, arms, 'b');
  assert.deepEqual(a, { ...b, extraHeaders: [] });
  assert.deepEqual(b.extraHeaders, ['x-anyray-tool-defer: on']);
  assert.equal(a.arm, 'anyray');
  assert.deepEqual(a.kinds, ['thinking_trim']);
  assert.equal(a.readTrim, true);
});

test('slotOptions: under anyray the extra headers still go to the anyray arm (B) only', () => {
  const args = { ...parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), extraHeaders: ['x-e: 1'] };
  assert.deepEqual(slotOptions(args, armsFor('anyray'), 'a').extraHeaders, []);
  assert.deepEqual(slotOptions(args, armsFor('anyray'), 'b').extraHeaders, ['x-e: 1']);
});

test('slotOptions: shared headers ride every Anyray arm, ahead of the treatment on B', () => {
  const args = { ...gw(), sharedHeaders: ['x-anyray-tool-defer: off'], extraHeaders: ['x-anyray-retrieval-tools: lazy'] };
  const arms = armsFor('gateway');
  assert.deepEqual(slotOptions(args, arms, 'a').extraHeaders, ['x-anyray-tool-defer: off']);
  assert.deepEqual(slotOptions(args, arms, 'b').extraHeaders, ['x-anyray-tool-defer: off', 'x-anyray-retrieval-tools: lazy']);
  const direct = { ...parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), sharedHeaders: ['x-anyray-tool-defer: off'] };
  assert.deepEqual(slotOptions(direct, armsFor('anyray'), 'a').extraHeaders, [], 'never on a direct arm');
  assert.deepEqual(slotOptions(direct, armsFor('anyray'), 'b').extraHeaders, ['x-anyray-tool-defer: off']);
});

test('roundTags: gateway gives each slot its own session id, same everything else', () => {
  const t = roundTags(gw(), 2, 7);
  assert.equal(t.a.sessionId, 'anyray-bench-s-gateway-r2-7-a');
  assert.equal(t.b.sessionId, 'anyray-bench-s-gateway-r2-7-b');
  assert.deepEqual({ ...t.a, sessionId: null }, { ...t.b, sessionId: null });
  assert.equal(t.b.experiment, 'thinking_trim');
});

test('roundTags: anyray and control keep one shared tag (unchanged ids)', () => {
  const t = roundTags(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), 3, 42);
  assert.equal(t.a, t.b);
  assert.equal(t.b.sessionId, 'anyray-bench-s-anyray-r3-42');
});

test('armSetups: gateway records two gateway arms, headers only on B', () => {
  const args = { ...gw(), extraHeaders: ['x-anyray-tool-defer: on'] };
  const s = armSetups(args, armsFor('gateway'), RUN, SCN, { enrolled: true, tenant: { tenant: 'default' } });
  assert.equal(s.a.arm, 'anyray');
  assert.equal(s.b.arm, 'anyray');
  assert.deepEqual(s.a.tenant, s.b.tenant);
  assert.equal(s.a.headers['x-anyray-tool-defer'], undefined);
  assert.equal(s.b.headers['x-anyray-tool-defer'], '<ANYRAY_BENCH_EXTRA_HEADERS>');
});

test('requestRecord: records which slots carried the extra headers', () => {
  assert.deepEqual(requestRecord({ ...gw(), extraHeaders: ['x-anyray-tool-defer: on'] }).extraHeadersOn, ['b']);
  assert.deepEqual(requestRecord({ ...gw(), extraHeaders: [] }).extraHeadersOn, []);
});

test('requestRecord: names the shared headers only when there are some', () => {
  assert.deepEqual(requestRecord({ ...gw(), extraHeaders: [], sharedHeaders: ['x-anyray-tool-defer: off'] }).sharedHeaders, ['x-anyray-tool-defer']);
  assert.equal('sharedHeaders' in requestRecord({ ...gw(), extraHeaders: [] }), false);
});

test('resultFileName: <scenario>--gateway[--label].json', () => {
  assert.equal(resultFileName({ scenario: 's', compare: 'gateway', label: 'defer-ab' }), 's--gateway--defer-ab.json');
  assert.equal(resultFileName({ scenario: 's', compare: 'gateway', label: null }), 's--gateway.json');
});

test('scoredRounds: drops failed rounds and rounds the gateway restarted under', () => {
  const rs = [{ round: 1, ratio: 1 }, { round: 2, error: 'x' }, { round: 3, ratio: 1, gatewayRestarted: true }, { round: 4, ratio: 0.9, gatewayRestarted: false }];
  assert.deepEqual(scoredRounds(rs).map((r) => r.round), [1, 4]);
});

test('parallelToolTurns: counts main-agent requests with more than one tool call', () => {
  const rq = (agent, n) => ({ agent, blocks: Array.from({ length: n }, () => ({ type: 'tool_use' })) });
  assert.equal(parallelToolTurns([rq('main', 1), rq('main', 3), rq('main', 2), rq('sub', 4), rq('main', 0)]), 2);
  assert.equal(parallelToolTurns([]), 0);
});

test('roundRatio: an arm with no result (timed out, killed) makes the round unscorable, not ratio 0', () => {
  const s = (costUsd) => ({ totals: { costUsd } });
  assert.deepEqual(roundRatio(s(2), s(1)), { ratio: 0.5 });
  assert.deepEqual(roundRatio(s(2), s(null)), { ratio: null, error: 'B ended without a result (no cost)' });
  assert.deepEqual(roundRatio(s(null), s(1)), { ratio: null, error: 'A ended without a result (no cost)' });
});

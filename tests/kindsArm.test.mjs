import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armConfig, describeSetup, routeViaProxy } from '../lib/agentRun.mjs';
import { parseArgs, armSetups, slotOptions } from '../run_agent.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = 'ark_svc_test_fake';
const TAG = { sessionId: 's1' };
const cfg = () => mkdtempSync(join(tmpdir(), 'cfg-'));
const deps = (configureArm) => ({
  connect: () => ({ gateway: 'https://elsewhere.example', clientKey: 'ark_machine' }),
  clientKey: () => KEY,
  anyrayHooks: () => ({}),
  binExists: () => false,
  bin: '/bin/anyray-connect',
  serviceKey: () => KEY,
  configureArm: configureArm ?? (() => ({ configured: false, reason: 'test' })),
});
const connectWrote = () => ({
  configured: true,
  settings: { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_CUSTOM_HEADERS: `x-anyray-provider: anthropic\nx-anyray-api-key: ${KEY}\nx-anyray-metadata: {"tool":"claude-code"}`, ENABLE_TOOL_SEARCH: 'auto:20' } },
  mcpServers: {},
  setup: { env: {} },
});
const lines = (h) => h.split('\n');

// ---- parseArgs: --compare anyray always names its strategies ----------------

test('parseArgs: --compare anyray without --kinds (or --strategy) is refused, never left to tenant defaults', () => {
  assert.throws(() => parseArgs(['--scenario', 's']), /--kinds/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'anyray']), /--kinds/);
});

test('parseArgs: --kinds sets the requested kinds', () => {
  const a = parseArgs(['--scenario', 's', '--kinds', 'observation_mask, code_graph']);
  assert.deepEqual(a.kinds, ['observation_mask', 'code_graph']);
  assert.equal(a.kindsSource, '--kinds');
});

test('parseArgs: --strategy alone requests exactly that kind', () => {
  const a = parseArgs(['--scenario', 's', '--strategy', 'thinking_trim']);
  assert.deepEqual(a.kinds, ['thinking_trim']);
  assert.equal(a.kindsSource, '--strategy');
});

test('parseArgs: --strategy must be one of the --kinds when both are given', () => {
  assert.deepEqual(parseArgs(['--scenario', 's', '--strategy', 'a_k', '--kinds', 'a_k,b_k']).kinds, ['a_k', 'b_k']);
  assert.throws(() => parseArgs(['--scenario', 's', '--strategy', 'a_k', '--kinds', 'b_k']), /--strategy/);
});

test('parseArgs: --kinds needs --compare anyray; control needs none', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--kinds', 'observation_mask']), /--kinds needs --compare anyray/);
  assert.equal(parseArgs(['--scenario', 's', '--compare', 'control']).kinds, null);
});

test('parseArgs: --arm-env still refuses harness-owned keys (the kinds header rides ANTHROPIC_CUSTOM_HEADERS)', () => {
  for (const k of ['ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BASE_URL', 'ANYRAY_BENCH_CLIENT_KEY']) {
    assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--arm-env', `b:${k}=x`]), /--arm-env cannot set/);
  }
});

test('slotOptions: kinds follow the Anyray arm only', () => {
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask']);
  const arms = { a: 'direct', b: 'anyray' };
  assert.deepEqual(slotOptions(args, arms, 'b').kinds, ['observation_mask']);
  assert.equal(slotOptions(args, arms, 'a').kinds, null);
});

// ---- armConfig: the header on the Anyray arm only ---------------------------

test('armConfig (harness arm): the kinds header joins the Anyray headers', () => {
  const a = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, cfgDir: cfg(), kinds: ['observation_mask', 'code_graph'], deps: deps() });
  const h = lines(a.settings.env.ANTHROPIC_CUSTOM_HEADERS);
  assert.ok(h.includes('x-anyray-optimization-kinds: observation_mask,code_graph'));
  assert.ok(h.includes(`x-anyray-api-key: ${KEY}`));
  assert.ok(h.includes(`x-anyray-metadata: ${JSON.stringify(TAG)}`));
});

test('armConfig (connect arm): merged into what connect wrote, nothing of connect\'s dropped', () => {
  const a = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, cfgDir: cfg(), kinds: ['observation_mask'], deps: deps(connectWrote) });
  assert.deepEqual(lines(a.settings.env.ANTHROPIC_CUSTOM_HEADERS), [
    'x-anyray-provider: anthropic',
    `x-anyray-api-key: ${KEY}`,
    `x-anyray-metadata: ${JSON.stringify(TAG)}`,
    'x-anyray-optimization-kinds: observation_mask',
  ]);
  assert.equal(a.settings.env.ENABLE_TOOL_SEARCH, 'auto:20');
});

test('armConfig: the direct arm never carries the kinds header', () => {
  const a = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: TAG, cfgDir: cfg(), kinds: ['observation_mask'], deps: deps() });
  assert.equal(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.ok(!JSON.stringify(a).includes('optimization-kinds'));
});

// ---- routeViaProxy: the session talks to the local recorder, which forwards to the gateway ----

test('routeViaProxy points the session base URL at the proxy and keeps every other env key', () => {
  const s = { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_CUSTOM_HEADERS: 'a: 1', X: 'y' }, hooks: { h: 1 } };
  const r = routeViaProxy(s, 'http://127.0.0.1:5555');
  assert.deepEqual(r, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555', ANTHROPIC_CUSTOM_HEADERS: 'a: 1', X: 'y' }, hooks: { h: 1 } });
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW, 'input not mutated');
});

// ---- recorded in setup ------------------------------------------------------

test('describeSetup records the requested kinds and the header on the Anyray arm; the direct arm has none', () => {
  const base = { model: 'm', gatewayUrl: GW, runTag: 't', maxTurns: 1, enrolled: false, kinds: ['observation_mask'], kindsSource: '--kinds' };
  const b = describeSetup({ ...base, arm: 'anyray' });
  assert.deepEqual(b.optimizationKinds, { requested: ['observation_mask'], source: '--kinds', header: 'x-anyray-optimization-kinds', feedback: 'x-anyray-optimization-result, read per request by a local pass-through proxy' });
  assert.equal(b.headers['x-anyray-optimization-kinds'], 'observation_mask');
  const a = describeSetup({ ...base, arm: 'direct' });
  assert.equal(a.optimizationKinds, null);
  assert.equal(a.headers['x-anyray-optimization-kinds'], undefined);
});

test('armSetups records the kinds on the Anyray slot', () => {
  const s = armSetups(parseArgs(['--scenario', 's', '--kinds', 'observation_mask,code_graph']), { a: 'direct', b: 'anyray' }, { model: 'm', gatewayUrl: GW }, { maxTurns: 3 }, { enrolled: false });
  assert.deepEqual(s.b.optimizationKinds.requested, ['observation_mask', 'code_graph']);
  assert.equal(s.a.optimizationKinds, null);
});

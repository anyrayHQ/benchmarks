// Socket-free checks complement the CLI tests, whose fake gateway needs listen permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetPlan, classify, shapeFeatures, loadCatalog } from '../lib/planner.mjs';
import { sessionGateState } from '../lib/traces.mjs';
import { TEST_SHAPES, shapeScenario, shapedScenarios } from './kitPlanFixtures.mjs';

test('offline shapes respect the cap, MCP and pause boundaries and ignore unused delays', () => {
  const features = (over, client = 'claude-code') => shapeFeatures(shapeScenario({}, over).doc, client);
  assert.equal(features({ maxTurns: 8, followups: ['next', 'last'] }).requests, 'short');
  assert.equal(features({ maxTurns: 9 }).requests, 'single');
  assert.equal(features({ followups: ['next'] }).requests, 'medium');
  assert.equal(features({ followups: ['next', 'last'] }).requests, 'long');
  assert.equal(features({ pastes: { log: 'log.txt' } }).requests, 'long');
  for (const [mcpTools, expected] of [[0, 'none'], [1, 'some'], [99, 'some'], [100, 'many']]) assert.equal(features({ mcpTools }).mcp, expected);
  for (const [followups, followupDelaySec, expected] of [
    [[], 900, false], [['next'], 299, false], [['next'], 300, true],
    [['next', 'last'], [0, 300], true], [['next', 'last'], [0, 0, 900], false],
  ]) assert.equal(features({ followups, followupDelaySec }).pause, expected);
  assert.equal(features({}, 'codex').cacheMarkers, 'none');
});

test('offline predictions use the first match and preserve the round floor, unknown and parity cases', () => {
  const predict = (scenario, client = 'claude-code') => classify(scenario.doc, client, { shapes: TEST_SHAPES });
  const all = shapedScenarios();
  assert.equal(predict(all['mcp-check-long']).shapeId, 't-mcp-many');
  assert.deepEqual(predict(all.docs).prediction, { status: 'none', reason: 'too_few_rounds', rounds: 7 });
  assert.deepEqual(predict(all.facts).prediction, { status: 'none', reason: 'unknown_shape' });
  assert.deepEqual(predict(all.paused).prediction, { status: 'band', expect: 'saving', lo: 0.6, hi: 0.8, rounds: 8 });
  assert.deepEqual(predict(all.facts, 'codex').prediction, { status: 'band', expect: 'parity', lo: 0.9, hi: 1.1, rounds: 8 });
  const catalog = loadCatalog();
  assert.ok(catalog.shapes.every((s) => s.rounds < 8), 'published seeds do not invent attributable rounds');
});

test('offline budget reports underpowered bands, exact affordability boundaries and spend ceilings', () => {
  const all = shapedScenarios();
  const scenarios = ['check-long', 'short-task', 'docs', 'facts'].map((id) => ({ id, ...classify(all[id].doc, 'claude-code', { shapes: TEST_SHAPES }) }));
  const plan = (budgetUsd, rows = scenarios) => budgetPlan(rows, { budgetUsd, sessionCostUsd: 0.15 });
  const p = plan(500);
  assert.deepEqual(p.scenarios.map((s) => s.pairsNeeded), [135, 604, null, null]);
  assert.deepEqual(p.scenarios.map((s) => s.resolvable), [true, false, null, null]);
  assert.equal(p.pairsAffordable, 416);
  assert.ok(Math.abs(p.spendCeilingUsd - 414.9) < 1e-9);
  assert.equal(p.resolvable, false);
  assert.equal(plan(724.9).resolvable, true);
  assert.equal(plan(724.7).resolvable, false);
  assert.equal(plan(0.5, scenarios.slice(0, 1)).detectableRatio, null);
  assert.equal(plan(10000, scenarios.slice(2)).resolvable, false);
  const parity = [{ id: 'parity', ...classify(all.facts.doc, 'codex', { shapes: TEST_SHAPES }) }];
  assert.equal(plan(500, parity).scenarios[0].pairsNeeded, null);
  assert.equal(plan(500, parity).resolvable, false);
});

const gateway = 'https://gateway.example';
const env = { ANYRAY_ADMIN_KEY: 'synthetic-admin' };
const fetchGate = (strategies, extra = {}) => sessionGateState(gateway, { env,
  fetchImpl: async () => ({ ok: true, json: async () => ({ tenant: 'acme', strategies }) }), ...extra });

test('session gate refuses only all-shadow, counts effective states and permits an empty list', async () => {
  assert.deepEqual(await fetchGate([{ state: 'shadow' }, { state: 'shadow' }]), { tenant: 'acme', kinds: { on: 0, shadow: 2, off: 0 }, allShadow: true });
  const mixed = await fetchGate([{ state: 'shadow', effectiveState: 'on' }, { state: 'shadow' }, { state: 'off' }]);
  assert.deepEqual(mixed, { tenant: 'acme', kinds: { on: 1, shadow: 1, off: 1 }, allShadow: false });
  assert.deepEqual(await fetchGate([]), { tenant: 'acme', kinds: { on: 0, shadow: 0, off: 0 }, allShadow: false });
});

test('session gate sends a bounded authenticated GET, selects the token in priority order and forwards only an explicit tenant', async () => {
  for (const [keys, token, tenant] of [
    [{ ANYRAY_TRACE_TOKEN: 'trace-token', ANYRAY_TRACE_KEY: 'trace-key', ...env }, 'trace-token', 'acme-eu'],
    [{ ANYRAY_TRACE_KEY: 'trace-key', ...env }, 'trace-key', undefined],
    [env, env.ANYRAY_ADMIN_KEY, undefined],
  ]) {
    await fetchGate([], { env: keys, tenant, fetchImpl: async (url, options) => {
      assert.equal(url.origin, gateway);
      assert.equal(url.pathname, '/admin/v1/optimizer/session-gate');
      assert.deepEqual(Object.fromEntries(url.searchParams), tenant ? { tenant } : {});
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, json: async () => ({ tenant: 'acme', strategies: [] }) };
    } });
  }
});

test('session gate fails closed without credentials, on HTTP or network errors, and on malformed responses', async () => {
  assert.deepEqual(await fetchGate([], { env: {}, fetchImpl: () => assert.fail('no credential must make no request') }), { reason: 'no_admin_key' });
  assert.deepEqual(await fetchGate([], { fetchImpl: async () => { throw new Error('private detail'); } }), { reason: 'request_failed' });
  assert.deepEqual(await fetchGate([], { fetchImpl: async () => ({ ok: false, status: 403 }) }), { reason: 'request_failed', status: 403 });
  for (const body of [null, {}, { tenant: 42, strategies: [] }, { tenant: 'acme' }, { tenant: 'acme', strategies: [null] }, { tenant: 'acme', strategies: [{ state: 'unrecognized' }] }]) {
    assert.deepEqual(await fetchGate([], { fetchImpl: async () => ({ ok: true, json: async () => body }) }), { reason: 'bad_response' });
  }
  assert.deepEqual(await fetchGate([], { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('private body'); } }) }), { reason: 'bad_response' });
});

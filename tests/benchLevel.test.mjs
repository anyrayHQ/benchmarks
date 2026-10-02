import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { parseArgs, requestRecord, withIntegrationLevel, armSetups, armsFor } from '../run_agent.mjs';
import { createBenchLevel } from '../lib/benchLevel.mjs';
import { checkConnectConfig, checkConnectSession, failedChecks } from '../lib/connectChecks.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = ['ark', 'svc', 'fake', 'secret'].join('_');
const ADMIN = ['aak', 'fake', 'secret'].join('_');
const policy = () => ({ skills: [{ id: 'one' }], hooks: { org: { digest: 'off' } }, tools: { enabled: ['Read'] }, integrationLevel: { org: 'gateway_hooks_mcp', agents: { other: 'gateway' } }, revision: 'r1' });
const testRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-level-'));
  writeFileSync(join(root, 'config.yaml'), 'run:\n  blocked_gateways:\n    - https://blocked.test.invalid\n');
  return root;
};

function api() {
  let state = policy(), puts = [], secrets = 0;
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/connect/policy') return response({ integrationLevel: { level: 'gateway_hooks_mcp', source: 'default' } });
    if (path === '/admin/v1/keys') return response({ keys: [{ id: 'agent-1', keyType: 'service', secretStored: true }, { id: 'other', keyType: 'service', secretStored: false }] });
    if (path === '/admin/v1/keys/agent-1/secret') { secrets++; return response({ key: KEY }); }
    if (path === '/admin/v1/policies/teams' && init.method === 'GET') return response(state);
    if (path === '/admin/v1/policies/teams' && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push(body);
      if (body.expectedRevision !== state.revision) return response({ error: { code: 'team_policy_conflict' } }, 409);
      state = { ...state, ...body, revision: `r${puts.length + 1}` };
      delete state.expectedRevision;
      return response(state);
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  return { fetchImpl, get state() { return state; }, puts, get secrets() { return secrets; } };
}

test('integration level arguments validate comparison, value and retrieval options', () => {
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--integration-level', 'gateway_hooks']);
  assert.equal(args.integrationLevel, 'gateway_hooks');
  assert.equal(requestRecord(args).integrationLevel, 'gateway_hooks');
  const setups = armSetups(args, armsFor(args.compare), { model: 'm', gatewayUrl: GW }, { maxTurns: 1 });
  assert.equal(setups.a.integrationLevel, null);
  assert.equal(setups.b.integrationLevel, 'gateway_hooks');
  const gatewayArgs = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--compare', 'gateway', '--integration-level', 'gateway']);
  assert.deepEqual(Object.values(armSetups(gatewayArgs, armsFor('gateway'), { model: 'm', gatewayUrl: GW }, { maxTurns: 1 })).map((s) => s.integrationLevel), ['gateway', 'gateway']);
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']).integrationLevel, null);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--integration-level', 'gateway']), /--integration-level needs/);
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--integration-level', 'bad']), /--integration-level/);
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--integration-level']), /--integration-level/);
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--integration-level', 'gateway_hooks', '--read-trim']), /--read-trim.*gateway_hooks_mcp/);
  assert.throws(() => parseArgs(['--scenario', 's', '--bare', '--integration-level', 'gateway']), /--bare runs without anyray-connect/);
});

test('set and clear preserve other policy fields, use revisions, and save no key', async () => {
  const stub = api(), root = testRoot();
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, agent: 'agent-1', fetchImpl: stub.fetchImpl, root });
  const change = await level.set('gateway_hooks');
  assert.equal(change.target.id, 'agent-1');
  assert.equal(stub.secrets, 0);
  assert.equal(stub.state.integrationLevel.agents['agent-1'], 'gateway_hooks');
  assert.deepEqual(stub.state.skills, policy().skills);
  assert.deepEqual(stub.state.hooks, policy().hooks);
  assert.deepEqual(stub.state.tools, policy().tools);
  assert.equal(stub.puts[0].expectedRevision, 'r1');
  assert.ok(!JSON.stringify(stub.puts[0]).includes(KEY));
  assert.ok(!readFileSync(join(root, 'results', 'integration-level.before.json'), 'utf8').includes(KEY));
  await level.clear(change);
  assert.deepEqual(stub.state.integrationLevel, policy().integrationLevel);
  assert.equal(stub.puts[1].expectedRevision, 'r2');
});

test('clear rebases over unrelated policy changes but refuses a changed target', async () => {
  const stub = api();
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, agent: 'agent-1', fetchImpl: stub.fetchImpl, root: testRoot() });
  const change = await level.set('gateway');
  stub.state.revision = 'external';
  stub.state.hooks.extra = 'on';
  await level.clear(change);
  assert.equal(stub.puts[1].expectedRevision, 'external');
  assert.equal(stub.state.hooks.extra, 'on');
  const changed = await level.set('gateway');
  stub.state.integrationLevel.agents['agent-1'] = 'gateway_hooks';
  await assert.rejects(level.clear(changed), /assignment changed/);
  const missing = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: ['ark', 'svc', 'other', 'fake'].join('_'), fetchImpl: stub.fetchImpl, root: testRoot() });
  await assert.rejects(missing.show(), /--agent/);
});

test('explicit ids avoid secret reads and restore an existing assignment', async () => {
  const stub = api(), root = testRoot();
  stub.state.integrationLevel.agents['agent-1'] = 'gateway_hooks_mcp';
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, agent: 'agent-1', fetchImpl: stub.fetchImpl, root });
  const change = await level.set('gateway');
  assert.equal(stub.secrets, 0);
  await level.clear(change);
  assert.equal(stub.state.integrationLevel.agents['agent-1'], 'gateway_hooks_mcp');
  assert.throws(() => createBenchLevel({ gatewayUrl: 'https://blocked.test.invalid', adminKey: ADMIN, clientKey: KEY, root }), /blocked/);
});

test('a lost set response is cleaned up using the saved prior assignment', async () => {
  const stub = api(), root = testRoot();
  let lost = false;
  const fetchImpl = async (url, init) => {
    const response = await stub.fetchImpl(url, init);
    if (!lost && init.method === 'PUT') { lost = true; throw new Error('response lost'); }
    return response;
  };
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, agent: 'agent-1', fetchImpl, root });
  await assert.rejects(level.set('gateway_hooks'), /response lost/);
  assert.deepEqual(stub.state.integrationLevel, policy().integrationLevel);
  assert.equal(existsSync(join(root, 'results', 'integration-level.before.json')), false);
});

test('clear retries a revision conflict without replacing unrelated edits', async () => {
  const stub = api(), root = testRoot();
  let conflict = false;
  const fetchImpl = async (url, init) => {
    if (!conflict && init.method === 'PUT' && stub.puts.length === 1) {
      conflict = true;
      stub.state.revision = 'external';
      stub.state.tools.extra = true;
      return { ok: false, status: 409 };
    }
    return stub.fetchImpl(url, init);
  };
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, agent: 'agent-1', fetchImpl, root });
  const change = await level.set('gateway');
  await level.clear(change);
  assert.equal(stub.state.integrationLevel.agents['agent-1'], undefined);
  assert.equal(stub.state.tools.extra, true);
  assert.equal(stub.puts[1].expectedRevision, 'external');
});

test('run scope sets before work and clears on success, failure and SIGINT cleanup', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const level = { set: async () => { calls.push('set'); return { target: {} }; }, clear: async () => { calls.push('clear'); } };
    const work = async () => { calls.push('run'); if (fail) throw new Error('failed'); };
    if (fail) await assert.rejects(withIntegrationLevel('gateway', work, { level }), /failed/);
    else await withIntegrationLevel('gateway', work, { level });
    assert.deepEqual(calls, ['set', 'run', 'clear']);
  }
  const signal = new EventEmitter(), calls = [];
  signal.exit = (code) => calls.push(`exit:${code}`);
  let finish;
  const running = withIntegrationLevel('gateway', () => new Promise((resolve) => { finish = resolve; }), { level: { set: async () => ({ target: {} }), clear: async () => { calls.push('clear'); } }, signal });
  await new Promise((resolve) => setImmediate(resolve));
  signal.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  await running;
  assert.deepEqual(calls, ['clear', 'exit:130']);
  const earlySignal = new EventEmitter(), earlyCalls = [];
  earlySignal.exit = (code) => earlyCalls.push(`exit:${code}`);
  let finishSet;
  const early = withIntegrationLevel('gateway', () => { earlyCalls.push('run'); }, { level: { set: () => new Promise((resolve) => { finishSet = resolve; }), clear: async () => { earlyCalls.push('clear'); } }, signal: earlySignal });
  earlySignal.emit('SIGINT');
  finishSet({ target: {} });
  await assert.rejects(early, /interrupted/);
  assert.deepEqual(earlyCalls, ['clear', 'exit:130']);
});

const shape = (level) => ({
  settings: { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_CUSTOM_HEADERS: 'x-anyray-metadata: {}', ANTHROPIC_AUTH_TOKEN: '' }, apiKeyHelper: 'key-helper',
    ...(level !== 'gateway' ? { hooks: Object.fromEntries(['PostToolUse', 'PostToolUseFailure'].map((e) => [e, [{ hooks: [{ command: '/bin/anyray-connect __anyray-hook' }] }]])) } : {}),
    ...(level === 'gateway_hooks_mcp' ? { permissions: { allow: ['mcp__anyray__anyray_retrieve'] } } : {}) },
  mcpServers: level === 'gateway_hooks_mcp' ? { anyray: { type: 'stdio', command: '/bin/anyray-connect', args: ['__anyray-mcp-server'] } } : {},
  skills: level === 'gateway_hooks_mcp' ? ['anyray'] : [], gatewayUrl: GW, lane: 'org', helperPrintsKey: true,
  appliedIntegrationLevel: level, integrationLevel: level,
});

test('level checks pass matching shapes and name each wrong piece in both directions', () => {
  for (const level of ['gateway', 'gateway_hooks', 'gateway_hooks_mcp']) {
    assert.deepEqual(failedChecks(checkConnectConfig(shape(level))), []);
    const init = level === 'gateway_hooks_mcp' ? { mcpServers: [{ name: 'anyray', status: 'connected' }], tools: ['mcp__anyray__anyray_retrieve'] } : { mcpServers: [], tools: [] };
    assert.deepEqual(failedChecks(checkConnectSession({ init, level, appliedIntegrationLevel: level })), []);
  }
  const wrong = failedChecks(checkConnectConfig({ ...shape('gateway'), ...{ integrationLevel: 'gateway', appliedIntegrationLevel: 'gateway_hooks_mcp' }, settings: shape('gateway_hooks_mcp').settings, mcpServers: shape('gateway_hooks_mcp').mcpServers, skills: ['anyray'] })).map((c) => c.name).join(' ');
  for (const piece of ['applied', 'PostToolUse', 'PostToolUseFailure', 'mcp anyray', 'permission', 'skill']) assert.match(wrong, new RegExp(piece));
  const missing = failedChecks(checkConnectConfig({ ...shape('gateway'), integrationLevel: 'gateway_hooks_mcp' })).map((c) => c.name).join(' ');
  for (const piece of ['applied', 'PostToolUse', 'mcp anyray', 'permission', 'skill']) assert.match(missing, new RegExp(piece));
  const session = failedChecks(checkConnectSession({ init: { mcpServers: [{ name: 'anyray', status: 'connected' }], tools: ['mcp__anyray__anyray_retrieve'] }, level: 'gateway', appliedIntegrationLevel: 'gateway' })).map((c) => c.name).join(' ');
  assert.match(session, /mcp anyray/); assert.match(session, /tool mcp__anyray__/);
  const hooksWrong = failedChecks(checkConnectConfig({ ...shape('gateway_hooks_mcp'), integrationLevel: 'gateway_hooks', appliedIntegrationLevel: 'gateway_hooks' })).map((c) => c.name).join(' ');
  for (const piece of ['mcp anyray', 'permission', 'skill']) assert.match(hooksWrong, new RegExp(piece));
  const fullWrong = failedChecks(checkConnectConfig({ ...shape('gateway_hooks'), integrationLevel: 'gateway_hooks_mcp', appliedIntegrationLevel: 'gateway_hooks_mcp' })).map((c) => c.name).join(' ');
  for (const piece of ['mcp anyray', 'permission', 'skill']) assert.match(fullWrong, new RegExp(piece));
});

test('without an explicit id the tool refuses, and never lists keys or reads a secret', async () => {
  const stub = api(), root = testRoot();
  const seen = [];
  const fetchImpl = (url, init) => (seen.push(String(url)), stub.fetchImpl(url, init));
  const level = createBenchLevel({ gatewayUrl: GW, adminKey: ADMIN, clientKey: KEY, fetchImpl, root });
  await assert.rejects(level.set('gateway'), /--agent <id>.*--user <id>/);
  await assert.rejects(level.show(), /--agent <id>/);
  assert.equal(stub.secrets, 0);
  assert.ok(seen.every((u) => !u.includes('/admin/v1/keys')), 'no key listing or secret read');
  assert.equal(stub.puts.length, 0);
});

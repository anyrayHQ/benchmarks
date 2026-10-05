import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, statSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureWithConnect, connectActivity } from '../lib/connectArm.mjs';
import { armConfig } from '../lib/agentRun.mjs';
import { parseArgs, armSetups, withSessionSetups } from '../run_agent.mjs';

const GATEWAY = 'https://gateway.test.invalid';
const KEY = 'ark_svc_test_fake';

/**
 * A stand-in for the anyray-connect binary. It logs how it was called (argv and
 * HOME) and, like the real apply, writes Claude Code config under $HOME.
 * `mode`: 'ok' applies; 'fail' exits 1; 'error-event' reports an NDJSON error.
 */
function fakeConnect(mode = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'fake-connect-'));
  const log = join(dir, 'calls.jsonl');
  const bin = join(dir, 'anyray-connect');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.HOME, argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, home, key: process.env.ANYRAY_CLIENT_KEY }) + '\\n');
const mode = ${JSON.stringify(mode)};
const level = ['gateway', 'gateway_hooks', 'gateway_hooks_mcp'].includes(mode) ? mode : 'gateway_hooks_mcp';
if (mode === 'fail') { process.stderr.write('gateway unreachable (${KEY})'); process.exit(1); }
if (mode === 'error-event') { console.log(JSON.stringify({ event: 'error', message: 'enrollment requires SSO' })); process.exit(3); }
if (argv[0] === 'print-key') { console.log(process.env.ANYRAY_CLIENT_KEY); process.exit(0); }
if (argv[0] === 'status') {
  console.log(JSON.stringify({ connectVersion: '9.9.9', keyKind: 'service', ...(mode !== 'ok' ? { appliedIntegrationLevel: level } : {}), hookPolicies: { greenCollapse: false, rereadStub: false }, clientTools: { readBatch: 'enabled' } }));
  process.exit(0);
}
const gw = argv[argv.indexOf('--gateway') + 1];
fs.mkdirSync(path.join(home, '.anyray'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.anyray', 'connect.json'), JSON.stringify({ gateway: gw, clientKey: process.env.ANYRAY_CLIENT_KEY, fleetHookPolicy: { digest: 'on' }, hookPolicies: { x: 1 } }));
if (level === 'gateway_hooks_mcp') {
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'anyray'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'anyray', 'SKILL.md'), '# anyray');
}
const hook = [{ matcher: '*', hooks: [{ type: 'command', command: '/somewhere/.anyray/bin/anyray-connect __anyray-hook' }] }];
const org = argv.includes('--org'); // the org lane: gateway key as bearer, no provider pin
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: gw,
    ANTHROPIC_CUSTOM_HEADERS: org
      ? 'x-anyray-metadata: {"tool":"claude-code"}'
      : 'x-anyray-provider: anthropic\\nx-anyray-auth-mode: passthrough\\nx-anyray-api-key: ' + process.env.ANYRAY_CLIENT_KEY + '\\nx-anyray-metadata: {"tool":"claude-code"}',
    ...(org ? { ANTHROPIC_AUTH_TOKEN: '' } : {}),
    ENABLE_TOOL_SEARCH: 'auto:20',
  },
  ...(org ? { apiKeyHelper: process.argv[1] + ' print-key' } : {}),
  ...(level !== 'gateway' ? { hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '/somewhere/.anyray/bin/anyray-connect refresh', async: true }] }],
    PostToolUse: hook,
    PostToolUseFailure: hook,
  } } : {}),
  ...(level === 'gateway_hooks_mcp' ? { permissions: { allow: ['mcp__anyray__anyray_retrieve'] } } : {}),
}));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: {
  ...(level === 'gateway_hooks_mcp' ? { anyray: { type: 'stdio', command: '/somewhere/.anyray/bin/anyray-connect', args: ['__anyray-mcp-server', 'claude'] } } : {}),
  'anyray-connectors': { type: 'http', url: gw + '/mcp/org', headers: { 'x-anyray-api-key': process.env.ANYRAY_CLIENT_KEY } },
} }));
console.log(JSON.stringify({ event: 'applied', keyKind: 'service', connected: ['claude-code'], failed: [] }));
`
  );
  chmodSync(bin, 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, calls };
}

/** armConfig deps: this machine's install is never read; connect is the given one. */
const HOOKS = { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/anyray-connect __anyray-hook' }] }] };
const deps = ({ configureArm, serviceKey = KEY } = {}) => ({
  connect: () => ({ gateway: 'https://elsewhere.example', clientKey: 'ark_machine' }),
  clientKey: () => serviceKey || 'ark_machine',
  anyrayHooks: () => structuredClone(HOOKS),
  binExists: () => true,
  bin: '/bin/anyray-connect',
  serviceKey: () => serviceKey,
  ...(configureArm ? { configureArm } : {}),
});
const cfg = () => mkdtempSync(join(tmpdir(), 'cfg-'));

const armHome = () => {
  const home = join(mkdtempSync(join(tmpdir(), 'arm-')), 'home');
  mkdirSync(home, { recursive: true });
  return home;
};

test('connect runs with HOME = the arm home and targets the given gateway', () => {
  const { bin, calls } = fakeConnect();
  const home = armHome();
  const realHome = mkdtempSync(join(tmpdir(), 'real-home-'));
  const r = configureWithConnect({ home, gatewayUrl: GATEWAY, clientKey: KEY, bin, realHome });
  assert.equal(r.configured, true);
  const apply = calls().find((c) => c.argv[0] !== 'status');
  assert.equal(apply.home, home);
  assert.equal(apply.argv[apply.argv.indexOf('--gateway') + 1], GATEWAY);
  assert.ok(apply.argv.includes('--yes') && apply.argv.includes('--json'));
  assert.deepEqual(apply.argv.slice(apply.argv.indexOf('--tools'), apply.argv.indexOf('--tools') + 2), ['--tools', 'claude-code']);
  assert.equal(apply.key, KEY);
  for (const c of calls()) assert.notEqual(c.home, realHome);
});

test('connect is never run against the real HOME (or a parent of it)', () => {
  const { bin, calls } = fakeConnect();
  const realHome = join(mkdtempSync(join(tmpdir(), 'real-')), 'me');
  mkdirSync(realHome, { recursive: true });
  for (const home of [realHome, `${realHome}/`, join(realHome, '..'), join(realHome, 'x', '..')]) {
    assert.throws(() => configureWithConnect({ home, gatewayUrl: GATEWAY, clientKey: KEY, bin, realHome }), /real HOME/);
  }
  assert.equal(calls().length, 0);
});

test('captures what connect wrote (env names, hooks, hook policy, skills, MCP) with secrets redacted', () => {
  const { bin } = fakeConnect();
  const home = armHome();
  const r = configureWithConnect({ home, gatewayUrl: GATEWAY, clientKey: KEY, bin, realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
  assert.deepEqual(r.setup.env, {
    ANTHROPIC_BASE_URL: GATEWAY,
    ANTHROPIC_CUSTOM_HEADERS: '<redacted>',
    ENABLE_TOOL_SEARCH: 'auto:20',
  });
  assert.deepEqual(r.setup.headers, ['x-anyray-provider', 'x-anyray-auth-mode', 'x-anyray-api-key', 'x-anyray-metadata']);
  assert.deepEqual(r.setup.hooks, { SessionStart: ['anyray-connect refresh'], PostToolUse: ['anyray-connect __anyray-hook'], PostToolUseFailure: ['anyray-connect __anyray-hook'] });
  assert.deepEqual(r.setup.hookPolicy, { greenCollapse: false, rereadStub: false });
  assert.deepEqual(r.setup.skills, ['anyray']);
  assert.deepEqual(Object.keys(r.setup.mcpServers), ['anyray', 'anyray-connectors']);
  assert.equal(r.setup.connectVersion, '9.9.9');
  assert.equal(r.setup.keyKind, 'service');
  assert.ok(!JSON.stringify(r.setup).includes(KEY), 'the client key never reaches the recorded setup');
  // The live config (for the session itself) keeps the real values.
  assert.match(r.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-api-key: ark_svc_test/);
  assert.equal(r.mcpServers.anyray.args[0], '__anyray-mcp-server');
});

test('reports why connect could not configure the arm, without leaking the key', () => {
  const realHome = mkdtempSync(join(tmpdir(), 'rh-'));
  const run = (bin, clientKey = KEY) => configureWithConnect({ home: armHome(), gatewayUrl: GATEWAY, clientKey, bin, realHome });

  const failed = run(fakeConnect('fail').bin);
  assert.equal(failed.configured, false);
  assert.match(failed.reason, /exited 1.*gateway unreachable/);
  assert.ok(!failed.reason.includes(KEY));

  const refused = run(fakeConnect('error-event').bin);
  assert.equal(refused.configured, false);
  assert.match(refused.reason, /enrollment requires SSO/);

  assert.match(run('/nonexistent/anyray-connect').reason, /not found/);

  const noKey = fakeConnect();
  assert.match(run(noKey.bin, '').reason, /ANYRAY_CLIENT_KEY/);
  assert.equal(noKey.calls().length, 0, 'no key: connect is not run (it would prompt for SSO)');
});

test('the direct arm is untouched: no connect, no settings, no MCP, real HOME', () => {
  let called = false;
  const a = armConfig({ arm: 'direct', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, deps: deps({ configureArm: () => (called = true) }) });
  assert.equal(called, false);
  assert.deepEqual(a.settings, { env: {} });
  assert.deepEqual(a.mcp, { mcpServers: {} });
  assert.equal(a.home, null);
  assert.equal(a.settingSources, '');
  assert.equal(a.setup, null);
});

test('the anyray arm is configured by connect in its own HOME, tagged with the run metadata', () => {
  const { bin, calls } = fakeConnect();
  const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const runTag = { sessionId: 's1', tool: 'anyray-bench' };
  const realHome = mkdtempSync(join(tmpdir(), 'rh-'));
  const configureArm = (o) => configureWithConnect({ ...o, bin, realHome });
  const a = armConfig({ arm: 'anyray', cfgDir, gatewayUrl: GATEWAY, runTag, deps: deps({ configureArm }) });
  assert.equal(a.home, join(cfgDir, 'home'));
  assert.equal(calls()[0].home, a.home);
  assert.equal(a.settingSources, 'user', "Claude Code reads connect's user settings: hooks, skills");
  assert.equal(a.settings.env.ENABLE_TOOL_SEARCH, 'auto:20');
  assert.equal(a.settings.hooks, undefined, 'hooks come from the user settings, not duplicated in --settings');
  assert.match(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-api-key: ark_svc_test/);
  assert.match(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-metadata: \{"sessionId":"s1","tool":"anyray-bench"\}$/);
  assert.ok(!a.settings.env.ANTHROPIC_CUSTOM_HEADERS.includes('"tool":"claude-code"'));
  assert.deepEqual(Object.keys(a.mcp.mcpServers), ['anyray', 'anyray-connectors']);
  assert.equal(a.setup.configuredBy, 'anyray-connect');
  assert.deepEqual(a.setup.skills, ['anyray']);
  assert.ok(!JSON.stringify(a.setup).includes(KEY));
});

test("when connect can't configure the arm, it falls back to the harness config and records why", () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const runTag = { sessionId: 's2' };
  const configureArm = () => ({ configured: false, reason: 'anyray-connect exited 3: enrollment requires SSO' });
  const a = armConfig({ arm: 'anyray', cfgDir, gatewayUrl: GATEWAY, runTag, deps: deps({ configureArm }) });
  assert.equal(a.settings.env.ANTHROPIC_BASE_URL, GATEWAY);
  assert.match(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-api-key: ark_svc_test/);
  assert.match(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-metadata: \{"sessionId":"s2"\}/);
  assert.equal(a.settingSources, '');
  assert.equal(a.home, null);
  assert.equal(a.setup.configuredBy, 'harness (fallback)');
  assert.equal(a.setup.fallbackReason, 'anyray-connect exited 3: enrollment requires SSO');
});

test("after the session, reads what connect's hooks left in the arm HOME: cached fleet policy, refresh, tee files", () => {
  const home = armHome();
  mkdirSync(join(home, '.anyray', 'hook-tee'), { recursive: true });
  writeFileSync(join(home, '.anyray', 'connect.json'), JSON.stringify({ clientKey: KEY, fleetHookPolicy: { digest: true, readTrim: false } }));
  writeFileSync(join(home, '.anyray', 'refresh-state.json'), '{}');
  writeFileSync(join(home, '.anyray', 'hook-tee', 'a.txt'), 'x');
  writeFileSync(join(home, '.anyray', 'hook-tee', 'b.txt'), 'y');
  assert.deepEqual(connectActivity(home), {
    fleetHookPolicy: { digest: true, readTrim: false },
    refreshed: true,
    hookTeeFiles: 2,
    anyrayFiles: ['connect.json', 'hook-tee', 'refresh-state.json'],
    hookLogRead: null,
  });
  assert.deepEqual(connectActivity(armHome()), { fleetHookPolicy: null, refreshed: false, hookTeeFiles: 0, anyrayFiles: [], hookLogRead: null });
});

test("keeps the test-log Read lane's counts (never its records) from the arm HOME before it goes", () => {
  // Two real sessions left a recorded log unshortened while a replay shortened
  // it; the counts said why, and they were deleted with the arm HOME.
  const home = armHome();
  mkdirSync(join(home, '.anyray'), { recursive: true });
  const counts = { recorded: 2, emits: 1, rangedRereads: 0, fullRereads: 0, declined: { 'log-read-ranged': 3 } };
  const record = { key: 'a'.repeat(64), size: 87730, mtimeMs: 1, runner: 'go', at: 1, emitted: true, pages: [], omitted: [] };
  writeFileSync(join(home, '.anyray', 'hook-log-reads.json'), JSON.stringify({ v: 1, counts, records: [record, { ...record, key: 'b'.repeat(64) }] }));
  const activity = connectActivity(home);
  assert.deepEqual(activity.hookLogRead, { ...counts, records: 2 });
  assert.ok(!JSON.stringify(activity).includes('a'.repeat(64)), 'no record key leaves the HOME');
  writeFileSync(join(home, '.anyray', 'hook-log-reads.json'), 'not json');
  assert.equal(connectActivity(home).hookLogRead, null);
});

// ---- the connect-configured arm combined with --read-trim, --arm-env and the HOME guard ----

const connectedArm = (extra = {}) => {
  const { bin } = fakeConnect();
  const realHome = mkdtempSync(join(tmpdir(), 'rh-'));
  const cfgDir = cfg();
  const configureArm = (o) => configureWithConnect({ ...o, bin, realHome });
  return armConfig({ arm: 'anyray', cfgDir, gatewayUrl: GATEWAY, runTag: { sessionId: 's3' }, deps: deps({ configureArm }), ...extra });
};

test('--read-trim on the connect-configured arm sets readTrim in the profile connect wrote to the arm HOME', () => {
  const a = connectedArm({ readTrim: true });
  assert.equal(a.trimHome.home, a.home, 'read trim is set where the session runs, not in a second HOME');
  assert.equal(a.settingSources, 'user');
  const profile = JSON.parse(readFileSync(join(a.home, '.anyray', 'connect.json'), 'utf8'));
  assert.deepEqual(profile.fleetHookPolicy, { digest: 'on', readTrim: 'on' });
  assert.equal(profile.hookPolicies, undefined);
  assert.equal(statSync(join(a.home, '.anyray', 'connect.json')).mode & 0o777, 0o600);
  assert.deepEqual(a.trimHome.posture, { digest: 'on', readTrim: 'on' });
  assert.equal(a.persistSession, true, 'the hook reads the transcript');
  assert.deepEqual(a.procEnv, { ANYRAY_REFRESH_DISABLE: 'true' }, 'no policy sync rewrites the profile mid-session');
  assert.equal(a.settings.hooks, undefined, "connect's own hooks run, from the user settings");
  assert.deepEqual(Object.keys(a.mcp.mcpServers), ['anyray', 'anyray-connectors']);
  assert.match(a.setup.readTrim, /^on for this session only: .*profile anyray-connect wrote/);
});

test('without --read-trim the connect-configured arm leaves connect\'s profile alone', () => {
  const a = connectedArm();
  assert.equal(a.trimHome, null);
  assert.equal(a.persistSession, false);
  assert.deepEqual(a.procEnv, {});
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, '.anyray', 'connect.json'), 'utf8')).fleetHookPolicy, { digest: 'on' });
});

test('--read-trim when connect falls back: the harness read-trim HOME, hooks pointed at it, fallback reason recorded', () => {
  const cfgDir = cfg();
  const configureArm = () => ({ configured: false, reason: 'no ANYRAY_CLIENT_KEY' });
  const a = armConfig({ arm: 'anyray', cfgDir, gatewayUrl: GATEWAY, runTag: {}, readTrim: true, deps: deps({ configureArm }) });
  assert.equal(a.home, null);
  assert.equal(a.settingSources, '');
  assert.ok(a.trimHome.home.startsWith(cfgDir));
  assert.ok(a.settings.hooks.PostToolUse[0].hooks[0].command.startsWith(`HOME='${a.trimHome.home}' ANYRAY_REFRESH_DISABLE='true'`));
  assert.equal(a.setup.fallbackReason, 'no ANYRAY_CLIENT_KEY');
});

test('--read-trim fails loudly if connect configured the arm but wrote no profile', () => {
  const configureArm = () => ({ configured: true, settings: { env: {} }, mcpServers: {}, setup: {} });
  assert.throws(() => armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, readTrim: true, deps: deps({ configureArm }) }), /wrote no profile/);
});

test('--hook-posture on the connect-configured arm pins the switch in the profile connect wrote, as --read-trim does', () => {
  const a = connectedArm({ hookPosture: { logRead: 'on' } });
  assert.equal(a.trimHome.home, a.home, 'pinned where the session runs, not in a second HOME');
  const profile = JSON.parse(readFileSync(join(a.home, '.anyray', 'connect.json'), 'utf8'));
  assert.deepEqual(profile.fleetHookPolicy, { digest: 'on', logRead: 'on' });
  assert.equal(profile.hookPolicies, undefined);
  assert.equal(statSync(join(a.home, '.anyray', 'connect.json')).mode & 0o777, 0o600);
  assert.deepEqual(a.trimHome.pinned, { logRead: 'on' });
  assert.equal(a.persistSession, true, 'a switch is on, so the hook may read the transcript');
  assert.deepEqual(a.procEnv, { ANYRAY_REFRESH_DISABLE: 'true' }, 'no policy sync rewrites the profile mid-session');
  assert.deepEqual(a.setup.hookPosture.pinned, { logRead: 'on' });
  assert.match(a.setup.hookPosture.how, /^for this session only: .*logRead on.*profile anyray-connect wrote/);
  assert.match(a.setup.readTrim, /^fleet policy/);
});

test('--hook-posture pinned only off on the connect-configured arm: key refresh off, no transcript', () => {
  const a = connectedArm({ hookPosture: { logRead: 'off' } });
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, '.anyray', 'connect.json'), 'utf8')).fleetHookPolicy, { digest: 'on', logRead: 'off' });
  assert.equal(a.persistSession, false);
  assert.deepEqual(a.procEnv, { ANYRAY_REFRESH_DISABLE: 'true' });
});

test('--hook-posture fails loudly if connect configured the arm but wrote no profile', () => {
  const configureArm = () => ({ configured: true, settings: { env: {} }, mcpServers: {}, setup: {} });
  assert.throws(() => armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, hookPosture: { logRead: 'on' }, deps: deps({ configureArm }) }), /--hook-posture logRead=on: anyray-connect wrote no profile/);
});

test('--arm-env on the connect-configured arm overrides connect\'s env in --settings only; the run tag survives', () => {
  const a = connectedArm({ env: { ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } });
  assert.equal(a.settings.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(a.settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.match(a.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-metadata: \{"sessionId":"s3"\}$/);
  const onDisk = JSON.parse(readFileSync(join(a.home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(onDisk.env.ENABLE_TOOL_SEARCH, 'auto:20', "connect's settings file is what connect wrote");
  assert.throws(() => connectedArm({ env: { HOME: '/x' } }), /--arm-env cannot set HOME/);
});

test('the recorded setup keeps --arm-env beside what connect configured, never the key', () => {
  const a = connectedArm({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } });
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--arm-env', 'b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000']);
  const planned = armSetups(args, { a: 'direct', b: 'anyray' }, { model: 'm', gatewayUrl: GATEWAY }, { maxTurns: 3 }, { enrolled: false });
  const s = withSessionSetups(planned, { a: { setup: null }, b: { setup: a.setup } });
  assert.deepEqual(s.b.env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' });
  assert.equal(s.b.connectEnv.ENABLE_TOOL_SEARCH, 'auto:20');
  assert.equal(s.b.configuredBy, 'anyray-connect');
  assert.deepEqual(s.a, planned.a);
  assert.ok(!JSON.stringify(s).includes(KEY));
});

test('a HOME redirected out of the session dir is refused before connect runs', () => {
  const cfgDir = cfg();
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  symlinkSync(outside, join(cfgDir, 'home'), 'dir');
  let called = false;
  const configureArm = () => { called = true; return { configured: false, reason: 'x' }; };
  for (const readTrim of [false, true]) {
    assert.throws(() => armConfig({ arm: 'anyray', cfgDir, gatewayUrl: GATEWAY, runTag: {}, readTrim, deps: deps({ configureArm }) }), /session directory/);
  }
  assert.equal(called, false);
  assert.deepEqual(readdirSync(outside), []);
});

test('lane org: connect is run with --org, and the key helper it installs must print a gateway key', () => {
  const { bin, calls } = fakeConnect();
  const r = configureWithConnect({ home: armHome(), gatewayUrl: GATEWAY, clientKey: KEY, lane: 'org', bin, realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
  assert.ok(calls()[0].argv.includes('--org') && !calls()[0].argv.includes('--subscription'));
  assert.equal(r.setup.lane, 'org');
  assert.equal(r.settings.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.deepEqual(r.checks.filter((c) => c.required && !c.ok), []);
  assert.match(r.checks.find((c) => c.name.startsWith('auth:')).detail, /apiKeyHelper prints a gateway key/);
  assert.ok(!JSON.stringify([r.setup, r.checks]).includes(KEY));
  // The default lane is unchanged: the subscription pass-through.
  const sub = configureWithConnect({ home: armHome(), gatewayUrl: GATEWAY, clientKey: KEY, bin, realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
  assert.ok(calls().at(-2).argv.includes('--subscription'));
  assert.deepEqual(sub.checks.filter((c) => c.required && !c.ok), []);
});

test('fake Connect applies every requested level and reports it in status', () => {
  for (const level of ['gateway', 'gateway_hooks', 'gateway_hooks_mcp']) {
    const { bin } = fakeConnect(level);
    const result = configureWithConnect({ home: armHome(), gatewayUrl: GATEWAY, clientKey: KEY, lane: 'org', bin, integrationLevel: level, realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
    assert.equal(result.configured, true, result.reason);
    assert.equal(result.setup.appliedIntegrationLevel, level);
    assert.equal(result.setup.connectBinary, 'anyray-connect');
    assert.deepEqual(result.checks.filter((check) => check.required && !check.ok), []);
    assert.equal(Boolean(result.mcpServers.anyray), level === 'gateway_hooks_mcp');
    assert.equal(Boolean(result.settings.hooks?.PostToolUse), level !== 'gateway');
  }
  const old = fakeConnect('ok');
  const result = configureWithConnect({ home: armHome(), gatewayUrl: GATEWAY, clientKey: KEY, bin: old.bin, integrationLevel: 'gateway_hooks_mcp', realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
  assert.match(result.checks.find((check) => !check.ok).name, /applied integration level/);
});

test('a requested level never falls back to harness wiring when Connect fails', () => {
  assert.throws(() => armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, integrationLevel: 'gateway', deps: deps({ configureArm: () => ({ configured: false, reason: 'old binary' }) }) }), /--integration-level needs a Connect binary/);
  assert.throws(() => armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, integrationLevel: 'gateway', deps: deps({ configureArm: () => ({ configured: true, settings: { env: {} }, mcpServers: {}, setup: {} }) }) }), /did not report the requested integration level/);
});

test('ANYRAY_CONNECT_BIN is the binary used by enrollment and fallback MCP wiring', () => {
  const { bin } = fakeConnect();
  // The fallback wiring reads this machine's Connect profile: give the child its own
  // HOME with one, so the test does not depend on the machine it runs on.
  const home = mkdtempSync(join(tmpdir(), 'bin-home-'));
  mkdirSync(join(home, '.anyray'), { recursive: true });
  writeFileSync(join(home, '.anyray', 'connect.json'), JSON.stringify({ gateway: 'https://elsewhere.test.invalid', clientKey: KEY }));
  const code = `import { ANYRAY_BIN } from './lib/connectArm.mjs'; import { armConfig } from './lib/agentRun.mjs';
    const arm = armConfig({ arm: 'anyray', gatewayUrl: '${GATEWAY}', runTag: {}, cfgDir: process.env.TEST_CFG_DIR });
    console.log(JSON.stringify({ binary: ANYRAY_BIN, mcp: arm.mcp.mcpServers.anyray?.command }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, HOME: home, ANYRAY_CONNECT_BIN: bin, ANYRAY_CLIENT_KEY: '', ANYRAY_BENCH_CLIENT_KEY: '', TEST_CFG_DIR: cfg() }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { binary: bin, mcp: bin });
});

test('a lower-level session leaves refresh enabled unless an existing option disables it', () => {
  const { bin } = fakeConnect('gateway_hooks');
  const configureArm = (options) => configureWithConnect({ ...options, bin, realHome: mkdtempSync(join(tmpdir(), 'rh-')) });
  const ordinary = armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, integrationLevel: 'gateway_hooks', deps: deps({ configureArm }) });
  assert.deepEqual(ordinary.procEnv, {});
  assert.equal(ordinary.mcp.mcpServers.anyray, undefined);
  const unset = armConfig({ arm: 'anyray', cfgDir: cfg(), gatewayUrl: GATEWAY, runTag: {}, integrationLevel: 'gateway_hooks', env: { ENABLE_TOOL_SEARCH: '-' }, deps: deps({ configureArm }) });
  assert.deepEqual(unset.procEnv, { ANYRAY_REFRESH_DISABLE: 'true' });
});

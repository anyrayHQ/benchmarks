// A pinned anyray-connect build (ANYRAY_CONNECT_BIN, --connect-bin-b) must be what the
// Anyray arm's hooks and MCP server run. On a machine with the Connect desktop app, connect
// hands the configure to the app and links the arm's launcher to the app's binary; the
// harness seeds a no-app profile, and a check follows every command to the file it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkConnectBinary, commandExecutable, failedChecks } from '../lib/connectChecks.mjs';
import { configureWithConnect, checkArmBinary } from '../lib/connectArm.mjs';
import { armConfig, armSeeds, NO_APP_PROFILE } from '../lib/agentRun.mjs';
import { armsFor, parseArgs, parseSeedHome, slotOptions } from '../run_agent.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = 'ark_svc_test_fake';
const PROFILE = '.anyray/connect.json';
const sha16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/** An executable file with the given body, at <dir>/<rel>. */
function exe(dir, rel, body) {
  const f = join(dir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
  chmodSync(f, 0o755);
  return f;
}

/** A synthetic arm HOME whose <HOME>/.anyray/bin/anyray-connect is `launcher(home)` (a symlink target, or a copy). */
function armHome({ target = null, copyOf = null } = {}) {
  const home = join(tmp('arm-'), 'home');
  mkdirSync(join(home, '.anyray', 'bin'), { recursive: true });
  const launcher = join(home, '.anyray', 'bin', 'anyray-connect');
  if (target) symlinkSync(target, launcher);
  if (copyOf) copyFileSync(copyOf, launcher);
  return { home, launcher };
}

/** What connect writes for Claude Code, every command naming `cmd`. */
const written = (cmd) => ({
  settings: {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `${cmd} __anyray-hook-lifecycle` }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${cmd} __anyray-hook` }, { type: 'command', command: 'echo unrelated' }] }],
    },
    apiKeyHelper: `${cmd} print-key`,
  },
  mcpServers: { anyray: { type: 'stdio', command: cmd, args: ['__anyray-mcp-server', 'claude'] }, 'anyray-connectors': { type: 'http', url: `${GW}/mcp/org` } },
});

test('commandExecutable: the first word of a hook command, quoted or after VAR=value prefixes', () => {
  assert.equal(commandExecutable('/h/.anyray/bin/anyray-connect __anyray-hook'), '/h/.anyray/bin/anyray-connect');
  assert.equal(commandExecutable('"/a b/anyray-connect" print-key'), '/a b/anyray-connect');
  assert.equal(commandExecutable("A=1 B='x' '/a/anyray-connect' refresh"), '/a/anyray-connect');
  assert.equal(commandExecutable(''), null);
});

test('a launcher linked to the requested build passes; linked to an installed app\'s binary it fails, naming no absolute path', () => {
  const builds = tmp('builds-');
  const pinned = exe(builds, 'pr/anyray-connect', 'pinned build');
  const app = exe(builds, 'Applications/Anyray Connect.app/Contents/MacOS/anyray-connect', 'app build');

  const good = armHome({ target: pinned });
  const ok = checkConnectBinary({ ...written(good.launcher), bin: pinned, home: good.home });
  assert.deepEqual(ok.map((c) => [c.name, c.ok, c.required]), [
    ['hooks run the requested anyray-connect build', true, true],
    ['MCP servers run the requested anyray-connect build', true, true],
    ['apiKeyHelper runs the requested anyray-connect build', true, true],
  ]);
  assert.match(ok[0].detail, new RegExp(`2 command\\(s\\), sha256 ${sha16('pinned build')}`), 'the unrelated hook is not connect\'s');

  const bad = armHome({ target: app });
  const checks = checkConnectBinary({ ...written(bad.launcher), bin: pinned, home: bad.home });
  assert.equal(failedChecks(checks).length, 3);
  assert.match(checks[0].detail, new RegExp(`^SessionStart, PostToolUse: runs sha256 ${sha16('app build')} \\(inside Anyray Connect\\.app\\), not the requested ${sha16('pinned build')}$`));
  assert.match(checks[1].detail, /^mcp anyray: runs sha256/);
  for (const c of checks) assert.ok(!c.detail.includes(builds) && !c.detail.includes(bad.home), `no absolute path in "${c.detail}"`);
  // Reported only, when the run did not pin the build.
  assert.deepEqual(failedChecks(checkConnectBinary({ ...written(bad.launcher), bin: pinned, home: bad.home, required: false })), []);
});

test('a launcher that is a copy of the requested build passes; a dangling one, a missing build or a bare name off PATH fail', () => {
  const builds = tmp('builds-');
  const pinned = exe(builds, 'pr/anyray-connect', 'pinned build');
  const copy = armHome({ copyOf: pinned });
  assert.deepEqual(failedChecks(checkConnectBinary({ ...written(copy.launcher), bin: pinned, home: copy.home })), []);

  const dangling = armHome({ target: join(builds, 'gone', 'anyray-connect') });
  assert.match(checkConnectBinary({ ...written(dangling.launcher), bin: pinned, home: dangling.home })[0].detail, /^SessionStart, PostToolUse: resolves to no file$/);

  const good = armHome({ target: pinned });
  assert.match(checkConnectBinary({ ...written(good.launcher), bin: join(builds, 'missing'), home: good.home })[0].detail, /the requested build does not exist/);

  // A bare name resolves through the session's PATH, a `~/` path through the arm HOME.
  const path = dirname(pinned);
  assert.deepEqual(failedChecks(checkConnectBinary({ ...written('anyray-connect'), bin: pinned, home: good.home, path })), []);
  assert.equal(failedChecks(checkConnectBinary({ ...written('anyray-connect'), bin: pinned, home: good.home, path: join(builds, 'none') })).length, 3);
  assert.deepEqual(failedChecks(checkConnectBinary({ ...written('~/.anyray/bin/anyray-connect'), bin: pinned, home: good.home })), []);
  // Nothing of connect's configured (a lower integration level): nothing to check.
  assert.deepEqual(checkConnectBinary({ settings: { hooks: {} }, mcpServers: {}, bin: pinned, home: good.home }), []);
});

test('armSeeds: a pinned build adds the no-app profile unless --seed-home already places that file', () => {
  const user = [{ path: '.anyray/hook-tee-ledger.json', file: '/x', sha256: 'u' }];
  assert.deepEqual(armSeeds(user, false), user);
  const seeds = armSeeds(user, true);
  assert.equal(seeds.length, 2);
  assert.deepEqual(JSON.parse(seeds[1].content), { trayAppPath: '/nonexistent/Anyray Connect.app' });
  assert.equal(seeds[1].path, PROFILE);
  assert.equal(seeds[1].sha256, sha16(NO_APP_PROFILE.content));
  const own = [{ path: PROFILE, file: '/mine', sha256: 'm' }];
  assert.deepEqual(armSeeds(own, true), own, 'the user\'s own profile seed wins');
});

// ---- end to end through armConfig, with a fake connect that behaves like the real one ----

/**
 * A stand-in anyray-connect: like the real one, it links the arm's launcher to the
 * installed Connect app's binary when the profile's trayAppPath (default: `app`) exists,
 * else to itself, and writes every hook and MCP command through that launcher.
 */
function fakeConnect(app) {
  const dir = tmp('fake-connect-');
  const bin = exe(dir, 'anyray-connect', `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.HOME, argv = process.argv.slice(2);
if (argv[0] === 'status') { console.log(JSON.stringify({ connectVersion: '9.9.9', keyKind: 'service' })); process.exit(0); }
const gw = argv[argv.indexOf('--gateway') + 1];
const profileFile = path.join(home, '.anyray', 'connect.json');
let profile = {};
try { profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch {}
fs.appendFileSync(${JSON.stringify(join(dir, 'seen.jsonl'))}, JSON.stringify(profile) + '\\n');
const appBin = path.join(profile.trayAppPath ?? ${JSON.stringify(app)}, 'Contents', 'MacOS', 'anyray-connect');
const launcher = path.join(home, '.anyray', 'bin', 'anyray-connect');
fs.mkdirSync(path.dirname(launcher), { recursive: true });
fs.rmSync(launcher, { force: true });
fs.symlinkSync(fs.existsSync(appBin) ? appBin : process.argv[1], launcher);
fs.writeFileSync(profileFile, JSON.stringify({ ...profile, gateway: gw, clientKey: process.env.ANYRAY_CLIENT_KEY }));
fs.mkdirSync(path.join(home, '.claude', 'skills', 'anyray'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'skills', 'anyray', 'SKILL.md'), '# anyray');
const hook = [{ matcher: '*', hooks: [{ type: 'command', command: launcher + ' __anyray-hook' }] }];
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
  env: { ANTHROPIC_BASE_URL: gw, ANTHROPIC_CUSTOM_HEADERS: 'x-anyray-provider: anthropic\\nx-anyray-auth-mode: passthrough\\nx-anyray-api-key: ' + process.env.ANYRAY_CLIENT_KEY + '\\nx-anyray-metadata: {"tool":"claude-code"}' },
  hooks: { PostToolUse: hook, PostToolUseFailure: hook },
  permissions: { allow: ['mcp__anyray__anyray_retrieve'] },
}));
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { anyray: { type: 'stdio', command: launcher, args: ['__anyray-mcp-server', 'claude'] } } }));
console.log(JSON.stringify({ event: 'applied', connected: ['claude-code'], failed: [] }));
`);
  const seen = () => readFileSync(join(dir, 'seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { bin, seen };
}

/** A machine with the Connect app installed at a (synthetic) default location. */
const withApp = () => {
  const app = join(tmp('apps-'), 'Anyray Connect.app');
  exe(app, 'Contents/MacOS/anyray-connect', 'the app build');
  return app;
};

const deps = (bin, { binPinned = false } = {}) => ({
  binExists: () => true,
  bin,
  binPinned,
  serviceKey: () => KEY,
  clientKey: () => KEY,
  realClaudeJson: () => ({}),
  configureArm: (o) => configureWithConnect({ ...o, bin: o.bin ?? bin, realHome: tmp('real-home-') }),
});
const anyrayArm = (bin, opts = {}, depOpts = {}) => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: tmp('build-cfg-'), ...opts, deps: deps(bin, depOpts) });

test('ANYRAY_CONNECT_BIN on a machine with the app: the no-app profile is seeded first, so the arm runs the pinned build', () => {
  const app = withApp();
  const connect = fakeConnect(app);
  const arm = anyrayArm(connect.bin, {}, { binPinned: true });
  assert.deepEqual(connect.seen()[0], { trayAppPath: '/nonexistent/Anyray Connect.app' }, 'in place before connect ran');
  assert.equal(arm.setup.connectBinPinned, true);
  assert.deepEqual(arm.setup.seedHome, [{ path: PROFILE, sha256: sha16(NO_APP_PROFILE.content), by: 'harness: no-app profile for a pinned anyray-connect build' }]);
  const build = arm.setup.connectChecks.filter((c) => /requested anyray-connect build/.test(c.name));
  assert.deepEqual(build.map((c) => [c.ok, c.required]), [[true, true], [true, true]]);
  assert.equal(arm.connectBuild, connect.bin, 're-checked after the session');
  assert.ok(!JSON.stringify(arm.setup).includes(connect.bin), 'the build\'s path is never recorded');
});

test('a pinned build the app takes over fails the arm setup, though every command is still named anyray-connect', () => {
  const app = withApp();
  const connect = fakeConnect(app);
  const appProfile = join(tmp('seed-'), 'connect.json');
  writeFileSync(appProfile, JSON.stringify({ trayAppPath: app }));
  // The user's own profile seed replaces the harness's: here one that keeps the app.
  assert.throws(
    () => anyrayArm(connect.bin, { seedHome: [parseSeedHome(`${PROFILE}=${appProfile}`)] }, { binPinned: true }),
    (e) => /left the arm misconfigured: hooks run the requested anyray-connect build \(PostToolUse, PostToolUseFailure: runs sha256 \w+ \(inside Anyray Connect\.app\)/.test(e.message) && /MCP servers run the requested/.test(e.message)
  );
  assert.deepEqual(connect.seen()[0], { trayAppPath: app });
});

test('without a pinned build nothing is seeded and the build check is reported only', () => {
  const app = withApp();
  const connect = fakeConnect(app);
  const arm = anyrayArm(connect.bin);
  assert.deepEqual(connect.seen()[0], {}, 'connect starts from an empty HOME, as before');
  assert.equal('seedHome' in arm.setup, false);
  assert.equal('connectBinPinned' in arm.setup, false);
  assert.equal(arm.connectBuild, null);
  const build = arm.setup.connectChecks.filter((c) => /requested anyray-connect build/.test(c.name));
  assert.deepEqual(build.map((c) => [c.ok, c.required]), [[false, false], [false, false]], 'the app runs, which this run did not pin');
});

test('--connect-bin-b pins the build on both Anyray arms: B its own, A ANYRAY_CONNECT_BIN', () => {
  const args = { ...parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask', '--connect-bin-b', '/opt/pr/anyray-connect']), extraHeaders: [] };
  const arms = armsFor('gateway');
  assert.deepEqual([slotOptions(args, arms, 'a').connectBinPinned, slotOptions(args, arms, 'b').connectBinPinned], [true, true]);
  assert.equal('connectBin' in slotOptions(args, arms, 'a'), false, 'A keeps the default build');
  const plain = { ...parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask']), extraHeaders: [] };
  assert.equal('connectBinPinned' in slotOptions(plain, arms, 'b'), false);

  const app = withApp();
  const [a, b] = [fakeConnect(app), fakeConnect(app)];
  const armA = anyrayArm(a.bin, { connectBinPinned: true });
  const armB = anyrayArm(a.bin, { connectBin: b.bin });
  assert.deepEqual([a.seen()[0], b.seen()[0]], [JSON.parse(NO_APP_PROFILE.content), JSON.parse(NO_APP_PROFILE.content)], 'both arms start from the same profile');
  assert.equal(armA.connectBuild, a.bin);
  assert.equal(armB.connectBuild, b.bin);
});

test('connect could not configure a pinned arm: the harness seed is removed and the fallback runs as before', () => {
  let home;
  const arm = armConfig({
    arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: tmp('build-cfg-'),
    deps: { ...deps('/nonexistent/anyray-connect', { binPinned: true }), connect: () => ({ gateway: GW }), anyrayHooks: () => ({}), configureArm: (o) => ((home = o.home), { configured: false, reason: 'synthetic: no service key' }) },
  });
  assert.equal(arm.setup.configuredBy, 'harness (fallback)');
  assert.equal(existsSync(join(home, PROFILE)), false);
});

test('after the session: a launcher re-pointed at the app fails the session check', () => {
  const builds = tmp('builds-');
  const pinned = exe(builds, 'pr/anyray-connect', 'pinned build');
  const app = exe(builds, 'Anyray Connect.app/Contents/MacOS/anyray-connect', 'app build');
  const { home, launcher } = armHome({ target: pinned });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const w = written(launcher);
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(w.settings));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: w.mcpServers }));
  assert.deepEqual(failedChecks(checkArmBinary({ home, bin: pinned, prefix: 'session: ' })), []);
  rmSync(launcher);
  symlinkSync(app, launcher); // what a refresh handing the HOME to the app would do
  const failed = failedChecks(checkArmBinary({ home, bin: pinned, prefix: 'session: ' }));
  assert.deepEqual(failed.map((c) => c.name), [
    'session: hooks run the requested anyray-connect build',
    'session: MCP servers run the requested anyray-connect build',
    'session: apiKeyHelper runs the requested anyray-connect build',
  ]);
});

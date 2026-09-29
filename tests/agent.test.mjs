import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { countCacheBreaks } from '../lib/cacheBreaks.mjs';
import { armConfig, describeSetup } from '../lib/agentRun.mjs';
import { parseArgs, armSetups, armReadTrim } from '../run_agent.mjs';

// ---- cache-break counter ---------------------------------------------------

const req = (agent, read, write = 0, input = 0) => ({
  agent,
  usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write },
});

test('countCacheBreaks: a steadily growing prefix never breaks', () => {
  const rs = [req('main', 0, 10000, 5), req('main', 10000, 800, 5), req('main', 10800, 1200, 5), req('main', 12000, 400, 5)];
  assert.equal(countCacheBreaks(rs), 0);
});

test('countCacheBreaks: a sudden drop in cache reads is one break', () => {
  const rs = [req('main', 0, 20000), req('main', 20000, 1000), req('main', 3000, 18000), req('main', 21000, 500)];
  assert.equal(countCacheBreaks(rs), 1);
});

test('countCacheBreaks: exactly 90% of the previous input is not a break, just below is', () => {
  assert.equal(countCacheBreaks([req('main', 0, 10000), req('main', 9000, 1500)]), 0);
  assert.equal(countCacheBreaks([req('main', 0, 10000), req('main', 8999, 1500)]), 1);
});

test('countCacheBreaks: tracks each agent separately, so interleaved subagents are not breaks', () => {
  const rs = [
    req('main', 0, 40000),
    req('sub-1', 0, 6000), // first request of a subagent: small, never a break
    req('main', 40000, 2000),
    req('sub-1', 6000, 900),
    req('sub-2', 0, 5000),
    req('main', 42000, 700),
    req('sub-2', 5000, 300),
  ];
  assert.equal(countCacheBreaks(rs), 0);
});

test('countCacheBreaks: the first request of each agent never counts', () => {
  assert.equal(countCacheBreaks([req('main', 0, 50000)]), 0);
  assert.equal(countCacheBreaks([req('main', 0, 50000), req('sub-1', 0, 100), req('sub-2', 0, 100)]), 0);
  assert.equal(countCacheBreaks([]), 0);
});

test('countCacheBreaks: the saltstack-docs round-1 shape (masked 63590, then unmasked 102816 reading 7660) is 1 break', () => {
  const rs = [req('main', 60000, 3590), req('main', 7660, 95156)];
  assert.equal(rs[0].usage.cache_read_input_tokens + rs[0].usage.cache_creation_input_tokens, 63590);
  assert.equal(rs[1].usage.cache_read_input_tokens + rs[1].usage.cache_creation_input_tokens, 102816);
  assert.equal(countCacheBreaks(rs), 1);
});

test('countCacheBreaks: missing usage counts as zero input and does not throw', () => {
  assert.equal(countCacheBreaks([{ agent: 'main' }, req('main', 0, 100)]), 0);
});

// ---- --read-trim: argument parsing ------------------------------------------

test('parseArgs: --read-trim is off by default and on with the flag', () => {
  assert.equal(parseArgs(['--scenario', 's']).readTrim, false);
  assert.equal(parseArgs(['--scenario', 's', '--read-trim']).readTrim, true);
  assert.equal(parseArgs(['--scenario', 's', '--compare', 'anyray', '--read-trim', '--label', 'x']).label, 'x');
});

test('parseArgs: --read-trim needs --compare anyray', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--read-trim']), /--read-trim needs --compare anyray/);
});

// ---- --read-trim: Anyray arm only -----------------------------------------------

test('armReadTrim: only the anyray arm gets it', () => {
  const on = parseArgs(['--scenario', 's', '--read-trim']);
  assert.equal(armReadTrim(on, 'anyray'), true);
  assert.equal(armReadTrim(on, 'direct'), false);
  const off = parseArgs(['--scenario', 's']);
  assert.equal(armReadTrim(off, 'anyray'), false);
});

const PROFILE = { gateway: 'https://enrolled.example', clientKey: 'ark_test', fleetHookPolicy: { digest: 'on' }, hookPolicies: { x: 1 } };
const HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: '/bin/anyray-connect refresh' }] }],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/anyray-connect __anyray-hook' }] }],
  PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/anyray-connect __anyray-hook' }] }],
};
const deps = (enrolledOn) => ({
  connect: () => structuredClone({ ...PROFILE, gateway: enrolledOn }),
  clientKey: () => 'ark_test',
  anyrayHooks: () => structuredClone(HOOKS),
  binExists: () => true,
  bin: '/bin/anyray-connect',
});
const withCfg = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'any712-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const GW = 'https://gw.example';
const TAG = { sessionId: 's1' };

test('armConfig: the direct arm is unchanged by readTrim (no env, hooks, MCP; no persistence)', () => withCfg((dir) => {
  const off = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: TAG, readTrim: false, cfgDir: dir, deps: deps(GW) });
  const on = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, deps: deps(GW) });
  assert.deepEqual(on, off);
  assert.deepEqual(off.settings, { env: {} });
  assert.deepEqual(off.mcp, { mcpServers: {} });
  assert.equal(off.trimHome, null);
  assert.equal(off.persistSession, false);
}));

test('armConfig: the anyray arm without readTrim keeps the fleet hooks and the plain MCP server', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: false, cfgDir: dir, deps: deps(GW) });
  assert.equal(c.trimHome, null);
  assert.equal(c.persistSession, false);
  assert.deepEqual(c.settings.hooks, HOOKS);
  assert.equal(c.mcp.mcpServers.anyray.env, undefined);
  assert.equal(c.settings.env.ANTHROPIC_BASE_URL, GW);
}));

test('armConfig: the anyray arm with readTrim runs its hooks and MCP in a private HOME with readTrim on', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, deps: deps(GW) });
  const home = c.trimHome.home;
  assert.ok(home.startsWith(dir));
  assert.equal(c.persistSession, true); // the hook reads the transcript
  // Only the PostToolUse hooks, each pointed at the private HOME with key refresh off.
  assert.deepEqual(Object.keys(c.settings.hooks).sort(), ['PostToolUse', 'PostToolUseFailure']);
  for (const g of Object.values(c.settings.hooks)) {
    for (const h of g[0].hooks) assert.equal(h.command, `HOME='${home}' ANYRAY_REFRESH_DISABLE='true' /bin/anyray-connect __anyray-hook`);
  }
  assert.deepEqual(c.mcp.mcpServers.anyray.env, { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' });
  // Enrolled on this gateway: the cached posture is kept, readTrim added, hookPolicies dropped.
  const profile = JSON.parse(readFileSync(join(home, '.anyray', 'connect.json'), 'utf8'));
  assert.deepEqual(profile.fleetHookPolicy, { digest: 'on', readTrim: 'on' });
  assert.equal(profile.hookPolicies, undefined);
  assert.equal(statSync(join(home, '.anyray', 'connect.json')).mode & 0o777, 0o600);
  // The hook sends to the arm's gateway and finds the MCP registration it checks for.
  const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.env.ANTHROPIC_BASE_URL, GW);
  assert.ok(s.permissions.allow.includes('mcp__anyray__anyray_retrieve'));
  const cj = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(cj.mcpServers.anyray.args, ['__anyray-mcp-server', 'claude']);
}));

test('armConfig: readTrim on a gateway this machine is not enrolled on turns digest off, so Read trim is the only hook change', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, deps: deps('https://elsewhere.example') });
  const profile = JSON.parse(readFileSync(join(c.trimHome.home, '.anyray', 'connect.json'), 'utf8'));
  assert.deepEqual(profile.fleetHookPolicy, { digest: 'off', readTrim: 'on' });
  assert.deepEqual(c.trimHome.posture, { digest: 'off', readTrim: 'on' });
}));

test('armConfig: readTrim without anyray-connect installed fails loudly', () => withCfg((dir) => {
  assert.throws(
    () => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, deps: { ...deps(GW), binExists: () => false } }),
    /--read-trim needs anyray-connect installed/,
  );
}));

// ---- --read-trim: recorded in the result's setup ----------------------------------

const RUN = { model: 'm', gatewayUrl: GW };
const SCN = { maxTurns: 40 };

test('armSetups: records readTrim on the anyray arm only', () => {
  const s = armSetups(parseArgs(['--scenario', 's', '--read-trim']), { a: 'direct', b: 'anyray' }, RUN, SCN, { enrolled: true });
  assert.equal(s.a.readTrim, null);
  assert.match(s.b.readTrim, /^on for this session only/);
  assert.deepEqual(Object.keys(s.b.hooks).sort(), ['PostToolUse', 'PostToolUseFailure']);
});

test('armSetups: without the flag the anyray arm records the fleet policy', () => {
  const s = armSetups(parseArgs(['--scenario', 's']), { a: 'direct', b: 'anyray' }, RUN, SCN, { enrolled: true });
  assert.equal(s.a.readTrim, null);
  assert.match(s.b.readTrim, /^fleet policy/);
  const off = armSetups(parseArgs(['--scenario', 's']), { a: 'direct', b: 'anyray' }, RUN, SCN, { enrolled: false });
  assert.match(off.b.readTrim, /^off/);
});

test('armSetups: --compare control records no readTrim on either arm', () => {
  const s = armSetups(parseArgs(['--scenario', 's', '--compare', 'control']), { a: 'direct', b: 'direct' }, RUN, SCN, { enrolled: true });
  assert.equal(s.a.readTrim, null);
  assert.equal(s.b.readTrim, null);
  assert.deepEqual(s.a, s.b);
});

test('describeSetup: the direct arm ignores readTrim', () => {
  const a = describeSetup({ arm: 'direct', model: 'm', gatewayUrl: GW, runTag: 't', maxTurns: 1, readTrim: true, enrolled: true });
  const b = describeSetup({ arm: 'direct', model: 'm', gatewayUrl: GW, runTag: 't', maxTurns: 1, readTrim: false, enrolled: true });
  assert.deepEqual(a, b);
});

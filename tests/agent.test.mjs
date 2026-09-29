import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { join } from 'node:path';

import { countCacheBreaks } from '../lib/cacheBreaks.mjs';
import { armConfig, checkCitations, describeSetup } from '../lib/agentRun.mjs';
import { parseArgs, armSetups, armReadTrim, slotOptions } from '../run_agent.mjs';

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

// ---- more coverage (ANY-712 follow-up) ------------------------------------------

test('countCacheBreaks: requests with no agent form their own stream, never compared with main', () => {
  const noAgent = (read, write) => ({ usage: { cache_read_input_tokens: read, cache_creation_input_tokens: write } });
  // A small agent-less request between two main requests is not a drop for main.
  assert.equal(countCacheBreaks([req('main', 0, 40000), noAgent(0, 500), req('main', 40000, 800)]), 0);
  // Two agent-less requests are compared with each other.
  assert.equal(countCacheBreaks([noAgent(0, 20000), noAgent(2000, 18000)]), 1);
});

test('countCacheBreaks: missing usage fields count as zero on both sides of the comparison', () => {
  // Previous sent 10000 as plain input only; the next reads 8000 from cache: below 90%.
  assert.equal(countCacheBreaks([{ agent: 'main', usage: { input_tokens: 10000 } }, { agent: 'main', usage: { cache_read_input_tokens: 8000 } }]), 1);
  // Previous wrote 10000; the next has no cache read at all: a break.
  assert.equal(countCacheBreaks([{ agent: 'main', usage: { cache_creation_input_tokens: 10000 } }, { agent: 'main', usage: {} }]), 1);
});

test('countCacheBreaks: after a break the baseline is the rebuilt request, not the old peak', () => {
  // 20000 sent → break (reads 3000, writes 12000: a shorter 15000 prefix) → reads 14000 of
  // that 15000: fine, even though 14000 is under 90% of the old 20000 peak.
  assert.equal(countCacheBreaks([req('main', 0, 20000), req('main', 3000, 12000), req('main', 14000, 500)]), 1);
});

test('parseArgs: --read-trim before --compare control is still rejected', () => {
  assert.throws(() => parseArgs(['--read-trim', '--compare', 'control', '--scenario', 's']), /--read-trim needs --compare anyray/);
});

test('armConfig: the private HOME never touches the real ~/.anyray or ~/.claude', () => withCfg((cfgDir) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'any712-home-'));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome; // homedir() follows $HOME
  try {
    mkdirSync(join(fakeHome, '.anyray'), { recursive: true });
    const realProfile = join(fakeHome, '.anyray', 'connect.json');
    const original = JSON.stringify({ ...PROFILE, gateway: GW });
    writeFileSync(realProfile, original);
    const liveLike = { ...deps(GW), connect: () => JSON.parse(readFileSync(join(homedir(), '.anyray', 'connect.json'), 'utf8')) };
    for (const [readTrim, d] of [[true, liveLike], [false, { ...liveLike, connect: () => ({ gateway: 'https://elsewhere.example' }) }]]) {
      const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim, cfgDir, deps: d });
      if (c.trimHome) assert.ok(c.trimHome.home.startsWith(cfgDir));
      const home = c.mcp.mcpServers.anyray.env.HOME;
      assert.ok(home.startsWith(cfgDir), `MCP HOME ${home} is outside the session dir`);
    }
    assert.equal(readFileSync(realProfile, 'utf8'), original); // readTrim was not written back
    assert.deepEqual(readdirSync(fakeHome).sort(), ['.anyray']); // no .claude/, .claude.json
    assert.deepEqual(readdirSync(join(fakeHome, '.anyray')), ['connect.json']);
  } finally {
    process.env.HOME = oldHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}));

test('armConfig: refuses a HOME outside the session directory before writing', () => withCfg((cfgDir) => {
  const outside = mkdtempSync(join(tmpdir(), 'any712-outside-'));
  try {
    symlinkSync(outside, join(cfgDir, 'home'), 'dir');
    for (const readTrim of [true, false]) {
      const enrolledOn = readTrim ? GW : 'https://elsewhere.example';
      assert.throws(
        () => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim, cfgDir, deps: deps(enrolledOn) }),
        /session directory/,
      );
      assert.deepEqual(readdirSync(outside), []);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

// ---- saltstack-docs scenario ------------------------------------------------------------

test('saltstack-docs scenario: loads, pins a commit and is graded by citations', () => {
  const s = yaml.load(readFileSync(new URL('../scenarios/saltstack-docs/scenario.yaml', import.meta.url), 'utf8'));
  assert.match(s.repo.git, /^https:\/\/github\.com\/saltstack\/salt(\.git)?$/);
  assert.match(s.repo.ref, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(s.citations.min) && s.citations.min > 0);
  assert.ok(s.citations.resolveRate > 0 && s.citations.resolveRate <= 1);
  // Exactly one grading mode, so solved() takes the citations path.
  assert.equal(s.check, undefined);
  assert.equal(s.keyFacts, undefined);
  assert.ok(Number.isInteger(s.maxTurns) && s.maxTurns > 0);
  assert.ok(s.timeoutMin > 0);
});

test('checkCitations: resolves Python path:line citations (what saltstack-docs is graded on)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'any712-cite-'));
  try {
    mkdirSync(join(dir, 'salt', 'loader'), { recursive: true });
    writeFileSync(join(dir, 'salt', 'loader', 'lazy.py'), 'a\nb\nc\n');
    const r = checkCitations('See salt/loader/lazy.py:3 and ./salt/loader/lazy.py:2, but not salt/loader/lazy.py:99 or salt/nope.py:1.', dir);
    assert.equal(r.total, 4);
    assert.equal(r.resolved, 2);
    assert.deepEqual(r.unresolved.sort(), ['salt/loader/lazy.py:99', 'salt/nope.py:1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --arm-env (#32) combined with --read-trim (#33): the env lands in the session settings,
// never in the private HOME, and never displaces the route or the private-HOME hooks.
test('armConfig: --arm-env with readTrim adds the env to the session and keeps gateway env, private-HOME hooks and MCP', () => withCfg((dir) => {
  const env = { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' };
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, env, deps: deps(GW) });
  assert.equal(c.settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.equal(c.settings.env.ANTHROPIC_BASE_URL, GW);
  assert.match(c.settings.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-api-key: ark_test/);
  assert.ok(c.settings.hooks.PostToolUse[0].hooks[0].command.startsWith(`HOME='${c.trimHome.home}'`));
  assert.equal(c.mcp.mcpServers.anyray.env.HOME, c.trimHome.home);
  const homeSettings = JSON.parse(readFileSync(join(c.trimHome.home, '.claude', 'settings.json'), 'utf8'));
  assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in homeSettings.env, false);
  assert.equal(homeSettings.env.ANTHROPIC_BASE_URL, GW);
}));

test('armConfig: --arm-env reaches the direct arm and the plain anyray arm too', () => withCfg((dir) => {
  const env = { X: '1' };
  assert.deepEqual(armConfig({ arm: 'direct', gatewayUrl: GW, runTag: TAG, cfgDir: dir, env, deps: deps(GW) }).settings.env, { X: '1' });
  const a = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, cfgDir: dir, env, deps: deps(GW) });
  assert.equal(a.settings.env.X, '1');
  assert.equal(a.settings.env.ANTHROPIC_BASE_URL, GW);
}));

test('--arm-env refuses keys that would reroute an arm or escape its private HOME', () => withCfg((dir) => {
  for (const key of ['HOME', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANYRAY_REFRESH_DISABLE']) {
    assert.throws(() => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: TAG, readTrim: true, cfgDir: dir, env: { [key]: 'x' }, deps: deps(GW) }), /--arm-env cannot set/);
    assert.throws(() => parseArgs(['--scenario', 's', '--arm-env', `b:${key}=x`]), /--arm-env cannot set/);
  }
}));

test('slotOptions: --read-trim follows the anyray arm, --arm-env follows the slot', () => {
  const args = parseArgs(['--scenario', 's', '--read-trim', '--arm-env', 'b:K=v']);
  const arms = { a: 'direct', b: 'anyray' };
  assert.deepEqual(slotOptions(args, arms, 'a'), { arm: 'direct', readTrim: false, env: {} });
  assert.deepEqual(slotOptions(args, arms, 'b'), { arm: 'anyray', readTrim: true, env: { K: 'v' } });
  const control = parseArgs(['--scenario', 's', '--compare', 'control', '--arm-env', 'b:K=v']);
  const both = { a: 'direct', b: 'direct' };
  assert.deepEqual(slotOptions(control, both, 'a').env, {});
  assert.deepEqual(slotOptions(control, both, 'b').env, { K: 'v' });
  const s = armSetups(args, arms, { model: 'm', gatewayUrl: GW }, { maxTurns: 3 }, { enrolled: true });
  assert.equal('env' in s.a, false);
  assert.deepEqual(s.b.env, { K: 'v' });
  assert.match(s.b.readTrim, /^on for this session only/);
});

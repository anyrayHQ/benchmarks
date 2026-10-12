import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { armConfig, benchExtraHeaders, benchSharedHeaders, describeSetup, followupDelayMs, subagentArgs } from '../lib/agentRun.mjs';
import { gatewayReplicaStarts, replicaStarts, restartedDuring } from '../lib/traces.mjs';
import { parseArgs, requestRecord, roundTag, slotOptions } from '../run_agent.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = 'test-client-key';
const withCfg = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const deps = (configureArm) => ({
  connect: () => ({ gateway: 'https://elsewhere.example', clientKey: KEY }),
  clientKey: () => KEY,
  anyrayHooks: () => ({}),
  binExists: () => false,
  bin: '/bin/anyray-connect',
  serviceKey: () => KEY,
  configureArm: configureArm ?? (() => ({ configured: false, reason: 'test' })),
});
const headerLines = (c) => c.settings.env.ANTHROPIC_CUSTOM_HEADERS.split('\n');

// ---- --no-subagents -----------------------------------------------------------------

test('subagentArgs disallows the tools that spawn subagents only when asked', () => {
  assert.deepEqual(subagentArgs(false), []);
  assert.deepEqual(subagentArgs(true), ['--disallowed-tools', 'Task', 'Workflow']);
});

test('parseArgs: --no-subagents is off by default, on with the flag, and allowed under --compare control', () => {
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']).noSubagents, false);
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--no-subagents']).noSubagents, true);
  assert.equal(parseArgs(['--scenario', 's', '--compare', 'control', '--no-subagents']).noSubagents, true);
});

test('slotOptions: --no-subagents applies to both arms, so the pair stays like for like', () => {
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--no-subagents']);
  const arms = { a: 'direct', b: 'anyray' };
  assert.equal(slotOptions(args, arms, 'a').noSubagents, true);
  assert.equal(slotOptions(args, arms, 'b').noSubagents, true);
});

test('describeSetup records that subagents were disallowed', () => {
  const on = describeSetup({ arm: 'direct', model: 'm', gatewayUrl: GW, runTag: {}, maxTurns: 1, noSubagents: true });
  assert.match(on.tools, /--disallowed-tools Task Workflow/);
  const off = describeSetup({ arm: 'direct', model: 'm', gatewayUrl: GW, runTag: {}, maxTurns: 1 });
  assert.match(off.tools, /incl\. Task/);
});

// ---- --experiment -------------------------------------------------------------------

test('parseArgs: --experiment names the experiment for a gateway rule and lands in the round tag', () => {
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--experiment', 'idle-kw']);
  assert.equal(args.experiment, 'idle-kw');
  assert.equal(roundTag(args, 3, 42).experiment, 'idle-kw');
  assert.equal(roundTag(args, 3, 42).sessionId, 'anyray-bench-s-anyray-r3-42');
  assert.equal(roundTag(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), 1, 1).experiment, undefined);
  assert.equal(roundTag(parseArgs(['--scenario', 's', '--strategy', 'thinking_trim']), 1, 1).experiment, 'thinking_trim');
});

test('parseArgs: --experiment needs --compare anyray and cannot be combined with --strategy (both set experiment)', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--experiment', 'x']), /--experiment needs --compare anyray/);
  assert.throws(() => parseArgs(['--scenario', 's', '--strategy', 'thinking_trim', '--experiment', 'x']), /--experiment.*--strategy/);
});

// ---- ANYRAY_BENCH_EXTRA_HEADERS -----------------------------------------------------

test('benchExtraHeaders: newline-separated "name: value" lines, blank lines ignored', () => {
  assert.deepEqual(benchExtraHeaders({}), []);
  assert.deepEqual(benchExtraHeaders({ ANYRAY_BENCH_EXTRA_HEADERS: 'x-anyray-cache-ttl: 1h\n\nx-trace: a:b\n' }), ['x-anyray-cache-ttl: 1h', 'x-trace: a:b']);
});

test('benchSharedHeaders: parsed like the treatment, and never a name the treatment sets', () => {
  assert.deepEqual(benchSharedHeaders({}), []);
  assert.deepEqual(benchSharedHeaders({ ANYRAY_BENCH_SHARED_HEADERS: 'x-anyray-tool-defer: off\n' }), ['x-anyray-tool-defer: off']);
  assert.throws(() => benchSharedHeaders({ ANYRAY_BENCH_SHARED_HEADERS: 'x-anyray-api-key: k' }), /ANYRAY_BENCH_SHARED_HEADERS cannot set/);
  assert.throws(
    () => benchSharedHeaders({ ANYRAY_BENCH_SHARED_HEADERS: 'X-Anyray-Tool-Defer: off', ANYRAY_BENCH_EXTRA_HEADERS: 'x-anyray-tool-defer: on' }),
    /in both/
  );
  assert.deepEqual(
    benchSharedHeaders({ ANYRAY_BENCH_SHARED_HEADERS: 'x-anyray-tool-defer: off', ANYRAY_BENCH_EXTRA_HEADERS: 'x-anyray-retrieval-tools: lazy' }),
    ['x-anyray-tool-defer: off']
  );
});

test('benchExtraHeaders refuses a malformed line or a header the harness owns', () => {
  assert.throws(() => benchExtraHeaders({ ANYRAY_BENCH_EXTRA_HEADERS: 'no colon' }), /name: value/);
  for (const h of ['x-anyray-api-key: k', 'X-Anyray-Metadata: {}', 'x-anyray-optimization-kinds: a', 'x-anyray-provider: openai', 'x-anyray-auth-mode: managed', 'authorization: Bearer x']) {
    assert.throws(() => benchExtraHeaders({ ANYRAY_BENCH_EXTRA_HEADERS: h }), /harness/, h);
  }
});

test('armConfig: extra headers go on the Anyray arm (harness config), before the kinds header', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: dir, kinds: ['observation_mask'], extraHeaders: ['x-anyray-cache-ttl: 1h'], deps: deps() });
  const h = headerLines(c);
  assert.ok(h.includes('x-anyray-cache-ttl: 1h'));
  assert.equal(h.at(-1), 'x-anyray-optimization-kinds: observation_mask');
}));

test('armConfig: extra headers go on the Anyray arm when anyray-connect configured it', () => withCfg((dir) => {
  const configureArm = () => ({
    configured: true,
    settings: { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_CUSTOM_HEADERS: `x-anyray-api-key: ${KEY}\nx-anyray-metadata: {"tool":"claude-code"}` } },
    mcpServers: {},
    setup: { env: {} },
  });
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: dir, kinds: ['observation_mask'], extraHeaders: ['x-anyray-cache-ttl: 1h'], deps: deps(configureArm) });
  const h = headerLines(c);
  assert.ok(h.includes('x-anyray-cache-ttl: 1h'));
  assert.equal(h.filter((l) => l.startsWith('x-anyray-metadata')).length, 1);
}));

test('slotOptions: extra headers follow the Anyray arm only', () => {
  const args = { ...parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), extraHeaders: ['x-a: 1'] };
  assert.deepEqual(slotOptions(args, { a: 'direct', b: 'anyray' }, 'a').extraHeaders, []);
  assert.deepEqual(slotOptions(args, { a: 'direct', b: 'anyray' }, 'b').extraHeaders, ['x-a: 1']);
  assert.deepEqual(slotOptions(args, { a: 'direct', b: 'direct' }, 'b').extraHeaders, []);
});

test('requestRecord: what the run asked for, extra header names only (values may be secret)', () => {
  const args = { ...parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--no-subagents', '--experiment', 'e1']), extraHeaders: ['x-anyray-cache-ttl: 1h'] };
  assert.deepEqual(requestRecord(args), { noSubagents: true, bare: false, warmUp: false, experiment: 'e1', extraHeaders: ['x-anyray-cache-ttl'], extraHeadersOn: ['b'] });
});

// ---- followupDelaySec ---------------------------------------------------------------

test('followupDelayMs takes one delay for every follow-up or a list, one per follow-up', () => {
  assert.equal(followupDelayMs({}, 0), 0);
  assert.equal(followupDelayMs({ followupDelaySec: 360 }, 2), 360_000);
  assert.equal(followupDelayMs({ followupDelaySec: [360, 900, 2400] }, 1), 900_000);
  // Past the end of the list, the last delay repeats.
  assert.equal(followupDelayMs({ followupDelaySec: [360, 900] }, 5), 900_000);
});

// ---- gateway restarts ---------------------------------------------------------------

const health = (replicas) => ({ replicas: replicas.map(([id, reportedAt, uptimeSec]) => ({ replicaId: id, reportedAt, uptimeSec })) });

test('replicaStarts derives each replica start time from its report and uptime', () => {
  assert.deepEqual(replicaStarts(health([['r1', '2026-09-30T00:10:00.000Z', 600]])), { r1: '2026-09-30T00:00:00.000Z' });
  assert.equal(replicaStarts({}), null);
});

test('replicaStarts keeps only replicas reporting fresh', () => {
  const h = { replicas: [
    { replicaId: 'live', reportedAt: '2026-09-30T00:10:00.000Z', uptimeSec: 60, freshness: 'fresh' },
    { replicaId: 'gone', reportedAt: '2026-09-28T00:10:00.000Z', uptimeSec: 60, freshness: 'stale' },
  ] };
  assert.deepEqual(Object.keys(replicaStarts(h)), ['live']);
});

test('restartedDuring flags a replica that is new or started again within the round', () => {
  const before = { r1: '2026-09-30T00:00:00.000Z', r2: '2026-09-29T20:00:00.000Z' };
  assert.equal(restartedDuring(before, { ...before }), false);
  // Reports drift by a few seconds; that is not a restart.
  assert.equal(restartedDuring(before, { ...before, r1: '2026-09-30T00:00:03.000Z' }), false);
  assert.equal(restartedDuring(before, { ...before, r1: '2026-09-30T00:20:00.000Z' }), true);
  assert.equal(restartedDuring(before, { r3: '2026-09-30T00:20:00.000Z', r2: before.r2 }), true);
  assert.equal(restartedDuring(null, before), null);
});

test('gatewayReplicaStarts reads the admin health report, null without a key or on failure', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return { ok: true, json: async () => health([['r1', '2026-09-30T00:10:00.000Z', 600]]) };
  };
  assert.deepEqual(await gatewayReplicaStarts(GW, { ANYRAY_ADMIN_KEY: 'test-admin-key' }, { fetchImpl }), { r1: '2026-09-30T00:00:00.000Z' });
  assert.equal(calls[0].url, `${GW}/admin/v1/settings/health`);
  assert.equal(calls[0].auth, 'Bearer test-admin-key');
  assert.equal(await gatewayReplicaStarts(GW, {}, { fetchImpl: async () => assert.fail('no call') }), null);
  assert.equal(await gatewayReplicaStarts(GW, { ANYRAY_ADMIN_KEY: 'k' }, { fetchImpl: async () => ({ ok: false, status: 403 }) }), null);
  assert.equal(await gatewayReplicaStarts(GW, { ANYRAY_ADMIN_KEY: 'k' }, { fetchImpl: async () => { throw new Error('down'); } }), null);
});

// ---- scenarios ----------------------------------------------------------------------

const scenario = (name) => yaml.load(readFileSync(new URL(`../scenarios/${name}/scenario.yaml`, import.meta.url), 'utf8'));

test('paused cobra scenarios: one delay per follow-up, and the walk-away waits for the gateway', () => {
  const pause = scenario('cobra-pause');
  assert.equal(pause.followups.length, 1);
  assert.equal(typeof pause.followupDelaySec, 'number');
  const three = scenario('cobra-3pause');
  assert.equal(three.followupDelaySec.length, three.followups.length);
  // The session must outlast its own pauses.
  assert.ok(three.timeoutMin * 60 > three.followupDelaySec.reduce((a, b) => a + b, 0));
  const walk = scenario('cobra-walkaway');
  assert.equal(walk.followups, undefined);
  assert.ok(walk.gatewaySettleSec > 0);
});

test('pyrepo scenarios: pinned, one grading mode each', () => {
  for (const name of ['pyrepo-docs', 'pyrepo-loader', 'pyrepo-long-session', 'pyrepo-pillar-docs', 'pyrepo-state-docs']) {
    const s = scenario(name);
    assert.match(s.repo.git, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, name);
    assert.match(s.repo.ref, /^[0-9a-f]{40}$/, name);
    assert.equal([s.check, s.citations, s.keyFacts].filter(Boolean).length, 1, name);
  }
});

test('citation-graded scenarios: every turn that asks for path:line asks for repository-root paths', () => {
  // The grader rejects a bare file name that several files share (lazy.py in a repo with
  // more than one), so a turn that leaves the path's form open fails rounds at random.
  const names = readdirSync(new URL('../scenarios/', import.meta.url)).filter((n) => scenario(n).citations);
  assert.ok(names.includes('pyrepo-long-session'));
  for (const name of names) {
    const s = scenario(name);
    for (const turn of [s.task, ...(s.followups ?? [])].filter((t) => /path:line/.test(t))) {
      assert.match(turn, /relative to the repository root|from\s+the repository root|repository-relative/, `${name}: ${turn}`);
    }
  }
});

test('gin scenarios: each applies the same fixed-ports lock patch, hidden in the import commit', () => {
  const names = readdirSync(new URL('../scenarios/', import.meta.url)).filter((n) => /gin-gonic\/gin/.test(scenario(n).repo?.git ?? ''));
  assert.deepEqual(names.sort(), ['gin-doc-audit', 'gin-long-session', 'gin-test-triage']);
  const copies = new Set();
  for (const name of names) {
    const s = scenario(name);
    assert.ok([s.patch].flat().includes('fixed-ports-lock.patch'), name);
    assert.equal(s.hidePatch, true, name);
    copies.add(readFileSync(new URL(`../scenarios/${name}/fixed-ports-lock.patch`, import.meta.url), 'utf8'));
  }
  assert.equal(copies.size, 1, 'the copies differ');
  const [patch] = copies;
  // A new test file only: it touches neither the library code nor the planted bugs.
  assert.deepEqual([...patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]), ['testmain_test.go']);
  assert.match(patch, /^new file mode/m);
});

// ---- the connect arm's HOME matches a real user's ------------------------------------

const connectDeps = (realClaudeJson) => ({
  ...deps(({ home }) => {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: GW, ENABLE_TOOL_SEARCH: 'auto:20' } }));
    return {
      configured: true,
      settings: { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_CUSTOM_HEADERS: `x-anyray-api-key: ${KEY}`, ENABLE_TOOL_SEARCH: 'auto:20' } },
      mcpServers: {},
      setup: { env: {} },
    };
  }),
  realClaudeJson: () => realClaudeJson,
});

test('armConfig: the connect arm carries the account identity a real user has, and nothing else from ~/.claude.json', () => withCfg((dir) => {
  const real = { userID: 'u1', oauthAccount: { accountUuid: 'a1' }, projects: { '/x': {} }, mcpServers: { s: {} } };
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: dir, kinds: ['k'], deps: connectDeps(real) });
  const written = JSON.parse(readFileSync(join(c.home, '.claude.json'), 'utf8'));
  assert.deepEqual(written, { userID: 'u1', oauthAccount: { accountUuid: 'a1' } });
  assert.deepEqual(c.setup.identity, ['userID', 'oauthAccount']);
}));

test('armConfig: unsetting a connect setting removes it from the user settings the session reads too', () => withCfg((dir) => {
  const c = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: dir, kinds: ['k'], env: { ENABLE_TOOL_SEARCH: '-' }, deps: connectDeps({}) });
  assert.equal(c.settings.env.ENABLE_TOOL_SEARCH, undefined);
  const user = JSON.parse(readFileSync(join(c.home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(user.env.ENABLE_TOOL_SEARCH, undefined);
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BENCH_PROVIDER_ID, CODEX_SEAT_BACKEND, KEY_ENV, anyrayHeaders, codexArgv, codexTotals, parseExecEvents,
  readArmHomeConfig, readRollout, runCodexAgent, sessionThreads, traceResults, configureCodexArmHome,
} from '../lib/codexAgent.mjs';
import { tallyKinds } from '../lib/optimizationKinds.mjs';
import { editsIn } from '../lib/stats.mjs';
import { parseArgs, runComparison } from '../run_agent.mjs';

const KEY = 'ark_synthetic-codex-123456';
const pricing = { cache_read: 0.1, cache_write: 1.25, models: { 'gpt-6-sol': { input: 2, output: 10 }, 'gpt-6.1-sol': { input: 2, output: 10, cache_read: 0.05 } } };

// The block anyray-connect writes for a Codex seat (connect src/tools/codex.ts), shape only.
const CONNECT_TOML = `model_provider = "anyray"

[model_providers.anyray]
name = "OpenAI"
base_url = "https://gateway.test.invalid/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = true
http_headers = { "x-anyray-auth-mode" = "passthrough", "x-anyray-custom-host" = "https://chatgpt.com/backend-api/codex", "x-anyray-api-key" = "${KEY}" }

[mcp_servers.anyray]
command = "/private/home/.anyray/bin/anyray-connect"
args = ["__anyray-mcp-server", "profile"]

[mcp_servers.anyray.tools.anyray_retrieve]
approval_mode = "approve"

[mcp_servers.anyray.tools.anyray_read_batch]
approval_mode = "approve"
`;

const armHome = readArmHomeConfig(CONNECT_TOML, '/private/home');

/** The `-c key=value` pairs in an argv, as a map. */
const overrides = (argv) => Object.fromEntries(argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [[a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]] : [])));

test('connect\'s seat block reads back as the arm\'s route, server and approvals', () => {
  assert.equal(armHome.configured, true, armHome.reasons.join('; '));
  assert.equal(armHome.providerName, 'OpenAI');
  assert.equal(armHome.websockets, true);
  assert.deepEqual(armHome.approvedTools, ['anyray_retrieve', 'anyray_read_batch']);
  assert.equal(armHome.mcpCommand, '/private/home/.anyray/bin/anyray-connect');
  assert.deepEqual(armHome.mcpArgs, ['__anyray-mcp-server', 'profile']);
  const noSocket = readArmHomeConfig(CONNECT_TOML.replace('supports_websockets = true\n', ''), '/h');
  assert.equal(noSocket.configured, true);
  assert.equal(noSocket.websockets, false);
});

test('a home without the seat lane or the retrieve approval is not a configured arm', () => {
  const noApproval = readArmHomeConfig(CONNECT_TOML.replace('[mcp_servers.anyray.tools.anyray_retrieve]\napproval_mode = "approve"\n', ''), '/h');
  assert.equal(noApproval.configured, false);
  assert.match(noApproval.reasons.join(), /anyray_retrieve is not pre-approved/);
  const apiKeyLane = readArmHomeConfig(CONNECT_TOML.replace('requires_openai_auth = true\n', ''), '/h');
  assert.equal(apiKeyLane.configured, false);
  assert.match(apiKeyLane.reasons.join(), /not the seat lane/);
  assert.equal(readArmHomeConfig('', '/h').configured, false);
});

test('connect is applied for Codex into the private home, which it must see as a Codex install', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-arm-home-'));
  const bin = join(home, 'anyray-connect');
  writeFileSync(bin, '');
  const calls = [];
  try {
    const armHome = configureCodexArmHome({
      home, gatewayUrl: 'https://gateway.test.invalid', clientKey: KEY, bin, realHome: '/nonexistent-real-home',
      spawnImpl: (cmd, argv, opts) => {
        // connect's Codex adapter detects Codex by ~/.codex existing (detect() in src/tools/codex.ts).
        calls.push({ argv, home: opts.env.HOME, codexDirExisted: existsSync(join(opts.env.HOME, '.codex')), key: opts.env.ANYRAY_CLIENT_KEY });
        writeFileSync(join(opts.env.HOME, '.codex', 'config.toml'), CONNECT_TOML);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].codexDirExisted, true);
    assert.equal(calls[0].home, home);
    assert.equal(calls[0].key, KEY);
    assert.deepEqual(calls[0].argv, ['--gateway', 'https://gateway.test.invalid', '--tools', 'codex', '--subscription', '--yes', '--json']);
    assert.equal(armHome.configured, true);
    assert.equal(armHome.home, home);
    assert.throws(() => configureCodexArmHome({ home, gatewayUrl: 'x', clientKey: KEY, bin, realHome: home }), /real HOME/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the direct arm is plain Codex: built-in provider, no user config, no hooks, no MCP', () => {
  const argv = codexArgv({ arm: 'direct', prompt: 'Fix it', model: 'gpt-6-sol', effort: 'medium' });
  assert.deepEqual(argv.slice(0, 2), ['exec', '--json']);
  for (const flag of ['--ignore-user-config', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf('--disable'), argv.indexOf('--disable') + 2), ['--disable', 'hooks']);
  const c = overrides(argv);
  assert.equal(c.model_provider, '"openai"');
  assert.equal(c.model_reasoning_effort, '"medium"');
  assert.ok(!Object.keys(c).some((k) => k.startsWith('mcp_servers') || k.startsWith('model_providers')));
  assert.equal(argv.at(-1), 'Fix it');
});

test('the anyray arm takes connect\'s seat route to the bench gateway, and the key never reaches argv', () => {
  const runTag = { sessionId: 'anyray-bench-x-r1', tool: 'anyray-bench', intent: 'x' };
  const headers = anyrayHeaders({ runTag, sharedHeaders: ['x-anyray-tool-defer: off'], extraHeaders: ['x-example: on'] });
  const argv = codexArgv({ arm: 'anyray', prompt: 'Fix it', model: 'gpt-6-sol', gatewayUrl: 'https://gateway.test.invalid/', headers, armHome });
  const c = overrides(argv);
  const p = `model_providers.${BENCH_PROVIDER_ID}`;
  assert.equal(c.model_provider, `"${BENCH_PROVIDER_ID}"`);
  assert.equal(c[`${p}.name`], '"OpenAI"');
  assert.equal(c[`${p}.base_url`], '"https://gateway.test.invalid/v1"');
  assert.equal(c[`${p}.requires_openai_auth`], 'true');
  assert.equal(c[`${p}.supports_websockets`], 'true');
  assert.equal(c[`${p}.env_http_headers`], `{ "x-anyray-api-key" = "${KEY_ENV}" }`);
  const h = c[`${p}.http_headers`];
  assert.match(h, /"x-anyray-auth-mode" = "passthrough"/);
  assert.ok(h.includes(`"x-anyray-custom-host" = "${CODEX_SEAT_BACKEND}"`));
  assert.ok(h.includes(`"x-anyray-metadata" = ${JSON.stringify(JSON.stringify(runTag))}`));
  // Never on the seat route: the gateway answers an upgrade (a GET) carrying it with 400,
  // which Codex reads as a broken socket and fails the turn (requestOptimization middleware).
  assert.doesNotMatch(h, /x-anyray-optimization-kinds/);
  assert.match(h, /"x-anyray-tool-defer" = "off"/);
  assert.match(h, /"x-example" = "on"/);
  // Shared or extra headers cannot re-target the seat route.
  const rerouted = anyrayHeaders({ runTag, extraHeaders: ['x-anyray-custom-host: https://evil.invalid', 'x-anyray-forward-headers: none'] });
  assert.equal(rerouted['x-anyray-custom-host'], CODEX_SEAT_BACKEND);
  assert.notEqual(rerouted['x-anyray-forward-headers'], 'none');
  assert.equal(c['mcp_servers.anyray.command'], '"/private/home/.anyray/bin/anyray-connect"');
  assert.equal(c['mcp_servers.anyray.args'], '["__anyray-mcp-server", "profile"]');
  assert.equal(c['mcp_servers.anyray.env'], '{ "HOME" = "/private/home" }');
  assert.equal(c['mcp_servers.anyray.tools.anyray_retrieve.approval_mode'], '"approve"');
  assert.ok(!argv.join(' ').includes('ark_'), 'no client key in argv');
  // A gateway that does not serve the socket: connect wrote no flag, and neither does the arm.
  const https = overrides(codexArgv({ arm: 'anyray', prompt: 'p', gatewayUrl: 'https://g.invalid', headers, armHome: { ...armHome, websockets: false } }));
  assert.equal(https[`${p}.supports_websockets`], undefined);
});

test('a follow-up resumes the thread; an arm without a configured home is refused', () => {
  const argv = codexArgv({ arm: 'direct', prompt: 'Next', resumeThreadId: '01a1309a-364a-7901-8f14-06624c861c17' });
  assert.deepEqual(argv.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(argv.slice(-2), ['01a1309a-364a-7901-8f14-06624c861c17', 'Next']);
  assert.throws(() => codexArgv({ arm: 'anyray', prompt: 'p', gatewayUrl: 'https://g.invalid', armHome: { configured: false } }), /configured/);
  assert.throws(() => codexArgv({ arm: 'anyray', prompt: 'p', armHome }), /gateway URL/);
  assert.throws(() => codexArgv({ arm: 'other', prompt: 'p' }), /direct or anyray/);
});

test('exec --json events give the thread, the last agent message and a failed turn', () => {
  const ok = [
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';
  assert.deepEqual(parseExecEvents(ok), { threadId: 't-1', answer: 'final answer', failure: null });
  const failed = [JSON.stringify({ type: 'thread.started', thread_id: 't-2' }), JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } })].join('\n');
  assert.equal(parseExecEvents(failed).failure, 'usage limit');
});

const at = (s) => `2026-10-12T10:00:${String(s).padStart(2, '0')}.000Z`;
const usageRecord = (s, u) => ({ timestamp: at(s), type: 'token_usage_record', payload: { response_id: `resp_${s}`, usage: { input_tokens: u[0], cached_input_tokens: u[1], cache_write_input_tokens: u[2], output_tokens: u[3], reasoning_output_tokens: u[4] ?? 0 } } });
const rollout = ({ id, parent = null, model = 'gpt-6-sol' }, events) => [
  { timestamp: at(0), type: 'session_meta', payload: { id, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } : 'exec' } },
  { timestamp: at(0), type: 'turn_context', payload: { model, effort: 'medium' } },
  ...events,
].map((e) => JSON.stringify(e)).join('\n');

const MAIN = rollout({ id: 'main-1' }, [
  usageRecord(4, [10000, 0, 9000, 300, 100]),
  { timestamp: at(5), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.mcp__anyray__anyray_retrieve({ handle: "ctx_x" }); tools.mcp__anyray__anyray_retrieve;' } },
  { timestamp: at(7), type: 'response_item', payload: { type: 'custom_tool_call_output', output: [] } },
  usageRecord(10, [12000, 9000, 2000, 200]),
  { timestamp: at(11), type: 'response_item', payload: { type: 'function_call', name: 'mcp__anyray__anyray_read_batch', arguments: '{}' } },
  { timestamp: at(11), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
  { timestamp: at(12), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 41.5 } } } },
  { timestamp: at(13), type: 'response_item', payload: { type: 'function_call_output', output: 'x' } },
  usageRecord(16, [13000, 11000, 0, 500]),
  { timestamp: at(17), type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 42 } } } },
]);
const CHILD = rollout({ id: 'child-1', parent: 'main-1' }, [usageRecord(20, [5000, 0, 4000, 100])]);
const OTHER = rollout({ id: 'other-1' }, [usageRecord(20, [99999, 0, 0, 1])]);

test('a rollout gives per-response usage, latency, retrieval calls by tool and the seat reading', () => {
  const t = readRollout(MAIN);
  assert.equal(t.threadId, 'main-1');
  assert.equal(t.parentThreadId, null);
  assert.equal(t.model, 'gpt-6-sol');
  assert.deepEqual(t.requests.map((r) => r.usage), [
    { input: 10000, cacheRead: 0, cacheWrite: 9000, output: 300, reasoning: 100 },
    { input: 12000, cacheRead: 9000, cacheWrite: 2000, output: 200, reasoning: 0 },
    { input: 13000, cacheRead: 11000, cacheWrite: 0, output: 500, reasoning: 0 },
  ]);
  // From the input being complete (turn start, a tool output) to the usage record.
  assert.deepEqual(t.requests.map((r) => r.latencyMs), [4000, 3000, 3000]);
  // One exec script naming the binding twice is one call; a shell call is not retrieval.
  assert.deepEqual(t.retrievals, { anyray_retrieve: 1, anyray_read_batch: 1 });
  assert.equal(t.toolCalls, 3);
  assert.deepEqual(t.usedPercent, [41.5, 42]);
  assert.equal(readRollout(CHILD).parentThreadId, 'main-1');
});

test('a session\'s threads are its main thread and its subagents, never another session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  try {
    const day = join(dir, '2026', '10', '12');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-10-12T10-00-00-main-1.jsonl'), MAIN);
    writeFileSync(join(day, 'rollout-2026-10-12T10-00-01-child-1.jsonl'), CHILD);
    writeFileSync(join(day, 'rollout-2026-10-12T10-00-02-other-1.jsonl'), OTHER);
    const threads = sessionThreads('main-1', { sinceMs: Date.now() - 60_000, sessionsDir: dir });
    assert.deepEqual(threads.map((t) => t.threadId), ['main-1', 'child-1']);
    assert.deepEqual(sessionThreads('missing', { sinceMs: 0, sessionsDir: dir }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('totals price every response from config.yaml, writes at 1.25x and reads at the model\'s rate', () => {
  const threads = [readRollout(MAIN), readRollout(CHILD)];
  const t = codexTotals(threads, pricing, { wallMs: 20000 });
  assert.equal(t.requests, 4);
  assert.equal(t.turns, 3);
  assert.equal(t.subagents, 1);
  assert.equal(t.subagentRequests, 1);
  assert.equal(t.input, 40000);
  assert.equal(t.cacheRead, 20000);
  assert.equal(t.cacheWrite, 15000);
  assert.equal(t.uncachedInput, 5000);
  const cost = (u) => ((u[0] - u[1] - u[2]) + u[1] * 0.1 + u[2] * 1.25) * 2 / 1e6 + u[3] * 10 / 1e6;
  const want = [[10000, 0, 9000, 300], [12000, 9000, 2000, 200], [13000, 11000, 0, 500], [5000, 0, 4000, 100]].reduce((n, u) => n + cost(u), 0);
  assert.ok(Math.abs(t.costUsd - want) < 1e-12, `${t.costUsd} vs ${want}`);
  assert.deepEqual(t.retrievals, { anyray_retrieve: 1, anyray_read_batch: 1 });
  assert.deepEqual(t.seatUsedPercent, { first: 41.5, last: 42 });
  // An unpriced model leaves the session without a cost rather than a wrong one.
  const unpriced = codexTotals([{ ...readRollout(MAIN), model: 'gpt-unknown' }], pricing);
  assert.equal(unpriced.costUsd, null);
  assert.deepEqual(unpriced.unpricedModels, ['gpt-unknown']);
});

test('a session runs the task, resumes each follow-up, carries the key in env only, and deletes its threads', async () => {
  const calls = [];
  const deleted = [];
  const session = await runCodexAgent({
    arm: 'anyray', scenario: { task: 'T', followups: ['F1', 'F2'], timeoutMin: 5 }, work: '/w', model: 'gpt-6-sol',
    gatewayUrl: 'https://g.invalid', clientKey: KEY, runTag: { sessionId: 's' }, kinds: ['relevance_filter'], armHome, pricing,
    runProcess: async (bin, argv, opts) => {
      calls.push({ argv, env: opts.env, cwd: opts.cwd });
      const events = [...(calls.length === 1 ? [{ type: 'thread.started', thread_id: 'main-1' }] : []), { type: 'item.completed', item: { type: 'agent_message', text: `answer ${calls.length}` } }];
      return { code: 0, stdout: events.map((e) => JSON.stringify(e)).join('\n'), stderr: '', timedOut: false };
    },
    readThreads: () => [readRollout(MAIN), readRollout(CHILD)],
    deleteThread: (id) => deleted.push(id),
    check: () => ({ passed: true }),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.argv.at(-1)), ['T', 'F1', 'F2']);
  assert.equal(calls[0].argv[1], '--json');
  assert.deepEqual(calls[1].argv.slice(0, 2), ['exec', 'resume']);
  assert.equal(calls[1].argv.at(-2), 'main-1');
  assert.ok(calls.every((c) => c.env[KEY_ENV] === KEY && c.env.CODEX_HOME === undefined && c.cwd === '/w'));
  assert.ok(calls.every((c) => !c.argv.join(' ').includes('ark_')));
  // --kinds only selects what the trace tally reads: the header would 400 the socket upgrade.
  assert.ok(calls.every((c) => !c.argv.join(' ').includes('x-anyray-optimization-kinds')));
  assert.equal(session.result.text, 'answer 3');
  assert.equal(session.result.subtype, 'success');
  assert.ok(session.totals.costUsd > 0);
  assert.deepEqual(deleted, ['main-1', 'child-1']);
  assert.deepEqual(session.check, { passed: true });
  assert.equal(session.setup.websockets, true);
});

test('a session that times out or fails has no cost, so its round is excluded rather than scored', async () => {
  const base = { arm: 'direct', scenario: { task: 'T', timeoutMin: 1 }, work: '/w', runTag: {}, pricing, readThreads: () => [readRollout(MAIN)] };
  const out = await runCodexAgent({ ...base, runProcess: async () => ({ code: null, signal: 'SIGTERM', stdout: JSON.stringify({ type: 'thread.started', thread_id: 'main-1' }), timedOut: true }) });
  assert.equal(out.totals.costUsd, null);
  assert.equal(out.result.subtype, 'error_timeout');
  const failed = await runCodexAgent({ ...base, runProcess: async () => ({ code: 1, stdout: [JSON.stringify({ type: 'thread.started', thread_id: 'main-1' }), JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })].join('\n'), timedOut: false }) });
  assert.equal(failed.totals.costUsd, null);
  assert.equal(failed.error, 'boom');
  // A failed turn with an empty message, or a bare non-zero exit, is still a failure.
  const blank = await runCodexAgent({ ...base, runProcess: async () => ({ code: 1, stdout: [JSON.stringify({ type: 'thread.started', thread_id: 'main-1' }), JSON.stringify({ type: 'turn.failed', error: { message: '' } })].join('\n'), stderr: 'Error: stream disconnected ark_synthetic-x\n', timedOut: false }) });
  assert.equal(blank.error, 'codex exited 1: Error: stream disconnected ark_<redacted>');
  assert.equal(blank.result.subtype, 'error_during_execution');
  // The direct arm never carries the key.
  let env;
  await runCodexAgent({ ...base, runProcess: async (_b, _a, o) => { env = o.env; return { code: 0, stdout: '', timedOut: false }; } });
  assert.equal(env[KEY_ENV], undefined);
});

test('trace rows tally like response feedback: a relayed seat turn edits nothing, a trim counts', () => {
  const traces = [
    { optimizationStatus: 'skipped', optimizationKinds: undefined, decisions: [] },
    { optimizationStatus: 'applied', optimizationKinds: ['relevance_filter'], decisions: [{ kind: 'relevance_filter' }], suppressed: [{ kind: 'code_graph', reason: 'source_trim_scope' }] },
    { optimizationStatus: 'applied', optimizationKinds: [], decisions: [], suppressed: [{ kind: 'relevance_filter', reason: 'session_gate_holdout' }] },
    {},
  ];
  const tally = tallyKinds(traceResults(traces), ['relevance_filter']);
  assert.equal(tally.requests, 4);
  assert.equal(tally.unconfirmed, 1);
  assert.equal(tally.byKind.relevance_filter.applied, 1);
  assert.deepEqual(tally.byKind.relevance_filter.guards, { session_gate_holdout: 1 });
  assert.equal(editsIn(tally), 1);
  assert.equal(editsIn(tallyKinds(traceResults([traces[0]]), ['relevance_filter'])), 0);
});

test('--client codex takes Codex switches, refuses Claude Code ones, and keeps its own result file', () => {
  const a = parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter', '--codex-model', 'gpt-6-sol', '--codex-effort', 'medium']);
  assert.equal(a.client, 'codex');
  assert.equal(a.label, 'codex');
  assert.equal(a.codexModel, 'gpt-6-sol');
  assert.equal(parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--compare', 'control', '--label', 'x']).label, 'codex-x');
  assert.equal(parseArgs(['--scenario', 'cobra-flag-groups', '--compare', 'control']).client, 'claude-code');
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex']), /needs --kinds/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter', '--max-turns', '80']), /no turn cap/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter', '--claude-bin', '/x/claude']), /--claude-bin/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter', '--provider', 'bedrock']), /--provider/);
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs', '--client', 'codex', '--provider', 'bedrock']), /SDK agent|needs --provider bedrock/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter', '--codex-effort', 'max']), /--codex-effort/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--codex-model', 'gpt-6-sol']), /need --client codex/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'cursor']), /--client claude-code\|codex/);
});

test('a gateway-compare Codex round pairs both gateway arms, tallies each from its traces, and scores treatment A', async () => {
  const label = `offline-${process.pid}-${Date.now()}`;
  const args = parseArgs(['--scenario', 'cobra-dispatch', '--client', 'codex', '--compare', 'gateway', '--kinds', 'relevance_filter', '--experiment-b', 'codex-trim-off', '--treatment', 'a', '--rounds', '1', '--label', label, '--parallel', '1']);
  const work = [];
  const homes = [];
  const seen = [];
  const rule = [{ label: 'anyray-bench: params for experiment=codex-trim-off', params: { relevance_filter: { minChars: 1e9 } } }];
  const deps = {
    clientKey: KEY,
    log: () => {},
    write: () => {},
    prepareRepo: () => { const d = mkdtempSync(join(tmpdir(), 'codex-cmp-')); work.push(d); return d; },
    describeRepo: () => ({ files: 1 }),
    armHomeParent: () => tmpdir(),
    connectPolicy: async () => ({}),
    readOptimizerConfig: async () => ({ strategies: [], overrides: { rules: rule.map((r) => ({ ...r, when: { metadata: { tool: ['anyray-bench'], experiment: ['codex-trim-off'] } } })) } }),
    gatewayReplicaStarts: async () => ({ r1: '2026-10-12T09:00:00.000Z' }),
    configureCodexArmHome: ({ home }) => { homes.push(home); return { ...armHome, home }; },
    runCodexAgent: async (o) => {
      seen.push({ arm: o.arm, sessionId: o.runTag.sessionId, experiment: o.runTag.experiment ?? null, home: o.armHome.home });
      const cost = o.runTag.experiment ? 0.02 : 0.015; // B (trim off) costs more: A, under test, saves
      return { codex: true, totals: { costUsd: cost, turns: 3, requests: 3, subagents: 0, subagentRequests: 0, input: 100, cacheRead: 50, cacheWrite: 0, uncachedInput: 50, output: 1, retrievalCalls: 0, latencyMs: null, outsideCheckout: 0 }, result: { text: 'ExecuteC calls Find, stripFlags and ParseFlags in command.go' }, setup: {} };
    },
    sessionTraces: async (_url, sessionId) => ({ traces: sessionId.endsWith('-a') ? [{ optimizationStatus: 'applied', optimizationKinds: ['relevance_filter'] }] : [{ optimizationStatus: 'applied', optimizationKinds: [] }] }),
  };
  const cfg = { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid' }, pricing };
  try {
    const { record } = await runComparison(args, cfg, { deps });
    assert.equal(record.client, 'codex');
    assert.deepEqual(seen.map((s) => [s.arm, s.sessionId.slice(-2), s.experiment]), [['anyray', '-a', null], ['anyray', '-b', 'codex-trim-off']]);
    assert.equal(new Set(homes).size, 2, 'each arm its own private home');
    const r = record.rounds[0];
    assert.equal(r.ratio, 0.02 / 0.015);
    assert.equal(r.optimizationA.byKind.relevance_filter.applied, 1);
    assert.equal(r.optimization.byKind.relevance_filter.applied, 0);
    assert.equal(r.experimentRule.stable, true);
    assert.equal(record.rule0Verdict.treatment, 'a');
    assert.equal(record.rule0Verdict.treatmentEdits, 1);
  } finally { for (const d of [...work, ...homes]) rmSync(d, { recursive: true, force: true }); }
});

test('a Codex round whose anyray arm connect could not set up fails the round, naming the arm', async () => {
  const args = parseArgs(['--scenario', 'cobra-dispatch', '--client', 'codex', '--kinds', 'relevance_filter', '--rounds', '1', '--label', `offline-fail-${process.pid}`, '--parallel', '1']);
  const work = [];
  let ran = 0;
  const deps = {
    clientKey: KEY, log: () => {}, write: () => {}, describeRepo: () => ({}), armHomeParent: () => tmpdir(),
    prepareRepo: () => { const d = mkdtempSync(join(tmpdir(), 'codex-cmp-')); work.push(d); return d; },
    connectPolicy: async () => ({}), readOptimizerConfig: async () => ({}), gatewayReplicaStarts: async () => null,
    configureCodexArmHome: () => ({ configured: false, reasons: ['anyray-connect exited 1'] }),
    runCodexAgent: async () => { ran++; return { totals: { costUsd: 0.01 }, result: { text: '' } }; },
    sessionTraces: async () => ({ traces: [] }),
  };
  try {
    const { record } = await runComparison(args, { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid' }, pricing }, { deps });
    assert.match(record.rounds[0].error, /^B: anyray-connect did not set up the Codex seat route: anyray-connect exited 1$/);
    assert.equal(ran, 1, 'the direct arm still ran; only B failed');
  } finally { for (const d of work) rmSync(d, { recursive: true, force: true }); }
});

test('per-arm Codex config overrides ride as -c flags on that arm, before the prompt', () => {
  const configOverrides = [['model_auto_compact_token_limit', '150000']];
  for (const arm of ['direct', 'anyray']) {
    const argv = codexArgv({ arm, prompt: 'Fix it', gatewayUrl: 'https://g.invalid', headers: {}, armHome, configOverrides });
    assert.equal(overrides(argv).model_auto_compact_token_limit, '150000', arm);
    assert.equal(argv.at(-1), 'Fix it');
  }
  assert.equal(overrides(codexArgv({ arm: 'direct', prompt: 'p' })).model_auto_compact_token_limit, undefined);
});

test('a rollout counts Codex compactions and the largest request it sent', () => {
  const compacting = rollout({ id: 'main-c' }, [
    usageRecord(4, [150000, 140000, 0, 300]),
    { timestamp: at(5), type: 'compacted', payload: { message: '' } },
    usageRecord(9, [30000, 0, 30000, 200]),
    { timestamp: at(10), type: 'compacted', payload: { message: '' } },
  ]);
  const t = readRollout(compacting);
  assert.equal(t.compactions, 2);
  const totals = codexTotals([t, readRollout(CHILD)], pricing);
  assert.equal(totals.compactions, 2);
  assert.equal(totals.peakInput, 150000);
  assert.equal(readRollout(MAIN).compactions, 0);
});

test('--codex-config-b sets arm B\'s Codex config alone and is refused where it cannot isolate one change', () => {
  const base = ['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter'];
  const a = parseArgs([...base, '--compare', 'gateway', '--codex-config-b', 'model_auto_compact_token_limit=150000']);
  assert.deepEqual(a.codexConfigB, [['model_auto_compact_token_limit', '150000']]);
  assert.deepEqual(parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--compare', 'control', '--codex-config-b', 'a.b_c=true']).codexConfigB, [['a.b_c', 'true']]);
  assert.throws(() => parseArgs([...base, '--codex-config-b', 'model_auto_compact_token_limit=150000']), /--compare gateway or control/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--treatment', 'a', '--codex-config-b', 'k=1']), /treatment b/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--codex-config-b', 'k="x"; rm']), /key=value/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--codex-config-b', 'Bad Key=1']), /key=value/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--compare', 'gateway', '--kinds', 'relevance_filter', '--codex-config-b', 'k=1']), /need --client codex/);
});

test('a --codex-config-b round runs the override on B only and scores whether B compacted more than A', async () => {
  const args = parseArgs(['--scenario', 'cobra-dispatch', '--client', 'codex', '--compare', 'gateway', '--kinds', 'relevance_filter', '--codex-config-b', 'model_auto_compact_token_limit=150000', '--rounds', '1', '--label', `offline-cfg-${process.pid}-${Date.now()}`, '--parallel', '1']);
  const work = [];
  const homes = [];
  const seen = [];
  const deps = {
    clientKey: KEY, log: () => {}, write: () => {}, describeRepo: () => ({}), armHomeParent: () => tmpdir(),
    prepareRepo: () => { const d = mkdtempSync(join(tmpdir(), 'codex-cmp-')); work.push(d); return d; },
    connectPolicy: async () => ({}), readOptimizerConfig: async () => ({}), gatewayReplicaStarts: async () => ({ r1: 'x' }),
    configureCodexArmHome: ({ home }) => { homes.push(home); return { ...armHome, home }; },
    runCodexAgent: async (o) => {
      const b = o.configOverrides.length > 0;
      seen.push(o.configOverrides);
      return { codex: true, totals: { costUsd: b ? 0.012 : 0.015, turns: 3, requests: 3, subagents: 0, subagentRequests: 0, input: 100, cacheRead: 50, cacheWrite: 0, uncachedInput: 50, output: 1, retrievalCalls: 0, latencyMs: null, outsideCheckout: 0, compactions: b ? 2 : 1, peakInput: b ? 150000 : 210000 }, result: { text: 'ExecuteC calls Find, stripFlags and ParseFlags in command.go' }, setup: {} };
    },
    sessionTraces: async () => ({ traces: [{ optimizationStatus: 'skipped', optimizationKinds: [] }] }),
  };
  try {
    const { record } = await runComparison(args, { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid' }, pricing }, { deps });
    assert.deepEqual(seen.sort((x, y) => x.length - y.length), [[], [['model_auto_compact_token_limit', '150000']]]);
    const r = record.rounds[0];
    assert.deepEqual(r.compactions, { a: 1, b: 2 });
    assert.equal(r.optimization.otherApplied.codex_config_b, 1);
    assert.equal(record.setup.b.codexConfig.model_auto_compact_token_limit, '150000');
    assert.equal(record.setup.a.codexConfig, undefined);
    assert.deepEqual(record.request.codexConfigB, { model_auto_compact_token_limit: '150000' });
    assert.equal(record.rule0Verdict.treatmentEdits, 1);
  } finally { for (const d of [...work, ...homes]) rmSync(d, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BENCH_PROVIDER_ID, CODEX_SEAT_BACKEND, KEY_ENV, anyrayHeaders, codexArgv, codexTotals, parseExecEvents,
  readArmHomeConfig, readRollout, runCodexAgent, sessionThreads, traceResults, configureCodexArmHome,
  codexHookTrustHash, readArmHomeHook, hooksJsonKeys, codexHookSpec, readShimLog,
} from '../lib/codexAgent.mjs';
import { withShellRunEnv } from '../lib/codexHookShim.mjs';
import { exclusionReasons } from '../lib/benchVerdict.mjs';
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
  assert.deepEqual(parseExecEvents(ok), { threadId: 't-1', answer: 'final answer', failure: null, reconnects: 0 });
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
    clientKey: KEY, connectBinPinned: false,
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
    clientKey: KEY, connectBinPinned: false, log: () => {}, write: () => {}, describeRepo: () => ({}), armHomeParent: () => tmpdir(),
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
    clientKey: KEY, connectBinPinned: false, log: () => {}, write: () => {}, describeRepo: () => ({}), armHomeParent: () => tmpdir(),
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

test("Codex's Reconnecting notices are not failures: the session went on (a socket retry, then HTTPS)", () => {
  const recovered = [
    { type: 'thread.started', thread_id: 't-3' },
    { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 502 Bad Gateway: Unknown error, url: wss://gateway.test.invalid/v1/responses)' },
    { type: 'error', message: 'Reconnecting... 5/5 (unexpected status 503 Service Unavailable: An error occurred)' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1 } },
  ].map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(parseExecEvents(recovered), { threadId: 't-3', answer: 'done', failure: null, reconnects: 2 });
  // Any other error event still fails the turn, and so does turn.failed after a notice.
  const fatal = [JSON.stringify({ type: 'error', message: 'Selected model is at capacity. Please try a different model.' })].join('\n');
  assert.equal(parseExecEvents(fatal).failure, 'Selected model is at capacity. Please try a different model.');
  const failedAfterNotice = [
    JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected)' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit' } }),
  ].join('\n');
  assert.deepEqual(parseExecEvents(failedAfterNotice), { threadId: null, answer: '', failure: 'usage limit', reconnects: 1 });
});

// ── --codex-hooks-b: connect's Codex PreToolUse source trim on arm B alone ───────────

// What anyray-connect writes into the arm home's ~/.codex/hooks.json (connect src/tools/codex.ts
// installCodexHook): one PreToolUse group, matcher Bash, the stable launcher path.
const ARM = '/bench/sessions/anyray-bench-codex-home-x1';
const CONNECT_HOOKS_JSON = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${ARM}/.anyray/bin/anyray-connect __anyray-codex-hook` }] }] } });

test("Codex's trust hash for a session hook is the one Codex itself computes (0.162.1, hooks/list)", () => {
  // Goldens read from `codex app-server` hooks/list (currentHash) under a throwaway CODEX_HOME.
  assert.equal(codexHookTrustHash({ matcher: 'Bash', command: "'/opt/node/bin/node' '/bench/lib/codexHookShim.mjs' '/bench/home/.anyray-bench/codex-hook.json'", timeoutSec: 600 }),
    'sha256:4dd75bbbc7424f8d875068c6ce3fb0792585854651008ab65f7ba7ac18276261');
  assert.equal(codexHookTrustHash({ matcher: 'Bash', command: '/h/.anyray/bin/anyray-connect __anyray-codex-hook', timeoutSec: 30 }),
    'sha256:ee824046557153c2edd1036936053c0e7a10f873239df8b98fd98a1bc79d5eac');
});

test("connect's Codex PreToolUse hook reads back from the arm home's hooks.json; nothing else counts as it", () => {
  assert.deepEqual(readArmHomeHook(CONNECT_HOOKS_JSON), { command: `${ARM}/.anyray/bin/anyray-connect __anyray-codex-hook`, timeoutSec: null });
  const timed = JSON.parse(CONNECT_HOOKS_JSON);
  timed.hooks.PreToolUse[0].hooks[0].timeout = 30;
  assert.equal(readArmHomeHook(JSON.stringify(timed)).timeoutSec, 30);
  const post = JSON.stringify({ hooks: { PostToolUse: JSON.parse(CONNECT_HOOKS_JSON).hooks.PreToolUse } });
  assert.equal(readArmHomeHook(post), null);
  const otherMatcher = CONNECT_HOOKS_JSON.replace('"Bash"', '"apply_patch"');
  assert.equal(readArmHomeHook(otherMatcher), null);
  const foreign = CONNECT_HOOKS_JSON.replace('__anyray-codex-hook', '__anyray-hook');
  assert.equal(readArmHomeHook(foreign), null);
  assert.equal(readArmHomeHook('not json'), null);
  assert.equal(readArmHomeHook(null), null);
});

test('every handler in a hooks.json gets its Codex state key, so the real one can be switched off', () => {
  const real = JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'c' }] }],
  } });
  assert.deepEqual(hooksJsonKeys(real, '/Users/x/.codex/hooks.json'), [
    '/Users/x/.codex/hooks.json:pre_tool_use:0:0',
    '/Users/x/.codex/hooks.json:pre_tool_use:0:1',
    '/Users/x/.codex/hooks.json:session_start:0:0',
  ]);
  assert.deepEqual(hooksJsonKeys('{', '/x/hooks.json'), []);
  assert.deepEqual(hooksJsonKeys(null, '/x/hooks.json'), []);
});

const HOOK = { command: "'/opt/node' '/bench/lib/codexHookShim.mjs' '/h/.anyray-bench/codex-hook.json'", timeoutSec: 600, disableKeys: ['/Users/x/.codex/hooks.json:pre_tool_use:0:0'] };

test('arm B declares exactly one trusted PreToolUse hook as session config; A keeps hooks off', () => {
  const b = codexArgv({ arm: 'anyray', prompt: 'p', gatewayUrl: 'https://g.invalid', headers: {}, armHome, hook: HOOK });
  assert.ok(!b.includes('--disable'), 'hooks on for B');
  assert.deepEqual(b.slice(b.indexOf('--enable'), b.indexOf('--enable') + 2), ['--enable', 'hooks']);
  // Trust comes from the session's own hooks.state entry, never the bypass flag that trusts every hook.
  assert.ok(!b.some((x) => /bypass-hook-trust/.test(x)));
  const c = overrides(b);
  assert.equal(c['hooks.PreToolUse'], `[{ matcher = "Bash", hooks = [{ type = "command", command = ${JSON.stringify(HOOK.command)}, timeout = 600 }] }]`);
  const hash = codexHookTrustHash({ matcher: 'Bash', command: HOOK.command, timeoutSec: 600 });
  // One table, every key quoted: Codex splits a -c key on every dot, so a path key cannot ride in it.
  assert.equal(c['hooks.state'], `{ "/<session-flags>/config.toml:pre_tool_use:0:0" = { trusted_hash = "${hash}" }, "/Users/x/.codex/hooks.json:pre_tool_use:0:0" = { enabled = false } }`);
  assert.deepEqual(Object.keys(c).filter((k) => k.startsWith('hooks')), ['hooks.PreToolUse', 'hooks.state']);
  assert.equal(b.at(-1), 'p');
  // Arm A: the same route, hooks disabled, no hook config at all.
  const a = codexArgv({ arm: 'anyray', prompt: 'p', gatewayUrl: 'https://g.invalid', headers: {}, armHome });
  assert.deepEqual(a.slice(a.indexOf('--disable'), a.indexOf('--disable') + 2), ['--disable', 'hooks']);
  assert.ok(!a.includes('--enable'));
  assert.ok(!Object.keys(overrides(a)).some((k) => k.startsWith('hooks')));
  // No connect arm home, no hook: the direct arm never carries one.
  assert.throws(() => codexArgv({ arm: 'direct', prompt: 'p', hook: HOOK }), /hook/);
});

test('the shim puts the arm HOME in front of connect\'s shell-run and nothing else; anything it cannot place it drops', () => {
  const exe = `${ARM}/.anyray/bin/anyray-connect`;
  const env = { HOME: ARM, ANYRAY_REFRESH_DISABLE: 'true', GOPATH: "/Users/o'neil/go" };
  const out = (command) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command, workdir: '/w' } } });
  const prefix = `HOME='${ARM}' ANYRAY_REFRESH_DISABLE='true' GOPATH='/Users/o'\\''neil/go'`;
  const wrapped = JSON.parse(withShellRunEnv(out(`${exe} __anyray-shell-run --b64 Z28gdGVzdA==`), { exe, env }));
  assert.equal(wrapped.hookSpecificOutput.updatedInput.command, `${prefix} ${exe} __anyray-shell-run --b64 Z28gdGVzdA==`);
  assert.equal(wrapped.hookSpecificOutput.updatedInput.workdir, '/w');
  assert.equal(wrapped.hookSpecificOutput.permissionDecision, 'allow');
  const cd = JSON.parse(withShellRunEnv(out(`cd /w/sub && ${exe} __anyray-shell-run --b64 eA== --codex`), { exe, env }));
  assert.equal(cd.hookSpecificOutput.updatedInput.command, `cd /w/sub && ${prefix} ${exe} __anyray-shell-run --b64 eA== --codex`);
  // A context-only answer (the batch-read reminder) passes through byte for byte.
  const note = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'x' } });
  assert.equal(withShellRunEnv(note, { exe, env }), note);
  // A shell-run by any other binary, or twice, is not the shape connect writes: stand aside
  // (the command runs unwrapped) rather than let it trim through the real ~/.anyray.
  assert.equal(withShellRunEnv(out('/Users/x/.anyray/bin/anyray-connect __anyray-shell-run --b64 eA=='), { exe, env }), '');
  assert.equal(withShellRunEnv(out(`${exe} __anyray-shell-run --b64 eA== && ${exe} __anyray-shell-run --b64 eA==`), { exe, env }), '');
  assert.equal(withShellRunEnv('{ not json', { exe, env }), '');
  assert.equal(withShellRunEnv('', { exe, env }), '');
});

test("the shim runs the arm's connect hook under the arm HOME and logs what it did", () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-shim-home-'));
  try {
    const fake = join(home, 'fake-connect');
    const seen = join(home, 'seen');
    // A stand-in for connect's hook: records the env it ran under, answers with a shell-run.
    writeFileSync(fake, `#!/bin/sh\ncat > /dev/null\necho "$HOME|$ANYRAY_REFRESH_DISABLE" > '${seen}'\necho '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"${fake} __anyray-shell-run --b64 eA=="}}}'\n`, { mode: 0o755 });
    const spec = codexHookSpec({ armHome: { home, codexHook: { command: `${fake} __anyray-codex-hook`, timeoutSec: null } }, wrappedEnv: { GOPATH: '/real/go' }, disableKeys: ['k'] });
    assert.equal(spec.timeoutSec, 600);
    assert.deepEqual(spec.disableKeys, ['k']);
    assert.equal(spec.connectExe, fake);
    const r = spawnSync('/bin/sh', ['-c', spec.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'go test ./...' } }), encoding: 'utf8', env: { ...process.env, HOME: '/real-home-must-not-be-used' } });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command, `HOME='${home}' ANYRAY_REFRESH_DISABLE='true' GOPATH='/real/go' ${fake} __anyray-shell-run --b64 eA==`);
    assert.equal(readFileSync(seen, 'utf8').trim(), `${home}|true`);
    assert.deepEqual(readShimLog(home), { calls: 1, rewrites: 1, passthrough: 0, standAside: 0, errors: 0 });
    // No connect hook in the arm home: the arm cannot carry the treatment.
    assert.throws(() => codexHookSpec({ armHome: { home, codexHook: null } }), /no Codex PreToolUse hook/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const ITEM = (s, command, output = '') => ({ timestamp: at(s), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: `c${s}`, command, aggregated_output: output, exit_code: 0 } } });
const FOOTER = '\n\n…[anyray-hook digest — 120 lines → 9. Anyray, this organization\'s LLM gateway, shortened this output to save tokens. Only if you need the omitted part, full output: Read /h/.anyray/hook-tee/1.log]…';
const OLD_FOOTER = '\n\n…[anyray-hook digest — 120 lines → 9]…';

test("a rollout counts each command connect's hook wrapped (by binary) and each digest footer the model was shown", () => {
  const hooked = rollout({ id: 'main-h' }, [
    usageRecord(2, [1000, 0, 900, 10]),
    ITEM(3, ['/bin/zsh', '-lc', `HOME='${ARM}' ${ARM}/.anyray/bin/anyray-connect __anyray-shell-run --b64 eA==`]),
    ITEM(4, ['/bin/zsh', '-lc', `cd /w && '${ARM}/.anyray/bin/anyray-connect' __anyray-shell-run --b64 eQ==`]),
    ITEM(5, ['/bin/zsh', '-lc', '/Users/x/.anyray/bin/anyray-connect __anyray-shell-run --b64 eg==']),
    ITEM(6, ['/bin/zsh', '-lc', 'rg -n func gin.go']),
    { timestamp: at(7), type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: `ok${FOOTER}` }, { type: 'input_text', text: `ok${OLD_FOOTER}` }] } },
    // An exec script that JSON-encodes what it prints shows the footer after an escaped newline.
    { timestamp: at(8), type: 'response_item', payload: { type: 'custom_tool_call_output', output: '{"out":"ok\\n…[anyray-hook digest — 3 lines → 1]…"}' } },
    // Quoted inside a line (a grep hit, prose, the skill's own description) is not a footer,
    // nor is one in the model's own message.
    { timestamp: at(8), type: 'response_item', payload: { type: 'function_call_output', output: 'notes.md:3: …[anyray-hook digest — x]…\nskill: a `…[anyray-hook digest — n]…` footer' } },
    { timestamp: at(9), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: FOOTER }] } },
  ]);
  const t = readRollout(hooked);
  assert.deepEqual(t.hookWrapExes, { [`${ARM}/.anyray/bin/anyray-connect`]: 2, '/Users/x/.anyray/bin/anyray-connect': 1 });
  assert.equal(t.hookDigests, 3);
  // The arm's connect is whatever its hook command names: a launcher in the arm home, or a
  // pinned build elsewhere (--connect-bin-b). Any other binary is someone else's hook.
  const totals = codexTotals([t, readRollout(CHILD)], pricing, { connectExe: `${ARM}/.anyray/bin/anyray-connect` });
  assert.equal(totals.hookWraps, 3);
  assert.equal(totals.hookWrapsOther, 1, "a wrap by another connect binary is someone else's hook");
  const pinned = codexTotals([t], pricing, { connectExe: '/Users/x/.anyray/bin/anyray-connect' });
  assert.equal(pinned.hookWrapsOther, 2);
  // An arm with no hook of its own: every wrap is someone else's.
  assert.equal(codexTotals([t], pricing).hookWrapsOther, 3);
  assert.equal(totals.hookDigests, 3);
  const plain = codexTotals([readRollout(MAIN)], pricing, { connectExe: `${ARM}/.anyray/bin/anyray-connect` });
  assert.deepEqual([plain.hookWraps, plain.hookWrapsOther, plain.hookDigests], [0, 0, 0]);
});

test('--codex-hooks-b and --connect-bin-b are Codex gateway-pair switches for arm B; misuse is refused', () => {
  const base = ['--scenario', 'cobra-flag-groups', '--client', 'codex', '--kinds', 'relevance_filter'];
  const a = parseArgs([...base, '--compare', 'gateway', '--codex-hooks-b']);
  assert.equal(a.codexHooksB, true);
  assert.throws(() => parseArgs([...base, '--codex-hooks-b']), /--codex-hooks-b needs --compare gateway/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--client', 'codex', '--compare', 'control', '--codex-hooks-b']), /--codex-hooks-b needs --compare gateway/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--treatment', 'a', '--codex-hooks-b']), /treatment b/);
  assert.throws(() => parseArgs(['--scenario', 'cobra-flag-groups', '--compare', 'gateway', '--kinds', 'relevance_filter', '--codex-hooks-b']), /need --client codex/);
  // Hook settings are the harness's to set: a config override cannot reach them on either arm.
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--codex-config-b', 'hooks.x=true']), /hooks/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--codex-config-b', 'features.hooks=true']), /hooks/);
  const pinned = parseArgs([...base, '--compare', 'gateway', '--codex-hooks-b', '--connect-bin-b', '/abs/pr/anyray-connect']);
  assert.equal(pinned.connectBinB, '/abs/pr/anyray-connect');
  assert.throws(() => parseArgs([...base, '--connect-bin-b', '/abs/pr/anyray-connect']), /--compare gateway/);
  assert.throws(() => parseArgs([...base, '--compare', 'gateway', '--connect-bin-b', 'rel/anyray-connect']), /absolute/);
});

/** A runComparison harness for the --codex-hooks-b round tests: B's session reports `wraps`. */
async function hookRound({ extra = [], wraps = { a: 0, b: 3, bOther: 0 }, deps: more = {} } = {}) {
  const args = parseArgs(['--scenario', 'cobra-dispatch', '--client', 'codex', '--compare', 'gateway', '--kinds', 'relevance_filter', '--codex-hooks-b', '--rounds', '1', '--label', `offline-hook-${process.pid}-${Date.now()}-${Math.random()}`, '--parallel', '1', ...extra]);
  const work = [];
  const homes = [];
  const seen = [];
  const deps = {
    clientKey: KEY, connectBinPinned: false, log: () => {}, write: () => {}, describeRepo: () => ({}), armHomeParent: () => tmpdir(),
    prepareRepo: () => { const d = mkdtempSync(join(tmpdir(), 'codex-cmp-')); work.push(d); return d; },
    connectPolicy: async () => ({}), readOptimizerConfig: async () => ({}), gatewayReplicaStarts: async () => ({ r1: 'x' }),
    connectBinPinned: false, // hermetic: not whatever ANYRAY_CONNECT_BIN this shell has
    realHookKeys: () => ['/Users/x/.codex/hooks.json:pre_tool_use:0:0'],
    wrappedCommandEnv: () => ({ GOPATH: '/real/go' }),
    configureCodexArmHome: ({ home, bin }) => { homes.push(home); return { ...armHome, home, bin, codexHook: { command: `${home}/.anyray/bin/anyray-connect __anyray-codex-hook`, timeoutSec: null } }; },
    runCodexAgent: async (o) => {
      const slot = o.hook ? 'b' : 'a';
      seen.push({ slot, hook: o.hook, home: o.armHome.home, bin: o.armHome.bin });
      const t = { costUsd: slot === 'b' ? 0.012 : 0.015, turns: 3, requests: 3, subagents: 0, subagentRequests: 0, input: 100, cacheRead: 50, cacheWrite: 0, uncachedInput: 50, output: 1, retrievalCalls: 0, latencyMs: null, outsideCheckout: 0,
        hookWraps: slot === 'b' ? wraps.b + wraps.bOther : wraps.a, hookWrapsOther: slot === 'b' ? wraps.bOther : wraps.a, hookDigests: slot === 'b' ? 2 : 0 };
      return { codex: true, totals: t, result: { text: 'ExecuteC calls Find, stripFlags and ParseFlags in command.go' }, setup: {} };
    },
    sessionTraces: async () => ({ traces: [{ optimizationStatus: 'skipped', optimizationKinds: [] }] }),
    ...more,
  };
  try {
    const { record } = await runComparison(args, { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid' }, pricing }, { deps });
    return { record, seen, homes };
  } finally { for (const d of [...work, ...homes]) rmSync(d, { recursive: true, force: true }); }
}

test('a --codex-hooks-b round hooks arm B alone and scores B as acting only when its connect wrapped a command', async () => {
  const { record, seen } = await hookRound();
  const a = seen.find((s) => s.slot === 'a');
  const b = seen.find((s) => s.slot === 'b');
  assert.equal(a.hook, undefined);
  assert.equal(b.hook.timeoutSec, 600);
  assert.deepEqual(b.hook.disableKeys, ['/Users/x/.codex/hooks.json:pre_tool_use:0:0']);
  assert.match(b.hook.command, /codexHookShim\.mjs' '.*\/\.anyray-bench\/codex-hook\.json'$/);
  assert.ok(b.hook.command.includes(b.home), "the shim's config lives in B's own home");
  const r = record.rounds[0];
  assert.equal(r.optimization.otherApplied.codex_hooks_b, 1);
  assert.equal(r.hookLeak, undefined);
  assert.equal(record.request.codexHooksB, true);
  assert.deepEqual(record.setup.b.codexHooks.wrappedCommandEnv, ['HOME', 'ANYRAY_REFRESH_DISABLE', 'GOPATH']);
  assert.equal(record.setup.a.codexHooks, undefined);
  assert.equal(record.rule0Verdict.treatmentEdits, 1);
  // B's hook never wrapped anything: the treatment did not act, so there is nothing to score.
  const idle = await hookRound({ wraps: { a: 0, b: 0, bOther: 0 } });
  assert.equal(idle.record.rounds[0].optimization.otherApplied.codex_hooks_b, 0);
  assert.equal(idle.record.rule0Verdict.treatmentEdits, 0);
  assert.match(idle.record.rule0Verdict.reasons.join(' '), /applied no optimization/);
  // The gateway editing B is not the treatment acting (A gets the same kinds): only the hook counts.
  const gatewayOnly = await hookRound({ wraps: { a: 0, b: 0, bOther: 0 }, deps: { sessionTraces: async () => ({ traces: [{ optimizationStatus: 'applied', optimizationKinds: ['relevance_filter'] }] }) } });
  assert.equal(gatewayOnly.record.rule0Verdict.treatmentEdits, 0);
  assert.equal(gatewayOnly.record.rounds[0].gatewayOptimization.b.byKind.relevance_filter.applied, 1);
});

test('a hook that fired where it must not (any wrap on A, a foreign binary on B) leaves the round out of the stats', async () => {
  for (const wraps of [{ a: 1, b: 3, bOther: 0 }, { a: 0, b: 3, bOther: 1 }, { a: 0, b: 0, bOther: 2 }]) {
    const { record } = await hookRound({ wraps });
    const r = record.rounds[0];
    assert.deepEqual(r.hookLeak, { a: wraps.a, bOther: wraps.bOther });
    // Another connect's wraps are never B's treatment acting.
    assert.equal(r.optimization.otherApplied.codex_hooks_b, wraps.b > 0 ? 1 : 0);
    assert.equal(record.stats.n, 0);
    assert.equal(record.verdict.excludedByReason['hook leak'], 1);
    assert.match(exclusionReasons(r).join(), /hook leak/);
  }
});

test('--connect-bin-b configures arm B from that build, A from ANYRAY_CONNECT_BIN, both from a no-app profile, and records digests only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bin-b-'));
  try {
    const binB = join(dir, 'anyray-connect');
    writeFileSync(binB, '#!/bin/sh\n# build B\n');
    const seeded = [];
    const { record, seen } = await hookRound({ extra: ['--connect-bin-b', binB], deps: {
      binDigest: (bin) => ({ sha256: bin === binB ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa' }),
      seedNoAppProfile: (home) => seeded.push(home),
      checkArmBinary: () => [],
    } });
    assert.equal(seen.find((s) => s.slot === 'b').bin, binB);
    assert.notEqual(seen.find((s) => s.slot === 'a').bin, binB);
    assert.equal(seeded.length, 2, 'both arms start from the no-app profile');
    assert.deepEqual(record.request.connectBinB, { sha256: 'bbbbbbbbbbbbbbbb' });
    assert.deepEqual(record.setup.b.connectBin, { sha256: 'bbbbbbbbbbbbbbbb' });
    assert.deepEqual(record.setup.a.connectBin, { sha256: 'aaaaaaaaaaaaaaaa' });
    assert.ok(!JSON.stringify(record).includes(dir), 'never the path');
    // The same build on both arms is no treatment.
    await assert.rejects(hookRound({ extra: ['--connect-bin-b', binB], deps: { binDigest: () => ({ sha256: 'same' }) } }), /same build/);
    // A pinned arm whose connect commands run another build fails the round, naming it.
    const { record: off } = await hookRound({ extra: ['--connect-bin-b', binB], deps: {
      binDigest: (bin) => ({ sha256: bin === binB ? 'b' : 'a' }), seedNoAppProfile: () => {},
      checkArmBinary: ({ bin }) => (bin === binB ? [{ ok: false, required: true, name: 'hooks run the requested anyray-connect build', detail: 'runs another' }] : []),
    } });
    assert.match(off.rounds[0].error, /^B: .*requested anyray-connect build/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a hooked session passes the hook to every codex process and reports what it did from the arm home", async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-hooked-home-'));
  try {
    mkdirSync(join(home, '.anyray', 'hook-tee'), { recursive: true });
    for (const f of ['a.log', 'b.log']) writeFileSync(join(home, '.anyray', 'hook-tee', f), '');
    mkdirSync(join(home, '.anyray-bench'), { recursive: true });
    writeFileSync(join(home, '.anyray-bench', 'codex-hook-shim.log'), 'rewrite\npassthrough\nrewrite\n');
    const exe = `${home}/.anyray/bin/anyray-connect`;
    const wrapped = rollout({ id: 'main-w' }, [
      usageRecord(2, [1000, 0, 900, 10]),
      ITEM(3, ['/bin/zsh', '-lc', `HOME='${home}' ${exe} __anyray-shell-run --b64 eA== --codex`]),
      ITEM(4, ['/bin/zsh', '-lc', '/Users/x/.anyray/bin/anyray-connect __anyray-shell-run --b64 eA==']),
    ]);
    const argvs = [];
    const session = await runCodexAgent({
      arm: 'anyray', scenario: { task: 'T', followups: ['F'], timeoutMin: 5 }, work: '/w', gatewayUrl: 'https://g.invalid', clientKey: KEY, runTag: { sessionId: 's' },
      armHome: { ...armHome, home }, pricing, hook: { ...HOOK, connectExe: exe },
      runProcess: async (_bin, argv) => { argvs.push(argv); return { code: 0, stdout: [JSON.stringify({ type: 'thread.started', thread_id: 'main-w' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })].join('\n'), timedOut: false }; },
      readThreads: () => [readRollout(wrapped)],
    });
    assert.equal(argvs.length, 2);
    assert.ok(argvs.every((a) => a.includes('--enable') && !a.includes('--disable') && overrides(a)['hooks.PreToolUse']), 'the task and the resume both carry the hook');
    assert.deepEqual([session.totals.hookWraps, session.totals.hookWrapsOther], [2, 1]);
    assert.deepEqual(session.setup.codexHook, { shim: { calls: 3, rewrites: 2, passthrough: 1, standAside: 0, errors: 0 }, teeFiles: 2 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ANYRAY_CONNECT_BIN pins the build both Codex arms are configured from, as --connect-bin-b pins B', async () => {
  const seeded = [];
  const checked = [];
  const { record } = await hookRound({ deps: {
    connectBinPinned: true, seedNoAppProfile: (home) => seeded.push(home),
    checkArmBinary: ({ bin, home }) => { checked.push({ bin, home }); return []; },
  } });
  assert.equal(seeded.length, 2, 'an installed Connect app cannot take either configure over');
  assert.equal(checked.length, 2);
  assert.equal(new Set(checked.map((c) => c.bin)).size, 1, 'both arms must run the one pinned build');
  assert.ok(!record.rounds[0].error);
  // Unpinned (ANYRAY_CONNECT_BIN unset, no --connect-bin-b): connect configures as it would on this machine.
  const loose = [];
  await hookRound({ deps: { connectBinPinned: false, seedNoAppProfile: (home) => loose.push(home), checkArmBinary: () => { loose.push('check'); return []; } } });
  assert.deepEqual(loose, []);
});

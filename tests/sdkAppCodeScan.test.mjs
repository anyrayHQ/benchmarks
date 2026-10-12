import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ARMS, armEnvFor, armMcpServers, foldAppSession } from '../lib/agentSdkApp.mjs';
import { codeScanOptions, gradeKeyFacts, mainCodeScanPrompt, auditorSubagentDefinition, runCodeScanAgent, READ_TOOLS } from '../lib/sdkAppCodeScan.mjs';
import {
  CONNECT_MCP_SERVER,
  READ_BATCH_TOOL,
  connectArmTools,
  connectMcpServerConfig,
  probeMcpTools,
  prepareConnectHome,
} from '../lib/connectMcp.mjs';
import { NO_APP_PROFILE } from '../lib/agentRun.mjs';
import { parseArgs as parseAppArgs, SCENARIOS } from '../run_sdk_app.mjs';
import { pairsFor, readBatchPrecondition, compareFile, formatReport } from '../tools/compare-sdk-app.mjs';

const ROOT = join(import.meta.dirname, '..');
const DIR = join(ROOT, 'scenarios', 'sdk-app-code-scan');
const scenario = () => parseYaml(readFileSync(join(DIR, 'scenario.yaml'), 'utf8'));
const patchText = () => readFileSync(join(DIR, 'seeded-vulns.patch'), 'utf8');

const BIN = '/opt/fake/anyray-connect';
const HOME = '/opt/fake/connect-home';
const PROBED = [{ name: 'anyray_retrieve' }, { name: 'anyray_recall' }, { name: READ_BATCH_TOOL }];
const connectFor = () => ({ name: CONNECT_MCP_SERVER, server: connectMcpServerConfig({ home: HOME, bin: BIN, path: '/usr/bin' }), tools: connectArmTools(PROBED) });
const base = { scenario: { maxTurns: 16, subagentMaxTurns: 60, slices: [{ name: 's', files: ['a.py'] }], keyFacts: ['X'] }, work: '/work/checkout', model: 'claude-sonnet-5-5', gatewayUrl: 'https://gw.example', sessionId: 'sid' };
const READ_BATCH = `mcp__${CONNECT_MCP_SERVER}__${READ_BATCH_TOOL}`;

// --- the scenario and its seeded patch --------------------------------------------------

test('the scenario pins a repo, hides its patch, and names three slices and nine key facts', () => {
  const s = scenario();
  assert.match(s.repo.ref, /^[0-9a-f]{40}$/);
  assert.equal(s.patch, 'seeded-vulns.patch');
  assert.equal(s.hidePatch, true);
  assert.equal(s.slices.length, 3);
  assert.equal(s.keyFacts.length, 9);
  assert.equal(new Set(s.keyFacts).size, 9);
  assert.ok(s.maxTurns > 0 && s.subagentMaxTurns > 0 && s.timeoutMin > 0);
});

test('every key fact is planted by the patch on an added line, in a file of exactly one slice, three per slice', () => {
  const s = scenario();
  const files = new Map(s.slices.flatMap((sl, i) => sl.files.map((f) => [f, i])));
  // Added lines by file, and every line the patch keeps or removes.
  const added = new Map();
  const kept = [];
  let file = null;
  for (const line of patchText().split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = m[1];
      continue;
    }
    if (line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.set(file, [...(added.get(file) ?? []), line]);
    else kept.push(line);
  }
  const perSlice = s.slices.map(() => 0);
  for (const fact of s.keyFacts) {
    const where = [...added].filter(([, lines]) => lines.some((l) => l.includes(fact))).map(([f]) => f);
    assert.equal(where.length, 1, `${fact} must be planted in exactly one file, found ${where.join(', ') || 'none'}`);
    assert.ok(files.has(where[0]), `${fact} is planted in ${where[0]}, which no slice audits`);
    perSlice[files.get(where[0])]++;
    // Only the seeded lines may carry it: a context or removed line would mean the fact
    // predates the patch and an unplanted line could earn the point.
    assert.ok(!kept.some((l) => l.includes(fact)), `${fact} appears on a line the patch did not add`);
  }
  assert.deepEqual(perSlice, [3, 3, 3]);
});

test('the main prompt dispatches one auditor per slice in a single response and names every file', () => {
  const s = scenario();
  const p = mainCodeScanPrompt(s.slices);
  assert.match(p, /SINGLE response/);
  assert.match(p, /exactly 3 `auditor` subagents in parallel/);
  for (const f of s.slices.flatMap((sl) => sl.files)) assert.ok(p.includes(f), `prompt must name ${f}`);
  assert.throws(() => mainCodeScanPrompt([]), /slices/);
});

// --- grading ----------------------------------------------------------------------------

test('gradeKeyFacts grades as run_agent does: case-sensitive substrings, solved only on all', () => {
  const facts = ['break_glass', '_LEGACY_ROOT_PREFIX'];
  assert.deepEqual(gradeKeyFacts('', facts), { total: 2, found: [], missed: facts, recall: 0, solved: false });
  assert.equal(gradeKeyFacts('see break_glass', facts).recall, 1);
  assert.equal(gradeKeyFacts('BREAK_GLASS and _legacy_root_prefix', facts).recall, 0);
  const all = gradeKeyFacts('break_glass … _LEGACY_ROOT_PREFIX', facts);
  assert.equal(all.solved, true);
  assert.equal(gradeKeyFacts('x', []).solved, false, 'a scenario with no facts can never be solved');
});

// --- connect's MCP server mount ---------------------------------------------------------

test('connectMcpServerConfig starts connect as the Claude source in the connect HOME, with no key in its env', () => {
  const c = connectMcpServerConfig({ home: HOME, bin: BIN, path: '/usr/bin' });
  assert.equal(c.type, 'stdio');
  assert.equal(c.command, BIN);
  assert.deepEqual(c.args, ['__anyray-mcp-server', 'claude']);
  assert.deepEqual(c.env, { PATH: '/usr/bin', HOME: HOME, ANYRAY_REFRESH_DISABLE: 'true' });
  assert.equal(c.alwaysLoad, true);
});

test('connectArmTools offers the batch read only and disallows the rest of what connect lists', () => {
  const t = connectArmTools(PROBED);
  assert.deepEqual(t.allowed, [READ_BATCH]);
  assert.deepEqual(t.disallowed, [`mcp__${CONNECT_MCP_SERVER}__anyray_retrieve`, `mcp__${CONNECT_MCP_SERVER}__anyray_recall`]);
  assert.deepEqual(connectArmTools(['anyray_read_batch']).disallowed, []);
  // A server without the batch read would make D a renamed B: refused.
  assert.throws(() => connectArmTools([{ name: 'anyray_retrieve' }, { name: 'anyray_recall' }]), /does not advertise anyray_read_batch/);
  assert.throws(() => connectArmTools(undefined), /does not advertise/);
});

test('probeMcpTools lists a real stdio server the way Claude Code starts one', async () => {
  const r = await probeMcpTools({ command: process.execPath, args: [join(ROOT, 'tools', 'mcp-catalog-server.mjs'), '3'], env: { PATH: process.env.PATH } });
  assert.equal(r.error, undefined);
  assert.equal(r.serverInfo, 'bench-catalog');
  assert.equal(r.tools.length, 3);
  for (const t of r.tools) assert.deepEqual(Object.keys(t).sort(), ['alwaysLoad', 'name'], 'names and the load flag only, never a description');
  // With a call: its size and whether it errored, never its text.
  const c = await probeMcpTools({ command: process.execPath, args: [join(ROOT, 'tools', 'mcp-catalog-server.mjs'), '3'], env: { PATH: process.env.PATH }, call: { name: r.tools[0].name, arguments: {} } });
  assert.deepEqual(c.call, { isError: false, chars: 'No matching records.'.length, header: null });
});

test('probeMcpTools reports a server that exits or never answers, without throwing', async () => {
  const exited = await probeMcpTools({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} });
  assert.match(exited.error, /exited 3/);
  const silent = await probeMcpTools({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, timeoutMs: 300 });
  assert.equal(silent.error, 'timeout');
  const missing = await probeMcpTools({ command: '/nonexistent/anyray-connect', env: {} });
  assert.match(missing.error, /spawn failed/);
});

test('prepareConnectHome enrolls a private HOME on the org lane with the D key, always from the no-app profile', () => {
  const parent = mkdtempSync(join(tmpdir(), 'connect-parent-'));
  try {
    const calls = [];
    const configure = (a) => {
      calls.push(a);
      return { configured: true, setup: { lane: a.lane }, checks: [{ name: 'c', ok: true }] };
    };
    const r = prepareConnectHome({ gatewayUrl: 'https://gw.example', clientKey: 'ark_svc_synthetic', parent, bin: BIN, binPinned: true, configure });
    assert.equal(r.configured, true);
    assert.ok(realpathSync(r.home).startsWith(realpathSync(parent) + sep), 'the HOME is under the bench session dir');
    assert.equal(calls.length, 1);
    assert.deepEqual({ home: calls[0].home, gatewayUrl: calls[0].gatewayUrl, clientKey: calls[0].clientKey, lane: calls[0].lane, bin: calls[0].bin }, { home: r.home, gatewayUrl: 'https://gw.example', clientKey: 'ark_svc_synthetic', lane: 'org', bin: BIN });
    assert.equal(readFileSync(join(r.home, NO_APP_PROFILE.path), 'utf8'), NO_APP_PROFILE.content);
    // Unpinned too: D runs `bin` itself, so no installed app may enroll in its place. A
    // refused enrollment comes back with its reason.
    const no = prepareConnectHome({ gatewayUrl: 'https://gw.example', clientKey: 'k', parent, bin: BIN, binPinned: false, configure: () => ({ configured: false, reason: 'no service key' }) });
    assert.deepEqual({ configured: no.configured, reason: no.reason }, { configured: false, reason: 'no service key' });
    assert.equal(readFileSync(join(no.home, NO_APP_PROFILE.path), 'utf8'), NO_APP_PROFILE.content);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// --- arm D's options --------------------------------------------------------------------

test('arm D is arm B on the wire: same harness-retrieval header, no optimize bypass', () => {
  assert.equal(ARMS.D.harnessRetrieval, ARMS.B.harnessRetrieval);
  assert.equal(ARMS.D.optimize, null);
  assert.equal(ARMS.D.readPath, true);
  assert.equal(ARMS.D.localReadBatch, true);
  const env = (arm) => armEnvFor({ arm, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic', model: 'm', sessionId: 'sid' });
  assert.deepEqual(env('D'), env('B'));
});

test('codeScanOptions D: the gateway read path, connect mounted, the batch read offered to every agent, connect retrieval hidden', () => {
  const o = codeScanOptions({ ...base, arm: 'D', clientKey: 'ark_synthetic-d', connect: connectFor() });
  assert.deepEqual(Object.keys(o.mcpServers).sort(), ['anyray', CONNECT_MCP_SERVER].sort());
  assert.equal(o.mcpServers.anyray.url, 'https://gw.example/mcp');
  assert.deepEqual(o.mcpServers[CONNECT_MCP_SERVER], connectFor().server);
  assert.deepEqual(o.allowedTools, ['Task', ...READ_TOOLS, 'ReportFindings', 'mcp__anyray__anyray_retrieve', 'mcp__anyray__anyray_recall', READ_BATCH]);
  assert.deepEqual(o.disallowedTools, [`mcp__${CONNECT_MCP_SERVER}__anyray_retrieve`, `mcp__${CONNECT_MCP_SERVER}__anyray_recall`]);
  assert.ok(o.agents.auditor.tools.includes(READ_BATCH), 'the auditors are the readers: they get the batch read');
  assert.equal(o.agents.auditor.maxTurns, 60);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.permissionMode, 'bypassPermissions');
  assert.equal(o.cwd, '/work/checkout');
  assert.equal(o.maxTurns, 16);
  assert.ok(!JSON.stringify(o.mcpServers[CONNECT_MCP_SERVER]).includes('ark_synthetic-d'), "the key never rides connect's server entry");
});

test('D differs from B by exactly the connect server, the batch read, and the hidden connect tools', () => {
  const b = codeScanOptions({ ...base, arm: 'B', clientKey: 'ark_synthetic', connect: connectFor() });
  const d = codeScanOptions({ ...base, arm: 'D', clientKey: 'ark_synthetic', connect: connectFor() });
  assert.ok(!(CONNECT_MCP_SERVER in b.mcpServers), 'B ignores a connect mount');
  assert.equal(b.disallowedTools, undefined);
  assert.ok(!b.allowedTools.includes(READ_BATCH));
  const { [CONNECT_MCP_SERVER]: _, ...dServers } = d.mcpServers;
  assert.deepEqual(dServers, b.mcpServers);
  assert.deepEqual(d.allowedTools.filter((t) => t !== READ_BATCH), b.allowedTools);
  assert.deepEqual(d.agents.auditor.tools.filter((t) => t !== READ_BATCH), b.agents.auditor.tools);
  assert.deepEqual(d.env, b.env);
  const { mcpServers: _m1, allowedTools: _a1, agents: _g1, disallowedTools: _x, ...dRest } = d;
  const { mcpServers: _m2, allowedTools: _a2, agents: _g2, ...bRest } = b;
  assert.deepEqual(dRest, bRest);
});

test('codeScanOptions A and C: A has the read path with the harness off; C has no Anyray tools at all', () => {
  const a = codeScanOptions({ ...base, arm: 'A', clientKey: 'ark_synthetic-a' });
  assert.match(a.env.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval: off/);
  assert.deepEqual(Object.keys(a.mcpServers), ['anyray']);
  const c = codeScanOptions({ ...base, arm: 'C', clientKey: 'ark_synthetic-c' });
  assert.deepEqual(c.mcpServers, {});
  assert.deepEqual(c.allowedTools, ['Task', ...READ_TOOLS, 'ReportFindings']);
  assert.deepEqual(c.agents.auditor.tools, [...READ_TOOLS, 'ReportFindings']);
});

test('armMcpServers refuses D without a connect mount, and a mount whose name is taken', () => {
  assert.throws(() => armMcpServers({ arm: 'D', gatewayUrl: 'https://gw.example', clientKey: 'k' }), /connect/);
  assert.throws(() => codeScanOptions({ ...base, arm: 'D', clientKey: 'k' }), /connect/);
  assert.throws(() => armMcpServers({ arm: 'D', gatewayUrl: 'https://gw.example', clientKey: 'k', connect: { ...connectFor(), name: 'anyray' } }), /already taken/);
});

test('auditorSubagentDefinition omits a non-positive turn cap', () => {
  assert.equal('maxTurns' in auditorSubagentDefinition([], {}), false);
  assert.equal('maxTurns' in auditorSubagentDefinition([], { maxTurns: 0 }), false);
  assert.equal(auditorSubagentDefinition(['x'], { maxTurns: 5 }).maxTurns, 5);
});

// --- the session record -----------------------------------------------------------------

const usage = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 };
const pricing = { cache_read: 0.1, cache_write: 1.25, models: { 'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.05 } } };

test('foldAppSession counts tool calls by agent and the batch read calls that errored', () => {
  const s = foldAppSession([
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', model: 'claude-sonnet-5-5', usage, content: [
      { type: 'tool_use', id: 'r1', name: READ_BATCH, input: {} },
      { type: 'tool_use', id: 'r2', name: READ_BATCH, input: {} },
      { type: 'tool_use', id: 'r3', name: 'Read', input: {} },
    ] } },
    { type: 'user', parent_tool_use_id: 't1', message: { content: [
      { type: 'tool_result', tool_use_id: 'r1', is_error: false, content: 'x' },
      { type: 'tool_result', tool_use_id: 'r2', is_error: true, content: 'Batch read failed' },
    ] } },
    { type: 'result', subtype: 'success', num_turns: 2, result: '' },
  ], { pricing, model: 'claude-sonnet-5-5' });
  assert.deepEqual(s.totals.toolCalls, { main: { Task: 1 }, subagents: { [READ_BATCH]: 2, Read: 1 } });
  assert.deepEqual(s.totals.readBatch, { calls: 2, errors: 1 });
});

test('runCodeScanAgent runs D with its options in its checkout and grades findings from every agent', async () => {
  const s = scenario();
  let seen = null;
  const facts = s.keyFacts;
  const query = ({ prompt, options }) => {
    seen = { prompt, options };
    return (async function* () {
      yield { type: 'system', subtype: 'init', tools: ['Task', 'Read', READ_BATCH, 'mcp__anyray__anyray_retrieve'], mcp_servers: [{ name: CONNECT_MCP_SERVER, status: 'connected' }, { name: 'anyray', status: 'connected' }] };
      yield { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', model: 'claude-sonnet-5-5', usage, content: [
        { type: 'tool_use', id: 'f1', name: 'ReportFindings', input: { findings: [{ file: 'salt/auth/__init__.py', line: 532, summary: `bypass: if load["eauth"] == "${facts[0]}"`, failure_scenario: 'x' }] } },
      ] } };
      yield { type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', is_error: false, content: 'ok' }] } };
      yield { type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.01, result: `Report: ${facts.slice(1).join(', ')}` };
    })();
  };
  const r = await runCodeScanAgent({ arm: 'D', scenario: s, work: '/work/d', model: 'claude-sonnet-5-5', gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic', sessionId: 'sid-d', pricing, connect: connectFor(), deps: { query } });
  assert.equal(seen.options.cwd, '/work/d');
  assert.ok(seen.options.allowedTools.includes(READ_BATCH));
  assert.ok(seen.prompt.includes(s.slices[0].files[0]));
  assert.equal(r.completed, true);
  assert.equal(r.recall, facts.length);
  assert.equal(r.solved, true);
  assert.deepEqual(r.init.mcpServers, [{ name: CONNECT_MCP_SERVER, status: 'connected' }, { name: 'anyray', status: 'connected' }]);
  assert.deepEqual(r.init.anyrayTools, [READ_BATCH, 'mcp__anyray__anyray_retrieve']);
});

// --- the runner and the comparison ------------------------------------------------------

test('run_sdk_app: the code-scan lane runs A,D by default and accepts D; the scanner refuses D', () => {
  assert.deepEqual(parseAppArgs(['--scenario', 'sdk-app-code-scan', '--keys-dir', '/k']).arms, ['A', 'D']);
  assert.deepEqual(parseAppArgs(['--scenario', 'sdk-app-code-scan', '--arms', 'd,b,a', '--keys-dir', '/k']).arms, ['A', 'B', 'D']);
  assert.deepEqual(parseAppArgs(['--keys-dir', '/k']).arms, ['A', 'B', 'C'], 'the scanner default is unchanged');
  assert.equal(parseAppArgs(['--keys-dir', '/k']).scenario, 'sdk-app-scanner');
  assert.throws(() => parseAppArgs(['--arms', 'A,D', '--keys-dir', '/k']), /runs arms A, B, C, not D/);
  assert.throws(() => parseAppArgs(['--scenario', 'nope', '--keys-dir', '/k']), /--scenario takes one of/);
  for (const [name, lane] of Object.entries(SCENARIOS)) {
    assert.ok(existsSync(join(ROOT, 'scenarios', name, 'scenario.yaml')), `${name} has a scenario file`);
    for (const arm of lane.defaultArms) assert.ok(lane.arms.includes(arm));
  }
});

const roundWith = (round, d, b = 1) => ({
  round,
  sessions: { B: { totals: { costUsd: b } }, D: { totals: { costUsd: 0.8, readBatch: d } } },
  quality: { B: true, D: true },
  recall: { B: 9, D: 9 },
});

test('compare: D pairs against B (the batch read alone) and A, and its precondition is that the batch read ran', () => {
  assert.deepEqual(pairsFor(['A', 'D']), [['D', 'A']]);
  assert.deepEqual(pairsFor(['A', 'B', 'C', 'D']), [['B', 'A'], ['B', 'C'], ['A', 'C'], ['D', 'B'], ['D', 'A']]);
  const rounds = [
    roundWith(1, { calls: 4, errors: 0 }),
    roundWith(2, { calls: 2, errors: 2 }), // every call errored: did not run
    roundWith(3, { calls: 0, errors: 0 }),
    roundWith(4, undefined), // no count recorded: not proof
  ];
  assert.deepEqual(readBatchPrecondition(rounds), { sessions: 4, used: 1, usedRounds: [1], required: 2, pass: false });
  assert.equal(readBatchPrecondition([roundWith(1, { calls: 1, errors: 0 })]).pass, true);
  assert.equal(readBatchPrecondition([{ round: 1, sessions: { A: { totals: { costUsd: 1 } } } }]).pass, false);
  const out = compareFile({ scenario: 'sdk-app-code-scan', model: 'm', arms: ['B', 'D'], rounds: rounds.slice(0, 1) });
  assert.equal(out.pairs[0].treatment, 'D');
  const text = formatReport(out);
  assert.match(text, /^sdk-app-code-scan \[B,D\]/);
  assert.match(text, /read_batch precondition .*1\/1, need 1 -> PASS/);
});

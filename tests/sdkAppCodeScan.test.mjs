import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { ARMS, armEnvFor, armMcpServers, foldAppSession, batchReadFailureCode } from '../lib/agentSdkApp.mjs';
import { codeScanOptions, gradeKeyFacts, mainCodeScanPrompt, auditorSubagentDefinition, runCodeScanAgent, READ_TOOLS } from '../lib/sdkAppCodeScan.mjs';
import {
  CONNECT_MCP_SERVER,
  READ_BATCH_TOOL,
  connectArmTools,
  connectMcpServerConfig,
  probeMcpTools,
  prepareConnectHome,
  enrollConnectProfile,
  connectSourceOf,
  instructionsExpectedFor,
  preflightReadBatchCall,
  checkPreflightRead,
} from '../lib/connectMcp.mjs';
import { NO_APP_PROFILE } from '../lib/agentRun.mjs';
import { startFakeMessagesApi } from '../lib/fakeMessagesApi.mjs';
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
const base = { scenario: { maxTurns: 16, subagentMaxTurns: 60, slices: [{ name: 's', audit: [{ file: 'a.py', functions: ['f'] }] }], keyFacts: ['X'] }, work: '/work/checkout', model: 'claude-sonnet-5-5', gatewayUrl: 'https://gw.example', sessionId: 'sid' };
const READ_BATCH = `mcp__${CONNECT_MCP_SERVER}__${READ_BATCH_TOOL}`;

// --- the scenario and its seeded patch --------------------------------------------------

test('the scenario pins a repo, hides its patch, and names three slices of functions and nine key facts', () => {
  const s = scenario();
  assert.match(s.repo.ref, /^[0-9a-f]{40}$/);
  assert.equal(s.patch, 'seeded-vulns.patch');
  assert.equal(s.hidePatch, true);
  assert.equal(s.slices.length, 3);
  for (const sl of s.slices) {
    assert.ok(sl.audit.length > 0, `${sl.name} audits something`);
    for (const a of sl.audit) assert.ok(a.file && a.functions.length > 0, `${sl.name}: ${a.file} names functions`);
  }
  assert.equal(s.keyFacts.length, 9);
  assert.equal(new Set(s.keyFacts).size, 9);
  assert.deepEqual(s.seeded.map((x) => x.fact).sort(), [...s.keyFacts].sort(), 'every fact has a seeded entry');
  assert.ok(s.maxTurns > 0 && s.subagentMaxTurns > 0 && s.timeoutMin > 0);
});

/** The patch's added lines per file, each with its line number in the patched file, and every line it keeps or removes. */
const patchLines = () => {
  const added = new Map();
  const kept = [];
  let file = null;
  let line = 0;
  for (const l of patchText().split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(l);
    if (f) {
      file = f[1];
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) continue;
    if (l.startsWith('+')) {
      added.set(file, [...(added.get(file) ?? []), { n: line, text: l.slice(1) }]);
      line++;
    } else if (l.startsWith('-')) kept.push(l);
    else {
      kept.push(l);
      line++;
    }
  }
  return { added, kept };
};

test('each vulnerability sits behind a call chain: the audited file calls a helper whose deciding constant is only in another range, deep in its module', () => {
  const s = scenario();
  const { added, kept } = patchLines();
  const audited = (i) => new Set(s.slices[i].audit.map((a) => a.file));
  const perSlice = s.slices.map(() => 0);
  let pastOnePage = 0;
  for (const { fact, slice, sink, helper, definedIn } of s.seeded) {
    perSlice[slice]++;
    assert.ok(audited(slice).has(sink), `${fact}: ${sink} is audited by slice ${slice}`);
    // Planted only where the helper is defined, on added lines: no audited line shows it.
    const where = [...added].filter(([, lines]) => lines.some((l) => l.text.includes(fact))).map(([f]) => f);
    assert.deepEqual(where, [definedIn], `${fact} must be planted in ${definedIn} only, found ${where.join(', ') || 'none'}`);
    assert.ok(!kept.some((l) => l.includes(fact)), `${fact} appears on a line the patch did not add`);
    // The helper is defined at the end of its module: past line 400 always, past one Read page (1,000 lines) for most.
    const def = defLine(added, definedIn, helper);
    assert.ok(def > 400, `${helper} is defined at ${definedIn}:${def}, not deep`);
    // The audited file calls the helper (an added line) without naming the constant: in
    // the one slice where both live in one file, the call sits far above the definition.
    const callSite = (added.get(sink) ?? []).filter((l) => l.text.trim() && (sink !== definedIn || l.n < def));
    assert.ok(callSite.some((l) => l.text.includes(`${helper}(`)), `${sink} must call ${helper}`);
    assert.ok(!callSite.some((l) => l.text.includes(fact)), `${sink}'s call site must not show ${fact}`);
    if (sink === definedIn) assert.ok(def - Math.max(...callSite.map((l) => l.n)) > 1000, `${helper}'s definition is not a page away from its call`);
    if (def > 1000) pastOnePage++;
  }
  assert.deepEqual(perSlice, [3, 3, 3]);
  assert.ok(pastOnePage >= 8, `only ${pastOnePage} of 9 helpers sit past line 1,000`);
});

/** The patched-file line of `def <helper>(` among the patch's added lines. */
const defLine = (added, file, helper) => (added.get(file) ?? []).find((l) => l.text.startsWith(`def ${helper}(`))?.n ?? 0;

test('the main prompt dispatches one auditor per slice in a single response and names the functions, never the helpers or their modules', () => {
  const s = scenario();
  const p = mainCodeScanPrompt(s.slices);
  assert.match(p, /SINGLE response/);
  assert.match(p, /exactly 3 `auditor` subagents in parallel/);
  for (const a of s.slices.flatMap((sl) => sl.audit)) {
    assert.ok(p.includes(a.file), `prompt must name ${a.file}`);
    for (const f of a.functions) assert.ok(p.includes(f), `prompt must name ${f}`);
  }
  for (const { helper, definedIn, fact, sink } of s.seeded) {
    assert.ok(!p.includes(helper), `prompt must not name ${helper}`);
    assert.ok(!p.includes(fact), `prompt must not name ${fact}`);
    if (definedIn !== sink) assert.ok(!p.includes(definedIn), `prompt must not name ${definedIn}`);
  }
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

// A stand-in for connect's spawn: records argv and env, writes the profile a service-key
// apply commits before any adapter runs, and prints the NDJSON `applied` event. `connected`
// is empty by default: the D HOME has no ~/.claude, so connect configures no client.
const fakeRun = ({ status = 0, connected = [], applied = true, profile = (env) => ({ gateway: 'https://gw.example', clientKey: env.ANYRAY_CLIENT_KEY }), stderr = '' } = {}) => {
  const calls = [];
  const run = (bin, args, opts) => {
    calls.push({ bin, args, env: opts.env });
    const prof = profile(opts.env);
    if (prof) {
      mkdirSync(join(opts.env.HOME, '.anyray'), { recursive: true });
      writeFileSync(join(opts.env.HOME, '.anyray', 'connect.json'), JSON.stringify(prof));
    }
    const event = { event: 'applied', connected, queued: [], held: [], manual: [], failed: [], keyKind: 'service' };
    return { status, stdout: applied ? `${JSON.stringify(event)}\n` : '', stderr };
  };
  return { run, calls };
};

const withHome = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'connect-d-'));
  const bin = join(dir, 'anyray-connect');
  writeFileSync(bin, '');
  const home = join(dir, 'home');
  mkdirSync(home);
  try {
    return fn({ dir, bin, home });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('enrollConnectProfile: the agent-host apply, accepted with NO client configured once the profile names the gateway and D key', () => {
  withHome(({ bin, home }) => {
    const { run, calls } = fakeRun();
    const r = enrollConnectProfile({ home, gatewayUrl: 'https://gw.example', clientKey: 'ark_svc_synthetic-d', bin, realHome: '/nonexistent-real-home', run });
    assert.equal(r.configured, true, r.reason);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['--gateway', 'https://gw.example', '--tools', 'claude-code', '--org', '--yes', '--json']);
    assert.equal(calls[0].env.HOME, home);
    assert.equal(calls[0].env.ANYRAY_CLIENT_KEY, 'ark_svc_synthetic-d');
    assert.ok(!calls[0].args.join(' ').includes('ark_svc_synthetic-d'), 'the key rides the env, never argv');
    assert.deepEqual(r.setup.connected, []);
    assert.equal(r.setup.keyKind, 'service');
    assert.deepEqual(r.setup.profile, { gatewayMatches: true, keyMatches: true });
    assert.ok(!JSON.stringify(r).includes('ark_svc_synthetic-d'), 'the result never carries the key');
  });
});

test('enrollConnectProfile refuses an apply that did not enroll the profile D needs', () => {
  const refused = (opts, home, bin) => enrollConnectProfile({ home, gatewayUrl: 'https://gw.example', clientKey: 'ark_svc_synthetic-d', bin, realHome: '/nonexistent-real-home', ...opts });
  withHome(({ bin, home }) => {
    const exit = refused({ run: fakeRun({ status: 1, applied: false, stderr: 'rejected key ark_svc_synthetic-d' }).run }, home, bin);
    assert.equal(exit.configured, false);
    assert.match(exit.reason, /exited 1/);
    assert.ok(!exit.reason.includes('ark_svc_synthetic-d'), 'a reason quoting the key is scrubbed');
  });
  withHome(({ bin, home }) => assert.match(refused({ run: fakeRun({ applied: false }).run }, home, bin).reason, /no applied event/));
  withHome(({ bin, home }) => assert.match(refused({ run: fakeRun({ profile: () => null }).run }, home, bin).reason, /no profile/));
  withHome(({ bin, home }) => assert.match(refused({ run: fakeRun({ profile: (env) => ({ gateway: 'https://other.example', clientKey: env.ANYRAY_CLIENT_KEY }) }).run }, home, bin).reason, /gateway/));
  withHome(({ bin, home }) => assert.match(refused({ run: fakeRun({ profile: () => ({ gateway: 'https://gw.example', clientKey: 'ark_svc_synthetic-other' }) }).run }, home, bin).reason, /key/));
  withHome(({ bin, home }) => {
    // A ~/.claude in the HOME would let connect write Claude Code config there: refused before running it.
    mkdirSync(join(home, '.claude'));
    const { run, calls } = fakeRun();
    assert.match(refused({ run }, home, bin).reason, /\.claude/);
    assert.equal(calls.length, 0);
  });
  withHome(({ home }) => assert.match(refused({ run: fakeRun().run }, home, '/nonexistent/anyray-connect').reason, /not found/));
  withHome(({ bin, home }) => assert.match(refused({ run: fakeRun().run, clientKey: '' }, home, bin).reason, /no key/));
  // Never the real HOME.
  withHome(({ bin, home }) => assert.throws(() => enrollConnectProfile({ home, gatewayUrl: 'https://gw.example', clientKey: 'k', bin, realHome: home, run: fakeRun().run }), /real HOME/));
});

test('prepareConnectHome enrolls a private HOME with the profile-only enrollment by default, always from the no-app profile', () => {
  const parent = mkdtempSync(join(tmpdir(), 'connect-parent-'));
  try {
    const bin = join(parent, 'anyray-connect');
    writeFileSync(bin, '');
    // The dev-gateway failure this guards: connect applied with no client connected.
    const { run, calls } = fakeRun({ connected: [] });
    const r = prepareConnectHome({ gatewayUrl: 'https://gw.example', clientKey: 'ark_svc_synthetic', parent, bin, run });
    assert.equal(r.configured, true, r.reason);
    assert.ok(realpathSync(r.home).startsWith(realpathSync(parent) + sep), 'the HOME is under the bench session dir');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.HOME, r.home);
    assert.ok(!existsSync(join(r.home, '.claude')), 'no Claude Code config in the connect HOME');
    // D runs `bin` itself, so no installed app may enroll in its place: the no-app profile
    // is in place before connect runs.
    const seen = [];
    const no = prepareConnectHome({
      gatewayUrl: 'https://gw.example',
      clientKey: 'k',
      parent,
      bin,
      configure: (a) => {
        seen.push(readFileSync(join(a.home, NO_APP_PROFILE.path), 'utf8'));
        return { configured: false, reason: 'no service key' };
      },
    });
    assert.deepEqual(seen, [NO_APP_PROFILE.content]);
    assert.deepEqual({ configured: no.configured, reason: no.reason }, { configured: false, reason: 'no service key' });
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
      { type: 'tool_result', tool_use_id: 'r2', is_error: true, content: [{ type: 'text', text: 'Batch read failed: unsafe_path (only files inside the workspace); no files returned.' }] },
    ] } },
    { type: 'result', subtype: 'success', num_turns: 2, result: '' },
  ], { pricing, model: 'claude-sonnet-5-5' });
  assert.deepEqual(s.totals.toolCalls, { main: { Task: 1 }, subagents: { [READ_BATCH]: 2, Read: 1 } });
  assert.deepEqual(s.totals.readBatch, { calls: 2, errors: 1, errorCodes: { unsafe_path: 1 } });
});

test('batchReadFailureCode reads the code only where connect writes it, at the start of the result', () => {
  assert.equal(batchReadFailureCode('Batch read failed: file_too_large (entry 2; limit 16384 bytes per file); no files returned.'), 'file_too_large');
  assert.equal(batchReadFailureCode([{ type: 'text', text: 'Batch read failed: unsafe_path; no files returned.' }]), 'unsafe_path');
  // Text that quotes the phrase is not a failure code, and nothing else of it is kept.
  assert.equal(batchReadFailureCode('the tool said "Batch read failed: unsafe_path"'), 'other');
  assert.equal(batchReadFailureCode('<tool_use_error>Error: something else</tool_use_error>'), 'other');
  assert.equal(batchReadFailureCode(undefined), 'other');
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
  assert.ok(seen.prompt.includes(s.slices[0].audit[0].file));
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

// The Agent SDK streams one assistant event per content block, every one carrying the
// message_start usage (output_tokens a placeholder). Found on the arm D smoke: 14 requests
// recorded 139 output tokens and three spawns from one response read as maxParallelSpawn 1.
const blockEvent = (id, agent, block, outputTokens = 3) => ({
  type: 'assistant',
  parent_tool_use_id: agent,
  message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: outputTokens }, content: [block] },
});

test('foldAppSession counts spawns per response, not per streamed block', () => {
  const s = foldAppSession([
    blockEvent('m1', null, { type: 'tool_use', id: 't1', name: 'Agent', input: {} }),
    blockEvent('m1', null, { type: 'tool_use', id: 't2', name: 'Agent', input: {} }),
    blockEvent('m1', null, { type: 'tool_use', id: 't3', name: 'Agent', input: {} }),
    blockEvent('m2', null, { type: 'tool_use', id: 't4', name: 'Agent', input: {} }),
    { type: 'result', subtype: 'success', num_turns: 2, result: '' },
  ], { pricing, model: 'claude-sonnet-5-5' });
  assert.equal(s.totals.requests, 2);
  assert.equal(s.totals.subagentSpawns, 4);
  assert.equal(s.totals.maxParallelSpawn, 3);
  assert.equal(s.totals.spawnedInParallel, true);
});

test("foldAppSession prices the session from the result's modelUsage, which carries the real output tokens", () => {
  const messages = [
    blockEvent('m1', null, { type: 'text', text: 'a' }),
    blockEvent('s1', 't1', { type: 'text', text: 'b' }),
    {
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      total_cost_usd: 0.5,
      result: '',
      modelUsage: { 'claude-sonnet-5-5': { inputTokens: 20, outputTokens: 4000, cacheReadInputTokens: 2000, cacheCreationInputTokens: 1000, webSearchRequests: 0, costUSD: 0.5, contextWindow: 200000, maxOutputTokens: 64000 } },
    },
  ];
  const s = foldAppSession(messages, { pricing, model: 'claude-sonnet-5-5' });
  // 20 + 2000 * 0.05 + 1000 * 1.25 = 1370 input units at $2/M, 4000 output at $10/M.
  const expected = (1370 * 2 + 4000 * 10) / 1e6;
  assert.ok(Math.abs(s.totals.costUsd - expected) < 1e-12, `${s.totals.costUsd} vs ${expected}`);
  assert.equal(s.totals.costSource, 'modelUsage');
  assert.equal(s.totals.output, 4000);
  // The per-request sum stays, labelled: its output is the stream's placeholder.
  assert.equal(s.totals.requestOutput, 6);
  assert.ok(s.totals.requestCostUsd < s.totals.costUsd);
  // The request-level cache counts and modelUsage's agree when modelUsage covers every agent.
  assert.deepEqual(s.totals.modelUsage, { 'claude-sonnet-5-5': { input: 20, output: 4000, cacheRead: 2000, cacheWrite: 1000, costUsd: 0.5 } });
});

test('foldAppSession falls back to the per-request sum when the result carries no modelUsage, and says so', () => {
  const s = foldAppSession([blockEvent('m1', null, { type: 'text', text: 'a' }, 7), { type: 'result', subtype: 'success', num_turns: 1, result: '' }], { pricing, model: 'claude-sonnet-5-5' });
  assert.equal(s.totals.costSource, 'requests');
  assert.equal(s.totals.output, 7);
  assert.equal(s.totals.costUsd, s.totals.requestCostUsd);
  // An unpriced model in modelUsage gives no cost rather than a partial one.
  const u = foldAppSession([{ type: 'result', subtype: 'success', num_turns: 1, result: '', modelUsage: { 'unknown-model': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } } }], { pricing, model: 'claude-sonnet-5-5' });
  assert.equal(u.totals.costUsd, null);
  assert.equal(u.totals.costSource, 'modelUsage');
});

// --- arm E (D′): D with connect's `sdk` source, whose initialize carries instructions ---

test('arm E is arm D with the sdk source: same wire, same tools, a different server registration', () => {
  assert.deepEqual({ ...ARMS.E, connectSource: undefined }, { ...ARMS.D, connectSource: undefined });
  assert.equal(ARMS.E.connectSource, 'sdk');
  assert.equal(ARMS.D.connectSource, undefined, "arm D's definition is unchanged");
  assert.equal(connectSourceOf('D'), 'claude');
  assert.equal(connectSourceOf('E'), 'sdk');
  const env = (arm) => armEnvFor({ arm, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic', model: 'm', sessionId: 'sid' });
  assert.deepEqual(env('E'), env('D'));
  const e = connectMcpServerConfig({ home: HOME, bin: BIN, path: '/usr/bin', source: connectSourceOf('E') });
  assert.deepEqual(e.args, ['__anyray-mcp-server', 'sdk']);
  assert.deepEqual({ ...e, args: null }, { ...connectFor().server, args: null });
  const mount = { ...connectFor(), server: e };
  const oe = codeScanOptions({ ...base, arm: 'E', clientKey: 'ark_synthetic', connect: mount });
  const od = codeScanOptions({ ...base, arm: 'D', clientKey: 'ark_synthetic', connect: connectFor() });
  assert.deepEqual(oe.allowedTools, od.allowedTools);
  assert.deepEqual(oe.disallowedTools, od.disallowedTools);
  assert.deepEqual(oe.mcpServers[CONNECT_MCP_SERVER].args, ['__anyray-mcp-server', 'sdk']);
});

test("probeMcpTools reports whether initialize carried instructions, by presence and hash, never the text", async () => {
  const plain = await probeMcpTools({ command: process.execPath, args: [join(ROOT, 'tools', 'mcp-catalog-server.mjs'), '1'], env: { PATH: process.env.PATH } });
  assert.deepEqual(plain.instructions, { present: false, sha256: null });
  const withText = await probeMcpTools({
    command: process.execPath,
    args: ['-e', `require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l); if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'x' }, instructions: 'use the batch read' } }) + '\\n'); if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) + '\\n'); });`],
    env: { PATH: process.env.PATH },
  });
  assert.equal(withText.instructions.present, true);
  assert.match(withText.instructions.sha256, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(withText).includes('use the batch read'), 'the text is never recorded');
});

test('connectArmTools for E requires the server to send instructions: a stock build that reads sdk as auto is refused', () => {
  assert.throws(() => connectArmTools(PROBED, CONNECT_MCP_SERVER, { instructionsExpected: true, instructions: { present: false, sha256: null } }), /instructions/);
  assert.deepEqual(connectArmTools(PROBED, CONNECT_MCP_SERVER, { instructionsExpected: true, instructions: { present: true, sha256: 'abc' } }).allowed, [READ_BATCH]);
  // A stock build reads `sdk` as `auto` and adds its local search and read tools: still one allowed tool, the rest hidden.
  const stock = connectArmTools([...PROBED, { name: 'anyray_search' }, { name: 'anyray_read' }]);
  assert.deepEqual(stock.allowed, [READ_BATCH]);
  assert.equal(stock.disallowed.length, 4);
});

test('run_sdk_app runs E on the code-scan lane only; compare pairs E with B and checks E used the batch read', () => {
  assert.deepEqual(parseAppArgs(['--scenario', 'sdk-app-code-scan', '--arms', 'B,E', '--keys-dir', '/k']).arms, ['B', 'E']);
  assert.throws(() => parseAppArgs(['--arms', 'A,E', '--keys-dir', '/k']), /runs arms A, B, C, not E/);
  assert.deepEqual(pairsFor(['B', 'E']), [['E', 'B']]);
  assert.deepEqual(pairsFor(['A', 'B', 'D', 'E']).filter(([t]) => t === 'E'), [['E', 'B'], ['E', 'D']]);
  const rounds = [{ round: 1, sessions: { B: { totals: { costUsd: 1 } }, E: { totals: { costUsd: 0.9, readBatch: { calls: 3, errors: 0 } } } }, quality: { B: true, E: true }, recall: { B: 9, E: 9 } }];
  assert.deepEqual(readBatchPrecondition(rounds, 'E'), { sessions: 1, used: 1, usedRounds: [1], required: 1, pass: true });
  assert.equal(readBatchPrecondition(rounds).sessions, 0, 'D is still the default arm');
  const text = formatReport(compareFile({ scenario: 'sdk-app-code-scan', model: 'm', arms: ['B', 'E'], rounds }));
  assert.match(text, /read_batch precondition E .*1\/1, need 1 -> PASS/);
  assert.match(text, /E\/B: valid pairs 1/);
});

test('fakeMessagesApi spawns one subagent from the first main request and records only booleans', async () => {
  const api = await startFakeMessagesApi({ subagentType: 'auditor', subagentMarker: 'AUDITOR-MARK', markers: { guide: 'synthetic guidance' } });
  try {
    const post = (body) => fetch(`${api.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await post({ model: 'm', system: 'synthetic guidance', tools: [{ name: 'Read' }, { name: 'Agent' }], messages: [{ role: 'user', content: 'go' }] })).json();
    assert.equal(first.stop_reason, 'tool_use');
    assert.deepEqual({ name: first.content[0].name, type: first.content[0].input.subagent_type }, { name: 'Agent', type: 'auditor' });
    const sub = await (await post({ model: 'm', system: 'AUDITOR-MARK', tools: [{ name: 'Agent' }], messages: [] })).json();
    assert.equal(sub.stop_reason, 'end_turn', 'the subagent is answered, never asked to spawn');
    const again = await (await post({ model: 'm', tools: [{ name: 'Agent' }], messages: [] })).json();
    assert.equal(again.stop_reason, 'end_turn', 'only one spawn per run');
    const stream = await post({ model: 'm', stream: true, messages: [] });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    assert.match(await stream.text(), /event: message_stop/);
    assert.deepEqual(api.requests.slice(0, 3), [
      { subagent: false, markers: { guide: true } },
      { subagent: true, markers: { guide: false } },
      { subagent: false, markers: { guide: false } },
    ]);
  } finally {
    await api.close();
  }
});

// --- preflight: the batch read must serve the absolute paths the SDK's own tools produce ---

test('the connect-arm preflight reads two located ranges by ABSOLUTE in-checkout path, as the SDK hands them to the model', () => {
  const s = scenario();
  const call = preflightReadBatchCall(s, '/work/checkout');
  assert.equal(call.name, READ_BATCH_TOOL);
  assert.equal(call.arguments.reads.length, 2);
  for (const r of call.arguments.reads) {
    assert.ok(r.path.startsWith('/work/checkout/'), `${r.path} is absolute under the checkout`);
    assert.ok(Number.isInteger(r.offset) && Number.isInteger(r.limit));
  }
  assert.deepEqual(call.arguments.reads.map((r) => r.path.slice('/work/checkout/'.length)), [s.slices[0].audit[0].file, s.slices[1].audit[0].file]);
});

test('checkPreflightRead refuses a build whose batch read fails those paths, naming the failure code', () => {
  assert.doesNotThrow(() => checkPreflightRead('E', { isError: false, chars: 900, header: 'READ_BATCH_V2 2' }));
  assert.throws(() => checkPreflightRead('E', { isError: true, chars: 171, header: null, failure: 'unsafe_path' }), /arm E: .*absolute.*unsafe_path/);
  assert.throws(() => checkPreflightRead('D', { error: -32601 }), /arm D: .*batch read/);
  assert.throws(() => checkPreflightRead('D', undefined), /arm D: .*batch read/);
});

// --- arms P and S: connect's full `profile` surface, without and with the sdk instructions ---

const PROFILE_TOOLS = [{ name: 'anyray_retrieve' }, { name: 'anyray_recall' }, { name: 'anyray_search' }, { name: 'anyray_read' }, { name: READ_BATCH_TOOL }];

test('arms P and S differ only in the connect source: profile, and sdk (profile + instructions)', () => {
  assert.deepEqual({ ...ARMS.P, connectSource: null }, { ...ARMS.S, connectSource: null });
  assert.equal(connectSourceOf('P'), 'profile');
  assert.equal(connectSourceOf('S'), 'sdk');
  assert.equal(ARMS.P.connectTools, 'all');
  const env = (arm) => armEnvFor({ arm, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic', model: 'm', sessionId: 'sid' });
  assert.deepEqual(env('P'), env('B'), 'P and S are arm B on the wire');
  assert.deepEqual(env('S'), env('B'));
});

test("connectArmTools 'all' offers connect's whole surface except the gateway read path's duplicates", () => {
  const t = connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { exposeAll: true, instructionsExpected: false, instructions: { present: false, sha256: null } });
  const n = (x) => `mcp__${CONNECT_MCP_SERVER}__${x}`;
  assert.deepEqual(t.allowed, [n('anyray_search'), n('anyray_read'), n('anyray_read_batch')]);
  assert.deepEqual(t.disallowed, [n('anyray_retrieve'), n('anyray_recall')]);
  assert.throws(() => connectArmTools([{ name: 'anyray_search' }], CONNECT_MCP_SERVER, { exposeAll: true }), /does not advertise anyray_read_batch/);
});

test('the instructions expectation is two-sided: S needs them, every other connect arm must not get them', () => {
  const on = { present: true, sha256: 'abc' };
  const off = { present: false, sha256: null };
  assert.doesNotThrow(() => connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { instructionsExpected: true, instructions: on }));
  assert.throws(() => connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { instructionsExpected: true, instructions: off }), /sent no initialize instructions/);
  // A build that sent them to P would make P the treatment arm too.
  assert.throws(() => connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { instructionsExpected: false, instructions: on }), /sent initialize instructions/);
  assert.doesNotThrow(() => connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { instructionsExpected: false, instructions: off }));
  assert.equal(instructionsExpectedFor('S'), true);
  assert.equal(instructionsExpectedFor('E'), true);
  assert.equal(instructionsExpectedFor('P'), false);
  assert.equal(instructionsExpectedFor('D'), false);
});

test('codeScanOptions P: the gateway read path plus connect search, read and batch read for every agent', () => {
  const tools = connectArmTools(PROFILE_TOOLS, CONNECT_MCP_SERVER, { exposeAll: true });
  const server = connectMcpServerConfig({ home: HOME, bin: BIN, path: '/usr/bin', source: 'profile' });
  const o = codeScanOptions({ ...base, arm: 'P', clientKey: 'ark_synthetic', connect: { name: CONNECT_MCP_SERVER, server, tools } });
  assert.deepEqual(o.mcpServers[CONNECT_MCP_SERVER].args, ['__anyray-mcp-server', 'profile']);
  for (const t of tools.allowed) {
    assert.ok(o.allowedTools.includes(t), `${t} allowed`);
    assert.ok(o.agents.auditor.tools.includes(t), `${t} given to the auditors`);
  }
  assert.deepEqual(o.disallowedTools, tools.disallowed);
});

test('run_sdk_app runs P and S on the code-scan lane; compare pairs S with P and checks both used the batch read', () => {
  assert.deepEqual(parseAppArgs(['--scenario', 'sdk-app-code-scan', '--arms', 's,p', '--keys-dir', '/k']).arms, ['P', 'S']);
  assert.deepEqual(pairsFor(['P', 'S']), [['S', 'P']]);
  const rounds = [{ round: 1, sessions: { P: { totals: { costUsd: 1, readBatch: { calls: 0, errors: 0 } } }, S: { totals: { costUsd: 0.9, readBatch: { calls: 2, errors: 0 } } } }, quality: { P: true, S: true }, recall: { P: 8, S: 8 } }];
  const out = compareFile({ scenario: 'sdk-app-code-scan', model: 'm', arms: ['P', 'S'], rounds });
  assert.deepEqual(Object.keys(out.readBatchByArm).sort(), ['P', 'S']);
  assert.equal(out.readBatchByArm.S.pass, true);
  assert.equal(out.readBatchByArm.P.pass, false, 'P made none: reported, it is the no-hint baseline');
  assert.match(formatReport(out), /S\/P: valid pairs 1/);
});

// --- variance vs structure: the dispatch-mention counter and arm S2 ---

test('foldAppSession counts main-agent dispatches that mention the batch read, never keeping their text', () => {
  const spawn = (id, prompt) => ({ type: 'tool_use', id, name: 'Agent', input: { description: 'audit', prompt, subagent_type: 'auditor' } });
  const s = foldAppSession([
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5-5', usage, content: [spawn('a1', 'Use anyray_read_batch for located ranges. synthetic-1')] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5-5', usage, content: [spawn('a2', 'Read ranges in one Batch call. synthetic-2')] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-sonnet-5-5', usage, content: [spawn('a3', 'Audit these functions. synthetic-3')] } },
    // A subagent's own tool call is not a dispatch.
    { type: 'assistant', parent_tool_use_id: 'a1', message: { id: 's1', model: 'claude-sonnet-5-5', usage, content: [spawn('x1', 'anyray_read_batch synthetic-4')] } },
    { type: 'result', subtype: 'success', num_turns: 1, result: '' },
  ], { pricing, model: 'claude-sonnet-5-5' });
  assert.deepEqual(s.totals.dispatchMentions, { dispatches: 3, readBatchTool: 1, batchWord: 2 });
  assert.ok(!JSON.stringify(s.totals).includes('synthetic-'), 'no dispatch text is kept');
});

test('arm S2 is S with the sdk-lean source: same wire, same exposure policy, instructions expected', () => {
  assert.deepEqual({ ...ARMS.S2, connectSource: null }, { ...ARMS.S, connectSource: null });
  assert.equal(connectSourceOf('S2'), 'sdk-lean');
  assert.equal(instructionsExpectedFor('S2'), true);
  assert.deepEqual(parseAppArgs(['--scenario', 'sdk-app-code-scan', '--arms', 's2,s', '--keys-dir', '/k']).arms, ['S', 'S2']);
  // Its server lists retrieve, recall and the batch read: the gateway's duplicates hidden, the batch read offered.
  const t = connectArmTools([{ name: 'anyray_retrieve' }, { name: 'anyray_recall' }, { name: READ_BATCH_TOOL }], CONNECT_MCP_SERVER, { exposeAll: true, instructionsExpected: true, instructions: { present: true, sha256: 'abc' } });
  assert.deepEqual(t.allowed, [READ_BATCH]);
  const rounds = [{ round: 1, sessions: { S2: { totals: { costUsd: 1, readBatch: { calls: 1, errors: 0 } } } }, quality: { S2: true }, recall: { S2: 8 } }];
  assert.equal(compareFile({ scenario: 'sdk-app-code-scan', model: 'm', arms: ['S2'], rounds }).readBatchByArm.S2.pass, true);
});

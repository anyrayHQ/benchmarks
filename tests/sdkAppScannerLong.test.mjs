import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCANNER_VULNERABILITIES,
  SCANNER_LEADS,
  scannerMarkers,
} from '../tools/scanner-target/vulnerabilities.mjs';
import {
  buildScannerTarget,
  scannerEndpoints,
  customerFiles,
  INDEX_PATHS,
} from '../tools/scanner-target/target.mjs';
import { startScannerTargetServer } from '../tools/scanner-target/server.mjs';
import { MIN_ROW_BYTES, MAX_ROW_BYTES } from '../tools/traffic-fixture/generate.mjs';
import { gradeRecall } from '../tools/traffic-fixture/vulnerabilities.mjs';
import { makeTrafficQueryTool, makeHttpGetTool, foldAppSession, completionOf } from '../lib/agentSdkApp.mjs';
import {
  LONG_SYSTEM_PROMPT,
  longMainPrompt,
  longSubagentDefinition,
  makeCustomerFileTool,
  makeReportFindingTool,
  LONG_BUILTIN_TOOLS,
  gradeLongSession,
} from '../lib/scannerLong.mjs';

const stubTool = (name, _desc, _schema, handler) => ({ name, handler });
const textOf = (r) => r.content.map((c) => c.text).join('');
const SEED = 4242;
const ROWS = 48;

const withTarget = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-long-'));
  try {
    return await fn(dir, buildScannerTarget(dir, { seed: SEED, rows: ROWS }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const readRows = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, url, response_body, bytes FROM traffic ORDER BY id').all();
  } finally {
    db.close();
  }
};

/** Every place a scanner can read, as [where, text]: each traffic row, each customer
 *  file, each endpoint body (hidden and probe variants included). */
const everyReadable = (dir, target) => [
  ...readRows(target.dbPath).map((r) => [`traffic/${r.id}`, `${r.url}\n${r.response_body}`]),
  ...[...customerFiles({ seed: SEED })].map(([name, text]) => [`file/${name}`, text]),
  ...[...scannerEndpoints({ seed: SEED })].map(([path, e]) => [`http${path}`, e.body]),
];

test('15-20 vulnerabilities with unique, obviously synthetic markers across traffic, live and files', () => {
  const n = SCANNER_VULNERABILITIES.length;
  assert.ok(n >= 15 && n <= 20, `${n} vulnerabilities`);
  const markers = scannerMarkers();
  assert.equal(new Set(markers).size, n);
  for (const m of markers) assert.ok(/SYNTHETIC/.test(m), `marker not obviously synthetic: ${m}`);
  const by = (w) => SCANNER_VULNERABILITIES.filter((v) => v.where === w).length;
  assert.ok(by('traffic') >= 5, 'traffic vulns');
  assert.ok(by('http') >= 6, 'live vulns');
  assert.ok(by('file') >= 2, 'customer-file vulns');
  // At least four live findings sit behind a lead or a probe, never on the index.
  const hidden = SCANNER_VULNERABILITIES.filter((v) => v.where === 'http' && !INDEX_PATHS.includes(v.path.split('?')[0]));
  assert.ok(hidden.length >= 4, `${hidden.length} hidden live vulns`);
});

test('every marker is planted exactly once in the whole target, at its declared place', async () => {
  await withTarget((dir, target) => {
    const places = everyReadable(dir, target);
    for (const v of SCANNER_VULNERABILITIES) {
      const hits = places.filter(([, text]) => text.includes(v.marker)).map(([where]) => where);
      assert.equal(hits.length, 1, `${v.id} found at ${JSON.stringify(hits)}`);
      if (v.where === 'traffic') assert.match(hits[0], /^traffic\//);
      if (v.where === 'file') assert.equal(hits[0], `file/${v.file}`);
      if (v.where === 'http') assert.equal(hits[0], `http${v.path}`);
    }
  });
});

test('hidden live findings are reachable only by following leads, some three hops deep', async () => {
  await withTarget((dir, target) => {
    const places = everyReadable(dir, target);
    // Breadth-first from recon: the index paths, every traffic row and every customer file.
    const seen = new Set(INDEX_PATHS);
    const depth = new Map(INDEX_PATHS.map((p) => [p, 0]));
    const frontier = [...places.filter(([w]) => !w.startsWith('http')), ...INDEX_PATHS.map((p) => [`http${p}`, scannerEndpoints({ seed: SEED }).get(p)?.body ?? ''])];
    const depthOf = (where) => (where.startsWith('http') ? depth.get(where.slice(4)) ?? 0 : 0);
    while (frontier.length) {
      const [where, text] = frontier.shift();
      for (const lead of SCANNER_LEADS) {
        if (!text.includes(lead.text) || seen.has(lead.to)) continue;
        seen.add(lead.to);
        depth.set(lead.to, depthOf(where) + 1);
        frontier.push([`http${lead.to}`, scannerEndpoints({ seed: SEED }).get(lead.to).body]);
      }
    }
    for (const v of SCANNER_VULNERABILITIES.filter((x) => x.where === 'http')) assert.ok(seen.has(v.path), `${v.id} unreachable from recon`);
    assert.ok(Math.max(...depth.values()) >= 3, 'some finding must be three hops deep');
    // A hidden path is named nowhere but its leads: not on the index, not in a stray body.
    const index = scannerEndpoints({ seed: SEED }).get('/').body;
    for (const v of SCANNER_VULNERABILITIES.filter((x) => x.where === 'http' && !INDEX_PATHS.includes(x.path))) {
      assert.ok(!index.includes(v.path), `${v.path} leaks onto the index`);
    }
  });
});

test('the recorded-traffic db is deterministic, 20-60 kB rows, findings and leads spread end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-det-'));
  try {
    const a = buildScannerTarget(join(dir, 'a'), { seed: SEED, rows: ROWS });
    const b = buildScannerTarget(join(dir, 'b'), { seed: SEED, rows: ROWS });
    const ra = readRows(a.dbPath);
    const rb = readRows(b.dbPath);
    assert.equal(ra.length, ROWS);
    assert.deepEqual(ra.map((r) => r.response_body), rb.map((r) => r.response_body));
    for (const r of ra) assert.ok(r.bytes >= MIN_ROW_BYTES && r.bytes <= MAX_ROW_BYTES, `row ${r.id} is ${r.bytes} bytes`);
    const plantedIds = Object.keys(a.planted).map(Number);
    assert.ok(Math.min(...plantedIds) <= ROWS * 0.2, 'something planted early');
    assert.ok(Math.max(...plantedIds) >= ROWS * 0.8, 'something planted late');
    assert.deepEqual(readdirSync(a.filesDir).sort(), [...customerFiles({ seed: SEED }).keys()].sort());
    for (const name of readdirSync(a.filesDir)) {
      assert.equal(readFileSync(join(a.filesDir, name), 'utf8'), customerFiles({ seed: SEED }).get(name));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the target server serves the index, hidden paths and the debug probe, and nothing else', async () => {
  const srv = await startScannerTargetServer({ seed: SEED });
  try {
    const index = await (await fetch(srv.url + '/')).json();
    assert.deepEqual(index.endpoints, INDEX_PATHS);
    for (const v of SCANNER_VULNERABILITIES.filter((x) => x.where === 'http')) {
      const res = await fetch(srv.url + v.path);
      // A stack trace and a raw SQL error come back on a 500, as a real service sends them.
      assert.equal(res.status, scannerEndpoints({ seed: SEED }).get(v.path).status, v.path);
      assert.ok((await res.text()).includes(v.marker), `${v.path} must carry ${v.id}`);
    }
    // The probe finding needs the parameter: the plain path carries no marker.
    const probe = SCANNER_VULNERABILITIES.find((v) => v.where === 'http' && v.path.includes('?'));
    assert.ok(probe, 'one finding needs a query-parameter probe');
    const plain = await (await fetch(srv.url + probe.path.split('?')[0])).text();
    assert.ok(!plain.includes(probe.marker));
    assert.equal((await fetch(srv.url + '/nope')).status, 404);
    assert.equal((await fetch(srv.url + '/api/profile', { method: 'POST' })).status, 405);
  } finally {
    await srv.close();
  }
});

test('customer_file lists and reads the customer files, and refuses any other path', async () => {
  await withTarget(async (dir, target) => {
    const t = makeCustomerFileTool(target.filesDir, { tool: stubTool });
    const list = textOf(await t.handler({}));
    for (const name of customerFiles({ seed: SEED }).keys()) assert.ok(list.includes(name), `list names ${name}`);
    const [first] = customerFiles({ seed: SEED }).keys();
    assert.equal(textOf(await t.handler({ name: first })), customerFiles({ seed: SEED }).get(first));
    for (const bad of ['../traffic.sqlite', '/etc/passwd', 'sub/../../x', '..']) {
      assert.match(textOf(await t.handler({ name: bad })), /customer_file error/, `must refuse ${bad}`);
    }
  });
});

test('traffic_query refuses a result over its size cap and names the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan-tq-'));
  try {
    const target = buildScannerTarget(dir, { seed: SEED, rows: ROWS });
    const t = makeTrafficQueryTool(target.dbPath, { tool: stubTool, maxBytes: 64 * 1024 });
    assert.match(textOf(await t.handler({ sql: 'SELECT id, url, bytes FROM traffic' })), /"id":0/);
    assert.match(textOf(await t.handler({ sql: 'SELECT * FROM traffic WHERE id < 10' })), /traffic_query error: .*64 kB/);
    assert.match(textOf(await t.handler({ sql: 'SELECT * FROM traffic WHERE id = 3' })), /"id":3/);
    // Without a cap the tool answers whatever it is asked, as the short lane always has.
    const open = makeTrafficQueryTool(target.dbPath, { tool: stubTool });
    assert.match(textOf(await open.handler({ sql: 'SELECT * FROM traffic WHERE id < 10' })), /"id":9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('http_get returns a large body whole when its cap allows', async () => {
  const srv = await startScannerTargetServer({ seed: SEED });
  try {
    const big = [...scannerEndpoints({ seed: SEED })].find(([, e]) => e.body.length > 25_000);
    assert.ok(big, 'some endpoint is large');
    const t = makeHttpGetTool(srv.url, { tool: stubTool, maxChars: 64 * 1024 });
    const out = textOf(await t.handler({ path: big[0] }));
    assert.ok(out.endsWith(big[1].body), 'the whole body comes back');
    const short = makeHttpGetTool(srv.url, { tool: stubTool });
    assert.ok(textOf(await short.handler({ path: big[0] })).length < big[1].body.length, 'the default cap still truncates');
  } finally {
    await srv.close();
  }
});

test('report_finding accepts a finding and the long grader recalls markers from findings and the final text', async () => {
  const t = makeReportFindingTool({ tool: stubTool });
  assert.match(textOf(await t.handler({ vulnerability_class: 'secrets', location: 'traffic/2', evidence: 'x', summary: 'y' })), /recorded/);
  const [a, b, c] = SCANNER_VULNERABILITIES;
  const session = {
    result: { text: `final report quotes ${c.marker}` },
    reportedFindings: [
      { file: 'traffic/2', summary: `leak ${a.marker}` },
      { file: 'http/x', summary: `another ${b.marker}` },
    ],
  };
  const g = gradeLongSession(session);
  assert.equal(g.total, SCANNER_VULNERABILITIES.length);
  assert.equal(g.recall, 3);
  assert.equal(g.solved, false);
  assert.deepEqual(gradeRecall(scannerMarkers().join('\n'), SCANNER_VULNERABILITIES).recall, SCANNER_VULNERABILITIES.length);
});

test('the long app names the task-list, run, reflect loop and subagent delegation in a large system prompt', () => {
  assert.ok(LONG_SYSTEM_PROMPT.length >= 12_000, `system prompt is ${LONG_SYSTEM_PROMPT.length} chars`);
  assert.match(LONG_SYSTEM_PROMPT, /task list/i);
  assert.match(LONG_SYSTEM_PROMPT, /what (have I|did I) not (done|do) yet/i);
  assert.match(LONG_SYSTEM_PROMPT, /what else (should I |to )?test/i);
  assert.match(LONG_SYSTEM_PROMPT, /subagent/i);
  assert.match(LONG_SYSTEM_PROMPT, /untrusted/i);
  for (const cls of ['secret', 'injection', 'redirect', 'CORS', 'directory listing', 'IDOR', 'TLS', 'stack trace']) {
    assert.ok(LONG_SYSTEM_PROMPT.toLowerCase().includes(cls.toLowerCase()), `taxonomy names ${cls}`);
  }
  const main = longMainPrompt({ rows: ROWS, files: [...customerFiles({ seed: SEED }).keys()] });
  assert.match(main, new RegExp(`${ROWS} rows`));
  for (const name of customerFiles({ seed: SEED }).keys()) assert.ok(main.includes(name));
  const sub = longSubagentDefinition(['mcp__anyray__anyray_retrieve']);
  for (const t of ['mcp__scanner__traffic_query', 'mcp__scanner__http_get', 'mcp__scanner__customer_file', 'mcp__scanner__report_finding', 'mcp__anyray__anyray_retrieve']) {
    assert.ok(sub.tools.includes(t), `subagent has ${t}`);
  }
  assert.ok(sub.maxTurns >= 30, 'a subagent may run a long thread');
  assert.ok(LONG_BUILTIN_TOOLS.includes('TodoWrite'));
  assert.ok(LONG_BUILTIN_TOOLS.some((x) => x === 'Agent' || x === 'Task'));
  assert.ok(!LONG_BUILTIN_TOOLS.includes('Bash') && !LONG_BUILTIN_TOOLS.includes('Read'), 'no shell or filesystem tools');
});

test('foldAppSession counts a parallel spawn across the SDK messages that share one API message id', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  const block = (id) => ({ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'scanner' } });
  const messages = [
    // The SDK emits one assistant message per content block, all with the API message id.
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage, content: [block('t1')] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage, content: [block('t2')] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage, content: [block('t3')] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', usage, content: [block('t4')] } },
    { type: 'result', subtype: 'success', num_turns: 2, result: 'done' },
  ];
  const pricing = { cache_read: 0.1, cache_write: 1.25, models: { m: { input: 1, output: 5 } } };
  const s = foldAppSession(messages, { pricing, model: 'm' });
  assert.equal(s.totals.subagentSpawns, 4);
  assert.equal(s.totals.maxParallelSpawn, 3);
  assert.equal(s.totals.spawnedInParallel, true);
  assert.equal(s.totals.parallelSpawnMessages, 1);
});

test('foldAppSession counts main and subagent thread turns by API message id', () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  const a = (id, parent) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, usage, content: [{ type: 'text', text: '.' }] } });
  const messages = [a('m1', null), a('m1', null), a('m2', null), a('m3', null), a('s1', 't1'), a('s2', 't1'), a('s3', 't2'), { type: 'result', subtype: 'success', num_turns: 3 }];
  const s = foldAppSession(messages, { pricing: { models: {} }, model: 'm' });
  assert.equal(s.totals.mainTurns, 3);
  assert.deepEqual(s.totals.subagentTurns, [2, 1]);
  assert.equal(s.totals.maxSubagentTurns, 2);
});

test('foldAppSession prices output from the completed message, not the first streamed block', () => {
  const u = (out) => ({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out });
  const messages = [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage: u(1), content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', usage: u(1), content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: {} }] } },
    { type: 'stream_event', parent_tool_use_id: null, api_message_id: 'm1', event: { type: 'message_delta', usage: { output_tokens: 400 } } },
    // A subagent streams no deltas: the largest per-block count stands.
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', usage: u(3), content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', usage: u(90), content: [{ type: 'text', text: 'b' }] } },
    { type: 'result', subtype: 'success', num_turns: 1 },
  ];
  const s = foldAppSession(messages, { pricing: { models: {} }, model: 'm' });
  assert.equal(s.totals.output, 490);
});

test('foldAppSession grades accepted report_finding calls from the scanner server', () => {
  const [v] = SCANNER_VULNERABILITIES;
  const messages = [
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', usage: {}, content: [
      { type: 'tool_use', id: 'r1', name: 'mcp__scanner__report_finding', input: { vulnerability_class: 'secrets', location: 'traffic/2', evidence: v.marker, summary: 'key' } },
      { type: 'tool_use', id: 'r2', name: 'mcp__scanner__report_finding', input: { vulnerability_class: 'x', location: 'y', evidence: SCANNER_VULNERABILITIES[1].marker, summary: 'rejected' } },
    ] } },
    { type: 'user', parent_tool_use_id: 't1', message: { content: [
      { type: 'tool_result', tool_use_id: 'r1', is_error: false, content: 'recorded' },
      { type: 'tool_result', tool_use_id: 'r2', is_error: true, content: 'bad' },
    ] } },
    { type: 'result', subtype: 'success', num_turns: 1, result: '' },
  ];
  const s = foldAppSession(messages, { pricing: { models: {} }, model: 'm' });
  assert.equal(s.reportedFindings.length, 1);
  assert.equal(gradeLongSession(s).recall, 1);
});

test('a session the loop ended at its own turn cap is complete; an error or a missing result is not', () => {
  assert.deepEqual(completionOf({ subtype: 'success' }, { turnCapEnds: true }), { completed: true, endedBy: 'answer' });
  assert.deepEqual(completionOf({ subtype: 'error_max_turns' }, { turnCapEnds: true }), { completed: true, endedBy: 'turn_cap' });
  assert.deepEqual(completionOf({ subtype: 'error_max_turns' }, { turnCapEnds: false }), { completed: false, endedBy: 'turn_cap' });
  assert.deepEqual(completionOf({ subtype: 'error_during_execution' }, { turnCapEnds: true }), { completed: false, endedBy: 'error' });
  assert.deepEqual(completionOf({ subtype: null }, { turnCapEnds: true }), { completed: false, endedBy: 'no_result' });
  assert.deepEqual(completionOf({ subtype: 'success' }, { turnCapEnds: true, error: 'timeout' }), { completed: false, endedBy: 'timeout' });
});

test('run_sdk_app takes --scenario for either app lane and refuses any other', async () => {
  const { parseArgs, SCENARIO_PROFILES } = await import('../run_sdk_app.mjs');
  assert.equal(parseArgs(['--keys-dir', '/k']).scenario, 'sdk-app-scanner');
  assert.equal(parseArgs(['--keys-dir', '/k', '--scenario', 'sdk-app-scanner-long']).scenario, 'sdk-app-scanner-long');
  assert.throws(() => parseArgs(['--keys-dir', '/k', '--scenario', 'pyrepo-docs']), /--scenario/);
  assert.deepEqual(Object.keys(SCENARIO_PROFILES).sort(), ['sdk-app-scanner', 'sdk-app-scanner-long']);
});

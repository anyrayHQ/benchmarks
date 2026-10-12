import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  VULNERABILITIES,
  vulnerabilityMarkers,
  trafficVulnerabilities,
  httpVulnerabilities,
  gradeRecall,
} from '../tools/traffic-fixture/vulnerabilities.mjs';
import { buildTrafficDb, MIN_ROW_BYTES, MAX_ROW_BYTES } from '../tools/traffic-fixture/generate.mjs';
import { startFixtureServer } from '../tools/traffic-fixture/fixtureServer.mjs';
import {
  makeTrafficQueryTool,
  makeHttpGetTool,
  foldAppSession,
  gradeAppSession,
  armEnvFor,
  armMcpServers,
  mainScannerPrompt,
  evidenceDelta,
  budgetDecision,
} from '../lib/agentSdkApp.mjs';

const stubTool = (name, _desc, _schema, handler) => ({ name, handler });
const textOf = (r) => r.content.map((c) => c.text).join('');

test('ten vulnerabilities, unique synthetic markers, split across both read paths', () => {
  assert.equal(VULNERABILITIES.length, 10);
  const markers = vulnerabilityMarkers();
  assert.equal(new Set(markers).size, 10);
  for (const m of markers) assert.ok(/SYNTHETIC|evil\.synthetic/i.test(m), `marker not obviously synthetic: ${m}`);
  assert.equal(trafficVulnerabilities().length, 6);
  assert.equal(httpVulnerabilities().length, 4);
  for (const v of httpVulnerabilities()) assert.ok(v.path, 'an http vuln needs a path');
});

test('gradeRecall counts markers present in the answer and only solves on all ten', () => {
  assert.deepEqual(gradeRecall('').found, []);
  assert.equal(gradeRecall('').recall, 0);
  const all = vulnerabilityMarkers().join('\n');
  const g = gradeRecall(all);
  assert.equal(g.recall, 10);
  assert.equal(g.found.length, 10);
  assert.equal(g.missed.length, 0);
  assert.equal(gradeAppSession({ result: { text: all }, reportedFindings: [] }).solved, true);
  const partial = gradeRecall(vulnerabilityMarkers().slice(0, 3).join(' '));
  assert.equal(partial.recall, 3);
  assert.equal(partial.found.length, 3);
});

test('generated traffic db is deterministic, rows are 20–60 kB, every traffic marker is planted once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-'));
  try {
    const p1 = join(dir, 'a.sqlite');
    const p2 = join(dir, 'b.sqlite');
    const info = buildTrafficDb(p1, { seed: 7, rows: 24 });
    buildTrafficDb(p2, { seed: 7, rows: 24 });
    const read = (p) => {
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        return db.prepare('SELECT id, response_body, bytes FROM traffic ORDER BY id').all();
      } finally {
        db.close();
      }
    };
    const r1 = read(p1);
    const r2 = read(p2);
    assert.equal(r1.length, 24);
    assert.deepEqual(
      r1.map((r) => r.response_body),
      r2.map((r) => r.response_body),
      'same seed must give byte-identical rows'
    );
    for (const row of r1) {
      assert.ok(row.bytes >= MIN_ROW_BYTES && row.bytes <= MAX_ROW_BYTES, `row ${row.id} is ${row.bytes} bytes`);
    }
    const all = r1.map((r) => r.response_body).join('\n');
    for (const v of trafficVulnerabilities()) {
      const hits = r1.filter((r) => r.response_body.includes(v.marker)).length;
      assert.equal(hits, 1, `marker ${v.id} must be planted in exactly one row`);
      assert.ok(all.includes(v.marker));
    }
    assert.equal(Object.keys(info.planted).length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture server serves each http marker on its path and nothing else', async () => {
  const srv = await startFixtureServer();
  try {
    for (const v of httpVulnerabilities()) {
      const res = await fetch(srv.url + v.path);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes(v.marker), `${v.path} must carry ${v.id}`);
    }
    const index = await (await fetch(srv.url + '/')).json();
    assert.ok(Array.isArray(index.endpoints) && index.endpoints.length > 0);
    assert.equal((await fetch(srv.url + '/nope')).status, 404);
    assert.equal((await fetch(srv.url + '/api/profile', { method: 'POST' })).status, 405);
  } finally {
    await srv.close();
  }
});

test('traffic_query runs a SELECT and refuses anything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tq-'));
  try {
    const p = join(dir, 'c.sqlite');
    buildTrafficDb(p, { seed: 3, rows: 24 });
    const t = makeTrafficQueryTool(p, { tool: stubTool });
    const ok = await t.handler({ sql: 'SELECT id, bytes FROM traffic WHERE id = 0' });
    assert.match(textOf(ok), /"id":0/);
    for (const bad of ['DELETE FROM traffic', 'DROP TABLE traffic', 'SELECT 1; DELETE FROM traffic', 'UPDATE traffic SET bytes = 0']) {
      assert.match(textOf(await t.handler({ sql: bad })), /only a single read-only SELECT/, `must refuse: ${bad}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('http_get is confined to the fixture origin', async () => {
  const srv = await startFixtureServer();
  try {
    const seen = [];
    const spyFetch = (url, init) => {
      seen.push(String(url));
      return fetch(url, init);
    };
    const t = makeHttpGetTool(srv.url, { tool: stubTool, fetchImpl: spyFetch });
    assert.match(textOf(await t.handler({ path: '/api/profile' })), /HTTP 200/);
    assert.equal(seen.length, 1);
    // An absolute URL to another host must be refused before any fetch.
    const before = seen.length;
    assert.match(textOf(await t.handler({ path: 'http://evil.example/steal' })), /only .* is reachable/);
    assert.equal(seen.length, before, 'no request may leave for another host');
  } finally {
    await srv.close();
  }
});

test('foldAppSession extracts parallel spawns and accepted findings, and prices from usage', () => {
  const marker = VULNERABILITIES[0].marker;
  const usage = (i) => ({ input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 200 + i });
  const messages = [
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-haiku-4-5', usage: usage(0), content: [
      { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'scanner' } },
      { type: 'tool_use', id: 't2', name: 'Task', input: { subagent_type: 'scanner' } },
      { type: 'tool_use', id: 't3', name: 'Task', input: { subagent_type: 'scanner' } },
    ] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 's1', model: 'claude-haiku-4-5', usage: usage(1), content: [
      { type: 'tool_use', id: 'f1', name: 'ReportFindings', input: { findings: [{ file: 'traffic/0', line: 1, summary: `leak ${marker}`, failure_scenario: 'x' }] } },
    ] } },
    { type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', is_error: false, content: 'ok' }] } },
    { type: 'assistant', parent_tool_use_id: 't2', message: { id: 's2', model: 'claude-haiku-4-5', usage: usage(2), content: [
      { type: 'tool_use', id: 'f2', name: 'ReportFindings', input: { findings: [{ file: 'traffic/9', summary: 'rejected finding', failure_scenario: 'y' }] } },
    ] } },
    { type: 'user', parent_tool_use_id: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'f2', is_error: true, content: '<tool_use_error>bad</tool_use_error>' }] } },
    { type: 'result', subtype: 'success', num_turns: 5, total_cost_usd: 0.012, result: 'Final report.' },
  ];
  const pricing = { cache_read: 0.1, cache_write: 1.25, models: { 'claude-haiku-4-5': { input: 1, output: 5 } } };
  const s = foldAppSession(messages, { pricing, model: 'claude-haiku-4-5' });
  assert.equal(s.totals.subagentSpawns, 3);
  assert.equal(s.totals.maxParallelSpawn, 3);
  assert.equal(s.totals.spawnedInParallel, true);
  assert.equal(s.totals.subagentsObserved, 2);
  // Only the accepted ReportFindings survives.
  assert.equal(s.reportedFindings.length, 1);
  assert.match(s.reportedFindings[0].summary, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(s.totals.costUsd > 0);
  assert.equal(s.totals.sdkCostUsd, 0.012);
  assert.equal(s.totals.turns, 5);
  // The grader recalls the marker the accepted finding quoted.
  assert.equal(gradeAppSession(s).recall, 1);
});

test('armEnvFor wires A and B to the gateway with the harness switch, C as the optimize-off baseline', () => {
  const base = { gatewayUrl: 'https://gw.example', model: 'claude-sonnet-5', sessionId: 'sid' };
  const envA = armEnvFor({ ...base, arm: 'A', clientKey: 'ark_synthetic-a' });
  assert.equal(envA.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(envA.ANTHROPIC_API_KEY, 'ark_synthetic-a');
  assert.match(envA.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-metadata: .*"tool":"sdk-agent"/);
  assert.match(envA.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval: off/);
  assert.doesNotMatch(envA.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-optimize/);
  const envB = armEnvFor({ ...base, arm: 'B', clientKey: 'ark_synthetic-b' });
  assert.match(envB.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval: on/);
  assert.doesNotMatch(envB.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-optimize/);
  // C: the same gateway route and model, optimization bypassed, no harness switch.
  const envC = armEnvFor({ ...base, arm: 'C', clientKey: 'ark_synthetic-c' });
  assert.equal(envC.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(envC.ANTHROPIC_API_KEY, 'ark_synthetic-c');
  assert.match(envC.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-optimize: off/);
  assert.doesNotMatch(envC.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval/);
  assert.match(envC.ANTHROPIC_CUSTOM_HEADERS, /"tool":"sdk-agent"/);
  for (const env of [envA, envB, envC]) assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in env));
  assert.throws(() => armEnvFor({ ...base, arm: 'D', clientKey: 'k' }), /arm/);
});

test('armMcpServers adds the gateway read path on A and B only', () => {
  for (const arm of ['A', 'B']) {
    const gw = armMcpServers({ arm, scannerServer: { s: 1 }, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic' });
    assert.ok(gw.servers.scanner);
    assert.equal(gw.servers.anyray.type, 'http');
    assert.equal(gw.servers.anyray.url, 'https://gw.example/mcp');
    assert.equal(gw.servers.anyray.headers['x-anyray-api-key'], 'ark_synthetic');
    assert.deepEqual(gw.anyrayTools, ['mcp__anyray__anyray_retrieve', 'mcp__anyray__anyray_recall']);
  }
  const c = armMcpServers({ arm: 'C', scannerServer: { s: 1 }, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic' });
  assert.ok(c.servers.scanner);
  assert.ok(!('anyray' in c.servers));
  assert.deepEqual(c.anyrayTools, []);
});

const envelope = (requests, evidence, emitted) => ({
  state: 'measured',
  windowHours: 24,
  runtimes: requests ? [{ clientTool: 'sdk-agent', verdict: 'wired', requests, evidence }] : [],
  ...(emitted === 'absent' ? {} : { readBack: emitted === undefined ? [] : [{ clientTool: 'sdk-agent', ...(emitted === null ? {} : { emitted }), retrieved: 0, missed: 0 }] }),
});

test('evidenceDelta is the sdk-agent runtime growth across one session', () => {
  const before = envelope(10, { no_discovery: 10 }, 0);
  const after = envelope(31, { no_discovery: 12, direct: 19 }, 4);
  const d = evidenceDelta(before, after);
  assert.equal(d.requests, 21);
  assert.deepEqual(d.evidence, { no_discovery: 2, direct: 19 });
  assert.equal(d.freshEmitted, 4);
  // A key that had no runtime yet starts from zero.
  const first = evidenceDelta(envelope(0), envelope(5, { direct: 5 }, 2));
  assert.equal(first.requests, 5);
  assert.deepEqual(first.evidence, { direct: 5 });
  assert.equal(first.freshEmitted, 2);
});

test('evidenceDelta never reads an unknown mint count as zero', () => {
  // readBack measured but the tool row carries no emitted count: legacy rows made it partial.
  assert.equal(evidenceDelta(envelope(1, { direct: 1 }, 0), envelope(3, { direct: 3 }, null)).freshEmitted, null);
  // The store did not measure read-back at all.
  assert.equal(evidenceDelta(envelope(1, { direct: 1 }, 'absent'), envelope(3, { direct: 3 }, 'absent')).freshEmitted, null);
  // A read that could not answer is no evidence at all, never an empty delta.
  assert.equal(evidenceDelta({ state: 'unavailable' }, envelope(3, { direct: 3 }, 1)), null);
  assert.equal(evidenceDelta(envelope(1, { direct: 1 }, 0), { state: 'unavailable' }), null);
  // A tool with mints but no requests row yet still counts its mints from zero.
  assert.equal(evidenceDelta(envelope(0, {}, undefined), envelope(2, { direct: 2 }, 3)).freshEmitted, 3);
});

test('budgetDecision is a hard cap and aborts once three rounds project over it', () => {
  // Under budget, no projection yet: go.
  assert.deepEqual(budgetDecision({ roundCosts: [], rounds: 20, budget: 120 }), { stop: false });
  assert.deepEqual(budgetDecision({ roundCosts: [5, 6], rounds: 20, budget: 120 }), { stop: false });
  // Three rounds averaging $7 project $140 over 20 rounds: abort.
  const over = budgetDecision({ roundCosts: [6, 7, 8], rounds: 20, budget: 120 });
  assert.equal(over.stop, true);
  assert.equal(over.reason, 'projected_over_budget');
  assert.equal(over.projectedUsd, 140);
  // Three rounds averaging $5 project $100: continue.
  assert.deepEqual(budgetDecision({ roundCosts: [5, 5, 5], rounds: 20, budget: 120 }), { stop: false });
  // Hard cap: never start a round the costliest round so far would push past the budget.
  const cap = budgetDecision({ roundCosts: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6], rounds: 30, budget: 120 });
  assert.equal(cap.stop, true);
  assert.equal(cap.reason, 'budget_cap');
  assert.deepEqual(budgetDecision({ roundCosts: [1, 1, 1], rounds: 3, budget: 8 }), { stop: false });
  assert.equal(budgetDecision({ roundCosts: [3, 3], rounds: 3, budget: 8 }).reason, 'budget_cap');
});

test('mainScannerPrompt partitions the rows into three disjoint slices', () => {
  const p = mainScannerPrompt({ rows: 24, endpoints: ['/a', '/b'] });
  assert.match(p, /three `scanner` subagents in parallel/);
  assert.match(p, /from 0 to 7/);
  assert.match(p, /from 8 to 15/);
  assert.match(p, /from 16 to 23/);
  assert.match(p, /\/a, \/b/);
});

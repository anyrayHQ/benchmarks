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

test('armEnvFor wires each arm as the setup guide will', () => {
  const g = { arm: 'anyray-a', gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic', model: 'claude-haiku-4-5', harnessRetrieval: 'off', sessionId: 'sid-A' };
  const envA = armEnvFor(g);
  assert.equal(envA.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(envA.ANTHROPIC_API_KEY, 'ark_synthetic');
  assert.match(envA.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-metadata: .*"tool":"sdk-agent"/);
  assert.match(envA.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval: off/);
  assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in envA));
  const envB = armEnvFor({ ...g, arm: 'anyray-b', harnessRetrieval: 'on' });
  assert.match(envB.ANTHROPIC_CUSTOM_HEADERS, /x-anyray-harness-retrieval: on/);
  const envC = armEnvFor({ arm: 'direct', bedrock: { profile: 'p', region: 'us-east-1', smallModel: 'm' }, model: 'claude-haiku-4-5' });
  assert.equal(envC.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.ok(!('ANTHROPIC_BASE_URL' in envC) && !('ANTHROPIC_CUSTOM_HEADERS' in envC));
});

test('armMcpServers adds the gateway read path only on gateway arms', () => {
  const gw = armMcpServers({ arm: 'anyray-a', scannerServer: { s: 1 }, gatewayUrl: 'https://gw.example', clientKey: 'ark_synthetic' });
  assert.ok(gw.servers.scanner);
  assert.equal(gw.servers.anyray.type, 'http');
  assert.equal(gw.servers.anyray.url, 'https://gw.example/mcp');
  assert.equal(gw.servers.anyray.headers['x-anyray-api-key'], 'ark_synthetic');
  assert.deepEqual(gw.anyrayTools, ['mcp__anyray__anyray_retrieve', 'mcp__anyray__anyray_recall']);
  const direct = armMcpServers({ arm: 'direct', scannerServer: { s: 1 } });
  assert.ok(direct.servers.scanner);
  assert.ok(!('anyray' in direct.servers));
  assert.deepEqual(direct.anyrayTools, []);
});

test('mainScannerPrompt partitions the rows into three disjoint slices', () => {
  const p = mainScannerPrompt({ rows: 24, endpoints: ['/a', '/b'] });
  assert.match(p, /three `scanner` subagents in parallel/);
  assert.match(p, /from 0 to 7/);
  assert.match(p, /from 8 to 15/);
  assert.match(p, /from 16 to 23/);
  assert.match(p, /\/a, \/b/);
});

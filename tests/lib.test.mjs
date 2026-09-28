import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, suiteNames, workloadsFor } from '../lib/loadConfig.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { Client, parseCompletion, parseMessages } from '../lib/client.mjs';
import { chatToMessages } from '../lib/toAnthropic.mjs';
import { costOf, priceFor, savedPct } from '../lib/cost.mjs';
import { judgeAnswers, extractJsonObject, qualityLabel } from '../lib/judge.mjs';
import { directFirst } from '../run.mjs';
import { totals } from '../report.mjs';

const OAUTH = { mode: 'passthrough', provider: 'anthropic', upstreamToken: 'oat', clientKey: 'ark_x' };
const hasAnyrayHeader = (h) => Object.keys(h).some((k) => k.startsWith('x-anyray'));

test('loadConfig has no gateway default and reads env overrides', () => {
  const raw = { run: { model: 'm0' }, benchmarks: { s: { workloads: [{ id: 'a' }, { id: 'b' }] } } };
  const none = loadConfig({ raw, env: { ANYRAY_AUTH_MODE: 'managed' } });
  assert.equal(none.run.gatewayUrl, null);
  assert.equal(none.run.directUrl, 'https://api.anthropic.com');
  assert.equal(none.run.judge.url, 'https://api.anthropic.com/v1/messages');
  const set = loadConfig({
    raw,
    env: { ANYRAY_AUTH_MODE: 'managed', ANYRAY_GATEWAY_URL: 'http://gw:8787/', ANYRAY_LIVE_MODEL: 'm1' },
  });
  assert.equal(set.run.gatewayUrl, 'http://gw:8787');
  assert.equal(set.run.model, 'm1');
  assert.deepEqual(suiteNames(set), ['s']);
  assert.deepEqual(workloadsFor(set, 's', 'b').map((w) => w.id), ['b']);
});

test('every configured workload has a payload and a judge question', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cfg = loadConfig({ env: { ANYRAY_AUTH_MODE: 'managed' } });
  const kf = JSON.parse(readFileSync(join(cfg.root, 'keyfacts.json'), 'utf8'));
  for (const s of suiteNames(cfg)) {
    for (const w of workloadsFor(cfg, s)) {
      assert.ok(existsSync(join(cfg.root, s, 'payloads', `${w.id}.json`)), `${s}/${w.id} payload`);
      // No key facts is allowed: the judge then asks the workload title, answer vs answer.
      assert.ok(kf[w.id]?.question || w.title, `${w.id} has no question or title`);
    }
  }
});

test('Client refuses a gateway side with no URL', () => {
  assert.throws(() => new Client({ side: 'gateway', url: null, auth: OAUTH }), /ANYRAY_GATEWAY_URL/);
});

test('gateway side sends the client key and NO x-anyray control headers', () => {
  const gw = new Client({ side: 'gateway', url: 'http://gw:8787', auth: OAUTH });
  const { url, headers, payload } = gw.prepare({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' });
  assert.equal(url, 'http://gw:8787/v1/chat/completions');
  assert.equal(headers['x-anyray-api-key'], 'ark_x');
  assert.equal(headers['x-anyray-optimize'], undefined);
  assert.equal(headers['x-anyray-metadata'], undefined);
  assert.match(payload.messages[0].content, /^You are Claude Code/);
});

test('gateway native route keeps the identity as its own system block', () => {
  const gw = new Client({ side: 'gateway', url: 'http://gw', auth: OAUTH });
  const { url, payload } = gw.prepare({ system: 'be terse', messages: [] }, { endpoint: '/v1/messages' });
  assert.equal(url, 'http://gw/v1/messages');
  assert.match(payload.system[0].text, /^You are Claude Code/);
  assert.equal(payload.system[1].text, 'be terse');
});

test('direct side goes native to the provider with no Anyray headers or key', () => {
  const d = new Client({ side: 'direct', url: 'https://api.anthropic.com/', auth: OAUTH });
  const { url, headers, payload } = d.prepare(
    { messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
    { model: 'm' }
  );
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers.authorization, 'Bearer oat');
  assert.ok(!hasAnyrayHeader(headers));
  assert.equal(payload.system.length, 2);
  assert.match(payload.system[0].text, /^You are Claude Code/);
});

test('authHeaders direct: x-api-key for an sk-ant key, refuses with no credential', () => {
  const h = authHeaders({ provider: 'anthropic', upstreamToken: 'sk-ant-api03-x' }, { direct: true });
  assert.equal(h['x-api-key'], 'sk-ant-api03-x');
  assert.equal(h.authorization, undefined);
  assert.throws(() => authHeaders({ mode: 'managed', clientKey: 'ark_x' }, { direct: true }), /upstream credential/);
});

test('authHeaders gateway: passthrough carries both credentials, managed only the key', () => {
  const p = authHeaders(OAUTH);
  assert.equal(p.authorization, 'Bearer oat');
  assert.equal(p['x-anyray-api-key'], 'ark_x');
  assert.equal(authHeaders({ mode: 'managed', clientKey: 'ark_x' }).authorization, 'Bearer ark_x');
});

test('chatToMessages converts system, tool calls and tool results to native blocks', () => {
  const out = chatToMessages(
    {
      model: 'm', max_tokens: 10,
      tools: [{ type: 'function', function: { name: 'bash', description: 'd', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'running', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'a.txt' },
        { role: 'user', content: 'and?' },
      ],
    },
    { identity: true }
  );
  assert.equal(out.system[1].text, 'be terse');
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(out.messages[1].content[1], { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } });
  assert.equal(out.messages[2].content[0].type, 'tool_result');
  assert.equal(out.messages[2].content[1].text, 'and?');
  assert.deepEqual(out.tools[0], { name: 'bash', description: 'd', input_schema: { type: 'object' } });
});

test('parseMessages folds cached input back into the total and renders tool calls', () => {
  const r = parseMessages({
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }],
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 7 },
    stop_reason: 'tool_use',
  });
  assert.equal(r.answer, 'ok\n[tool_call bash {"cmd":"ls"}]');
  assert.deepEqual(r.usage, { input: 1050, cacheRead: 900, cacheWrite: 50, output: 7 });
});

test('parseCompletion reads OpenAI usage incl. cached_tokens', () => {
  const r = parseCompletion({
    choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } },
  });
  assert.equal(r.answer, 'ab');
  assert.deepEqual(r.usage, { input: 120, cacheRead: 100, cacheWrite: null, output: 5 });
});

test('costOf prices uncached, cache reads/writes and output; resolves dated ids', () => {
  const pricing = { cache_read: 0.1, cache_write: 1.25, models: { 'claude-haiku-4-5': { input: 1, output: 5 } } };
  assert.ok(priceFor(pricing, 'claude-haiku-4-5-20251001'));
  // 50 uncached + 900*0.1 + 50*1.25 = 202.5 input units; 7 output
  assert.equal(costOf(pricing, 'claude-haiku-4-5', { input: 1000, cacheRead: 900, cacheWrite: 50, output: 7 }), (202.5 + 35) / 1e6);
  assert.equal(costOf(pricing, 'unknown-model', { input: 1, output: 1 }), null);
});

test('savedPct is signed and never divides by zero', () => {
  assert.equal(savedPct(200, 50), 75);
  assert.equal(savedPct(100, 110), -10);
  assert.equal(savedPct(0, 5), null);
});

test('directFirst alternates by default and honours fixed orders', () => {
  assert.deepEqual([0, 1, 2].map((i) => directFirst('alternate', i)), [true, false, true]);
  assert.equal(directFirst('gateway-first', 0), false);
  assert.equal(directFirst('direct-first', 1), true);
});

test('extractJsonObject pulls the first balanced object', () => {
  assert.equal(extractJsonObject('x {"a":"}{","b":{"c":1}} y'), '{"a":"}{","b":{"c":1}}');
});

test('judgeAnswers calls the provider natively, without Anyray headers, and clamps score', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"preserved":true,"score":140}' }] }) };
  };
  const j = await judgeAnswers({
    judge: { url: 'https://api.anthropic.com/v1/messages', model: 'jm', auth: OAUTH },
    question: 'q', keyFacts: ['f'], directAnswer: 'a', gatewayAnswer: 'b', fetchImpl,
  });
  assert.equal(j.score, 100);
  assert.equal(qualityLabel(j), 'PASS');
  assert.ok(!hasAnyrayHeader(seen.headers));
  assert.match(seen.body.system[0].text, /^You are Claude Code/);
  assert.equal(qualityLabel({ preserved: false, score: 80 }), 'MARGINAL');
  assert.equal(qualityLabel({ preserved: true, score: 60 }), 'FAIL');
});

test('report totals only price when every row is priced', () => {
  const row = (d, g, dc, gc, q) => ({
    direct: { input: d, costUsd: dc }, gateway: { input: g, costUsd: gc }, latencyOverheadMs: 10, quality: q,
  });
  const t = totals([row(100, 50, 1, 0.5, 'PASS'), row(100, 100, 1, 1, 'FAIL'), { id: 'x', error: 'boom' }]);
  assert.equal(t.n, 2);
  assert.equal(t.errors, 1);
  assert.equal(t.inputSavedPct, 25);
  assert.equal(t.costSavedPct, 25);
  assert.deepEqual(t.quality, { PASS: 1, MARGINAL: 0, FAIL: 1 });
  assert.equal(totals([row(1, 1, null, 1)]).costSavedPct, null);
});

test('rule0: passes only above the noise bar with Q3 < 1 and quality held', async () => {
  const { rule0 } = await import('../lib/stats.mjs');
  const r = (ratio, a = true, b = true) => ({ ratio, quality: { a, b } });
  assert.equal(rule0([r(0.8), r(0.85), r(0.9), r(0.7), r(0.95), r(0.88)]).verdict, 'PASS');
  const noisy = rule0([r(0.6), r(1.3), r(0.9), r(1.2), r(0.8), r(1.1)]);
  assert.equal(noisy.verdict, 'FAIL');
  assert.match(noisy.reasons.join(' '), /win rate 50%/);
  assert.equal(rule0([r(0.8)]).verdict, 'INCONCLUSIVE');
  assert.match(rule0([r(0.8), r(0.8), r(0.8), r(0.8), r(0.8, true, false)]).reasons.join(' '), /quality dropped/);
});

test('strategyTable: bench rule turns strategies on; outcomes classify worked / guard / never fired', async () => {
  const { strategyTable, effectiveStrategies } = await import('../lib/strategies.mjs');
  const opt = {
    strategies: [{ kind: 'relevance_filter', enabled: false }, { kind: 'cache_optimizer', enabled: true }, { kind: 'thinking_trim', enabled: false }, { kind: 'code_graph', enabled: false }],
    overrides: { rules: [
      { label: 'bench', when: { metadata: { tool: ['anyray-bench'] } }, enable: ['relevance_filter', 'thinking_trim'] },
      { label: 'someone else', when: { users: ['x@y'] }, enable: ['code_graph'] },
    ] },
  };
  const eff = effectiveStrategies(opt);
  assert.deepEqual(eff.filter((s) => s.on).map((s) => s.kind).sort(), ['cache_optimizer', 'relevance_filter', 'thinking_trim']);
  const traces = [{ decisions: [
    { kind: 'relevance_filter', estimatedTokensSaved: 400 },
    { kind: 'thinking_trim', metric: { name: 'guard_suppressed', value: 1 } },
  ] }];
  const rows = Object.fromEntries(strategyTable(opt, traces).map((r) => [r.kind, r.verdict]));
  assert.equal(rows.relevance_filter, 'worked');
  assert.equal(rows.thinking_trim, 'held by guard');
  assert.equal(rows.cache_optimizer, 'on, never fired');
  assert.equal(rows.code_graph, 'off');
  assert.equal(effectiveStrategies(null), null);
});

test('loadConfig refuses a blocked gateway', () => {
  const raw = { run: { blocked_gateways: ['https://gateway.anyray.ai'] }, benchmarks: {} };
  assert.throws(() => loadConfig({ raw, env: { ANYRAY_AUTH_MODE: 'managed', ANYRAY_GATEWAY_URL: 'https://gateway.anyray.ai/' } }), /blocked/);
  assert.equal(loadConfig({ raw, env: { ANYRAY_AUTH_MODE: 'managed', ANYRAY_GATEWAY_URL: 'https://gw.example' } }).run.gatewayUrl, 'https://gw.example');
});

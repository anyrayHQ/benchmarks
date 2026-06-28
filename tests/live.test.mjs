import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLiveConfig } from '../lib/env.mjs';
import { authHeaders } from '../lib/auth.mjs';
import { GatewayClient, parseCompletion } from '../lib/gatewayClient.mjs';
import { judgeAnswers, extractJsonObject } from '../lib/judge.mjs';
import { runCheck } from '../lib/checks/index.mjs';
import { withIsolatedStrategy } from '../lib/isolate.mjs';
import { synthesize } from '../lib/verdict.mjs';

test('resolveLiveConfig fills defaults and reads env', () => {
  const cfg = { live: { temperature: 0 }, requestTimeoutMs: 30000 };
  const env = {
    ANYRAY_GATEWAY_URL: 'http://gw:8787',
    ANYRAY_LIVE_MODEL: 'm1',
    ANYRAY_JUDGE_MODEL: 'claude-opus-4-8',
    ANYRAY_AUTH_MODE: 'managed', // avoid touching the real keychain/connect.json in unit tests
    ANYRAY_CLIENT_KEY: 'ark_test',
  };
  const live = resolveLiveConfig(cfg, env);
  assert.equal(live.gatewayUrl, 'http://gw:8787');
  assert.equal(live.model, 'm1');
  assert.equal(live.temperature, 0);
  assert.equal(live.auth.mode, 'managed');
  assert.equal(live.auth.clientKey, 'ark_test');
  assert.equal(live.judge.model, 'claude-opus-4-8');
  assert.equal(live.judge.url, 'http://gw:8787/v1/chat/completions');
  assert.equal(live.judge.auth, live.auth);
});

test('authHeaders builds passthrough headers (OAuth + ark key)', () => {
  const h = authHeaders({ mode: 'passthrough', provider: 'anthropic', upstreamToken: 'oat', clientKey: 'ark_x' });
  assert.equal(h.authorization, 'Bearer oat');
  assert.equal(h['x-anyray-api-key'], 'ark_x');
  assert.equal(h['x-anyray-auth-mode'], 'passthrough');
  assert.equal(h['x-anyray-provider'], 'anthropic');
});

test('authHeaders managed uses the client key as bearer', () => {
  const h = authHeaders({ mode: 'managed', clientKey: 'ark_x' });
  assert.equal(h.authorization, 'Bearer ark_x');
  assert.equal(h['x-anyray-api-key'], undefined);
});

test('parseCompletion extracts answer + usage + finishReason', () => {
  const body = {
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 5 },
  };
  const r = parseCompletion(body);
  assert.equal(r.answer, 'hello');
  assert.equal(r.usage.prompt_tokens, 120);
  assert.equal(r.finishReason, 'stop');
});

test('parseCompletion joins block-array content', () => {
  const body = { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] };
  assert.equal(parseCompletion(body).answer, 'ab');
});

test('GatewayClient.execute sends x-anyray-optimize header and parses decisions', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) =>
          h === 'x-anyray-optimization'
            ? JSON.stringify({ kinds: ['relevance_filter'], estimatedTokensSaved: 9 })
            : null,
      },
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10 },
      }),
    };
  };
  const gw = new GatewayClient({
    url: 'http://gw:8787',
    auth: { mode: 'managed', clientKey: 'k' },
    fetchImpl: fakeFetch,
  });
  const r = await gw.execute({ model: 'm', messages: [] }, { optimize: 'off' });
  assert.equal(calls[0].init.headers['x-anyray-optimize'], 'off');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  assert.equal(r.answer, 'ok');
  assert.equal(r.raw.usage.prompt_tokens, 10);
  assert.deepEqual(r.decisions.kinds, ['relevance_filter']);
});

test('extractJsonObject pulls the first balanced object (as a string)', () => {
  const s = extractJsonObject('noise {"preserved":true,"score":95} tail');
  assert.equal(s, '{"preserved":true,"score":95}');
  assert.deepEqual(JSON.parse(s), { preserved: true, score: 95 });
});

test('judgeAnswers parses verdict from a mocked judge and clamps score', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        { message: { content: '{"preserved":true,"score":105,"missingFacts":[],"rationale":"ok"}' } },
      ],
    }),
  });
  const r = await judgeAnswers({
    judge: {
      url: 'http://gw/v1/chat/completions',
      model: 'claude-opus-4-8',
      auth: { mode: 'managed', clientKey: 'k' },
    },
    question: 'q',
    keyFacts: ['a'],
    baselineAnswer: 'A',
    optimizedAnswer: 'A',
    fetchImpl: fakeFetch,
  });
  assert.equal(r.preserved, true);
  assert.equal(r.score, 100);
  assert.equal(r.by, 'claude-opus-4-8');
});

test('truncation check fails when output was cut', () => {
  assert.equal(runCheck('truncation', { optimized: { finishReason: 'length' } }).verdict, 'FAIL');
});
test('truncation check passes on a clean stop', () => {
  assert.equal(runCheck('truncation', { optimized: { finishReason: 'stop' } }).verdict, 'PASS');
});
test('identical check passes when answers match', () => {
  assert.equal(
    runCheck('identical', { baseline: { answer: 'x' }, optimized: { answer: 'x' } }).verdict,
    'PASS'
  );
});
test('cache_hit check passes when decisions report a hit', () => {
  assert.equal(
    runCheck('cache_hit', { optimized: { decisions: { cacheHit: true } } }).verdict,
    'PASS'
  );
});
test('readonly check is N/A and carries the metric', () => {
  const r = runCheck('readonly', { metric: { name: 'contextQuality', value: 42 } });
  assert.equal(r.verdict, 'N/A');
  assert.equal(r.detail.value, 42);
});

test('withIsolatedStrategy restores the snapshot even on throw', async () => {
  const events = [];
  const client = {
    getSettings: async () => ({
      config: { strategies: [{ kind: 'semantic_cache', enabled: true }] },
    }),
    setStrategy: async (k, p) => events.push(['set', k, p]),
    putConfig: async (c) => events.push(['restore', c.strategies?.[0]?.kind]),
  };
  await assert.rejects(
    withIsolatedStrategy(client, 'relevance_filter', { keepChars: 9 }, async () => {
      events.push(['run']);
      throw new Error('boom');
    })
  );
  assert.deepEqual(events, [
    ['set', 'relevance_filter', { keepChars: 9 }],
    ['run'],
    ['restore', 'semantic_cache'],
  ]);
});

const TH = { minSavedPct: 20, allowMarginal: 0 };
test('verdict WORKING when savings high and no FAIL', () => {
  const rows = [{ strategy: 'relevance_filter', realSavedPct: 80, quality: 'PASS' }];
  assert.equal(synthesize(rows, TH)[0].verdict, 'WORKING');
});
test('verdict REWORK when a quality FAIL and no recoverable knob', () => {
  const rows = [{ strategy: 'relevance_filter', realSavedPct: 80, quality: 'FAIL' }];
  assert.equal(synthesize(rows, TH)[0].verdict, 'REWORK');
});
test('verdict TUNE when a FAIL but sweep shows a recoverable knob', () => {
  const rows = [
    {
      strategy: 'relevance_filter',
      realSavedPct: 80,
      quality: 'FAIL',
      sweep: [{ knob: { keepChars: 32000 }, quality: 'PASS', realSavedPct: 55 }],
    },
  ];
  const v = synthesize(rows, TH)[0];
  assert.equal(v.verdict, 'TUNE');
  assert.deepEqual(v.recommendedKnob, { keepChars: 32000 });
});
test('verdict NEGLIGIBLE savings -> REWORK', () => {
  const rows = [{ strategy: 'x', realSavedPct: 3, quality: 'PASS' }];
  assert.equal(synthesize(rows, TH)[0].verdict, 'REWORK');
});
test('verdict N/A for readonly-only group', () => {
  const rows = [{ strategy: 'context_quality', realSavedPct: 0, quality: 'N/A' }];
  assert.equal(synthesize(rows, TH)[0].verdict, 'N/A');
});
test('verdict does NOT pool sweep across workloads: one unrecoverable FAIL -> REWORK', () => {
  // workload A fails at every knob; workload B passes. Pooling B's PASS would wrongly
  // call this TUNE — it must be REWORK because A never recovers on its own sweep.
  const rows = [
    { strategy: 'code_skeleton', realSavedPct: 70, quality: 'FAIL', sweep: [{ knob: { minBodyLines: 8 }, quality: 'FAIL', realSavedPct: 70 }] },
    { strategy: 'code_skeleton', realSavedPct: 24, quality: 'PASS', sweep: [{ knob: { minBodyLines: 2 }, quality: 'PASS', realSavedPct: 24 }] },
  ];
  assert.equal(synthesize(rows, TH)[0].verdict, 'REWORK');
});
test('verdict TUNE (not REWORK) when no FAIL but a MARGINAL + sub-threshold savings', () => {
  // the code_graph case: 1 PASS, 1 MARGINAL, ~18% median — improvable, not broken.
  const rows = [
    { strategy: 'code_graph', realSavedPct: 21, quality: 'PASS' },
    { strategy: 'code_graph', realSavedPct: 18, quality: 'MARGINAL' },
  ];
  assert.equal(synthesize(rows, TH)[0].verdict, 'TUNE');
});
test('verdict TUNE when default savings low but a sweep knob recovers (PASS + savings)', () => {
  const rows = [
    {
      strategy: 'prompt_compression',
      realSavedPct: 10,
      quality: 'PASS',
      sweep: [{ knob: { minChars: 200 }, quality: 'PASS', realSavedPct: 25 }],
    },
  ];
  const v = synthesize(rows, TH)[0];
  assert.equal(v.verdict, 'TUNE');
  assert.deepEqual(v.recommendedKnob, { minChars: 200 });
});

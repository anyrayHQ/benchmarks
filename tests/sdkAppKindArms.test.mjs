import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMS, armEnvFor, armMcpServers, watchedKinds, foldAppSession, modelFallbacksOf } from '../lib/agentSdkApp.mjs';
import { foldKindEvidence, readSessionKindEvidence } from '../lib/kindEvidence.mjs';
import { parseArgs, readSecretFile, sessionCost } from '../run_sdk_app.mjs';

const K_KINDS = ['observation_mask', 'relevance_filter', 'code_graph', 'columnar_fold', 'command_digest'];
const base = { gatewayUrl: 'https://gw.example', model: 'claude-sonnet-5-5', sessionId: 'sid', clientKey: 'ark_synthetic-k' };
const headerLines = (env) => env.ANTHROPIC_CUSTOM_HEADERS.split('\n');

// ---- the arms ----------------------------------------------------------------

test('K is harness retrieval on with Novee\'s five fresh-work kinds; R is K plus repeat_factor', () => {
  assert.deepEqual(ARMS.K.kinds, K_KINDS);
  assert.deepEqual(ARMS.R.kinds, [...K_KINDS, 'repeat_factor']);
  for (const arm of ['K', 'R']) {
    assert.equal(ARMS[arm].harnessRetrieval, 'on');
    assert.equal(ARMS[arm].optimize, null);
    assert.equal(ARMS[arm].readPath, true);
  }
  // The original three arms carry no kinds list: they keep the tenant's own selection.
  for (const arm of ['A', 'B', 'C']) assert.equal(ARMS[arm].kinds, undefined);
});

test('armEnvFor sends an arm spec\'s kinds as x-anyray-optimization-kinds', () => {
  const k = headerLines(armEnvFor({ ...base, arm: 'K' }));
  assert.ok(k.includes(`x-anyray-optimization-kinds: ${K_KINDS.join(',')}`));
  assert.ok(k.includes('x-anyray-harness-retrieval: on'));
  const r = headerLines(armEnvFor({ ...base, arm: 'R' }));
  assert.ok(r.includes(`x-anyray-optimization-kinds: ${[...K_KINDS, 'repeat_factor'].join(',')}`));
  for (const arm of ['A', 'B', 'C']) {
    assert.doesNotMatch(armEnvFor({ ...base, arm }).ANTHROPIC_CUSTOM_HEADERS, /x-anyray-optimization-kinds/);
  }
});

test('K and R differ ONLY by the kinds header: same env, same read path, same metadata', () => {
  const k = armEnvFor({ ...base, arm: 'K' });
  const r = armEnvFor({ ...base, arm: 'R' });
  const { ANTHROPIC_CUSTOM_HEADERS: hk, ...restK } = k;
  const { ANTHROPIC_CUSTOM_HEADERS: hr, ...restR } = r;
  assert.deepEqual(restK, restR);
  const kindsLine = /^x-anyray-optimization-kinds:/;
  assert.deepEqual(hk.split('\n').filter((h) => !kindsLine.test(h)), hr.split('\n').filter((h) => !kindsLine.test(h)));
  const mk = armMcpServers({ arm: 'K', scannerServer: { s: 1 }, gatewayUrl: base.gatewayUrl, clientKey: 'ark_synthetic' });
  const mr = armMcpServers({ arm: 'R', scannerServer: { s: 1 }, gatewayUrl: base.gatewayUrl, clientKey: 'ark_synthetic' });
  assert.deepEqual(mk, mr);
  assert.equal(mk.servers.anyray.url, 'https://gw.example/mcp');
});

test('watchedKinds names the kinds some selected arm runs and another does not', () => {
  assert.deepEqual(watchedKinds(['K', 'R']), ['repeat_factor']);
  assert.deepEqual(watchedKinds(['R']), []);
  assert.deepEqual(watchedKinds(['A', 'B', 'C']), []);
  // An arm without a kinds list runs the tenant's selection, so every listed kind is watched.
  assert.deepEqual(watchedKinds(['B', 'R']), [...K_KINDS, 'repeat_factor'].sort());
});

// ---- the runner's flags --------------------------------------------------------

test('run_sdk_app still defaults to A,B,C and takes K,R by name', () => {
  assert.deepEqual(parseArgs(['--keys-dir', '/k']).arms, ['A', 'B', 'C']);
  assert.deepEqual(parseArgs(['--keys-dir', '/k', '--arms', 'r,k']).arms, ['K', 'R']);
  assert.throws(() => parseArgs(['--keys-dir', '/k', '--arms', 'K,Z']), /--arms/);
  assert.equal(parseArgs(['--keys-dir', '/k']).adminTokenFile, null);
  assert.equal(parseArgs(['--keys-dir', '/k', '--admin-token-file', '/t/admin.token']).adminTokenFile, '/t/admin.token');
});

test('readSecretFile refuses a file group or others can read, and an empty one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-'));
  try {
    const f = join(dir, 'admin.token');
    writeFileSync(f, 'synthetic-admin-token\n');
    chmodSync(f, 0o644);
    assert.throws(() => readSecretFile(f), /chmod 600/);
    chmodSync(f, 0o600);
    assert.equal(readSecretFile(f), 'synthetic-admin-token');
    writeFileSync(f, '  \n');
    assert.throws(() => readSecretFile(f), /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- per-session kind evidence from trace metadata ------------------------------

const row = (id, kinds, { suppressed, declines, sessionId = 's' } = {}) => ({
  id,
  sessionId,
  metadata: { optimizationKinds: kinds, ...(suppressed && { optimizationSuppressed: suppressed }), ...(declines && { strategyDeclines: declines }) },
});

test('foldKindEvidence counts fresh folds, blocks, tokens and replays of one kind, from metadata only', () => {
  const rows = [
    row('t1', ['cache_optimizer']),
    row('t2', ['repeat_factor', 'observation_mask']),
    row('t3', ['repeat_factor', 'repeat_factor'], { declines: { repeat_factor: { payback_premium: 2 } } }),
    row('t4', ['content_census'], { declines: { repeat_factor: { no_candidate_span: 1, payback_premium: 1 } } }),
  ];
  const decisions = {
    t2: [{ kind: 'repeat_factor', estimatedTokensSaved: 900, after: { blocksFactored: 3 } }, { kind: 'observation_mask', estimatedTokensSaved: 50 }],
    // A mixed turn: the replay of settled folds and a new fold, booked apart.
    t3: [{ kind: 'repeat_factor', estimatedTokensSaved: 400, pinsReplayed: 2 }, { kind: 'repeat_factor', estimatedTokensSaved: 120, after: { blocksFactored: 1 } }],
  };
  const e = foldKindEvidence(rows, decisions, 'repeat_factor');
  assert.equal(e.requests, 4);
  assert.equal(e.requestsWithKind, 2);
  assert.equal(e.freshFolds, 2);
  assert.equal(e.blocksFactored, 4);
  assert.equal(e.freshTokens, 1020);
  assert.equal(e.replays, 1);
  assert.equal(e.pinsReplayed, 2);
  assert.equal(e.replayTokens, 400);
  assert.equal(e.tokensSaved, 1420);
  assert.deepEqual(e.declines, { payback_premium: 3, no_candidate_span: 1 });
  assert.deepEqual(e.suppressed, {});
  assert.equal(e.holdout, false);
  assert.equal(e.detailUnread, 0);
});

test('foldKindEvidence flags a session-gate holdout and an unread decision list', () => {
  const rows = [
    row('t1', ['cache_optimizer'], { suppressed: [{ kind: 'repeat_factor', reason: 'session_gate_holdout' }, { kind: 'code_graph', reason: 'toolless_turn' }] }),
    row('t2', ['repeat_factor']),
  ];
  const e = foldKindEvidence(rows, {}, 'repeat_factor');
  assert.equal(e.holdout, true);
  assert.deepEqual(e.suppressed, { session_gate_holdout: 1 });
  // The trace says repeat_factor decided, but its decision list was not read: unknown, not zero.
  assert.equal(e.requestsWithKind, 1);
  assert.equal(e.detailUnread, 1);
  assert.equal(e.tokensSaved, null);
  assert.equal(e.blocksFactored, null);
  // A control session the kind never touched reads zero, known.
  const k = foldKindEvidence([row('t9', ['observation_mask'])], {}, 'repeat_factor');
  assert.equal(k.requestsWithKind, 0);
  assert.equal(k.tokensSaved, 0);
  assert.equal(k.blocksFactored, 0);
});

test('foldKindEvidence ignores malformed metadata instead of counting it', () => {
  const rows = [{ id: 't1', metadata: { optimizationKinds: 'repeat_factor', optimizationSuppressed: [{ kind: 'repeat_factor' }], strategyDeclines: { repeat_factor: { 'bad reason!': 2, ok: -1 } } } }, { id: 't2' }];
  const decisions = { t1: [{ kind: 'repeat_factor', estimatedTokensSaved: 'lots', after: { blocksFactored: -2 } }] };
  const e = foldKindEvidence(rows, decisions, 'repeat_factor');
  assert.equal(e.requestsWithKind, 0);
  assert.deepEqual(e.suppressed, {});
  assert.deepEqual(e.declines, {});
});

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('readSessionKindEvidence pages the metadata list, reads decisions only where the kind decided, never the /content path', async () => {
  const seen = [];
  const pages = {
    first: { data: [row('t1', ['repeat_factor'], { sessionId: 'sess-1' }), row('t2', ['cache_optimizer'], { sessionId: 'sess-1' })], next_cursor: 'c2' },
    // A row of another session (a gateway that ignored the filter) is never counted.
    c2: { data: [row('t3', ['observation_mask'], { sessionId: 'sess-1' }), row('t4', ['repeat_factor'], { sessionId: 'other' })], next_cursor: null },
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    assert.equal(init.headers.authorization, 'Bearer synthetic-admin');
    if (u.pathname === '/admin/v1/traces') {
      assert.equal(u.searchParams.get('sessionId'), 'sess-1');
      return jsonRes(pages[u.searchParams.get('cursor') ?? 'first']);
    }
    if (u.pathname === '/admin/v1/traces/t1') return jsonRes({ observations: [{ name: 'optimizer', output: { decisions: [{ kind: 'repeat_factor', estimatedTokensSaved: 700, after: { blocksFactored: 2 }, summary: 'synthetic' }] } }] });
    throw new Error(`unexpected ${u.pathname}`);
  };
  const out = await readSessionKindEvidence('https://gw.example', 'synthetic-admin', 'sess-1', ['repeat_factor'], { fetchImpl, sleep: async () => {}, settleReads: 2 });
  assert.equal(out.requests, 3);
  assert.equal(out.kinds.repeat_factor.blocksFactored, 2);
  assert.equal(out.kinds.repeat_factor.freshTokens, 700);
  assert.ok(seen.every((p) => !p.includes('/content')), 'never the body path');
  assert.equal(seen.filter((p) => p.startsWith('/admin/v1/traces/')).length, 1, 'one detail read, for the one trace the kind decided on');
  // The record keeps counts only: no summary text survives the fold.
  assert.doesNotMatch(JSON.stringify(out), /synthetic"/);
});

test('readSessionKindEvidence answers unavailable, never throws, when it cannot read', async () => {
  const out = await readSessionKindEvidence('https://gw.example', 'synthetic-admin', 's', ['repeat_factor'], { fetchImpl: async () => jsonRes({}, 403), sleep: async () => {} });
  assert.match(out.unavailable, /403/);
  assert.equal((await readSessionKindEvidence('https://gw.example', null, 's', ['repeat_factor'])).unavailable, 'no admin token');
});

// ---- which model served each thread, and the dollars the cap counts ----------------

test('foldAppSession counts requests per served model, main thread and subagents apart', () => {
  const asst = (id, model, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });
  const s = foldAppSession(
    [asst('m1', 'claude-opus-4-6'), asst('m1', 'claude-opus-4-6'), asst('m2', 'claude-sonnet-5'), asst('s1', 'claude-sonnet-5', 'tu1'), asst('s2', 'claude-opus-4-6', 'tu1')],
    { pricing: { cache_read: 0.1, cache_write: 1.25, models: {} }, model: 'claude-opus-4-6' }
  );
  assert.deepEqual(s.totals.models, { main: { 'claude-opus-4-6': 1, 'claude-sonnet-5': 1 }, subagents: { 'claude-sonnet-5': 1, 'claude-opus-4-6': 1 } });
});

test('sessionCost counts the larger of the priced and the SDK-reported dollars, so the cap never undercounts', () => {
  assert.equal(sessionCost({ totals: { costUsd: 3.6, sdkCostUsd: 4.84 } }), 4.84);
  assert.equal(sessionCost({ totals: { costUsd: 3.0, sdkCostUsd: 2.9 } }), 3.0);
  assert.equal(sessionCost({ totals: { costUsd: null, sdkCostUsd: 2.9 } }), 2.9);
  assert.equal(sessionCost({ totals: { costUsd: 1.5, sdkCostUsd: null } }), 1.5);
  assert.equal(sessionCost({ error: 'timeout' }), 0);
});

test('modelFallbacksOf keeps the CLI\'s model fallbacks as model ids and the request they followed, nothing else', () => {
  const asst = (id) => ({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [] } });
  const messages = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
    asst('m1'),
    asst('m2'),
    { type: 'system', subtype: 'model_refusal_fallback', original_model: 'claude-sonnet-5-5', fallback_model: 'claude-sonnet-5', note: 'synthetic text' },
    asst('m3'),
    { type: 'system', subtype: 'model_fallback', original_model: 'claude-opus-4-6', fallback_model: 'not a model id!' },
  ];
  assert.deepEqual(modelFallbacksOf(messages), [
    { subtype: 'model_refusal_fallback', from: 'claude-sonnet-5-5', to: 'claude-sonnet-5', afterRequest: 2 },
    { subtype: 'model_fallback', from: 'claude-opus-4-6', to: 'unknown', afterRequest: 3 },
  ]);
  assert.deepEqual(modelFallbacksOf([{ type: 'system', subtype: 'status' }, asst('m1')]), []);
});

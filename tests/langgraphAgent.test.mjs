import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runLangGraphAgent, recordingFetch, withoutInheritedRoute } from '../lib/langgraphAgent.mjs';
import { EMPTY_ANSWER_REQUEST, FINAL_ANSWER_REQUEST } from '../lib/sdkAgent.mjs';
import { parseArgs, runComparison } from '../run_agent.mjs';

const fresh = () => mkdtempSync(join(process.cwd(), 'langgraph-test-'));
const pricing = { models: { 'claude-sonnet-5': { input: 2, output: 10 } }, cache_read: 0.1, cache_write: 1.25 };
const bedrock = { model: 'us.anthropic.claude-sonnet-5', profile: 'test', region: 'us-east-1' };
const credentials = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test' };
let replies = 0; // message ids must differ: LangGraph's reducer replaces a message whose id it has seen
const reply = (body) => new Response(JSON.stringify({ id: `msg_${++replies}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_sequence: null, ...body }), { status: 200, headers: { 'content-type': 'application/json' } });
const toolTurn = (id, input = { path: 'a.py', offset: 2, limit: 1 }) => reply({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'read_file', input }], usage: { input_tokens: 10, output_tokens: 4 } });
const answer = (text) => reply({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 6 } });

/** fetch stub: records each request, answers from `responses` in order. */
function wire(responses) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: new URL(String(url)), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return responses.shift();
  };
  return { sent, fetchImpl };
}

test('LangGraph agent runs tools through the graph, sends no cache markers, and bills each response', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const { sent, fetchImpl } = wire([toolTurn('t1'), answer('Answer a.py:2')]);
    const session = await runLangGraphAgent({ arm: 'anyray', scenario: { task: 'Explain', maxTurns: 8, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', kinds: ['cache_lint'], sessionId: 'sess-1', fetchImpl });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url.href, 'https://gateway.test.invalid/v1/messages');
    assert.equal(sent[0].headers.get('x-api-key'), 'fake-key');
    assert.equal(JSON.parse(sent[0].headers.get('x-anyray-metadata')).sessionId, 'sess-1');
    assert.equal(sent[0].headers.get('x-anyray-optimization-kinds'), 'cache_lint');
    assert.equal(JSON.stringify(sent.map((s) => s.body)).includes('cache_control'), false);
    assert.deepEqual(sent[0].body.tools.map((t) => t.name), ['read_file', 'list_dir', 'grep']);
    const toolResult = sent[1].body.messages.at(-1).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.match(JSON.stringify(toolResult.content), /2: second/);
    assert.equal(session.result.text, 'Answer a.py:2');
    assert.equal(session.result.subtype, 'success');
    assert.equal(session.citations.resolved, 1);
    assert.deepEqual(session.requests.map((r) => r.usage), [
      { input: 10, cacheRead: 0, cacheWrite: 0, output: 4 },
      { input: 3, cacheRead: 100, cacheWrite: 5, output: 6 },
    ]);
    assert.equal(session.requests[0].costUsd, (10 * 2 + 4 * 10) / 1e6);
    assert.equal(session.totals.costUsd, session.requests.reduce((n, r) => n + r.costUsd, 0));
    assert.equal(session.totals.turns, 2);
    assert.equal(session.totals.toolCalls, 1);
    assert.deepEqual(session.requests[1].blocks, ['text']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('LangGraph final turn asks for the answer with tools declared but not callable', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const { sent, fetchImpl } = wire([toolTurn('t1'), toolTurn('t2'), answer('Answer a.py:1')]);
    const session = await runLangGraphAgent({ arm: 'anyray', scenario: { task: 'Explain', maxTurns: 3, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', fetchImpl });
    assert.equal(sent.length, 3);
    assert.equal(sent[0].body.tool_choice, undefined);
    assert.deepEqual(sent[2].body.tool_choice, { type: 'none' });
    assert.deepEqual(sent[2].body.tools, sent[0].body.tools, 'tools stay declared, so the prefix is unchanged');
    assert.equal(sent[2].body.messages.at(-1).role, 'user');
    assert.match(JSON.stringify(sent[2].body.messages.at(-1).content), new RegExp(FINAL_ANSWER_REQUEST.slice(0, 30)));
    assert.equal(session.result.subtype, 'success');
    assert.equal(session.totals.turns, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a final reply of thinking alone gets one more answer-only request with the same params', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const thinkingOnly = reply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: { input_tokens: 2, output_tokens: 300 } });
    const { sent, fetchImpl } = wire([toolTurn('t1'), thinkingOnly, answer('Answer a.py:1')]);
    const session = await runLangGraphAgent({ arm: 'anyray', scenario: { task: 'Explain', maxTurns: 2, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', fetchImpl });
    assert.equal(sent.length, 3);
    const { messages: lastMessages, ...lastParams } = sent[2].body;
    const { messages: _m, ...finalParams } = sent[1].body;
    assert.deepEqual(lastParams, finalParams, 'same tools, tool_choice and max_tokens as the final turn');
    assert.deepEqual(sent[2].body.tool_choice, { type: 'none' });
    assert.match(JSON.stringify(lastMessages.at(-1).content), new RegExp(EMPTY_ANSWER_REQUEST.slice(0, 30)));
    assert.equal(session.result.text, 'Answer a.py:1');
    assert.equal(session.result.subtype, 'success');
    assert.equal(session.totals.answerRetries, 1);
    assert.equal(session.totals.turns, 3);
    assert.deepEqual(session.requests[1].blocks, ['thinking']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an answer that is still empty after the retry is graded as no answer', async () => {
  const root = fresh();
  try {
    const thinkingOnly = () => reply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: { input_tokens: 2, output_tokens: 3 } });
    const { sent, fetchImpl } = wire([thinkingOnly(), thinkingOnly()]);
    const session = await runLangGraphAgent({ arm: 'anyray', scenario: { task: 'Explain', maxTurns: 5 }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', fetchImpl });
    assert.equal(sent.length, 2, 'one retry, never a loop');
    assert.equal(session.result.subtype, 'error_no_answer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a routed shell cannot reroute or re-key either arm', async () => {
  const root = fresh();
  const env = { ANTHROPIC_BASE_URL: 'https://elsewhere.invalid', ANTHROPIC_CUSTOM_HEADERS: 'x-anyray-api-key: leaked\nx-anyray-provider: other', ANTHROPIC_API_KEY: 'leaked-key' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    for (const arm of ['anyray', 'direct']) {
      const { sent, fetchImpl } = wire([answer('done')]);
      await runLangGraphAgent({ arm, scenario: { task: 'Explain', maxTurns: 2 }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', bedrock, credentials, fetchImpl });
      const [req] = sent;
      assert.equal(req.url.host, arm === 'direct' ? 'bedrock-runtime.us-east-1.amazonaws.com' : 'gateway.test.invalid');
      assert.equal(req.headers.get('x-anyray-api-key'), null);
      assert.equal(req.headers.get('x-anyray-provider'), null);
      if (arm === 'direct') {
        assert.equal(req.url.pathname, '/model/us.anthropic.claude-sonnet-5/invoke');
        assert.match(req.headers.get('authorization'), /^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
        assert.equal(req.headers.get('x-api-key'), null);
        assert.equal(req.headers.get('x-anyray-metadata'), null);
        assert.equal(req.body.anthropic_version, 'bedrock-2023-05-31');
      } else assert.equal(req.headers.get('x-api-key'), 'fake-key');
    }
    assert.deepEqual(Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])), env, 'the shell env is restored');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }
});

test('recordingFetch refuses another host and x-anyray headers the arm did not set', async () => {
  const requests = [];
  const f = recordingFetch({ host: 'gateway.test.invalid', anyrayHeaders: ['x-anyray-metadata'], requests, fetchImpl: async () => answer('ok') });
  await assert.rejects(f('https://other.invalid/v1/messages', {}), /other\.invalid, not gateway\.test\.invalid/);
  await assert.rejects(f('https://gateway.test.invalid/v1/messages', { headers: { 'x-anyray-api-key': 'k' } }), /x-anyray-api-key/);
  await f('https://gateway.test.invalid/v1/messages', { headers: { 'x-anyray-metadata': '{}' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].usage.output_tokens, 6);
});

test('withoutInheritedRoute hides the route only while building', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://x.invalid', OTHER: '1' };
  const seen = withoutInheritedRoute(() => ({ ...env }), env);
  assert.deepEqual(seen, { OTHER: '1' });
  assert.deepEqual(env, { ANTHROPIC_BASE_URL: 'https://x.invalid', OTHER: '1' });
});

test('langgraph-docs takes the paired SDK flags and records its framework transports', async () => {
  assert.throws(() => parseArgs(['--scenario', 'langgraph-docs']), /langgraph-docs needs --provider bedrock/);
  assert.throws(() => parseArgs(['--scenario', 'langgraph-docs', '--provider', 'bedrock', '--warm-up']), /langgraph-docs supports/);
  const label = `offline-${process.pid}-${Date.now()}`;
  const args = parseArgs(['--scenario', 'langgraph-docs', '--provider', 'bedrock', '--rounds', '1', '--label', label]);
  const workDirs = [];
  const deps = {
    clientKey: 'fake-key',
    resolveBedrock: async () => bedrock,
    prepareRepo: () => { const dir = fresh(); workDirs.push(dir); return dir; },
    describeRepo: () => ({ files: 1 }),
    runSdkAgent: async ({ arm, scenario }) => ({ requests: [], totals: { costUsd: arm === 'direct' ? 0.00002 : 0.00001, input: 10, cacheRead: 0, cacheWrite: 0, output: 1, turns: 1, requests: 1, outsideCheckout: 0 }, result: { text: 'cited' }, citations: { total: scenario.citations.min, resolved: scenario.citations.min } }),
    log: () => {},
  };
  const cfg = { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid', model: 'claude-sonnet-5' }, pricing };
  let file;
  try {
    const result = await runComparison(args, cfg, { deps });
    file = result.file;
    assert.match(file, /langgraph-docs--anyray--/);
    assert.equal(result.record.scenario.name, 'langgraph-docs');
    assert.equal(result.record.request.framework, 'langgraph');
    assert.deepEqual([result.record.setup.a.transport, result.record.setup.b.transport], ['langchain-anthropic-bedrock', 'langchain-anthropic-gateway']);
    assert.equal(result.record.rounds[0].ratio, 0.5);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rounds.length, 1);
  } finally { if (file) rmSync(file, { force: true }); for (const dir of workDirs) rmSync(dir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { executeSdkTool, runSdkAgent, gatewayMessage, bedrockMessage } from '../lib/sdkAgent.mjs';
import { parseArgs, runComparison } from '../run_agent.mjs';
import { run as runVerdictTool } from '../tools/bench-verdict.mjs';

const fresh = () => mkdtempSync(join(process.cwd(), 'sdk-test-'));
const pricing = { models: { 'claude-sonnet-5': { input: 2, output: 10 } }, cache_read: 0.1, cache_write: 1.25 };

test('SDK loop preserves full history, sends no cache markers, and bills each response', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const bodies = [];
    const delays = [];
    const responses = [
      { model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.py', offset: 2, limit: 1 } }], usage: { input_tokens: 10, output_tokens: 4 } },
      { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer a.py:2' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 6 } },
    ];
    const session = await runSdkAgent({ arm: 'anyray', scenario: { task: 'Explain', maxTurns: 8, interTurnDelaySec: 310, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(responses.shift()), { status: 200 }); }, sleep: async (ms) => delays.push(ms) });
    assert.equal(bodies.length, 2);
    assert.deepEqual(delays, [310000]);
    assert.equal(JSON.stringify(bodies).includes('cache_control'), false);
    assert.equal(bodies[1].messages[2].content[0].content, '2: second');
    assert.equal(session.result.text, 'Answer a.py:2');
    assert.equal(session.citations.resolved, 1);
    assert.deepEqual(session.requests.map((r) => r.usage), [
      { input: 10, cacheRead: 0, cacheWrite: 0, output: 4 },
      { input: 3, cacheRead: 100, cacheWrite: 5, output: 6 },
    ]);
    assert.equal(session.totals.input, 118);
    assert.equal(session.totals.cacheRead, 100);
    assert.equal(session.totals.costUsd, session.requests.reduce((n, r) => n + r.costUsd, 0));
    assert.equal(session.requests[0].costUsd, (10 * 2 + 4 * 10) / 1e6);
    assert.equal(session.requests[1].costUsd, ((3 + 100 * 0.1 + 5 * 1.25) * 2 + 6 * 10) / 1e6);
    assert.ok(session.requests.every((r) => Number.isFinite(r.latencyMs)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SDK tools refuse traversal and symlinks outside the checkout', () => {
  const root = fresh();
  const outside = fresh();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'ok.py'), 'hello\n');
    writeFileSync(join(outside, 'secret.py'), 'secret\n');
    symlinkSync(join(outside, 'secret.py'), join(root, 'escape.py'));
    assert.match(executeSdkTool(root, 'read_file', { path: '../secret.py' }), /outside checkout/);
    assert.match(executeSdkTool(root, 'read_file', { path: 'escape.py' }), /outside checkout/);
    assert.match(executeSdkTool(root, 'grep', { pattern: 'secret' }), /No matches/);
    assert.equal(executeSdkTool(root, 'grep', { pattern: 'hello' }), 'src/ok.py:1:hello');
    assert.match(executeSdkTool(root, 'list_dir', { path: 'src' }), /ok.py/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('SDK scenario keeps early answers in the history until eight requests', async () => {
  const root = fresh();
  try {
    const bodies = [];
    const session = await runSdkAgent({ arm: 'anyray', scenario: { task: 'Explain', minTurns: 8, maxTurns: 10 }, work: root, model: 'claude-sonnet-5', pricing, gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    } });
    assert.equal(bodies.length, 8);
    assert.equal(bodies[7].messages.length, 15);
    assert.equal(session.result.subtype, 'success');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gateway and Bedrock transports carry the same unmarked body', async () => {
  const body = { model: 'claude-sonnet-5', max_tokens: 8, system: 'system', tools: [], messages: [{ role: 'user', content: 'hello' }] };
  let sent;
  await gatewayMessage({ gatewayUrl: 'https://gateway.test.invalid', clientKey: 'fake-key', body, sessionId: 'session', fetchImpl: async (url, init) => {
    sent = { url: String(url), init };
    return new Response(JSON.stringify({ content: [] }), { status: 200 });
  } });
  assert.equal(sent.url, 'https://gateway.test.invalid/v1/messages');
  assert.equal(sent.init.headers.authorization, 'Bearer fake-key');
  assert.equal(sent.init.headers['x-anyray-provider'], undefined);
  assert.deepEqual(JSON.parse(sent.init.body), body);
  const scratch = fresh();
  try {
    let native;
    await bedrockMessage({ bedrock: { model: 'us.anthropic.claude-sonnet-5', profile: 'test', region: 'us-east-1' }, body, scratchDir: scratch, execImpl: async (_bin, args) => {
      native = JSON.parse(readFileSync(args[args.indexOf('--body') + 1].slice('fileb://'.length), 'utf8'));
      writeFileSync(args.at(-1), JSON.stringify({ content: [] }));
    } });
    assert.equal(native.model, undefined);
    assert.equal(native.anthropic_version, 'bedrock-2023-05-31');
    assert.deepEqual(native.messages, body.messages);
    assert.equal(JSON.stringify(native).includes('cache_control'), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('sdk-docs routes through the paired runner and saves verdict-compatible rounds', async () => {
  const label = `offline-${process.pid}-${Date.now()}`;
  const args = parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--rounds', '1', '--label', label]);
  const workDirs = [];
  const logs = [];
  const deps = {
    clientKey: 'fake-key',
    resolveBedrock: async () => ({ model: 'us.anthropic.claude-sonnet-5', profile: 'test', region: 'us-east-1' }),
    prepareRepo: () => { const dir = fresh(); workDirs.push(dir); return dir; },
    describeRepo: () => ({ files: 1 }),
    runSdkAgent: async ({ arm, scenario }) => ({ requests: [{ usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, costUsd: 0.00001, latencyMs: 1 }], totals: { costUsd: arm === 'direct' ? 0.00002 : 0.00001, input: 10, cacheRead: arm === 'direct' ? 0 : 5, cacheWrite: 0, output: 1, turns: 1, requests: 1, outsideCheckout: 0 }, result: { text: 'cited' }, citations: { total: scenario.citations.min, resolved: scenario.citations.min }, setup: { transport: arm } }),
    log: (s) => logs.push(s),
  };
  const cfg = { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid', model: 'claude-sonnet-5' }, pricing };
  let file;
  try {
    const result = await runComparison(args, cfg, { deps });
    file = result.file;
    assert.equal(result.record.rounds.length, 1);
    assert.equal(result.record.rounds[0].ratio, 0.5);
    assert.deepEqual(result.record.rounds[0].quality, { a: true, b: true });
    assert.equal(result.record.verdict.n, 1);
    assert.match(logs.join('\n'), /cache-read share/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).rounds[0].sessions.b.requests.length, 1);
    let verdictJson = '';
    assert.equal(runVerdictTool(['--json', file], { out: { write: (s) => { verdictJson += s; } }, err: { write: (s) => assert.fail(s) } }), 2);
    assert.equal(JSON.parse(verdictJson).n, 1);
  } finally { if (file) rmSync(file, { force: true }); for (const dir of workDirs) rmSync(dir, { recursive: true, force: true }); }
});

test('sdk-docs requires the billed paired mode and validates delay', () => {
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs']), /--provider bedrock/);
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--inter-turn-delay-sec', '-1']), /nonnegative/);
  assert.equal(parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--inter-turn-delay-sec', '310']).interTurnDelaySec, 310);
});

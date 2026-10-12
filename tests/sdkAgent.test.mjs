import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeSdkTool, runSdkAgent, gatewayMessage, bedrockMessage, bedrockFailure, BEDROCK_CLI_READ_TIMEOUT_SEC, BEDROCK_CLI_PROCESS_TIMEOUT_MS, FINAL_ANSWER_REQUEST, EMPTY_ANSWER_REQUEST } from '../lib/sdkAgent.mjs';
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

test('SDK final turn asks for the answer with tools declared but not callable', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const bodies = [];
    const toolTurn = { model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a.py', offset: 1, limit: 1 } }], usage: { input_tokens: 1, output_tokens: 1 } };
    const answer = { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer a.py:1' }], usage: { input_tokens: 1, output_tokens: 1 } };
    const session = await runSdkAgent({
      arm: 'direct', scenario: { task: 'Explain', maxTurns: 3, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5',
      pricing: { 'claude-sonnet-5': { input: 2, output: 10 } },
      request: async ({ body, turn }) => { bodies.push(JSON.parse(JSON.stringify(body))); return turn === 2 ? answer : { ...toolTurn, content: [{ ...toolTurn.content[0], id: `t${turn}` }] }; },
    });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].tool_choice, undefined);
    assert.deepEqual(bodies[2].tool_choice, { type: 'none' });
    assert.deepEqual(bodies[2].tools, bodies[0].tools, 'tools stay declared, so the prefix is unchanged');
    const lastUser = bodies[2].messages.at(-1);
    assert.equal(lastUser.role, 'user');
    assert.equal(lastUser.content.at(-1).text, FINAL_ANSWER_REQUEST);
    assert.equal(lastUser.content[0].type, 'tool_result');
    assert.equal(session.result.subtype, 'success');
    assert.equal(session.citations.resolved, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SDK final reply of thinking alone gets one more answer-only request with the same tools', async () => {
  const root = fresh();
  try {
    writeFileSync(join(root, 'a.py'), 'first\nsecond\n');
    const bodies = [];
    const toolTurn = (id) => ({ model: 'claude-sonnet-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'a.py', offset: 1, limit: 1 } }], usage: { input_tokens: 1, output_tokens: 1 } });
    const thinkingOnly = { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: { input_tokens: 1, output_tokens: 300 } };
    const answer = { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer a.py:1' }], usage: { input_tokens: 1, output_tokens: 1 } };
    const session = await runSdkAgent({
      arm: 'direct', scenario: { task: 'Explain', maxTurns: 2, citations: { min: 1, resolveRate: 1 } }, work: root, model: 'claude-sonnet-5', pricing,
      request: async ({ body, turn }) => { bodies.push(JSON.parse(JSON.stringify(body))); return [toolTurn('t0'), thinkingOnly, answer][turn]; },
    });
    assert.equal(bodies.length, 3);
    const { messages: retryMessages, ...retryParams } = bodies[2];
    const { messages: _m, ...finalParams } = bodies[1];
    assert.deepEqual(retryParams, finalParams, 'same tools, tool_choice and max_tokens as the final turn');
    assert.equal(retryMessages.at(-2).content[0].type, 'thinking');
    assert.equal(retryMessages.at(-1).content, EMPTY_ANSWER_REQUEST);
    assert.deepEqual(session.requests.map((r) => r.blocks), [['tool_use'], ['thinking'], ['text']], 'each reply records what it held');
    assert.equal(session.result.text, 'Answer a.py:1');
    assert.equal(session.result.subtype, 'success');
    assert.equal(session.totals.answerRetries, 1);
    assert.equal(session.totals.requests, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SDK answer still empty after the retry is graded as no answer', async () => {
  const root = fresh();
  try {
    const bodies = [];
    const thinkingOnly = { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], usage: { input_tokens: 1, output_tokens: 3 } };
    const session = await runSdkAgent({ arm: 'direct', scenario: { task: 'Explain', maxTurns: 3 }, work: root, model: 'claude-sonnet-5', pricing, request: async ({ body }) => { bodies.push(body); return thinkingOnly; } });
    assert.equal(bodies.length, 2, 'one retry, never a loop');
    assert.equal(session.result.subtype, 'error_no_answer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const bedrock = { model: 'us.anthropic.claude-sonnet-5', profile: 'test', region: 'us-east-1' };
const body = { model: 'claude-sonnet-5', max_tokens: 16000, messages: [{ role: 'user', content: 'hello' }] };

test('Bedrock CLI call waits out a long non-streaming reply', async () => {
  const scratch = fresh();
  try {
    let call;
    const reply = await bedrockMessage({ bedrock, body, scratchDir: scratch, execImpl: async (bin, args, opts) => {
      call = { bin, args, opts };
      writeFileSync(args.at(-1), JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    } });
    assert.equal(reply.content[0].text, 'ok');
    assert.equal(call.bin, 'aws');
    const flag = (name) => call.args[call.args.indexOf(name) + 1];
    assert.ok(BEDROCK_CLI_READ_TIMEOUT_SEC >= 600, 'well above the CLI default of 60 s');
    assert.equal(flag('--cli-read-timeout'), String(BEDROCK_CLI_READ_TIMEOUT_SEC));
    assert.equal(flag('--cli-connect-timeout'), '60');
    assert.equal(flag('--model-id'), bedrock.model);
    assert.ok(call.args.at(-1).endsWith('response.json'), 'the reply file stays the positional last argument');
    assert.ok(call.opts.timeout > BEDROCK_CLI_READ_TIMEOUT_SEC * 1000, 'the CLI times out before the child process is killed');
    assert.equal(call.opts.timeout, BEDROCK_CLI_PROCESS_TIMEOUT_MS);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('a failed Bedrock CLI call names its cause from the CLI stderr', async () => {
  const scratch = fresh();
  const stub = join(scratch, 'aws-stub.mjs');
  writeFileSync(stub, `process.stderr.write('\\nRead timeout on endpoint URL: "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke"\\n'); process.exit(255);`);
  try {
    // A real child process, so the error has execFile's shape (numeric code, stderr, "Command failed" message).
    const run = promisify(execFile);
    await assert.rejects(
      bedrockMessage({ bedrock, body, scratchDir: scratch, execImpl: (_bin, args, opts) => run(process.execPath, [stub, ...args], opts) }),
      (e) => {
        assert.equal(e.message, 'SDK Bedrock request failed (exit 255): Read timeout on endpoint URL: "https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke"');
        return true;
      },
    );
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('Bedrock failure text: timeout kill, spawn error, bad reply, account ids', () => {
  assert.equal(bedrockFailure({ killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: aws ...' }), `SDK Bedrock request failed (timed out after ${BEDROCK_CLI_PROCESS_TIMEOUT_MS / 1000} s)`);
  assert.equal(bedrockFailure(Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' })), 'SDK Bedrock request failed (ENOENT): spawn aws ENOENT');
  assert.equal(bedrockFailure(new SyntaxError('Unexpected end of JSON input')), 'SDK Bedrock request failed: Unexpected end of JSON input');
  const denied = bedrockFailure({ code: 254, stderr: 'An error occurred (AccessDeniedException) when calling the InvokeModel operation: User: arn:aws:iam::123456789012:user/x is not authorized', message: 'Command failed: aws' });
  assert.match(denied, /^SDK Bedrock request failed \(exit 254\): An error occurred \(AccessDeniedException\)/);
  assert.equal(denied.includes('123456789012'), false);
  assert.match(denied, /iam::<account>:user/);
  assert.ok(bedrockFailure({ code: 255, stderr: 'x'.repeat(2000) }).length < 500, 'capped');
});

test('a failed SDK round names the arm that failed and its cause', async () => {
  const label = `offline-fail-${process.pid}-${Date.now()}`;
  const args = parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--rounds', '1', '--label', label]);
  const workDirs = [];
  const deps = {
    clientKey: 'fake-key',
    resolveBedrock: async () => bedrock,
    prepareRepo: () => { const dir = fresh(); workDirs.push(dir); return dir; },
    describeRepo: () => ({ files: 1 }),
    runSdkAgent: async ({ arm }) => {
      if (arm === 'direct') throw new Error('SDK Bedrock request failed (exit 255): Read timeout on endpoint URL');
      return { requests: [], totals: { costUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0, requests: 0, outsideCheckout: 0 }, result: { text: '' }, citations: null, setup: {} };
    },
    log: () => {},
  };
  const cfg = { root: process.cwd(), run: { gatewayUrl: 'https://gateway.test.invalid', model: 'claude-sonnet-5' }, pricing };
  let file;
  try {
    const result = await runComparison(args, cfg, { deps });
    file = result.file;
    assert.equal(result.record.rounds[0].error, 'direct: SDK Bedrock request failed (exit 255): Read timeout on endpoint URL');
  } finally { if (file) rmSync(file, { force: true }); for (const dir of workDirs) rmSync(dir, { recursive: true, force: true }); }
});

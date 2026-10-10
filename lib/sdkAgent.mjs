// A small, unmarked Anthropic Messages agent. Both transports receive the same
// conversation and tool schemas; only the Bedrock envelope differs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { checkCitations } from './agentRun.mjs';
import { costOfAnthropicUsage } from './cost.mjs';
import { countCacheBreaks } from './cacheBreaks.mjs';

const exec = promisify(execFile);
export const SDK_SYSTEM = 'You are documenting a pinned public source checkout. Use the tools to inspect code. Cite every factual claim as repository-relative path:line. Read at least eight distinct source files before the final answer. Never guess a citation.';
export const SDK_TOOLS = Object.freeze([
  { name: 'read_file', description: 'Read numbered lines from a repository file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['path'] } },
  { name: 'list_dir', description: 'List entries in a repository directory.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'grep', description: 'Search repository text files for a literal string.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
]);

function confined(root, path = '.') {
  if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('path outside checkout');
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, path));
  if (target !== base && !target.startsWith(`${base}/`)) throw new Error('path outside checkout');
  return { base, target };
}

export function executeSdkTool(root, name, input = {}) {
  try {
    if (name === 'read_file') {
      const { target } = confined(root, input.path);
      if (!statSync(target).isFile()) throw new Error('not a file');
      const offset = Math.max(1, Math.floor(Number(input.offset) || 1));
      const limit = Math.min(200, Math.max(1, Math.floor(Number(input.limit) || 100)));
      const lines = readFileSync(target, 'utf8').split('\n');
      return lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}: ${line.slice(0, 2000)}`).join('\n');
    }
    if (name === 'list_dir') {
      const { target } = confined(root, input.path ?? '.');
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
      return readdirSync(target, { withFileTypes: true }).slice(0, 200).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`).join('\n');
    }
    if (name === 'grep') {
      const pattern = input.pattern;
      if (typeof pattern !== 'string' || !pattern || pattern.length > 200) throw new Error('pattern must be 1–200 characters');
      const { base, target } = confined(root, input.path ?? '.');
      const found = [];
      const scan = (file) => {
        if (found.length >= 100) return;
        const s = statSync(file);
        if (s.isDirectory()) {
          for (const e of readdirSync(file, { withFileTypes: true })) {
            if (e.name === '.git' || e.isSymbolicLink()) continue;
            scan(join(file, e.name));
            if (found.length >= 100) break;
          }
        } else if (s.isFile() && s.size <= 1024 * 1024) {
          const lines = readFileSync(file, 'utf8').split('\n');
          for (let i = 0; i < lines.length && found.length < 100; i++) {
            if (lines[i].includes(pattern)) found.push(`${relative(base, file)}:${i + 1}:${lines[i].slice(0, 240)}`);
          }
        }
      };
      scan(target);
      return found.join('\n') || 'No matches';
    }
    throw new Error('unknown tool');
  } catch (e) {
    return `Tool error: ${e.message === 'path outside checkout' ? e.message : String(e.message).slice(0, 160)}`;
  }
}

export async function gatewayMessage({ gatewayUrl, clientKey, body, kinds, sessionId, fetchImpl = fetch }) {
  if (!gatewayUrl || !clientKey) throw new Error('SDK gateway arm needs a gateway URL and benchmark client key');
  const headers = { authorization: `Bearer ${clientKey}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-anyray-metadata': JSON.stringify({ tool: 'sdk-agent', sessionId }) };
  if (kinds?.length) headers['x-anyray-optimization-kinds'] = kinds.join(',');
  const res = await fetchImpl(new URL('/v1/messages', gatewayUrl), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`SDK gateway request: HTTP ${res.status}`);
  return res.json();
}

// The AWS CLI gives up on a socket read after 60 s by default, retries (sending the request
// again), and exits 255. InvokeModel does not stream: no byte arrives until the whole reply
// is written, and a 16k-token answer takes minutes. So the CLI waits up to the read timeout
// below, and the child process gets a little longer so the CLI's own error is what surfaces.
export const BEDROCK_CLI_READ_TIMEOUT_SEC = 600;
export const BEDROCK_CLI_CONNECT_TIMEOUT_SEC = 60;
export const BEDROCK_CLI_PROCESS_TIMEOUT_MS = (BEDROCK_CLI_READ_TIMEOUT_SEC + 60) * 1000;

/** The `aws bedrock-runtime invoke-model` argv for one request body file and one reply file. */
export function bedrockInvokeArgs({ bedrock, input, output }) {
  return [
    'bedrock-runtime', 'invoke-model', '--model-id', bedrock.model, '--content-type', 'application/json', '--accept', 'application/json',
    '--body', `fileb://${input}`, '--profile', bedrock.profile, '--region', bedrock.region,
    '--cli-read-timeout', String(BEDROCK_CLI_READ_TIMEOUT_SEC), '--cli-connect-timeout', String(BEDROCK_CLI_CONNECT_TIMEOUT_SEC),
    output,
  ];
}

/** Why the CLI call failed, in one line: exit code or signal, then the CLI's last stderr lines. */
export function bedrockFailure(e) {
  const how = e.killed ? `timed out after ${BEDROCK_CLI_PROCESS_TIMEOUT_MS / 1000} s` : e.signal ? `killed by ${e.signal}`
    : typeof e.code === 'number' ? `exit ${e.code}` : e.code ? String(e.code) : null;
  const stderr = String(e.stderr ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ');
  // execFile's own message repeats the argv; anything else (spawn ENOENT, a bad reply file) is the cause.
  const message = /^Command failed/.test(e.message ?? '') ? '' : String(e.message ?? '');
  // An AccessDenied message names the caller's ARN; keep the account id out of saved results.
  const why = (stderr || message).replace(/\b\d{12}\b/g, '<account>').slice(0, 400);
  return `SDK Bedrock request failed${how ? ` (${how})` : ''}${why ? `: ${why}` : ''}`;
}

export async function bedrockMessage({ bedrock, body, scratchDir, execImpl = exec }) {
  if (!bedrock?.model) throw new Error('SDK direct arm needs a Bedrock model id');
  const tmp = mkdtempSync(join(scratchDir, 'sdk-bedrock-'));
  try {
    const input = join(tmp, 'request.json');
    const output = join(tmp, 'response.json');
    const { model: _model, ...native } = body;
    writeFileSync(input, JSON.stringify({ ...native, anthropic_version: 'bedrock-2023-05-31' }));
    await execImpl('aws', bedrockInvokeArgs({ bedrock, input, output }), { maxBuffer: 1024 * 1024, timeout: BEDROCK_CLI_PROCESS_TIMEOUT_MS });
    return JSON.parse(readFileSync(output, 'utf8'));
  } catch (e) {
    throw new Error(bedrockFailure(e));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export const FINAL_ANSWER_REQUEST = 'This is your last turn. Write the complete Markdown answer now from what you have read, citing each claim as a repository-relative path:line.';
export const EMPTY_ANSWER_REQUEST = 'Your last reply had no text. Write the complete Markdown answer now as text, citing each claim as a repository-relative path:line.';
// Sonnet 5 thinks when `thinking` is omitted, and max_tokens caps thinking plus text;
// 16k is the most a non-streaming request should ask for.
export const ANSWER_MAX_TOKENS = 16000;

/** Add a request (the final-answer one by default) to the last user message (a tool-result turn or text). */
export function appendFinalAnswerRequest(messages, text = FINAL_ANSWER_REQUEST) {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'user') {
    messages.push({ role: 'user', content: text });
    return;
  }
  const content = typeof lastMessage.content === 'string' ? [{ type: 'text', text: lastMessage.content }] : lastMessage.content;
  lastMessage.content = [...content, { type: 'text', text }];
}
export async function runSdkAgent({ arm, scenario, work, model, gatewayUrl, clientKey, bedrock, pricing, kinds, sessionId, scratchDir, request, fetchImpl = fetch, execImpl = exec, sleep = wait }) {
  const messages = [{ role: 'user', content: scenario.task }];
  const requests = [];
  const maxTurns = scenario.maxTurns ?? 30;
  const minTurns = scenario.minTurns ?? 1;
  let answer = '';
  let stopped = false;
  let toolCalls = 0;
  let parallelToolTurns = 0;
  let answerRetries = 0;
  const started = Date.now();
  const send = async (body, turn) => {
    const start = Date.now();
    const response = await (request ? request({ arm, body, turn }) : arm === 'direct'
      ? bedrockMessage({ bedrock, body, scratchDir, execImpl })
      : gatewayMessage({ gatewayUrl, clientKey, body, kinds, sessionId, fetchImpl }));
    const usage = response.usage ?? {};
    const record = {
      turn: turn + 1, model: response.model ?? model, latencyMs: Date.now() - start,
      usage: { input: usage.input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? 0 },
      costUsd: response.usage ? costOfAnthropicUsage(pricing, response.model ?? model, usage) : null,
      // Block types, so a reply with no text shows what it held (thinking only, or nothing).
      stopReason: response.stop_reason, blocks: (response.content ?? []).map((b) => b.type),
    };
    requests.push(record);
    return response;
  };
  const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  for (let turn = 0; turn < maxTurns; turn++) {
    stopped = false;
    if (turn && scenario.interTurnDelaySec) await sleep(scenario.interTurnDelaySec * 1000);
    // The last turn asks for the answer with tools still declared (same prefix on both
    // arms) but not callable, so a session that is still researching at the cap ends
    // with an answer to check instead of a tool call.
    const last = turn === maxTurns - 1;
    if (last) appendFinalAnswerRequest(messages);
    const response = await send({ model, max_tokens: last ? ANSWER_MAX_TOKENS : 2048, system: SDK_SYSTEM, tools: SDK_TOOLS, messages, ...(last ? { tool_choice: { type: 'none' } } : {}) }, turn);
    const blocks = response.content ?? [];
    messages.push({ role: 'assistant', content: blocks });
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    toolCalls += toolUses.length;
    if (toolUses.length > 1) parallelToolTurns++;
    if (!toolUses.length) {
      answer = textOf(blocks);
      stopped = response.stop_reason === 'end_turn';
      if (stopped && turn + 1 >= minTurns) break;
      messages.push({ role: 'user', content: 'Continue investigating another relevant source file. Give the complete cited answer after your investigation.' });
      continue;
    }
    messages.push({ role: 'user', content: toolUses.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: executeSdkTool(work, b.name, b.input) })) });
  }
  // Sonnet 5 can end a turn on thinking alone. One more answer-only request, with the
  // tools still declared so neither arm's prefix changes.
  if (!answer.trim()) {
    answerRetries++;
    appendFinalAnswerRequest(messages, EMPTY_ANSWER_REQUEST);
    const response = await send({ model, max_tokens: ANSWER_MAX_TOKENS, system: SDK_SYSTEM, tools: SDK_TOOLS, messages, tool_choice: { type: 'none' } }, requests.length);
    messages.push({ role: 'assistant', content: response.content ?? [] });
    answer = textOf(response.content ?? []);
    stopped = response.stop_reason === 'end_turn';
  }
  const total = (key) => requests.reduce((n, r) => n + r.usage[key], 0);
  const costs = requests.map((r) => r.costUsd);
  const totals = {
    requests: requests.length, turns: requests.length, input: total('input') + total('cacheRead') + total('cacheWrite'),
    cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite'), output: total('output'),
    costUsd: costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null,
    wallMs: Date.now() - started, outsideCheckout: 0, subagents: 0, toolCalls, parallelToolTurns, answerRetries,
    start: { read: requests[0]?.usage.cacheRead ?? 0, written: requests[0]?.usage.cacheWrite ?? 0 },
    cacheBreaks: countCacheBreaks(requests.map((r) => ({ agent: 'main', usage: { input_tokens: r.usage.input, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite } }))),
  };
  return { sdk: true, requests, totals, result: { text: answer, subtype: !answer.trim() ? 'error_no_answer' : stopped ? 'success' : 'error_max_turns' }, citations: scenario.citations ? checkCitations(answer, work) : null, outsideCheckout: { count: 0 }, setup: { transport: arm === 'direct' ? 'bedrock-invoke-model' : 'anyray-messages', model, maxTurns, interTurnDelaySec: scenario.interTurnDelaySec ?? 0 } };
}

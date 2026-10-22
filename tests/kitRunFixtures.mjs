// Shared inputs for the kit's run-side tests (ANY-1487): noise, run, verdict, report and
// publish-result. A stand-in Claude Code (a node script) that speaks stream-json, sends the
// Anyray arm's requests to the base URL it is given and records what it ran; a fake gateway
// on 127.0.0.1 that answers inference with an optimization-result header (holdout draws on
// demand), the gateway version, and the client-tests route; a local git repo, so a round
// runs offline; a kit copy carrying run_agent.mjs and report_agent.mjs beside the test
// catalog; synthetic result records; and the gateway's client-tests body schema, copied.
// Everything is synthetic: nothing reaches a real gateway, a provider or a Claude session.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { KIT_ROOT, PINS, kitEnv, lockPath, readLock } from './kitFixtures.mjs';
import { ADMIN_KEY, TEST_CATALOG, json, spawnAsync } from './kitPlanFixtures.mjs';

export { ADMIN_KEY };
export const BENCH_KEY = 'ark_synthetic-bench-0001';
export const GATEWAY_VERSION = '1.10.515';
export const PUBLISHED_ID = '0b9f2c64-5d1e-4c8a-9f3b-2a7e6d1c0f55';
export const NOISE_MIN_ROUNDS = 6;

/**
 * Strings planted in a client's scenario and in what its sessions produce. None of them may
 * reach a kit run record, a report or a published body. Each is unique, so a hit names the leak.
 */
export const MARK = {
  task: 'ZQX-TASK-4471',
  followup: 'ZQX-FOLLOWUP-4472',
  paste: 'ZQX-PASTE-4473',
  patch: 'ZQX-PATCH-4474',
  repo: 'zqx-repo-4475',
  title: 'ZQX-TITLE-4476',
  checkCmd: 'ZQX-CHECKCMD-4477',
  checkOut: 'ZQX-CHECKOUT-4478',
  answer: 'ZQX-ANSWER-4479',
  toolIn: 'ZQX-TOOLIN-4480',
  toolOut: 'ZQX-TOOLOUT-4481',
  diff: 'ZQX-DIFF-4482',
  patchName: 'ZQX-PATCHNAME-4483',
  keyFact: 'ZQX-KEYFACT-4484',
};

/** Every planted marker found in `text`, by name (empty when clean). */
export const leaks = (text, marks = MARK) => Object.entries(marks).filter(([, m]) => String(text).includes(m)).map(([k]) => k);

// ---- temp dirs that outlive one test (a run shared by several leaf tests) --------------------

const shared = [];
process.on('exit', () => {
  for (const dir of shared) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory removed when the process exits (not when one test ends). */
export function sharedTemp(prefix = 'kit-run-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  shared.push(dir);
  return dir;
}

/** Run `work` once; every later call gets the same promise (a run several leaf tests read). */
export function once(work) {
  let p = null;
  return () => (p ??= work());
}

// ---- git ------------------------------------------------------------------------------------------

export const git = (cwd, args) => {
  const child = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')} failed: ${child.stderr}`);
  return child.stdout.trim();
};

/**
 * A local git repo the scenarios point at (`repo.git` is its path, so a clone works offline):
 * app.js (the stand-in session edits it), lib.js (the scenario's patch edits it) and
 * check-out.log (what the check command prints). Returns its path, the commit, and a patch
 * against that commit that adds a line holding MARK.patch.
 */
export function originRepo(parent, name = `${MARK.repo}-origin`) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'app.js'), "console.log('app');\n");
  writeFileSync(join(dir, 'lib.js'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'check-out.log'), `all checks passed ${MARK.checkOut}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'origin']);
  const ref = git(dir, ['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'lib.js'), `export const one = 1;\nexport const two = '${MARK.patch}';\n`);
  const patchText = `${git(dir, ['diff'])}\n`;
  git(dir, ['checkout', '-q', '--', 'lib.js']);
  return { git: dir, ref, patchText };
}

// ---- scenarios ----------------------------------------------------------------------------------

/**
 * A client scenario that runs offline against `origin`, graded by a check command that passes
 * (it prints check-out.log). Two follow-ups make it `requests: long`, so under the test catalog it
 * matches t-cc-check-long (saving 0.75-0.85, 9 rounds: target 0.8). `marked` plants a marker in
 * every content field: task, follow-ups, a paste, the patch (bytes and file name), title, check.
 */
export function runScenario(origin, { marked = false, source = 'client', over = {} } = {}) {
  const patchFile = marked ? `${MARK.patchName}.patch` : 'fix.patch';
  const doc = {
    title: marked ? `Fix it ${MARK.title}` : 'Fix it',
    source,
    repo: { git: origin.git, ref: origin.ref },
    patch: patchFile,
    pastes: { ciLog: 'ci-log.txt' },
    task: `${marked ? `${MARK.task} ` : ''}CI is red:\n\n{{ciLog}}\n\nFix the failing test.`,
    followups: [marked ? `Now list the files you changed ${MARK.followup}.` : 'Now list the files you changed.', 'Then stop.'],
    check: `cat check-out.log${marked ? ` # ${MARK.checkCmd}` : ''}`,
    maxTurns: 80,
    timeoutMin: 2,
    ...over,
  };
  return { doc, files: { [patchFile]: origin.patchText, 'ci-log.txt': `not ok 1 - ${marked ? MARK.paste : 'tokenizer'}\n` } };
}

/** A key-facts scenario with one user turn: matches no shape in the test catalog (prediction: none). */
export function factsScenario(origin, over = {}) {
  return {
    doc: {
      title: 'Explain it',
      source: 'proposed',
      repo: { git: origin.git, ref: origin.ref },
      task: 'Explain how the app starts.',
      keyFacts: ['done'],
      maxTurns: 80,
      timeoutMin: 2,
      ...over,
    },
    files: {},
  };
}

// ---- the stand-in Claude Code -----------------------------------------------------------------------

const FAKE_CLAUDE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const crypto = require('node:crypto');
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const argv = process.argv.slice(2);
const log = (o) => fs.appendFileSync(cfg.log, JSON.stringify(o) + '\n');
if (argv.includes('--version')) {
  log({ version: true, bin: __filename });
  process.stdout.write(cfg.version + ' (Claude Code)\n');
  return;
}
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
let settings = {};
try { settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8')); } catch {}
const env = settings.env || {};
const base = env.ANTHROPIC_BASE_URL || null;
const kind = base ? 'anyray' : 'direct';
const lines = String(env.ANTHROPIC_CUSTOM_HEADERS || '').split('\n').filter(Boolean);
const take = () => {
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(path.join(cfg.counterDir, kind + '-' + i), '', { flag: 'wx' }); return i; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
};
const ordinal = take();
const costs = cfg.costs[kind];
const cost = costs[ordinal % costs.length];
const behaviour = ((cfg.behave || {})[kind] || {})[ordinal] || 'ok';
const sessionId = crypto.randomUUID();
const model = opt('--model') || 'claude-sonnet-5';
const streamed = argv.includes('--input-format');
log({ session: true, kind, ordinal, cost, behaviour, sessionId, bin: __filename, headerNames: lines.map((l) => l.slice(0, l.indexOf(':')).trim().toLowerCase()) });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// The session is over without a further turn: stop reading stdin, so the process ends on its
// own once stdout has drained (process.exit could cut a pipe write short on macOS).
let ended = false;
const end = (code) => { ended = true; process.exitCode = code; try { process.stdin.destroy(); } catch {} };
const post = (text) => new Promise((resolve, reject) => {
  const u = new URL(base.replace(/\/$/, '') + '/v1/messages');
  const headers = { 'content-type': 'application/json', 'x-claude-code-session-id': sessionId, 'user-agent': 'claude-cli/' + cfg.version + ' (external, cli)' };
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const name = l.slice(0, i).trim().toLowerCase();
    const value = l.slice(i + 1).trim();
    headers[name] = headers[name] === undefined ? value : [].concat(headers[name], value);
  }
  const body = JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: text }] });
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  req.end(body);
});
let n = 0;
let edited = false;
async function turn(text) {
  n++;
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: ['Bash'], mcp_servers: [], apiKeySource: 'none' });
  if (behaviour === 'hang') {
    // Never answers: only the harness's session timeout ends it.
    setInterval(() => {}, 60000);
    return new Promise(() => {});
  }
  const msgs = [
    [{ type: 'tool_use', id: 'tu_' + n, name: 'Bash', input: { command: 'echo ' + cfg.toolInput } }],
    [{ type: 'text', text: cfg.answer }],
  ];
  for (let i = 0; i < msgs.length; i++) {
    const id = 'msg_' + n + '_' + i;
    out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null, session_id: sessionId });
    const status = base ? await post(text) : 200;
    if (status >= 400) {
      // As Claude Code ends a turn the API refused (after its own retries): an error result
      // that bills nothing, then exit 1.
      out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: ' + status, num_turns: 1, total_cost_usd: 0, duration_ms: 5, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
      return end(1);
    }
    out({ type: 'assistant', message: { id, model, role: 'assistant', usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, content: msgs[i] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: i === 0 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, api_message_id: id, parent_tool_use_id: null, session_id: sessionId });
    if (i === 0) out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_' + n, content: cfg.toolOutput }] }, parent_tool_use_id: null, session_id: sessionId });
  }
  if (!edited) {
    fs.appendFileSync(path.join(process.cwd(), 'app.js'), '// ' + cfg.diff + '\n');
    edited = true;
  }
  // Ends without a result event (as a crashed or cut-off client does): no cost is ever reported.
  if (behaviour === 'noresult') return end(0);
  out({ type: 'result', subtype: 'success', result: cfg.answer, num_turns: 2, total_cost_usd: cost, duration_ms: 50, usage: { input_tokens: 200, output_tokens: 20 }, modelUsage: { [model]: { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } } });
}
(async () => {
  if (!streamed) return turn(argv[argv.indexOf('-p') + 1] || '');
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let text = '';
    try { text = JSON.parse(line).message.content; } catch {}
    await turn(String(text));
    if (ended) break;
  }
})().catch(() => { process.exitCode = 1; });
`;

/**
 * A stand-in `claude` (a node script, so it needs no PATH): `--version` prints `version`; a
 * session reads its --settings, sends one POST /v1/messages per model message to
 * ANTHROPIC_BASE_URL when it has one (the Anyray arm), with ANTHROPIC_CUSTOM_HEADERS as sent
 * headers (a repeated name is sent twice), and prints stream-json: a Bash tool call, then an
 * answer, then a result whose total_cost_usd is the next value of `costs.direct` or
 * `costs.anyray` (one atomic counter per arm kind). On its first turn it appends MARK.diff to
 * app.js, so the checkout has a diff. The answer is "done ..." (solves a `keyFacts: [done]`).
 * `sessions()` lists every session it started (`bin`: the script's real path), `versions()` every
 * --version call; `realBin` is the real path of `bin` (a temp dir under /var is /private/var on macOS).
 *
 * `behave` picks how chosen sessions end, by arm kind and that kind's session ordinal (0-based, the
 * same counter as `costs`): `{ direct: { 1: 'hang' }, anyray: { 3: 'noresult' } }`. 'hang' prints
 * its init and never answers (only the harness's session timeout ends it); 'noresult' runs its
 * turn and exits 0 without a result event. Every session also reacts to an HTTP error from the
 * gateway as Claude Code does: an error result that bills nothing (total_cost_usd 0), then exit 1.
 */
export function fakeClaude(dir, { version = PINS.clientVersion, costs = { direct: [1], anyray: [0.5] }, marked = true, behave = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const counterDir = join(dir, 'counter');
  mkdirSync(counterDir, { recursive: true });
  const log = join(dir, 'invocations.jsonl');
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    log, counterDir, version, costs, behave,
    answer: marked ? `done ${MARK.answer}` : 'done',
    toolInput: marked ? MARK.toolIn : 'hello',
    toolOutput: marked ? MARK.toolOut : 'hello',
    diff: marked ? MARK.diff : 'edited',
  }));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}\nconst CONFIG_FILE = ${JSON.stringify(config)};\n(function () {${FAKE_CLAUDE}})();\n`);
  chmodSync(bin, 0o755);
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, realBin: realpathSync(bin), sessions: () => entries().filter((e) => e.session), versions: () => entries().filter((e) => e.version) };
}

/**
 * A `claude` on PATH that must never run: it records that it was called and fails. The kit
 * runs both arms from the pinned binary, never from PATH.
 */
export function poisonClaude(dir) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'poison.log');
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho called >> '${log}'\nexit 1\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0) };
}

// ---- the fake gateway -------------------------------------------------------------------------------

const CLEAN_RESULT = { status: 'applied', applied: ['observation_mask'], skipped: [{ kind: 'relevance_filter', reason: 'not_applicable' }], preserved: [] };
const HELD_RESULT = { status: 'applied', applied: [], skipped: [{ kind: 'observation_mask', reason: 'safety_gate', guard: 'session_gate_holdout' }, { kind: 'relevance_filter', reason: 'not_applicable' }], preserved: [] };
/** What the fake gateway reports running on the tenant's defaults: the kit records it as kindsObserved. */
export const OBSERVED_KINDS = ['observation_mask', 'relevance_filter'];
export const HELD_KIND = 'observation_mask';

const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * An HTTP server on 127.0.0.1 standing in for the gateway. Records every request (method, path,
 * the headers the tests read, and inference metadata) in `requests`. `holdout`: 'none', 'first'
 * (the first Anyray session it sees, by x-anyray-metadata sessionId, is drawn into a holdout of
 * observation_mask, every later one is not) or 'all'. `publishStatus`: what the client-tests
 * route answers (201 with `result.id`, or that error status). `inferenceStatus`: what inference
 * answers instead of 200, for every session (a number, e.g. 401) or for chosen ones (an object
 * keyed by the session's index, 0-based, in the order the gateway first saw its sessionId); an
 * error answer carries no optimization-result header. The server is unref'd, so it never keeps
 * the test process alive.
 */
export async function fakeRunGateway({ holdout = 'none', publishStatus = 201, inferenceStatus = null } = {}) {
  const requests = [];
  const held = new Set();
  const seen = [];
  let first = null;
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const metaRaw = req.headers['x-anyray-metadata'];
      const meta = typeof metaRaw === 'string' ? parseJson(metaRaw) : null;
      const entry = {
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        authorization: req.headers.authorization ?? null,
        apiKey: req.headers['x-anyray-api-key'] ?? null,
        metadataRaw: metaRaw ?? null,
        metadata: meta,
        kindsHeader: req.headers['x-anyray-optimization-kinds'] ?? null,
        body: req.method === 'POST' && url.pathname.startsWith('/admin/') ? parseJson(raw) : null,
      };
      requests.push(entry);
      const send = (code, payload, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      const admin = req.headers.authorization === `Bearer ${ADMIN_KEY}`;
      if (req.method === 'POST' && /^\/(v1\/)?messages$/.test(url.pathname)) {
        const session = meta?.sessionId ?? null;
        if (session && !seen.includes(session)) seen.push(session);
        const status = typeof inferenceStatus === 'number' ? inferenceStatus : inferenceStatus?.[seen.indexOf(session)] ?? 200;
        if (status !== 200) {
          return send(status, { type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'api_error', message: 'synthetic gateway error' } });
        }
        if (first === null && session) first = session;
        const drawn = holdout === 'all' || (holdout === 'first' && session !== null && session === first);
        if (drawn) held.add(session);
        return send(200, { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
          { 'x-anyray-optimization-result': JSON.stringify(drawn ? HELD_RESULT : CLEAN_RESULT) });
      }
      if (req.method === 'GET' && url.pathname === '/admin/v1/settings/updates') {
        return admin ? send(200, { version: GATEWAY_VERSION, updateMethod: 'compose', hasApplier: false, update: null }) : send(401, { error: { message: 'unauthorized' } });
      }
      if (req.method === 'GET' && url.pathname === '/admin/v1/optimizer') {
        return admin ? send(200, { config: { strategies: [] }, overrides: null }) : send(401, { error: { message: 'unauthorized' } });
      }
      if (req.method === 'POST' && url.pathname === '/admin/v1/client-tests') {
        if (!admin) return send(401, { status: 'failure', message: 'unauthorized' });
        if (publishStatus !== 201) return send(publishStatus, { status: 'failure', message: 'invalid client test result', issues: [] });
        return send(201, { result: { ...(entry.body ?? {}), id: PUBLISHED_ID, receivedAt: '2026-10-22T09:00:00.000Z' } });
      }
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    inference: () => requests.filter((r) => r.method === 'POST' && /^\/(v1\/)?messages$/.test(r.path)),
    heldSessions: () => [...held],
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---- a kit copy that can run --------------------------------------------------------------------------

/**
 * A copy of the kit with the test catalog (tests/kitPlanFixtures.mjs TEST_CATALOG) committed in
 * its own git repo: lib/, tools/, config.yaml, package.json, run_agent.mjs, report_agent.mjs,
 * predictions.yaml, node_modules linked. The run-side commands may read only these at the kit
 * root (plus what they write under the scenarios dir).
 */
export function kitRunCopy(root) {
  for (const dir of ['lib', 'tools']) cpSync(join(KIT_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ['config.yaml', 'package.json', 'run_agent.mjs', 'report_agent.mjs']) cpSync(join(KIT_ROOT, file), join(root, file));
  symlinkSync(join(KIT_ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, '.gitignore'), 'node_modules\nresults/\n');
  writeFileSync(join(root, 'predictions.yaml'), TEST_CATALOG);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'kit copy for a run test']);
  return { root, head: git(root, ['rev-parse', 'HEAD']), version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version };
}

/** `node <kitRoot>/tools/kit.mjs <args>` without blocking (the fake gateway lives in this process). */
export const kitIn = (kitRoot, args, { env, cwd = kitRoot, timeout = 180_000 } = {}) =>
  spawnAsync(process.execPath, [join(kitRoot, 'tools', 'kit.mjs'), ...args], { env, cwd, timeout });

export const PIN_ARGS = (gatewayUrl) => ['--model', PINS.model, '--provider', PINS.provider, '--client', PINS.client, '--client-version', PINS.clientVersion, '--gateway', gatewayUrl];

/** Freeze `dir` with the kit copy; returns the lock (asserting it worked). */
export async function freezeWith(kitRoot, dir, gatewayUrl, env) {
  const child = await kitIn(kitRoot, ['freeze', '--scenarios-dir', dir, ...PIN_ARGS(gatewayUrl), '--json'], { env });
  const out = json(child, 'freeze --json (kit copy)');
  assert.equal(out.ok, true, `freeze must succeed before this test can check anything: ${JSON.stringify(out)} ${child.stderr.slice(0, 400)}`);
  return readLock(dir);
}

/**
 * The env a run-side command gets: ANY-1485's minimal env plus the gateway URL, the admin key,
 * the kit's own bench key and a PATH whose first `claude` is the poison one.
 */
export function runEnv(home, { gateway = null, poison = null, extra = {} } = {}) {
  return kitEnv(home, {
    PATH: poison ? `${poison.dir}:${process.env.PATH}` : process.env.PATH,
    ...(gateway ? { ANYRAY_GATEWAY_URL: gateway.url } : {}),
    ANYRAY_ADMIN_KEY: ADMIN_KEY,
    ANYRAY_BENCH_CLIENT_KEY: BENCH_KEY,
    ANYRAY_BENCH_TENANT: 'acme',
    ...extra,
  });
}

// ---- the lock's noise block --------------------------------------------------------------------------

/** canon() per the ANY-1485 contract: keys sorted at every depth, no whitespace, undefined dropped. */
export function canon(x) {
  const sorted = (v) => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sorted(v[k])]));
    return v;
  };
  return JSON.stringify(sorted(x));
}

/** The noise block's own hash: HMAC-SHA256(nonce, canon({ planHash, sd, rounds, byScenario, measuredAt })). */
export const noiseHash = (lock, { sd, rounds, byScenario, measuredAt }) =>
  createHmac('sha256', Buffer.from(lock.nonce, 'hex')).update(canon({ planHash: lock.planHash, sd, rounds, byScenario, measuredAt })).digest('hex');

/** Write a signed noise block into the lock, as `noise` would have (for the tests of what comes after it). */
export function writeNoise(dir, { sd = 0.3, n = 6 } = {}) {
  const lock = readLock(dir);
  const byScenario = lock.scenarios.map((s) => ({ id: s.id, n, sd }));
  const block = { sd, rounds: n * byScenario.length, byScenario, measuredAt: '2026-10-22T08:00:00.000Z' };
  lock.noise = { ...block, hash: noiseHash(lock, block) };
  writeFileSync(lockPath(dir), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/** Pooled sample SD of ln(ratio): per-scenario means, sum of squares over the sum of (n - 1). */
export function pooledSd(groups) {
  let ss = 0;
  let df = 0;
  for (const xs of groups) {
    if (xs.length < 2) continue;
    const logs = xs.map(Math.log);
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    ss += logs.reduce((a, x) => a + (x - mean) ** 2, 0);
    df += logs.length - 1;
  }
  return df ? Math.sqrt(ss / df) : null;
}

// ---- result records --------------------------------------------------------------------------------

/** Where the kit keeps one plan's run records: <scenarios-dir>/.kit-results/<planHash>/. */
export const resultsDir = (dir, planHash) => join(dir, '.kit-results', planHash);
export const recordFile = (dir, planHash, id, compare) => join(resultsDir(dir, planHash), `${id}--${compare}.json`);
export const readRecord = (dir, planHash, id, compare) => {
  const file = recordFile(dir, planHash, id, compare);
  assert.ok(existsSync(file), `no ${compare} record for ${id} at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

/** Every regular file under `dir`, recursively (empty when it does not exist). */
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name));
    else if (s.isFile()) out.push(p);
  };
  walk(dir);
  return out;
}

/** One paired round as a run record keeps it: A and B costs, the ratio B / A, who solved. */
export function pairRound(round, a, b, { solved = [true, true], ...extra } = {}) {
  return {
    round,
    ratio: b / a,
    sessions: { a: { totals: { costUsd: a }, setup: { claudeVersion: PINS.clientVersion } }, b: { totals: { costUsd: b }, setup: { claudeVersion: PINS.clientVersion } } },
    quality: { a: solved[0], b: solved[1] },
    ...extra,
  };
}

/** A round whose Anyray session drew a holdout on its last allowed attempt: excluded, never scored. */
export const heldRound = (round) => ({ round, holdoutDrawn: { b: [HELD_KIND] }, redraws: [{ b: [HELD_KIND] }] });

/**
 * Write a kit run record for one scenario of a frozen plan: the paired `anyray` compare, or with
 * `compare: 'control'` the direct-vs-direct record `noise` keeps (no gateway version, no kinds).
 */
export function writeRecord(dir, lock, id, rounds, { gatewayVersion = GATEWAY_VERSION, extra = {}, compare = 'anyray' } = {}) {
  const s = lock.scenarios.find((x) => x.id === id);
  assert.ok(s, `${id} is not in the plan`);
  const file = recordFile(dir, lock.planHash, id, compare);
  mkdirSync(resultsDir(dir, lock.planHash), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    planHash: lock.planHash,
    scenario: { id, source: s.source, hash: s.hash },
    compare,
    ...(compare === 'control' ? {} : { gatewayVersion }),
    claudeVersion: PINS.clientVersion,
    ...(compare === 'control' ? {} : { kindsObserved: OBSERVED_KINDS }),
    rounds,
    ...extra,
  }, null, 2)}\n`);
  return file;
}

/**
 * A round as an unredacted record (one written before ANY-1487, or edited by hand) would carry
 * it: the final answer, the tool calls, the diff and the check output. A report must never read
 * any of it.
 */
export function contentRound(round, a, b, opts = {}) {
  const r = pairRound(round, a, b, opts);
  for (const slot of ['a', 'b']) {
    Object.assign(r.sessions[slot], {
      result: { text: `done ${MARK.answer}` },
      requests: [{ agent: 'main', blocks: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${MARK.toolIn}` }, result: { preview: MARK.toolOut } }] }],
      diff: ` app.js | 1 + ${MARK.diff}`,
      diffPatch: `+// ${MARK.diff}`,
      check: { passed: true, output: MARK.checkOut },
    });
  }
  return r;
}

/**
 * The rounds of a plan with four scenarios, chosen so every verdict word appears and the two
 * verdicts disagree where they should:
 *   check-long  (t-cc-check-long, band 0.75-0.85)  8 solved pairs near 0.5, one round drawn into a
 *               holdout: benchVerdict pass, Rule 0 PASS, below its band
 *   docs        (t-docs-few, too few public rounds: no band)  never run: no record
 *   facts       (no shape)                          2 pairs, 0.9 and 1.1: inconclusive, INSUFFICIENT
 *   short-task  (t-cc-short, parity band 0.85-0.95) 4 pairs near 1.3 at $2 direct, one round only B
 *               solved: fail, FAIL, above its band
 */
export function syntheticRounds({ content = false } = {}) {
  const pair = content ? contentRound : pairRound;
  return {
    'check-long': [
      ...[0.5, 0.55, 0.48, 0.52, 0.51, 0.49, 0.53, 0.5].map((b, i) => pair(i + 1, 1, b)),
      heldRound(9),
    ],
    facts: [pair(1, 1, 0.9), pair(2, 1, 1.1)],
    'short-task': [
      pair(1, 2, 2.6), pair(2, 2, 2.5), pair(3, 2, 2.7), pair(4, 2, 2.56),
      pair(5, 2, 1.0, { solved: [false, true] }),
    ],
  };
}

/** A citations scenario, one user turn: matches t-docs-few (seven public rounds: prediction none). */
export const citationsScenario = (origin) => ({
  doc: {
    title: 'Document it', source: 'proposed', repo: { git: origin.git, ref: origin.ref },
    task: 'Document the request path with file:line citations.', citations: { min: 3, resolveRate: 0.9 }, maxTurns: 80, timeoutMin: 2,
  },
  files: {},
});

/**
 * A frozen four-scenario plan (kit copy, test catalog) with synthetic run records written for
 * it: no session runs. `marked` plants a marker in every content field of the scenarios AND
 * in the records (as an old or hand-edited record would carry them). Returns the copy, the dir,
 * the lock and the rounds written per scenario.
 */
export async function syntheticPlan(root, { gatewayUrl = 'https://gw.example.test', env, marked = false, records = true, gatewayVersion = GATEWAY_VERSION, lostPair = false } = {}) {
  const origin = { git: `https://git.example.test/acme/${MARK.repo}.git`, ref: '0123456789abcdef0123456789abcdef01234567', patchText: `--- a/lib.js\n+++ b/lib.js\n@@ -1 +1,2 @@\n export const one = 1;\n+export const two = '${MARK.patch}';\n` };
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, {
    'check-long': runScenario(origin, { marked }),
    docs: citationsScenario(origin),
    facts: factsScenario(origin, marked ? { title: MARK.title, keyFacts: [MARK.keyFact] } : {}),
    'short-task': runScenario(origin, { marked, over: { maxTurns: 6 } }),
  });
  const lock = await freezeWith(copy.root, dir, gatewayUrl, env);
  const rounds = records ? syntheticRounds({ content: marked }) : {};
  // Only the direct arm solved this pair: a quality loss to Anyray, whatever it cost.
  if (lostPair && rounds.facts) rounds.facts.push(pairRound(3, 1, 0.9, { solved: [true, false] }));
  const extra = marked ? { scenarioText: { task: MARK.task, repo: origin.git, check: MARK.checkCmd, pastes: MARK.paste, followups: [MARK.followup], patch: `${MARK.patchName}.patch` } } : {};
  for (const [id, rs] of Object.entries(rounds)) writeRecord(dir, lock, id, rs, { gatewayVersion, extra });
  return { copy, dir, lock, rounds };
}

/** A scenarios dir written as YAML, for scenarios whose repo is a local path. */
export function writeDir(parent, scenarios, name = 'client-tests') {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  for (const [id, { doc, files = {} }] of Object.entries(scenarios)) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'scenario.yaml'), yaml.dump(doc));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(root, id, file), content);
  }
  return root;
}

// ---- the gateway's client-tests body (POST /admin/v1/client-tests) ------------------------------------

// Copied from the monorepo's gateway/src/services/clientTests.ts (clientTestResultSchema, ANY-1488,
// commit 4457e55c8). The kit's `report --json` and `publish-result` must produce a body this
// accepts. Keep the two in step by hand: the gateway lives in another repository.
const identity = z.string().min(1).regex(/^[A-Za-z0-9][\w.:-]{0,63}$/);
const version = z.string().min(1).regex(/^[0-9A-Za-z][\w.+-]{0,63}$/);
const ratio = z.number().finite().gt(0).max(1000);
const predictedBand = z.union([
  z.object({ kind: z.literal('band'), low: ratio, high: ratio }).strict().refine((band) => band.low <= band.high),
  z.object({ kind: z.literal('none') }).strict(),
]);
const interval = z.object({ lower: ratio, upper: ratio }).strict().refine((ci) => ci.lower <= ci.upper);
const pairCount = z.number().int().min(0).max(10000);
const parity = z.object({
  n: pairCount, passDirect: pairCount, passAnyray: pairCount, anyrayWorse: pairCount, anyrayBetter: pairCount,
}).strict().refine((p) => p.passDirect <= p.n && p.passAnyray <= p.n && p.anyrayWorse + p.anyrayBetter <= p.n
  && p.passAnyray === p.passDirect - p.anyrayWorse + p.anyrayBetter);
const scenario = z.object({
  shapeId: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.enum(['client', 'proposed']),
  predictedBand,
  parity: parity.optional(),
  n: z.number().int().min(0).max(10000),
  excluded: z.number().int().min(0).max(10000),
  winRate: z.number().finite().min(0).max(1).nullable(),
  median: ratio.nullable(),
  q3: ratio.nullable(),
  max: ratio.nullable(),
  ci95: interval.nullable(),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
}).strict();
export const clientTestBodySchema = z.object({
  planHash: z.string().min(1).regex(/^[0-9a-f]{64}$/),
  kitVersion: version,
  benchmarksCommit: z.string().min(1).regex(/^[0-9a-f]{40}$/),
  gatewayVersion: version,
  releaseTag: identity,
  clientTool: identity,
  clientToolVersion: version,
  model: z.string().min(1).regex(/^[A-Za-z0-9][\w.:+/-]{0,127}$/).refine((m) => !m.includes('//')),
  provider: identity,
  scenarios: z.array(scenario).min(1).max(50),
  totals: z.object({
    n: z.number().int().min(0).max(100000),
    excluded: z.number().int().min(0).max(100000),
    costUsdPerSession: z.object({ direct: z.number().finite().min(0).max(1e6), anyray: z.number().finite().min(0).max(1e6) }).strict(),
  }).strict(),
  rule0Verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'INSUFFICIENT', 'NO DATA']),
}).strict();

/** Parse with the gateway's schema; a failure names the paths (never the values). */
export function assertGatewayBody(body, what) {
  const r = clientTestBodySchema.safeParse(body);
  assert.ok(r.success, `${what}: the gateway would refuse this body: ${r.success ? '' : JSON.stringify(r.error.issues.map((i) => ({ path: i.path, code: i.code })))}`);
  return r.data;
}

#!/usr/bin/env node
// Cache economics — does a compressor pay for its savings by busting the prefix cache?
//
// WHY THIS EXISTS, and why it is the test that matters most. Every other number
// in this repo (and in COMPARISON.md) scores ONE request: bytes in, bytes out.
// On a long-lived agent that accounting is wrong in a way that can invert the
// result, because the provider does not bill a warm turn at face value:
//
//   turn 2, prefix unchanged   → ~35k tokens read from cache at ~0.1x
//   turn 2, prefix rewritten   → ~28k tokens written fresh  at ~1.25x
//
// So a rewrite that REMOVES 7k tokens can cost roughly 10x what leaving them
// alone would have. "Fewer bytes" and "cheaper" are different questions, and a
// byte-counting benchmark cannot tell them apart — it reports the rewrite as a
// 20% saving.
//
// WHAT THIS MEASURES. A mock upstream stands in for the provider: it hashes the
// longest common byte prefix against what it last saw for that conversation and
// reports cache_read on the matching span, cache_write on the rest — the same
// rule Anthropic/OpenAI apply, without needing their bill. Then, for each arm:
//
//   turn 1   a full agent transcript (system + tools + repo context + tool output)
//   turn 2   the SAME transcript plus a small delta
//
// and it asks two questions the benchmark above cannot:
//
//   * is the forwarded prefix byte-identical to turn 1's?
//   * what does the provider bill — cached tokens vs fresh/write tokens?
//
// It does NOT require the compressor to be nondeterministic. Any rewrite of
// previously-cached bytes is enough, which is what makes it fair.
//
// ARMS. Both systems, same transcript, same upstream, same scorer:
//
//   none                  no compressor. The control: this is what a cache hit
//                         looks like, and every other arm is judged against it.
//   anyray                the Anyray optimizer, pins threaded as the gateway does.
//   anyray-nopins         Anyray with the pin state LOST (see below).
//   headroom-cache        Headroom --mode cache  ("freeze prior turns")
//   headroom-token        Headroom --mode token  ("prior turns may be rewritten")
//   headroom-cache-restart  Headroom --mode cache, proxy RESTARTED between turns.
//
// THE RESTART ARMS ARE THE POINT. Both products keep prefix stability with
// per-conversation state — Headroom's delta engine holds a frozen prefix,
// Anyray's cache guard needs decision pins. That state is exactly what a
// deployment restart, a pod roll, or a load-balancer hop to a cold replica
// destroys. A benchmark that only ever measures the warm, single-process happy
// path certifies a property that does not survive an ordinary Tuesday deploy.
// Anyray is subjected to the identical condition, because a harness that only
// restarts the competitor is not a measurement.
//
// Usage:
//   node tools/cache-economics.mjs --python /path/to/venv/bin/python
//   node tools/cache-economics.mjs --python … --arm headroom-token

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { OptimizerClient } from '../lib/optimizerClient.mjs';
import { loadConfig } from '../lib/loadConfig.mjs';

const ROOT = join(import.meta.dirname, '..');

// Provider price ratios, relative to a fresh input token. These are the public
// Anthropic multipliers and they are the whole economic argument: a cache read
// is ~10x cheaper than fresh, and a cache WRITE is a 25% premium over fresh, so
// re-writing a prefix you already had cached is the worst of the three.
const RATE_CACHE_READ = 0.1;
const RATE_CACHE_WRITE = 1.25;
const RATE_FRESH = 1.0;

// ------------------------------------------------------------ the transcript ---
const lines = (label, n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${label} line ${i + 1}: implementation detail, error handling, and defensive branches ` +
      `that carry no answer to the live question but are billed on every turn they ride along.`
  ).join('\n');

/** A turn-1 transcript in the shape the cache economics actually bite: a big, stable prefix. */
function baseTranscript() {
  return [
    {
      role: 'system',
      content:
        'You are a coding agent working in a large repository. Use the tools to inspect files.\n' +
        lines('// house style', 40),
    },
    { role: 'user', content: 'Find where the retry ceiling is defined and what calls it.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_repo',
          type: 'function',
          function: { name: 'read_repo', arguments: '{"path":"src/"}' },
        },
      ],
    },
    // The bulk: a big repository dump that the provider caches on turn 1.
    {
      role: 'tool',
      tool_call_id: 'call_repo',
      name: 'read_repo',
      content:
        'export const RETRY_MAX = 5;\nexport class HttpClient { get() { return withRetry(...); } }\n' +
        lines('// repo', 900),
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_tests',
          type: 'function',
          function: { name: 'run_tests', arguments: '{"suite":"http"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_tests',
      name: 'run_tests',
      content: '=== test session starts ===\n' + lines('PASSED tests/http', 150) + '\n=== 150 passed ===',
    },
  ];
}

/**
 * Turn N = every prior byte plus a small delta. This is the shape a warm agent
 * sends, and the reason a two-turn test is not enough: a compressor's decisions
 * can be stable across one append and shift on the fourth, when the history it
 * is re-examining has grown past a threshold or "recent" has moved. Each delta
 * is small relative to the prefix (~40 tokens against ~46k), so ANY per-turn
 * divergence in the rewritten history dwarfs what the delta itself costs.
 */
function growTranscript(messages, turn) {
  return [
    ...messages,
    { role: 'assistant', content: `Answer for turn ${turn}: RETRY_MAX is 5.` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `call_grep_${turn}`,
          type: 'function',
          function: { name: 'run_tests', arguments: `{"suite":"http-${turn}"}` },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: `call_grep_${turn}`,
      name: 'run_tests',
      content: '=== test session starts ===\n' + lines(`PASSED tests/turn${turn}`, 40) + '\n=== 40 passed ===',
    },
    { role: 'user', content: `Follow-up ${turn}: confirm which class calls it.` },
  ];
}

const TURNS = 5;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_repo',
      description: 'Read a directory of source files.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run a test suite.',
      parameters: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] },
    },
  },
];

// --------------------------------------------------------- the mock upstream ---
/**
 * Stands in for the provider's prompt cache.
 *
 * The rule is the one the real providers use, reduced to its essential: cache
 * hits are prefix-anchored and BYTE-exact. So it keeps the last prompt it saw,
 * measures the longest common prefix with the next one, and bills that span as
 * a cache read; everything after it is a cache write. That is enough to price a
 * turn, and it needs no provider account, no key, and no network — so this arm
 * of the benchmark is reproducible by anyone.
 */
function startMockUpstream() {
  const state = { lastPrompt: null, calls: [] };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* a malformed body still gets a reply; the arm records what it sent */
      }
      // The prompt as the provider sees it: the serialized prefix, tools first
      // (they sit ahead of messages in the cached prefix on both providers).
      const prompt =
        JSON.stringify(parsed.tools ?? parsed.system ?? '') +
        ' ' +
        JSON.stringify(parsed.messages ?? []);

      const prev = state.lastPrompt;
      let common = 0;
      if (prev) {
        const max = Math.min(prev.length, prompt.length);
        while (common < max && prev[common] === prompt[common]) common++;
      }
      // chars/4, the same accounting basis every other number in this repo uses.
      const totalTok = Math.ceil(prompt.length / 4);
      const cachedTok = prev ? Math.floor(common / 4) : 0;
      const freshTok = totalTok - cachedTok;

      state.calls.push({
        totalTok,
        cachedTok,
        freshTok,
        prefixSha: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
        identicalPrefixToPrev: prev !== null && common === prev.length,
      });
      state.lastPrompt = prompt;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          model: parsed.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: totalTok,
            completion_tokens: 1,
            total_tokens: totalTok + 1,
            prompt_tokens_details: { cached_tokens: cachedTok },
          },
          // Anthropic-shaped mirror, so a client reading either shape sees it.
          cache_read_input_tokens: cachedTok,
          cache_creation_input_tokens: freshTok,
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, state, port: server.address().port })
    );
  });
}

/**
 * Price one turn in fresh-input-token equivalents: the cached span at the read
 * rate, everything else at the cache-write rate (a rewritten prefix has to be
 * written again, which is the 1.25x premium, not plain fresh input).
 */
function priceTurn(call) {
  return Math.round(call.cachedTok * RATE_CACHE_READ + call.freshTok * RATE_CACHE_WRITE);
}

// ------------------------------------------------------------------- runners ---
async function post(url, payload, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer synthetic-mock-key',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Wait for a port to accept a request, or throw. */
async function waitForPort(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url, { method: 'GET' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`nothing came up at ${url}`);
}

/** Start a Headroom proxy pointed at the mock upstream. */
async function startHeadroomProxy(python, port, mode, upstreamPort) {
  const proc = spawn(
    python.replace(/python[0-9.]*$/, 'headroom'),
    ['proxy', '--port', String(port), '--mode', mode, '--no-rate-limit'],
    {
      env: {
        ...process.env,
        HEADROOM_MODE: mode,
        // Point every provider route at the mock.
        OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        OPENAI_API_KEY: 'synthetic-mock-key',
        ANTHROPIC_API_KEY: 'synthetic-mock-key',
        HEADROOM_TELEMETRY: '0',
        // The proxy's SSRF guard rejects loopback upstreams unless an operator
        // explicitly allowlists them — correct default, and exactly the knob its
        // own docs name for pointing at an on-prem endpoint.
        HEADROOM_ALLOWED_BASE_URLS: `http://127.0.0.1:${upstreamPort}`,
        HEADROOM_SKIP_UPSTREAM_CHECK: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  await waitForPort(`http://127.0.0.1:${port}/health`);
  return proc;
}

const stop = (proc) =>
  new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      resolve();
    }, 5000);
  });

async function main() {
  const args = { python: null, arm: null };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--python') args.python = process.argv[++i];
    else if (process.argv[i] === '--arm') args.arm = process.argv[++i];
  }

  const cfg = loadConfig();
  const opt = new OptimizerClient({ url: cfg.optimizerUrl, adminToken: cfg.adminToken });
  const optimizerUp = await opt.ping();

  const up = await startMockUpstream();
  const results = [];

  const ARMS = [
    'none',
    'anyray',
    'anyray-nopins',
    'headroom-cache',
    'headroom-token',
    'headroom-cache-restart',
  ];

  for (const arm of ARMS) {
    if (args.arm && arm !== args.arm) continue;
    if (arm.startsWith('anyray') && !optimizerUp) {
      console.log(`${arm.padEnd(24)} SKIPPED (no optimizer at ${cfg.optimizerUrl})`);
      continue;
    }
    if (arm.startsWith('headroom') && !args.python) {
      console.log(`${arm.padEnd(24)} SKIPPED (--python not given)`);
      continue;
    }

    // Reset the provider's view between arms so each starts cold.
    up.state.lastPrompt = null;
    up.state.calls.length = 0;

    // Build the turn sequence once, so every arm replays byte-identical inputs.
    const seqs = [];
    let msgs = baseTranscript();
    seqs.push(msgs);
    for (let t = 2; t <= TURNS; t++) {
      msgs = growTranscript(msgs, t);
      seqs.push(msgs);
    }
    const reqs = seqs.map((m) => ({ model: 'gpt-4o', max_tokens: 256, messages: m, tools: TOOLS }));

    let proxy = null;
    let pins = [];
    let note = '';
    const perTurnDecisions = [];
    const pinCounts = [];

    try {
      if (arm === 'none') {
        for (const r of reqs) await post(`http://127.0.0.1:${up.port}/v1/chat/completions`, r);
      } else if (arm === 'anyray' || arm === 'anyray-nopins') {
        const keepPins = arm === 'anyray';
        for (const req of reqs) {
          // The no-pins arm is the cold replica: it never carries state forward.
          const res = await opt.optimizeWithPins(req, keepPins ? pins : [], {});
          if (keepPins && Array.isArray(res?.pins)) pins = res.pins;
          perTurnDecisions.push((res?.decisions ?? []).map((d) => d.kind ?? d).filter(Boolean));
          pinCounts.push(Array.isArray(res?.pins) ? res.pins.length : 0);
          await post(`http://127.0.0.1:${up.port}/v1/chat/completions`, res?.request ?? req);
        }
        note = keepPins
          ? 'pins threaded turn-to-turn, as the gateway does'
          : 'pin state LOST every turn (restart / cold replica)';
      } else {
        const mode = arm.includes('token') ? 'token' : 'cache';
        const base = 8790 + ARMS.indexOf(arm) * 4;
        const hdr = { 'x-headroom-base-url': `http://127.0.0.1:${up.port}` };
        const restartEvery = arm.endsWith('-restart');
        proxy = await startHeadroomProxy(args.python, base, mode, up.port);
        let port = base;
        for (let i = 0; i < reqs.length; i++) {
          if (restartEvery && i > 0) {
            // The operational failure this file exists for: the process holding
            // the frozen prefix is gone and its replacement has never seen this
            // conversation. Restarting on EVERY turn models a rolling deploy or
            // a load balancer spreading a session across cold replicas.
            await stop(proxy);
            port = base + i;
            proxy = await startHeadroomProxy(args.python, port, mode, up.port);
          }
          await post(`http://127.0.0.1:${port}/v1/chat/completions`, reqs[i], hdr);
        }
        note = restartEvery
          ? `--mode ${mode}, proxy RESTARTED between every turn (delta state lost)`
          : `--mode ${mode}`;
      }
    } catch (err) {
      console.log(`${arm.padEnd(24)} ERROR ${err.message.slice(0, 120)}`);
      await stop(proxy);
      continue;
    }
    await stop(proxy);

    const calls = [...up.state.calls];
    if (calls.length !== reqs.length) {
      console.log(`${arm.padEnd(24)} ERROR ${calls.length} upstream calls, expected ${reqs.length}`);
      continue;
    }

    // Turn 1 necessarily writes the cache and costs the same for every arm, so
    // the comparison is over turns 2..N — the warm turns, where a rewrite of
    // already-cached bytes is the whole question.
    const warm = calls.slice(1);
    const warmCost = warm.reduce((n, c) => n + priceTurn(c), 0);
    const busts = warm.filter((c, i) => c.cachedTok < calls[i].totalTok - 2).length;

    const row = {
      arm,
      note,
      turns: calls.length,
      turn1Tok: calls[0].totalTok,
      warmTurns: warm.map((c, i) => ({
        turn: i + 2,
        totalTok: c.totalTok,
        cachedTok: c.cachedTok,
        freshTok: c.freshTok,
        prefixHeld: c.cachedTok >= calls[i].totalTok - 2,
        costUnits: priceTurn(c),
      })),
      warmBusts: busts,
      warmCostUnits: warmCost,
      ...(perTurnDecisions.length ? { perTurnDecisions, pinsReturnedPerTurn: pinCounts } : {}),
    };
    results.push(row);

    console.log(
      `${arm.padEnd(24)} warm turns ${warm.length}  busts ${String(busts).padStart(2)}/${warm.length}  ` +
        `cached ${String(warm.reduce((n, c) => n + c.cachedTok, 0)).padStart(7)}  ` +
        `fresh ${String(warm.reduce((n, c) => n + c.freshTok, 0)).padStart(7)}  ` +
        `cost ${String(warmCost).padStart(7)}u   ${note}`
    );
  }

  up.server.close();

  const baseline = results.find((r) => r.arm === 'none');
  for (const r of results) {
    r.costVsNoCompressor = baseline
      ? Number((r.warmCostUnits / baseline.warmCostUnits).toFixed(2))
      : null;
  }

  const out = join(ROOT, 'tools', 'cache-economics.json');
  writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        rates: { cacheRead: RATE_CACHE_READ, cacheWrite: RATE_CACHE_WRITE, fresh: RATE_FRESH },
        rows: results,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`\nwrote ${out}`);
}

await main();

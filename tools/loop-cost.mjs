#!/usr/bin/env node
// Loop cost — does optimizing make the agent take MORE turns?
//
// WHY THIS EXISTS. Every other number in this repo scores a single request in
// isolation: bytes in, bytes out, key facts survived. That silently assumes the
// trim is free. In an agent loop it is not. If the optimizer elides something the
// agent still needed, the agent does not fail — it goes and READS IT AGAIN. The
// per-request saving is real and the loop still costs more, because a whole extra
// round trip (full accumulated history, re-billed) buys back one file.
//
// A single-request benchmark cannot see that. It is invisible by construction:
// the row shows a healthy saving and 100% key-fact survival, and the extra turn
// happens on the next request, which is scored as its own independent row.
//
// So this runs the same task to completion twice — optimizer OFF, optimizer ON —
// and reports the thing that actually decides whether optimizing paid:
//
//     turns to finish · TOTAL input tokens billed across the loop · correctness
//
// The net verdict is not per-request savings. It is total loop tokens, and a
// strategy can win every request and still lose the loop.
//
// THE ENVIRONMENT IS SYNTHETIC AND DETERMINISTIC, on purpose. Tools resolve
// against an in-memory file map defined below — no real filesystem, no network,
// no dependence on a checkout. Two runs of the same arm see identical tool
// results, so a turn-count difference is attributable to the optimizer rather
// than to the environment moving underneath it.
//
// Needs a running optimizer and a gateway that serves a model.
//
// Usage:
//   node tools/loop-cost.mjs --gateway https://… --key … --model gpt-4o-mini
//   node tools/loop-cost.mjs --task retry-policy --turns 12

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OptimizerClient } from '../lib/optimizerClient.mjs';
import { loadConfig } from '../lib/loadConfig.mjs';

const ROOT = join(import.meta.dirname, '..');

/** Median of a numeric list (even counts take the lower-middle: no invented value). */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

// ---------------------------------------------------------------- the repo ---
// A small synthetic codebase. Each file is big enough that carrying all of them
// in history is expensive, so an optimizer has a real reason to trim — and the
// answer lives in exactly one of them, so trimming the wrong one costs a re-read.
const pad = (label, n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `// ${label} internal detail ${i + 1}: bookkeeping, error paths, and defensive ` +
      `branches that carry no answer but are billed in full on every turn they ride along.`
  ).join('\n');

const FILES = {
  'src/http/retryPolicy.ts': `export const RETRY_MAX = 5;\nexport const RETRY_BASE_MS = 250;\n\nexport async function withRetry<T>(fn: () => Promise<T>): Promise<T> {\n  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {\n    try { return await fn(); } catch (err) { await sleep(RETRY_BASE_MS * 2 ** attempt); }\n  }\n  throw new Error('retries exhausted');\n}\n${pad('retryPolicy', 260)}`,
  'src/http/httpClient.ts': `import { withRetry } from './retryPolicy';\n\nexport class HttpClient {\n  constructor(private baseUrl: string) {}\n  async get(path: string) { return withRetry(() => fetch(this.baseUrl + path)); }\n}\n${pad('httpClient', 260)}`,
  'src/auth/session.ts': `export const SESSION_TTL_SECONDS = 3600;\nexport function isExpired(issuedAt: number) {\n  return Date.now() / 1000 - issuedAt > SESSION_TTL_SECONDS;\n}\n${pad('session', 260)}`,
  'src/auth/middleware.ts': `import { isExpired } from './session';\nexport function requireAdmin(user: { role: string; issuedAt: number }) {\n  return user.role === 'admin' && !isExpired(user.issuedAt);\n}\n${pad('middleware', 260)}`,
  'src/billing/invoice.ts': `export const INVOICE_GRACE_DAYS = 14;\nexport function isOverdue(dueAt: number) {\n  return Date.now() > dueAt + INVOICE_GRACE_DAYS * 86400_000;\n}\n${pad('invoice', 260)}`,
  'src/billing/tax.ts': `export const DEFAULT_TAX_RATE = 0.2;\n${pad('tax', 260)}`,
  'src/util/logger.ts': `export const LOG_LEVEL = 'info';\n${pad('logger', 260)}`,
  'src/util/clock.ts': `export const CLOCK_SKEW_MS = 500;\n${pad('clock', 260)}`,
};

// Each task needs facts from TWO files, so the loop is genuinely multi-turn and
// history has accumulated by the time the second read happens — which is exactly
// where an eliding optimizer can cost a turn.
const TASKS = [
  {
    id: 'retry-policy',
    question:
      'What is RETRY_MAX in the retry policy, and which class calls withRetry? Answer with both the number and the class name.',
    facts: ['5', 'HttpClient'],
  },
  {
    id: 'auth-expiry',
    question:
      'What is SESSION_TTL_SECONDS, and which function checks a user is an admin? Answer with both the number and the function name.',
    facts: ['3600', 'requireAdmin'],
  },
  {
    // A deliberately read-heavy task: the agent must touch every file, so history
    // grows across the loop and the optimizer finally has settled bytes behind the
    // cache boundary that it is allowed to trim. The short tasks above never get
    // there, which is itself the finding.
    id: 'audit-all',
    question:
      'Audit the repository: read every file and report RETRY_MAX, SESSION_TTL_SECONDS, ' +
      'INVOICE_GRACE_DAYS and DEFAULT_TAX_RATE. Answer with all four numbers.',
    facts: ['5', '3600', '14', '0.2'],
  },
  {
    id: 'billing-grace',
    question:
      'What is INVOICE_GRACE_DAYS, and what is DEFAULT_TAX_RATE? Answer with both numbers.',
    facts: ['14', '0.2'],
  },
];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List every file path in the repository.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one file in full, by exact path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description: 'Submit the final answer. Call this as soon as you can answer.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    },
  },
];

function runTool(name, args) {
  if (name === 'list_files') return Object.keys(FILES).join('\n');
  if (name === 'read_file') return FILES[args?.path] ?? `ERROR: no such file: ${args?.path}`;
  return '';
}

function parseArgs(argv) {
  const a = { gateway: null, key: null, model: 'gpt-4o-mini', turns: 12, task: null, out: null, trials: 3 };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--gateway') a.gateway = argv[++i];
    else if (f === '--key') a.key = argv[++i];
    else if (f === '--model') a.model = argv[++i];
    else if (f === '--turns') a.turns = Number(argv[++i]);
    else if (f === '--task') a.task = argv[++i];
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--trials') a.trials = Number(argv[++i]);
  }
  return a;
}

/**
 * Run one task to completion.
 *
 * optimize=true routes EVERY request through /v1/optimize first, which is what a
 * deployed gateway does on every turn — not just the first. That repetition is
 * the point: the cost of a trim shows up on the turns after it.
 */
async function runLoop({ task, optimize, opt, gateway, key, model, maxTurns }) {
  const messages = [
    {
      role: 'system',
      content:
        'You are a coding agent exploring a repository. Use list_files and read_file to find what you need, ' +
        'then call submit_answer. Be efficient: do not re-read a file you have already read.',
    },
    { role: 'user', content: task.question },
  ];

  // The gateway sends a `pins` array and persists what comes back; the optimizer
  // is stateless about them. WITHOUT this field the cache-safety guard cannot
  // locate a boundary and stands every eliding strategy down (`cache_guard`), so
  // a harness that omits pins measures a no-op and reports it as "no benefit".
  let pins = [];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let answer = null;
  const reads = [];
  const decisions = [];

  while (turns < maxTurns && answer === null) {
    let request = { model, max_tokens: 512, messages, tools: TOOLS };

    if (optimize) {
      try {
        const res = await opt.optimizeWithPins(request, pins, {
          // Attribute the loop so this traffic is identifiable and filterable
          // wherever it lands, rather than looking like organic usage.
          metadata: { user: 'benchmark-loop-cost', team: 'benchmarks' },
        });
        if (res?.request) request = res.request;
        if (Array.isArray(res?.pins)) pins = res.pins;   // persist, as the gateway does
        decisions.push(...(res?.decisions ?? []).map((d) => d.kind ?? d).filter(Boolean));
      } catch {
        // Fail open, exactly as the gateway does: an optimizer problem must not
        // become a loop failure, or the arm measures the harness not the product.
      }
    }

    const resp = await fetch(`${gateway.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-anyray-metadata': JSON.stringify({ user: 'benchmark-loop-cost', team: 'benchmarks' }),
      },
      body: JSON.stringify(request),
    });
    if (!resp.ok) throw new Error(`gateway ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const body = await resp.json();

    turns += 1;
    inputTokens += body.usage?.prompt_tokens ?? 0;
    outputTokens += body.usage?.completion_tokens ?? 0;

    const msg = body.choices?.[0]?.message ?? {};
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      // No tool call and no answer: treat the prose as the answer and stop.
      answer = msg.content ?? '';
      break;
    }
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.function?.arguments || '{}');
      } catch {
        /* a malformed call still costs a turn — that is the honest accounting */
      }
      const fname = c.function?.name;
      if (fname === 'submit_answer') {
        answer = args.answer ?? '';
      } else if (fname === 'read_file') {
        reads.push(args.path);
      }
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        name: fname,
        content: runTool(fname, args),
      });
    }
  }

  const hay = String(answer ?? '');
  const kept = task.facts.filter((f) => hay.includes(f));
  const rereads = reads.length - new Set(reads).size;

  return {
    turns,
    inputTokens,
    outputTokens,
    correct: kept.length === task.facts.length,
    factsKept: kept.length,
    factsTotal: task.facts.length,
    reads: reads.length,
    rereads,
    decisions: [...new Set(decisions)],
    answered: answer !== null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = args.gateway || process.env.ANYRAY_GATEWAY_URL;
  const key = args.key || process.env.OPENAI_API_KEY;
  if (!gateway || !key) {
    console.error('need --gateway and --key (or ANYRAY_GATEWAY_URL / OPENAI_API_KEY)');
    process.exit(2);
  }

  const cfg = loadConfig();
  const opt = new OptimizerClient({ url: cfg.optimizerUrl, adminToken: cfg.adminToken });
  if (!(await opt.ping())) {
    console.error(`no optimizer at ${cfg.optimizerUrl}`);
    process.exit(2);
  }

  const tasks = TASKS.filter((t) => !args.task || t.id === args.task);
  const rows = [];

  for (const task of tasks) {
    const out = { task: task.id, trials: args.trials };
    for (const [arm, optimize] of [['plain', false], ['optimized', true]]) {
      // Repeat each arm: an agent loop is stochastic, so a single pair of runs
      // cannot tell a real turn-count difference from ordinary sampling noise.
      // Report the median and keep every trial in the JSON.
      const runs = [];
      for (let t = 0; t < args.trials; t++) {
        runs.push(
          await runLoop({ task, optimize, opt, gateway, key, model: args.model, maxTurns: args.turns })
        );
      }
      out[`${arm}Trials`] = runs;
      out[arm] = {
        turns: median(runs.map((r) => r.turns)),
        inputTokens: median(runs.map((r) => r.inputTokens)),
        outputTokens: median(runs.map((r) => r.outputTokens)),
        correct: runs.filter((r) => r.correct).length,
        of: runs.length,
        reads: median(runs.map((r) => r.reads)),
        rereads: median(runs.map((r) => r.rereads)),
      };
      const r = out[arm];
      console.log(
        `${task.id.padEnd(14)} ${arm.padEnd(9)} turns~${String(r.turns).padStart(2)} ` +
          `inTok~${String(r.inputTokens).padStart(6)} reads~${r.reads} re-reads~${r.rereads} ` +
          `correct ${r.correct}/${r.of}  [turns ${runs.map((x) => x.turns).join(',')}]`
      );
    }
    out.turnsDelta = out.optimized.turns - out.plain.turns;
    out.inputTokenDelta = out.optimized.inputTokens - out.plain.inputTokens;
    out.netSavedPct =
      out.plain.inputTokens > 0
        ? Math.round((100 * (out.plain.inputTokens - out.optimized.inputTokens)) / out.plain.inputTokens)
        : 0;
    console.log(
      `${''.padEnd(14)} ${'=> delta'.padEnd(9)} turns ${out.turnsDelta >= 0 ? '+' : ''}${out.turnsDelta}, ` +
        `loop input tokens ${out.netSavedPct >= 0 ? '-' : '+'}${Math.abs(out.netSavedPct)}%\n`
    );
    rows.push(out);
  }

  const dest = args.out || join(ROOT, 'tools', 'loop-cost.json');
  writeFileSync(
    dest,
    JSON.stringify(
      { measuredAt: new Date().toISOString().slice(0, 10), model: args.model, rows },
      null,
      2
    ) + '\n'
  );
  console.log(`wrote ${dest}`);
}

await main();

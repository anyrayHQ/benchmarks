#!/usr/bin/env node
// Head-to-head: the Anyray optimizer vs Headroom, on identical payloads.
//
// WHY THIS EXISTS. Every number in this repo is Anyray measuring Anyray. That is
// reproducible but it is not comparative: a reader has no way to tell whether the
// savings are good, or merely non-zero. Headroom (Apache-2.0,
// github.com/headroomlabs-ai/headroom) is the closest public comparable — a local
// context-compression layer aimed at the same waste, with a Python `compress()`
// that takes the same OpenAI message shape our payloads already carry. So it can
// be run on the SAME bytes, scored by the SAME key-fact scorer, with no
// translation layer in between.
//
// HOW IT IS KEPT FAIR. The failure mode of a vendor-run comparison is picking the
// ground the vendor wins on, so the things that would tilt it are fixed here:
//
//   * Same payload bytes, unmodified, to both sides.
//   * Same accounting: chars of message bodies + tools schema, chars/4, the basis
//     `lib/tokens.mjs` already uses for every published Anyray number.
//   * Same quality gate: `keyFactSurvival` from `lib/quality.mjs`, the same
//     markers in `keyfacts.json`, scored against whatever each side returns.
//   * Anyray runs its FULL default pipeline, not a per-workload hero strategy at
//     a tuned knob. The headline in README.md pins one strategy per workload at a
//     swept knob; reusing those knobs here would be scoring a tuned system
//     against an untuned one. This runs Anyray the way a stock install runs.
//   * Headroom runs at ITS defaults too, and its defaults are reported as its
//     result even where that is 0%.
//
// THE SHAPE CAVEAT, which decides how the result must be read. Headroom compresses
// what an agent READ BACK — tool outputs, logs, RAG chunks — and by default leaves
// user messages alone (`compress_user_messages` defaults false). 17 of this repo's
// 41 payloads are a single user turn with a pasted blob, which is a shape Headroom
// deliberately declines. Pooling those into one average would report a shape
// mismatch as a win. So the two families are scored and reported SEPARATELY, and
// the tool-bearing split is the one that is actually a like-for-like comparison.
//
// Writes tools/headroom-comparison.json. Needs a running Anyray optimizer and a
// Python with `headroom-ai` installed (--python to point at its interpreter).
//
// Usage:
//   node tools/compare-headroom.mjs --python /path/to/venv/bin/python
//   node tools/compare-headroom.mjs --python … --only 29-orders-json

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { OptimizerClient } from '../lib/optimizerClient.mjs';
import { estTokens, savedPct } from '../lib/tokens.mjs';
import { keyFactSurvival, fullText } from '../lib/quality.mjs';
import { withRetrieveTool, stripSyntheticRetrieve } from '../lib/retrieveTool.mjs';
import { loadConfig } from '../lib/loadConfig.mjs';

const ROOT = join(import.meta.dirname, '..');
const SUITES = ['agent-ops', 'code-context', 'guardrails', 'logs-and-data', 'memory-recall', 'tools-and-rag'];

function parseArgs(argv) {
  const a = { python: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--python') a.python = argv[++i];
    else if (argv[i] === '--only') a.only = argv[++i];
  }
  return a;
}

/** Every committed payload, with its suite and id. */
function allPayloads() {
  const out = [];
  for (const suite of SUITES) {
    const dir = join(ROOT, suite, 'payloads');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      // 44-prefix-churn.turn2 is the second half of a two-turn fixture; it is
      // only meaningful behind its own turn 1, so it is not a standalone row.
      if (f.includes('.turn2.')) continue;
      out.push({ suite, id: f.replace(/\.json$/, ''), path: join(dir, f) });
    }
  }
  return out;
}

/**
 * Headroom's compress(), run over every payload in ONE warmed process.
 *
 * THIS IS NOT AN OPTIMIZATION, IT IS A CORRECTNESS REQUIREMENT, and getting it
 * wrong is how this comparison first "measured" Headroom at 0% on 34 of 40
 * workloads. Its text compressor (Kompress, a 274MB ModernBERT model) is fetched
 * and loaded on a BACKGROUND thread — `compress()` deliberately does not block a
 * request on the download, it routes around the deep path and returns the input
 * unchanged until the model is resident. A process-per-payload harness therefore
 * exits before the thread ever finishes, and every row reads as a clean, silent
 * 0% that looks exactly like a strategy declining to fire.
 *
 * So: one process, force the model in and WAIT for `is_ready()` before the first
 * payload is scored, then stream payloads over stdin. A comparison that gets this
 * wrong publishes its competitor's cold-start as its competitor's quality.
 */
const PY = `
import json, sys, time

# Load the text compressor and BLOCK until it is resident. Without this the
# first N payloads are scored against a model that is still downloading.
from headroom.transforms.kompress_compressor import (
    KompressCompressor, KompressConfig, is_kompress_available,
)
warm = {"available": bool(is_kompress_available()), "ready": False, "waited_s": 0}
if warm["available"]:
    c = KompressCompressor(KompressConfig())
    if not c.is_ready():
        c.ensure_background_load()
        for i in range(60):          # up to 5 minutes on a cold HF cache
            if c.is_ready(): break
            time.sleep(5)
    warm["ready"] = bool(c.is_ready())
    warm["waited_s"] = i * 5 if not c.is_ready() else None

import headroom
print(json.dumps({"warmup": warm}), flush=True)   # line 1 = warmup receipt

for line in sys.stdin:                            # one request per line
    line = line.strip()
    if not line: continue
    msgs = json.loads(line).get("messages") or []
    try:
        # Defaults, deliberately: this measures Headroom as it ships, the same
        # way the Anyray side runs its shipped pipeline rather than a tuned knob.
        res = headroom.compress(msgs, model="gpt-4o")
        out = {"messages": res.messages, "transforms": list(res.transforms_applied or []),
               "tokensBefore": res.tokens_before, "tokensAfter": res.tokens_after}
    except Exception as exc:   # a failure is a result, not a crash
        out = {"messages": msgs, "transforms": [], "error": type(exc).__name__}
    print(json.dumps(out), flush=True)
`;

/** Long-lived warmed Headroom process, one JSON request per line. */
class Headroom {
  constructor(python, script) {
    this.proc = spawn(python, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = createInterface({ input: this.proc.stdout });
    this.queue = [];
    this.rl.on('line', (line) => {
      const next = this.queue.shift();
      if (next) next(JSON.parse(line));
    });
  }
  /** Resolves with the next stdout line. */
  #next() {
    return new Promise((res) => this.queue.push(res));
  }
  /** Line 1 is the warmup receipt — await before scoring anything. */
  ready() {
    return this.#next();
  }
  compress(request) {
    const p = this.#next();
    this.proc.stdin.write(JSON.stringify({ messages: request.messages ?? [] }) + '\n');
    return p;
  }
  close() {
    this.proc.stdin.end();
  }
}

/** Chars of message bodies + tools schema — the basis every Anyray number uses. */
const sizeOf = (req) => fullText(req).length;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.python) {
    console.error('--python <interpreter with headroom-ai installed> is required');
    process.exit(2);
  }

  const scriptPath = join(mkdtempSync(join(tmpdir(), 'hrcmp-')), 'compress.py');
  writeFileSync(scriptPath, PY);

  const hrProc = new Headroom(args.python, scriptPath);
  const { warmup } = await hrProc.ready();
  if (!warmup?.ready) {
    // Refuse to publish a comparison against a cold competitor. A silent 0%
    // here is indistinguishable from a real decline, which is precisely the
    // failure this guard exists to prevent.
    console.error(
      `Headroom's Kompress model is not resident (available=${warmup?.available}, ` +
        `waited ${warmup?.waited_s}s). Scoring now would report its cold-start as ` +
        `its result. Pre-download it and retry:\n` +
        `  ${args.python} -c "from huggingface_hub import snapshot_download as d; ` +
        `d('chopratejas/kompress-v2-base')"`
    );
    process.exit(2);
  }
  console.log('headroom: Kompress model resident, scoring\n');

  const cfg = loadConfig();
  const opt = new OptimizerClient({
    url: cfg.optimizerUrl,
    adminToken: cfg.adminToken,
    optimizerToken: cfg.optimizerToken,
    endpoint: cfg.endpoint,
    timeoutMs: cfg.requestTimeoutMs,
  });
  if (!(await opt.ping())) {
    console.error(`no optimizer at ${cfg.optimizerUrl}`);
    process.exit(2);
  }

  const keyFacts = JSON.parse(readFileSync(join(ROOT, 'keyfacts.json'), 'utf8'));
  const rows = [];

  for (const p of allPayloads()) {
    if (args.only && p.id !== args.only) continue;
    const request = JSON.parse(readFileSync(p.path, 'utf8'));
    const facts = keyFacts[p.id]?.keyFacts ?? [];
    const messages = request.messages ?? [];
    const roles = new Set(messages.map((m) => m.role));
    const hasToolRole = roles.has('tool') || roles.has('function');

    const before = sizeOf(request);

    // --- Anyray: full default pipeline, no enabledKinds pin, no knob override.
    let anyray = null;
    try {
      const { request: sent, injected } = withRetrieveTool(request);
      const res = await opt.optimize(sent);
      const got = stripSyntheticRetrieve(res.request ?? sent, injected);
      anyray = {
        afterChars: sizeOf(got),
        messages: (got.messages ?? []).length,
        keyFacts: keyFactSurvival(got, facts),
        decisions: (res.decisions ?? []).map((d) => d.kind ?? d).filter(Boolean),
      };
    } catch (err) {
      anyray = { error: err.name };
    }

    // --- Headroom: shipped defaults.
    let headroom = null;
    try {
      const hr = await hrProc.compress(request);
      const got = { ...request, messages: hr.messages };
      headroom = {
        afterChars: sizeOf(got),
        messages: (hr.messages ?? []).length,
        keyFacts: keyFactSurvival(got, facts),
        transforms: hr.transforms ?? [],
        ...(hr.error ? { error: hr.error } : {}),
      };
    } catch (err) {
      headroom = { error: err.name };
    }

    const score = (side) =>
      side.error
        ? { error: side.error }
        : {
            afterChars: side.afterChars,
            beforeTok: estTokens(before),
            afterTok: estTokens(side.afterChars),
            savedPct: savedPct(before, side.afterChars),
            messagesDelta: side.messages - messages.length,
            keyFactsKept: side.keyFacts.present.length,
            keyFactsTotal: facts.length,
            verdict: side.keyFacts.verdict,
          };

    const row = {
      id: p.id,
      suite: p.suite,
      shape: hasToolRole ? 'tool-bearing' : 'single-turn',
      beforeChars: before,
      messages: messages.length,
      anyray: score(anyray),
      headroom: score(headroom),
    };
    rows.push(row);

    const a = row.anyray.savedPct ?? 'err';
    const h = row.headroom.savedPct ?? 'err';
    console.log(`${p.id.padEnd(30)} ${row.shape.padEnd(13)} anyray ${String(a).padStart(3)}%  headroom ${String(h).padStart(3)}%`);
  }

  hrProc.close();

  const out = join(ROOT, 'tools', 'headroom-comparison.json');
  writeFileSync(
    out,
    JSON.stringify(
      { measuredAt: new Date().toISOString().slice(0, 10), headroomWarmup: warmup, rows },
      null,
      2
    ) + '\n'
  );
  console.log(`\nwrote ${out} (${rows.length} rows)`);
}

await main();

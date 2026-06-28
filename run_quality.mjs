#!/usr/bin/env node
// Quality benchmark runner — does the answer survive the token reduction?
//
// For each workload with declared key facts (config.yaml), it pins the workload's
// strategy, runs the request through a live optimizer, and scores how many
// answer-bearing key facts survive in the optimized request:
//
//   deterministic (default) — verbatim substring survival, no model, reproducible.
//   --judge                 — also ask an OpenAI-compatible model whether each fact
//                             is still answerable from the kept context.
//   --dump                  — write the judge inputs (question + optimized context +
//                             key facts) to results/judge-inputs.json for an offline
//                             judge pass. (Contexts are synthetic.)
//
// Writes <suite>/results/quality.json, pairing each saving with its coverage.
//
// Usage:
//   node run_quality.mjs --all
//   node run_quality.mjs --suite code-context --judge
//
// Env: ANYRAY_OPTIMIZER_URL, ANYRAY_ADMIN_TOKEN (as run_benchmark.mjs); for --judge
//      also ANYRAY_JUDGE_URL (OpenAI-compatible /chat/completions), ANYRAY_JUDGE_KEY,
//      ANYRAY_JUDGE_MODEL.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames, workloadsFor } from './lib/loadConfig.mjs';
import { OptimizerClient } from './lib/optimizerClient.mjs';
import { sizeOf, savedPct } from './lib/tokens.mjs';
import { keyFactSurvival, fullText, judgePrompt, verdictFor } from './lib/quality.mjs';
import { extractJsonObject } from './lib/judge.mjs';

function parseArgs(argv) {
  const a = { all: false, suite: null, workload: null, judge: false, dump: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--all') a.all = true;
    else if (x === '--suite') a.suite = argv[++i];
    else if (x === '--workload') a.workload = argv[++i];
    else if (x === '--judge') a.judge = true;
    else if (x === '--dump') a.dump = true;
    else if (x === '--help' || x === '-h') a.help = true;
  }
  return a;
}

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

/** Load keyfacts.json (answer-bearing markers per workload id). */
function loadKeyFacts(root) {
  const raw = readJson(join(root, 'keyfacts.json'), {});
  const map = new Map();
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    if (Array.isArray(v?.keyFacts) && v.keyFacts.length) map.set(id, v);
  }
  return map;
}

async function judgeOne(judgeCfg, question, context, keyFacts) {
  const res = await fetch(`${judgeCfg.url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(judgeCfg.key ? { authorization: `Bearer ${judgeCfg.key}` } : {}),
    },
    body: JSON.stringify({
      model: judgeCfg.model,
      messages: judgePrompt(question, context, keyFacts),
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  const json = JSON.parse(extractJsonObject(text));
  const covered = Array.isArray(json.covered) ? json.covered : [];
  const coverage =
    typeof json.coverage === 'number'
      ? json.coverage / 100
      : covered.filter(Boolean).length / Math.max(1, keyFacts.length);
  return { coverage, verdict: verdictFor(coverage), note: json.note ?? '', covered };
}

async function runSuite(cfg, client, suite, only, opts, judgeCfg, keyFactsMap) {
  const workloads = workloadsFor(cfg, suite, only)
    .map((w) => ({ ...w, ...(keyFactsMap.get(w.id) ?? {}) }))
    .filter((w) => Array.isArray(w.keyFacts) && w.keyFacts.length);
  if (!workloads.length) return;

  const resultsDir = join(cfg.root, suite, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const optimized = readJson(join(resultsDir, 'optimized.json'), []);
  const savedById = new Map(optimized.map((r) => [r.id, r.savedPct]));
  // Reuse the exact optimized requests run_benchmark stashed, so quality scores
  // the same bytes the saving was measured on (and avoids a second optimize call).
  const stashed = readJson(join(resultsDir, 'optimized-requests.local.json'), {});

  const qualityPath = join(resultsDir, 'quality.json');
  const rows = readJson(qualityPath, []);
  const indexById = new Map(rows.map((r, i) => [r.id, i]));
  const dumps = [];
  for (const w of workloads) {
    const prev = indexById.has(w.id) ? rows[indexById.get(w.id)] : null;
    const wantJudge = opts.judge && judgeCfg;
    const haveJudge = prev?.judge && prev.judge.error == null;
    const alreadyScored = prev && (!wantJudge || haveJudge);
    // Resume: skip already-scored workloads, unless a --judge pass still owes a
    // verdict. A --dump pass still needs their optimized context, so fall through
    // (we compute the context below, then short-circuit before re-scoring).
    if (alreadyScored && !opts.dump) {
      console.log(`  [${suite}/${w.id}] already scored — skipping`);
      continue;
    }
    try {
      const payload = JSON.parse(
        readFileSync(join(cfg.root, suite, 'payloads', `${w.id}.json`), 'utf8')
      );
      let optimizedReq = stashed[w.id];
      if (!optimizedReq) {
        await client.setStrategy(w.strategy, w.params ?? {});
        const res = await client.optimize(payload, [w.strategy]);
        optimizedReq = res.request ?? payload;
      }
      const context = fullText(optimizedReq);

      if (opts.dump)
        dumps.push({ id: w.id, question: w.question ?? '', keyFacts: w.keyFacts, context });
      // Resume + --dump: we only fell through to capture the context — don't re-score.
      if (alreadyScored) {
        console.log(`  [${suite}/${w.id}] already scored — context dumped`);
        continue;
      }

      const det = keyFactSurvival(optimizedReq, w.keyFacts);
      const row = {
        id: w.id,
        strategy: w.strategy,
        savedPct: savedById.get(w.id) ?? savedPct(sizeOf(payload), sizeOf(optimizedReq)),
        keyFacts: w.keyFacts.length,
        deterministic: {
          coverage: Math.round(det.coverage * 100),
          verdict: det.verdict,
          missing: det.missing,
        },
      };

      if (wantJudge) {
        try {
          const j = await judgeOne(judgeCfg, w.question ?? '', context, w.keyFacts);
          row.judge = {
            coverage: Math.round(j.coverage * 100),
            verdict: j.verdict,
            note: j.note,
            by: judgeCfg.model,
          };
        } catch (e) {
          row.judge = { error: String(e.message ?? e) };
        }
      }

      if (indexById.has(w.id)) rows[indexById.get(w.id)] = row;
      else {
        indexById.set(w.id, rows.length);
        rows.push(row);
      }
      writeFileSync(qualityPath, JSON.stringify(rows, null, 2) + '\n');
      console.log(
        `  [${suite}/${w.id}] saved ${row.savedPct}% · key-facts ${row.deterministic.coverage}% ${row.deterministic.verdict}` +
          (row.judge?.coverage != null ? ` · judge ${row.judge.coverage}% ${row.judge.verdict}` : '')
      );
    } catch (e) {
      console.error(`  [${suite}/${w.id}] ERROR: ${e.message ?? e} — skipping`);
    }
  }
  if (opts.dump)
    writeFileSync(join(resultsDir, 'judge-inputs.json'), JSON.stringify(dumps, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.help || (!args.suite && !args.all)) {
    console.log(
      `Quality benchmark — key-fact survival\n\n  node run_quality.mjs --all [--judge] [--dump]\n  node run_quality.mjs --suite <name>\n\nSuites: ${suiteNames(cfg).join(', ')}`
    );
    process.exit(args.help ? 0 : 1);
  }

  const client = new OptimizerClient({
    url: cfg.optimizerUrl,
    adminToken: cfg.adminToken,
    optimizerToken: cfg.optimizerToken,
    endpoint: cfg.endpoint,
    timeoutMs: cfg.requestTimeoutMs,
  });
  if (!(await client.ping())) {
    console.error(`No optimizer reachable at ${cfg.optimizerUrl}.`);
    process.exit(2);
  }

  const judgeCfg = args.judge
    ? {
        url: process.env.ANYRAY_JUDGE_URL,
        key: process.env.ANYRAY_JUDGE_KEY,
        model: process.env.ANYRAY_JUDGE_MODEL || 'gpt-4o-mini',
      }
    : null;
  if (args.judge && !judgeCfg.url) {
    console.error('--judge needs ANYRAY_JUDGE_URL (OpenAI-compatible /chat/completions).');
    process.exit(2);
  }

  const keyFactsMap = loadKeyFacts(cfg.root);
  // Quality only re-pins a strategy when no stashed request exists; snapshot and
  // restore anyway so a fall-back optimize call can't leave the optimizer pinned.
  const snapshot = await client.getSettings().catch(() => null);
  try {
    const suites = args.all ? suiteNames(cfg) : [args.suite];
    for (const suite of suites) {
      console.log(`\n== ${suite} ==`);
      await runSuite(cfg, client, suite, args.workload, args, judgeCfg, keyFactsMap);
    }
    console.log('\nDone. Quality in <suite>/results/quality.json');
  } finally {
    if (snapshot) {
      try {
        await client.putConfig(snapshot);
      } catch (e) {
        console.error(`Warning: failed to restore optimizer config: ${e.message ?? e}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

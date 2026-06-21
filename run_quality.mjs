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
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
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

  const rows = [];
  const dumps = [];
  for (const w of workloads) {
    const payload = JSON.parse(
      readFileSync(join(cfg.root, suite, 'payloads', `${w.id}.json`), 'utf8')
    );
    await client.setStrategy(w.strategy, w.params ?? {});
    const res = await client.optimize(payload, [w.strategy]);
    const optimizedReq = res.request ?? payload;
    const context = fullText(optimizedReq);

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

    if (opts.dump) dumps.push({ id: w.id, question: w.question ?? '', keyFacts: w.keyFacts, context });
    if (opts.judge && judgeCfg) {
      try {
        const j = await judgeOne(judgeCfg, w.question ?? '', context, w.keyFacts);
        row.judge = { coverage: Math.round(j.coverage * 100), verdict: j.verdict, note: j.note };
      } catch (e) {
        row.judge = { error: String(e.message ?? e) };
      }
    }
    rows.push(row);
    console.log(
      `  [${suite}/${w.id}] saved ${row.savedPct}% · key-facts ${row.deterministic.coverage}% ${row.deterministic.verdict}` +
        (row.judge?.coverage != null ? ` · judge ${row.judge.coverage}% ${row.judge.verdict}` : '')
    );
  }
  writeFileSync(join(resultsDir, 'quality.json'), JSON.stringify(rows, null, 2) + '\n');
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
  const suites = args.all ? suiteNames(cfg) : [args.suite];
  for (const suite of suites) {
    console.log(`\n== ${suite} ==`);
    await runSuite(cfg, client, suite, args.workload, args, judgeCfg, keyFactsMap);
  }
  console.log('\nDone. Quality in <suite>/results/quality.json');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

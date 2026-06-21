#!/usr/bin/env node
// Anyray optimizer benchmark runner.
//
// For each workload in a suite the runner produces two configs — the Anyray
// analog of a compression benchmark's `control` vs `model--aggressiveness`:
//
//   control     the raw request, optimizer bypassed (establishes the baseline)
//   optimized   the suite's hero strategy at its knob, run by a live optimizer
//
// It measures the whole-request token reduction the optimizer actually returns
// (content-free: only sizes and the optimizer's own decision strings, never the
// message bodies) and writes results/<config>.json — an array over the suite's
// workloads, re-saved per item so an interrupted run resumes where it stopped.
//
// Usage:
//   node run_benchmark.mjs --suite memory-recall
//   node run_benchmark.mjs --suite code-context --workload 15-multifile-graph
//   node run_benchmark.mjs --all --limit 2
//
// Requires a running Anyray optimizer (ANYRAY_OPTIMIZER_URL, default
// http://localhost:8088) and its admin token (ANYRAY_ADMIN_TOKEN).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames, workloadsFor } from './lib/loadConfig.mjs';
import { OptimizerClient } from './lib/optimizerClient.mjs';
import { sizeOf, estTokens, savedPct } from './lib/tokens.mjs';

function parseArgs(argv) {
  const args = { limit: null, suite: null, workload: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--suite') args.suite = argv[++i];
    else if (a === '--workload' || a === '--config') args.workload = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `Anyray optimizer benchmarks

  node run_benchmark.mjs --suite <name> [--workload <id>] [--limit N]
  node run_benchmark.mjs --all [--limit N]

Suites: ${'{listed at runtime}'}
Env: ANYRAY_OPTIMIZER_URL (default http://localhost:8088), ANYRAY_ADMIN_TOKEN`;

function readResults(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function save(path, rows) {
  writeFileSync(path, JSON.stringify(rows, null, 2) + '\n');
}

async function runSuite(cfg, client, suite, only, limit) {
  let workloads = workloadsFor(cfg, suite, only);
  if (limit != null) workloads = workloads.slice(0, limit);

  const resultsDir = join(cfg.root, suite, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const controlPath = join(resultsDir, 'control.json');
  const optimizedPath = join(resultsDir, 'optimized.json');

  const control = readResults(controlPath);
  const optimized = readResults(optimizedPath);
  const done = new Set(optimized.map((r) => r.id));

  for (const w of workloads) {
    if (done.has(w.id)) {
      console.log(`  [${suite}/${w.id}] already done — skipping`);
      continue;
    }
    const payloadPath = join(cfg.root, suite, 'payloads', `${w.id}.json`);
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));

    const beforeChars = sizeOf(payload);
    const beforeTok = estTokens(beforeChars, cfg.charsPerToken);
    const maxTokensBefore = payload.max_tokens ?? null;

    // control: the raw request (optimizer bypassed). Recorded once per workload.
    if (!control.some((r) => r.id === w.id)) {
      control.push({
        id: w.id,
        title: w.title,
        chars: beforeChars,
        tokens: beforeTok,
        max_tokens: maxTokensBefore,
      });
      save(controlPath, control);
    }

    // optimized: pin the hero strategy at its knob, run the hook, measure.
    await client.setStrategy(w.strategy, w.params ?? {});
    const res = await client.optimize(payload, [w.strategy]);
    const afterReq = res.request ?? payload;
    const afterChars = sizeOf(afterReq);
    const afterTok = estTokens(afterChars, cfg.charsPerToken);
    const decisions = (res.decisions ?? []).map(
      (d) => d.summary ?? d.kind ?? String(d)
    );

    const row = {
      id: w.id,
      title: w.title,
      strategy: w.strategy,
      knob: formatKnob(w.params),
      tier: w.tier ?? 'accounting',
      beforeChars,
      afterChars,
      beforeTok,
      afterTok,
      savedPct: savedPct(beforeChars, afterChars),
      max_tokens_before: maxTokensBefore,
      max_tokens_after: afterReq.max_tokens ?? null,
      fired: decisions.length > 0,
      decisions,
    };
    optimized.push(row);
    save(optimizedPath, optimized);

    const tag = row.tier === 'accounting' ? `${row.savedPct}% saved` : `tier=${row.tier}`;
    console.log(
      `  [${suite}/${w.id}] ${beforeTok} -> ${afterTok} tok  (${tag})` +
        (row.fired ? '' : '  [no transform]')
    );
  }
  return { suite, control, optimized };
}

function formatKnob(params) {
  if (!params || Object.keys(params).length === 0) return '(defaults)';
  return Object.entries(params)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.help || (!args.suite && !args.all)) {
    console.log(HELP.replace('{listed at runtime}', suiteNames(cfg).join(', ')));
    process.exit(args.help ? 0 : 1);
  }

  const client = new OptimizerClient({
    url: cfg.optimizerUrl,
    adminToken: cfg.adminToken,
    endpoint: cfg.endpoint,
    timeoutMs: cfg.requestTimeoutMs,
  });
  if (!(await client.ping())) {
    console.error(
      `No optimizer reachable at ${cfg.optimizerUrl}. Start the Anyray stack ` +
        `(docker compose up) or set ANYRAY_OPTIMIZER_URL.`
    );
    process.exit(2);
  }

  const suites = args.all ? suiteNames(cfg) : [args.suite];
  for (const suite of suites) {
    console.log(`\n== ${suite} ==`);
    await runSuite(cfg, client, suite, args.workload, args.limit);
  }
  console.log('\nDone. Results in <suite>/results/{control,optimized}.json');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

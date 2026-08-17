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
import { withRetrieveTool, stripSyntheticRetrieve } from './lib/retrieveTool.mjs';

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

// Synthetic provider response used to seed the semantic cache for the hit demo.
const SYNTHETIC_CACHE_RESPONSE = {
  id: 'chatcmpl-bench-cache',
  object: 'chat.completion',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'cached answer' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
};

// Measure one optimized run. Most strategies transform the request in a single
// /v1/optimize call; semantic_cache is special — its saving is a *hit*, which only
// shows on a second identical call, so it gets a 3-step miss -> write -> hit probe.
async function measureOptimized(client, w, payload, cfg) {
  if (w.strategy === 'semantic_cache') return measureSemanticCacheHit(client, payload, cfg);
  await client.setStrategy(w.strategy, w.params ?? {});
  // Offer a retrieve tool if the fixture declares none, else the optimizer
  // suppresses every eliding strategy as `no_retrieve` and this measures 0%.
  // Stripped again before sizing, so the signal never inflates the accounting.
  const { request: sent, injected } = withRetrieveTool(payload);
  const res = await client.optimize(sent, [w.strategy], {
    endpoint: w.endpoint,
    metadata: w.metadata,
  });
  const afterReq = stripSyntheticRetrieve(res.request ?? sent, injected);
  const afterChars = sizeOf(afterReq);
  const decisions = (res.decisions ?? []).map((d) => d.summary ?? d.kind ?? String(d));
  return {
    afterReq,
    afterChars,
    afterTok: estTokens(afterChars, cfg.charsPerToken),
    decisions,
    fired: decisions.length > 0,
    savedPct: savedPct(sizeOf(payload), afterChars),
  };
}

// A hit serves the whole response from cache, so the provider call — and its entire
// input — is avoided; we book that as 100% of the request saved.
async function measureSemanticCacheHit(client, payload, cfg) {
  const before = sizeOf(payload);
  const unchanged = (note) => ({
    afterReq: payload,
    afterChars: before,
    afterTok: estTokens(before, cfg.charsPerToken),
    decisions: [note],
    fired: false,
    savedPct: 0,
  });
  const hitResult = () => ({
    afterReq: payload,
    afterChars: 0,
    afterTok: 0,
    decisions: [
      `semantic cache HIT on an identical repeat call — provider call avoided (~${estTokens(before, cfg.charsPerToken)} input tokens)`,
    ],
    fired: true,
    savedPct: 100,
  });
  await client.setStrategy('semantic_cache', {});
  const first = await client.optimize(payload, ['semantic_cache']);
  if (first.cacheHit) return hitResult(); // cache already warm from a prior run
  if (!first.cacheEligible || !first.cacheKey) {
    return unchanged('semantic cache not eligible — hit not demonstrable');
  }
  await client.cache({
    cacheKey: first.cacheKey,
    response: SYNTHETIC_CACHE_RESPONSE,
    ttlSeconds: 3600,
  });
  const second = await client.optimize(payload, ['semantic_cache']);
  if (!second.cacheHit) {
    return unchanged('cache populated but the repeat call did not hit');
  }
  return hitResult();
}

async function runSuite(cfg, client, suite, only, limit) {
  let workloads = workloadsFor(cfg, suite, only);
  if (limit != null) workloads = workloads.slice(0, limit);

  const resultsDir = join(cfg.root, suite, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const controlPath = join(resultsDir, 'control.json');
  const optimizedPath = join(resultsDir, 'optimized.json');
  // Optimized request bodies are stashed (gitignored, synthetic) so the quality
  // runner can score the exact same bytes instead of re-calling the optimizer.
  const requestsPath = join(resultsDir, 'optimized-requests.local.json');

  const control = readResults(controlPath);
  const optimized = readResults(optimizedPath);
  const optimizedReqs = existsSync(requestsPath)
    ? JSON.parse(readFileSync(requestsPath, 'utf8'))
    : {};
  const done = new Set(optimized.map((r) => r.id));

  for (const w of workloads) {
    if (done.has(w.id)) {
      console.log(`  [${suite}/${w.id}] already done — skipping`);
      continue;
    }
    try {
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
      const m = await measureOptimized(client, w, payload, cfg);

      const row = {
        id: w.id,
        title: w.title,
        strategy: w.strategy,
        knob: formatKnob(w.params),
        tier: w.tier ?? 'accounting',
        beforeChars,
        afterChars: m.afterChars,
        beforeTok,
        afterTok: m.afterTok,
        savedPct: m.savedPct,
        max_tokens_before: maxTokensBefore,
        max_tokens_after: m.afterReq.max_tokens ?? null,
        fired: m.fired,
        decisions: m.decisions,
      };
      const basis = w.tier === 'guardrail' ? guardrailBasis(w, payload, m.afterReq, cfg.charsPerToken) : null;
      if (basis) row.basis = basis;
      optimized.push(row);
      save(optimizedPath, optimized);
      optimizedReqs[w.id] = m.afterReq;
      save(requestsPath, optimizedReqs);

      const tag = row.tier === 'accounting' ? `${row.savedPct}% saved` : `tier=${row.tier}`;
      console.log(
        `  [${suite}/${w.id}] ${beforeTok} -> ${row.afterTok} tok  (${tag})` +
          (row.fired ? '' : '  [no transform]')
      );
    } catch (e) {
      console.error(`  [${suite}/${w.id}] ERROR: ${e.message ?? e} — skipping`);
    }
  }
  return { suite, control, optimized };
}

function formatKnob(params) {
  if (!params || Object.keys(params).length === 0) return '(defaults)';
  return Object.entries(params)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
    .join(', ');
}

// Guardrail strategies don't save request bytes — measure each on its own basis
// so the row carries a real number instead of a misleading 0%.
function guardrailBasis(w, before, after, charsPerToken) {
  if (w.strategy === 'reasoning_budget') {
    const b = before?.thinking?.budget_tokens;
    const a = after?.thinking?.budget_tokens;
    if (Number.isFinite(b) && Number.isFinite(a) && a < b) {
      return {
        name: 'thinking_budget_tokens',
        before: b,
        after: a,
        savedPct: Math.round((1 - a / b) * 100),
      };
    }
    return null;
  }
  if (w.strategy === 'provider_context_trim') {
    if (!after?.context_management) return null;
    // What the injected clear_tool_uses edit exposes: every tool_result except
    // the freshest round (Anthropic keeps recent tool uses, clears from the top).
    const msgs = Array.isArray(before?.messages) ? before.messages : [];
    const toolResultChars = (msg) =>
      Array.isArray(msg?.content)
        ? msg.content
            .filter((b) => b?.type === 'tool_result')
            .reduce((s, b) => s + JSON.stringify(b.content ?? '').length, 0)
        : 0;
    const carriers = msgs.map((m, i) => ({ i, chars: toolResultChars(m) })).filter((x) => x.chars > 0);
    if (carriers.length === 0) return null;
    const stale = carriers.slice(0, -1).reduce((s, x) => s + x.chars, 0);
    const eligibleTok = estTokens(stale, charsPerToken);
    const totalTok = estTokens(sizeOf(before), charsPerToken);
    return {
      name: 'provider_clearable_input_tokens',
      eligibleTok,
      ofTok: totalTok,
      sharePct: Math.round((eligibleTok / totalTok) * 100),
    };
  }
  return null;
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
    optimizerToken: cfg.optimizerToken,
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

  // Load the embedding model before the first measurement, or whichever
  // semanticRerank workload happens to run first silently scores against lexical
  // ranking only (see warmEmbedder). Warm with a real semanticRerank workload —
  // synthetic filler gets served by BM25 and never loads the model. Advisory: a
  // cold embedder still produces a number, just an order-dependent one.
  const warmup = suiteNames(cfg)
    .flatMap((s) => workloadsFor(cfg, s, null).map((w) => ({ suite: s, w })))
    .find(({ w }) => w.strategy === 'relevance_filter' && w.params?.semanticRerank);
  if (warmup) {
    const payloadPath = join(cfg.root, warmup.suite, 'payloads', `${warmup.w.id}.json`);
    // Must carry the retrieve tool, exactly like a measured run: without it the
    // optimizer suppresses every eliding strategy as `no_retrieve`, so the warm-up
    // never reaches the re-ranker and the model never loads.
    const request = existsSync(payloadPath)
      ? withRetrieveTool(JSON.parse(readFileSync(payloadPath, 'utf8'))).request
      : null;
    if (!(await client.warmEmbedder(request, warmup.w.params))) {
      console.warn(
        '  ! embedder did not confirm warm — semanticRerank rows may score low.\n' +
          "    Run 'npm run fetch-model' in the optimizer package if this persists."
      );
    }
  }

  // Pinning one strategy at a time rewrites the optimizer's config; snapshot it
  // first and restore on the way out so a shared optimizer is left as we found it.
  const snapshot = await client.getSettings().catch(() => null);
  try {
    const suites = args.all ? suiteNames(cfg) : [args.suite];
    for (const suite of suites) {
      console.log(`\n== ${suite} ==`);
      await runSuite(cfg, client, suite, args.workload, args.limit);
    }
    console.log('\nDone. Results in <suite>/results/{control,optimized}.json');
  } finally {
    if (snapshot) {
      try {
        await client.putConfig(snapshot);
        console.log('Restored optimizer config to its pre-benchmark state.');
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

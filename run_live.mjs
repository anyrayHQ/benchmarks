#!/usr/bin/env node
// Live validation runner — does the saving hold up when a real model answers?
//
// Modes:
//   per-strategy  pin ONE strategy, run baseline (hook off) + the optimizer-transformed
//                 request (hook off), measure the real prompt_token delta, and judge the
//                 optimized answer against the baseline answer.
//   pipeline      deployed config UNCHANGED: baseline (hook off) vs original (hook on,
//                 full pipeline). Validates the stack as it actually runs (mutates nothing).
//   sweep         per-strategy across config.sweep[strategy].values; records a
//                 savings<->quality curve used to recommend a tuned knob.
//
// Writes <suite>/results/{live,pipeline,sweep-<strategy>}.json. Resume-aware: a workload
// already present in the result file is skipped. Synthetic payloads only.
//
// Usage:
//   node run_live.mjs --mode pipeline --all
//   node run_live.mjs --mode per-strategy --suite logs-and-data --workload 1-access-log --limit 1
//   node run_live.mjs --mode sweep --strategy relevance_filter --all
//
// Env: ANYRAY_OPTIMIZER_URL, ANYRAY_ADMIN_TOKEN (as run_benchmark.mjs); ANYRAY_GATEWAY_URL,
//      ANYRAY_LIVE_MODEL, ANYRAY_JUDGE_URL/KEY/MODEL for the live + judge calls.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames, workloadsFor } from './lib/loadConfig.mjs';
import { OptimizerClient } from './lib/optimizerClient.mjs';
import { GatewayClient } from './lib/gatewayClient.mjs';
import { resolveLiveConfig } from './lib/env.mjs';
import { judgeAnswers } from './lib/judge.mjs';
import { runCheck } from './lib/checks/index.mjs';
import { withIsolatedStrategy } from './lib/isolate.mjs';
import { savedPct } from './lib/tokens.mjs';

function parseArgs(argv) {
  const a = { mode: 'per-strategy', suites: null, only: null, strategy: null, limit: Infinity, all: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--mode') a.mode = argv[++i];
    else if (f === '--suite') a.suites = [argv[++i]];
    else if (f === '--workload') a.only = argv[++i];
    else if (f === '--strategy') a.strategy = argv[++i];
    else if (f === '--limit') a.limit = Number(argv[++i]);
    else if (f === '--all') a.all = true;
  }
  return a;
}

const readJson = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const loadPayload = (root, suite, id) =>
  JSON.parse(readFileSync(join(root, suite, 'payloads', `${id}.json`), 'utf8'));
function loadKeyFacts(root) {
  return readJson(join(root, 'keyfacts.json'), {});
}
function writeResults(root, suite, file, rows) {
  const dir = join(root, suite, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(rows, null, 2) + '\n');
}

/** Coarse PASS/MARGINAL/FAIL/N-A quality label from a judge result or a check verdict. */
function qualityLabel({ checkKind, judged, check }) {
  if (checkKind === 'answer_judge') {
    if (judged.preserved && judged.score >= 90) return 'PASS';
    if (judged.score >= 75) return 'MARGINAL';
    return 'FAIL';
  }
  return check.verdict; // tool_safety/identical/cache_hit/truncation/readonly
}

/** Apply the deterministic temperature override so baseline/optimized are comparable. */
function withTemp(req, live) {
  return live.temperature != null ? { ...req, temperature: live.temperature } : req;
}

/**
 * Run a baseline + optimized pair through the gateway and score quality.
 * optimizeMode 'on' => send the original with the hook ON (pipeline mode);
 *              'off' => send the pre-transformed request with the hook OFF.
 * optMetric: a metric ({name,value}) from the optimizer-side decisions (per-strategy),
 *            since the gateway's optimize:off path emits no decisions header.
 */
async function evalOptimized({ gw, live, original, transformed, optimizeMode, wl, keyFacts, optMetric = null }) {
  const baseline = await gw.execute(withTemp(original, live), { optimize: 'off', model: live.model });
  const optimized =
    optimizeMode === 'on'
      ? await gw.execute(withTemp(original, live), { optimize: 'on', model: live.model })
      : await gw.execute(withTemp(transformed, live), { optimize: 'off', model: live.model });

  const realSaved = savedPct(baseline.usage.prompt_tokens ?? 0, optimized.usage.prompt_tokens ?? 0);
  const checkKind = wl.qualityCheck || 'answer_judge';

  let judged = null;
  if (checkKind === 'answer_judge' || checkKind === 'tool_safety') {
    judged = await judgeAnswers({
      judge: live.judge,
      question: keyFacts.question || wl.title,
      keyFacts: keyFacts.keyFacts || [],
      baselineAnswer: baseline.answer,
      optimizedAnswer: optimized.answer,
    });
  }
  const check =
    checkKind === 'answer_judge'
      ? { verdict: null, detail: null }
      : runCheck(checkKind, {
          baseline,
          optimized,
          judged,
          metric: optMetric ?? optimized.decisions?.metric,
        });
  const quality = qualityLabel({ checkKind, judged, check });

  return {
    id: wl.id,
    strategy: wl.strategy,
    checkKind,
    baselineTokens: baseline.usage.prompt_tokens ?? null,
    optimizedTokens: optimized.usage.prompt_tokens ?? null,
    realSavedPct: realSaved,
    quality,
    judge: judged
      ? {
          score: judged.score,
          preserved: judged.preserved,
          missingFacts: judged.missingFacts,
          rationale: judged.rationale,
          by: judged.by,
        }
      : null,
    detail: check.detail ?? null,
  };
}

/**
 * semantic_cache is a response-bypass, not a content reduction: a hit serves the whole
 * cached response. Exercise it directly on the optimizer — optimize (miss) -> seed the
 * cache with the real baseline answer -> optimize again (hit). A hit avoids the entire
 * input, so realSavedPct is 100; quality is trivially preserved (identical response).
 */
async function evalSemanticCache({ opt, gw, live, original, wl }) {
  const baseline = await gw.execute(withTemp(original, live), { optimize: 'off', model: live.model });
  const first = await opt.optimize(original, ['semantic_cache']);
  let cacheHit = !!first.cacheHit;
  if (!cacheHit && first.cacheEligible && first.cacheKey) {
    await opt.cache({ cacheKey: first.cacheKey, request: original, response: baseline.raw });
    const second = await opt.optimize(original, ['semantic_cache']);
    cacheHit = !!second.cacheHit;
  }
  return {
    id: wl.id,
    strategy: wl.strategy,
    checkKind: 'cache_hit',
    baselineTokens: baseline.usage.prompt_tokens ?? null,
    optimizedTokens: cacheHit ? 0 : (baseline.usage.prompt_tokens ?? null),
    realSavedPct: cacheHit ? 100 : 0,
    quality: cacheHit ? 'PASS' : 'FAIL',
    judge: null,
    detail: { cacheHit, eligible: !!first.cacheEligible },
  };
}

function logRow(prefix, row) {
  console.log(`${prefix}: saved ${row.realSavedPct ?? '—'}% quality ${row.quality ?? row.error}`);
}

/** Best-effort run attribution: timestamp, models, and the optimizer config snapshot. */
async function writeRunMeta(cfg, opt, live, args) {
  let optimizerConfig = null;
  try {
    optimizerConfig = (await opt.getSettings()) ?? null; // getSettings already returns the bare config
  } catch (e) {
    optimizerConfig = { error: e.message };
  }
  const dir = join(cfg.root, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run-meta.json'),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        mode: args.mode,
        liveModel: live.model,
        judgeModel: live.judge.model,
        gatewayUrl: live.gatewayUrl,
        optimizerUrl: cfg.optimizerUrl,
        optimizerConfig,
      },
      null,
      2
    ) + '\n'
  );
}

async function runPerStrategy(cfg, opt, gw, live, suite, only, limit) {
  const kf = loadKeyFacts(cfg.root);
  const out = readJson(join(cfg.root, suite, 'results', 'live.json'), []);
  const done = new Set(out.map((r) => r.id));
  let n = 0;
  for (const wl of workloadsFor(cfg, suite, only)) {
    if (done.has(wl.id)) continue;
    if (n >= limit) break;
    n++;
    const original = loadPayload(cfg.root, suite, wl.id);
    try {
      const row = await withIsolatedStrategy(opt, wl.strategy, wl.params || {}, async () => {
        if (wl.strategy === 'semantic_cache') {
          return evalSemanticCache({ opt, gw, live, original, wl });
        }
        const r = await opt.optimize(original, [wl.strategy]);
        const optMetric = (r.decisions || []).find((d) => d.metric)?.metric ?? null;
        return evalOptimized({
          gw, live, original, transformed: r.request, optimizeMode: 'off', wl,
          keyFacts: kf[wl.id] || {}, optMetric,
        });
      });
      out.push(row);
    } catch (e) {
      out.push({ id: wl.id, strategy: wl.strategy, error: e.message });
    }
    writeResults(cfg.root, suite, 'live.json', out);
    logRow(`${suite}/${wl.id}`, out.at(-1));
  }
}

async function runPipeline(cfg, opt, gw, live, suite, only, limit) {
  const kf = loadKeyFacts(cfg.root);
  const out = readJson(join(cfg.root, suite, 'results', 'pipeline.json'), []);
  const done = new Set(out.map((r) => r.id));
  let n = 0;
  for (const wl of workloadsFor(cfg, suite, only)) {
    if (done.has(wl.id)) continue;
    if (n >= limit) break;
    n++;
    const original = loadPayload(cfg.root, suite, wl.id);
    try {
      out.push(
        await evalOptimized({
          gw, live, original, transformed: null, optimizeMode: 'on', wl,
          keyFacts: kf[wl.id] || {},
        })
      );
    } catch (e) {
      out.push({ id: wl.id, strategy: wl.strategy, error: e.message });
    }
    writeResults(cfg.root, suite, 'pipeline.json', out);
    logRow(`${suite}/${wl.id} [pipeline]`, out.at(-1));
  }
}

async function runSweep(cfg, opt, gw, live, suite, only, strategy) {
  const kf = loadKeyFacts(cfg.root);
  const spec = (cfg.sweep || {})[strategy];
  if (!spec) throw new Error(`no sweep config for strategy ${strategy}`);
  const file = `sweep-${strategy}.json`;
  const rows = readJson(join(cfg.root, suite, 'results', file), []);
  const doneByWl = new Map(
    rows.map((r) => [r.id, new Set((r.points || []).map((p) => JSON.stringify(p.knob)))])
  );
  for (const wl of workloadsFor(cfg, suite, only)) {
    if (wl.strategy !== strategy) continue;
    const doneKnobs = doneByWl.get(wl.id) ?? new Set();
    const remaining = spec.values.filter(
      (v) => !doneKnobs.has(JSON.stringify({ [spec.param]: v }))
    );
    if (remaining.length === 0) continue;
    const original = loadPayload(cfg.root, suite, wl.id);
    let row = rows.find((r) => r.id === wl.id);
    if (!row) {
      row = { id: wl.id, strategy, param: spec.param, points: [] };
      rows.push(row);
    }
    for (const v of remaining) {
      const params = { ...(wl.params || {}), [spec.param]: v };
      try {
        const pt = await withIsolatedStrategy(opt, strategy, params, async () => {
          const r = await opt.optimize(original, [strategy]);
          return evalOptimized({
            gw, live, original, transformed: r.request, optimizeMode: 'off', wl,
            keyFacts: kf[wl.id] || {},
          });
        });
        row.points.push({ knob: { [spec.param]: v }, realSavedPct: pt.realSavedPct, quality: pt.quality });
      } catch (e) {
        row.points.push({ knob: { [spec.param]: v }, error: e.message });
      }
      const p = row.points.at(-1);
      console.log(`${suite}/${wl.id} [sweep ${spec.param}=${v}]: ${p.realSavedPct ?? '—'}% ${p.quality ?? p.error}`);
      writeResults(cfg.root, suite, file, rows);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const live = resolveLiveConfig(cfg);
  const opt = new OptimizerClient({
    url: cfg.optimizerUrl,
    adminToken: cfg.adminToken,
    optimizerToken: cfg.optimizerToken,
    endpoint: cfg.endpoint,
    timeoutMs: cfg.requestTimeoutMs,
  });
  const gw = new GatewayClient({ url: live.gatewayUrl, auth: live.auth, timeoutMs: live.timeoutMs });
  await writeRunMeta(cfg, opt, live, args);
  const suites = args.all ? suiteNames(cfg) : args.suites || [suiteNames(cfg)[0]];
  for (const suite of suites) {
    if (args.mode === 'per-strategy') await runPerStrategy(cfg, opt, gw, live, suite, args.only, args.limit);
    else if (args.mode === 'pipeline') await runPipeline(cfg, opt, gw, live, suite, args.only, args.limit);
    else if (args.mode === 'sweep') await runSweep(cfg, opt, gw, live, suite, args.only, args.strategy);
    else throw new Error(`unknown --mode ${args.mode}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

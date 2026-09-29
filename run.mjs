#!/usr/bin/env node
// End-to-end comparison: the same request sent straight to the provider, and through
// an Anyray gateway exactly as a customer would send it. Anyray is a black box — no
// x-anyray-* control headers, no optimizer calls. For each workload:
//
//   input/output tokens  from each provider usage block (billed, not estimated)
//   cost                 priced from usage incl. cache reads/writes (config.yaml pricing)
//   latency              wall clock per call; the gateway's overhead is the difference
//   quality              a direct-called judge rates the gateway answer against the
//                        direct answer, with the workload's key facts as the rubric
//
// Writes <suite>/results/compare.json (numbers + verdicts, committed) and
// <suite>/results/answers.local.json (answer text, gitignored). Resume-aware: a workload
// already in compare.json is skipped; pass --fresh to re-run.
//
// Usage:
//   node run.mjs --suite logs-and-data --workload 1-access-log
//   node run.mjs --all [--limit N] [--fresh] [--no-judge]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames, workloadsFor } from './lib/loadConfig.mjs';
import { Client } from './lib/client.mjs';
import { costOf, savedPct } from './lib/cost.mjs';
import { judgeAnswers, qualityLabel } from './lib/judge.mjs';

function parseArgs(argv) {
  const a = { suites: null, only: null, limit: Infinity, all: false, fresh: false, judge: true };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--suite') a.suites = [argv[++i]];
    else if (f === '--workload') a.only = argv[++i];
    else if (f === '--limit') a.limit = Number(argv[++i]);
    else if (f === '--all') a.all = true;
    else if (f === '--fresh') a.fresh = true;
    else if (f === '--no-judge') a.judge = false;
    else throw new Error(`unknown flag ${f}`);
  }
  return a;
}

const readJson = (p, fb) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fb);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

/** Apply the configured temperature to both sides alike (never with extended thinking). */
function withTemp(req, run) {
  if (req.thinking || run.temperature == null) return req;
  return { ...req, temperature: run.temperature };
}

/** Which side goes first. Either can warm the provider cache for the other. */
export function directFirst(order, index) {
  if (order === 'direct-first') return true;
  if (order === 'gateway-first') return false;
  return index % 2 === 0;
}

const side = (r, pricing, model) => ({
  input: r.usage.input,
  cacheRead: r.usage.cacheRead,
  cacheWrite: r.usage.cacheWrite,
  output: r.usage.output,
  costUsd: costOf(pricing, model, r.usage),
  latencyMs: r.latencyMs,
  finishReason: r.finishReason,
});

export async function compareOne({ cfg, clients, wl, request, keyFacts, index, judge }) {
  const { run, pricing } = cfg;
  const req = withTemp(request, run);
  const opts = { endpoint: wl.endpoint, model: run.model };
  const first = directFirst(run.order, index) ? ['direct', 'gateway'] : ['gateway', 'direct'];
  const res = {};
  for (const s of first) res[s] = await clients[s].execute(req, opts);

  const direct = side(res.direct, pricing, run.model);
  const gateway = side(res.gateway, pricing, run.model);
  let judged = null;
  if (judge) {
    judged = await judgeAnswers({
      judge: run.judge,
      question: keyFacts.question || wl.title,
      keyFacts: keyFacts.keyFacts || [],
      directAnswer: res.direct.answer,
      gatewayAnswer: res.gateway.answer,
    });
  }
  const row = {
    id: wl.id,
    order: first.join('>'),
    direct,
    gateway,
    inputSavedPct: savedPct(direct.input, gateway.input),
    costSavedPct: savedPct(direct.costUsd, gateway.costUsd),
    latencyOverheadMs: gateway.latencyMs - direct.latencyMs,
    quality: judged ? qualityLabel(judged) : null,
    judge: judged && {
      score: judged.score,
      preserved: judged.preserved,
      missingFacts: judged.missingFacts,
      rationale: judged.rationale,
      by: judged.by,
    },
  };
  return { row, answers: { id: wl.id, direct: res.direct.answer, gateway: res.gateway.answer } };
}

async function runSuite(cfg, clients, suite, args, counter) {
  const dir = join(cfg.root, suite, 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'compare.json');
  const answersFile = join(dir, 'answers.local.json');
  const rows = args.fresh ? [] : readJson(file, []);
  const answers = args.fresh ? [] : readJson(answersFile, []);
  const keyFacts = readJson(join(cfg.root, 'keyfacts.json'), {});
  const done = new Set(rows.filter((r) => !r.error).map((r) => r.id));

  for (const wl of workloadsFor(cfg, suite, args.only)) {
    const index = counter.index++;
    if (done.has(wl.id)) continue;
    if (counter.ran >= args.limit) break;
    if (wl.skip) {
      console.log(`${suite}/${wl.id}: skipped — ${wl.skip}`);
      continue;
    }
    counter.ran++;
    const request = readJson(join(cfg.root, suite, 'payloads', `${wl.id}.json`));
    let out;
    try {
      out = await compareOne({ cfg, clients, wl, request, keyFacts: keyFacts[wl.id] || {}, index, judge: args.judge });
    } catch (e) {
      out = { row: { id: wl.id, error: e.message }, answers: null };
    }
    const upsert = (list, item) => [...list.filter((r) => r.id !== item.id), item];
    const rowsNext = upsert(rows, out.row);
    rows.splice(0, rows.length, ...rowsNext);
    if (out.answers) answers.splice(0, answers.length, ...upsert(answers, out.answers));
    writeJson(file, rows);
    writeJson(answersFile, answers);

    const r = out.row;
    console.log(
      r.error
        ? `${suite}/${wl.id}: ERROR ${r.error}`
        : `${suite}/${wl.id}: input ${r.direct.input} → ${r.gateway.input} (${r.inputSavedPct}%), ` +
            `cost ${r.costSavedPct ?? '—'}%, +${r.latencyOverheadMs}ms, quality ${r.quality ?? '—'}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const { run } = cfg;
  const clients = {
    direct: new Client({ side: 'direct', url: run.directUrl, auth: run.auth, timeoutMs: run.timeoutMs }),
    gateway: new Client({ side: 'gateway', url: run.gatewayUrl, auth: run.auth, timeoutMs: run.timeoutMs }),
  };
  mkdirSync(join(cfg.root, 'results'), { recursive: true });
  writeJson(join(cfg.root, 'results', 'run-meta.json'), {
    timestamp: new Date().toISOString(),
    model: run.model,
    judgeModel: args.judge ? run.judge.model : null,
    gatewayUrl: run.gatewayUrl,
    directUrl: run.directUrl,
    order: run.order,
  });
  const suites = args.all || !args.suites ? suiteNames(cfg) : args.suites;
  const counter = { index: 0, ran: 0 };
  for (const suite of suites) await runSuite(cfg, clients, suite, args, counter);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}

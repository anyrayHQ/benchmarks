// Render SUMMARY.md — the PUBLIC, customer-facing overview.
//
// Sourced from the committed, reproducible benchmark data: optimized.json (token
// savings) + quality.json (answer-bearing key-fact survival — deterministic substring
// + LLM judge). It is intentionally a savings + quality-preservation OVERVIEW; the
// deeper per-strategy live diagnostics (VERDICTS.md / PIPELINE.md / live runs) are
// internal and gitignored. Numbers are real and reproducible — regenerate with
// `npm run summary` after `npm run bench` / `npm run quality`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames } from './loadConfig.mjs';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

export function renderSummary(cfg = loadConfig()) {
  let totBefore = 0;
  let totAfter = 0;
  let specialCount = 0; // guardrail/special-accounting workloads (cache/OCR/param) — not char reduction
  const perSuite = [];
  const quality = [];

  for (const suite of suiteNames(cfg)) {
    const opt = rd(join(cfg.root, suite, 'results', 'optimized.json')) || [];
    const q = rd(join(cfg.root, suite, 'results', 'quality.json')) || [];
    // Whole-request token-reduction workloads only (tier 'accounting'); guardrail tiers
    // (cache/vision/guardrail/cache-prefix/diagnostic) use special accounting.
    const main = opt.filter((r) => r.tier === 'accounting');
    specialCount += opt.length - main.length;
    if (main.length === 0) {
      quality.push(...q);
      continue;
    }
    const saved = main.map((r) => r.savedPct).filter((n) => typeof n === 'number');
    const before = main.reduce((a, r) => a + (r.beforeTok || 0), 0);
    const after = main.reduce((a, r) => a + (r.afterTok || 0), 0);
    totBefore += before;
    totAfter += after;
    perSuite.push({
      title: cfg.suites[suite]?.title || suite,
      n: main.length,
      medianSaved: median(saved),
      before,
      after,
    });
    quality.push(...q);
  }

  const overallPct = pct(totBefore - totAfter, totBefore);
  const withFacts = quality.filter((r) => r.keyFacts > 0);
  const detPass = withFacts.filter((r) => r.deterministic?.verdict === 'PASS').length;
  const judged = withFacts.filter((r) => r.judge && r.judge.error == null);
  const judgePass = judged.filter((r) => r.judge?.verdict === 'PASS').length;

  const lines = [
    '# Anyray optimizer — results summary',
    '',
    `Across ${perSuite.reduce((a, s) => a + s.n, 0)} synthetic agent/coding workloads, the Anyray ` +
      `optimizer cut input tokens by **${overallPct}% overall** (median ` +
      `${median(perSuite.map((s) => s.medianSaved))}% per workload) while preserving the ` +
      `answer-bearing key facts in **${pct(detPass, withFacts.length)}%** of cases ` +
      `(${pct(judgePass, judged.length)}% confirmed by an LLM judge).`,
    '',
    '## Token savings by workload type',
    '',
    '| Workload type | Workloads | Median input-token reduction |',
    '|---|---:|---:|',
    ...perSuite.map((s) => `| ${s.title} | ${s.n} | ${s.medianSaved}% |`),
    `| **All** | **${perSuite.reduce((a, s) => a + s.n, 0)}** | **${overallPct}% overall** |`,
    '',
    '## Quality preservation',
    '',
    'Quality is measured as **answer-bearing key-fact survival** — for each workload we define ' +
      'the short markers that carry the answer, then check they survive the optimizer’s trim ' +
      '(verbatim substring, plus an LLM judge for meaning).',
    '',
    `- **${detPass}/${withFacts.length}** workloads preserve their key facts (deterministic).`,
    `- **${judgePass}/${judged.length}** confirmed by the LLM judge.`,
    '',
    ...(specialCount
      ? [
          '',
          `_(${specialCount} guardrail workloads — semantic cache, screenshot OCR, runaway-output ` +
            'caps — use special accounting rather than whole-request token reduction and are ' +
            'reported separately.)_',
        ]
      : []),
    '',
    '_Synthetic data only (privacy-preserving). Numbers are reproducible: `npm run bench` ' +
      'then `npm run quality`, then `npm run summary`. See `VALIDATION.md` for methodology._',
  ];

  writeFileSync(join(cfg.root, 'SUMMARY.md'), lines.join('\n') + '\n');
  return { overallPct, workloads: perSuite.reduce((a, s) => a + s.n, 0), detPass, judgePass };
}

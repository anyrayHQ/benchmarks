// Render PIPELINE.md — the deployed-config scorecard from a `--mode pipeline` run.
//
// IMPORTANT framing: pipeline mode measures the WHOLE deployed optimizer config on each
// workload, NOT the per-workload "hero" strategy (some heroes are disabled in the config).
// So this is a "is my stack good as configured?" report; per-strategy attribution needs
// the live.json (per-strategy) run + VERDICTS.md.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames } from './loadConfig.mjs';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

// Checks that can't be validated in single-call pipeline mode (need the per-strategy
// seed/repeat path) — flagged so a FAIL here is not read as a real strategy defect.
const PIPELINE_INVALID_CHECKS = new Set(['cache_hit', 'identical']);

export function renderPipelineSummary(cfg = loadConfig()) {
  const meta = rd(join(cfg.root, 'results', 'run-meta.json'));
  const enabled = new Set(
    (meta?.optimizerConfig?.strategies || [])
      .filter((s) => s.enabled)
      .map((s) => s.kind)
  );

  const rows = [];
  for (const suite of suiteNames(cfg)) {
    for (const r of rd(join(cfg.root, suite, 'results', 'pipeline.json')) || []) {
      rows.push({ suite, ...r });
    }
  }
  rows.sort((a, b) => (a.suite + a.id).localeCompare(b.suite + b.id));

  // Classify each row, accounting for disabled strategies + invalid pipeline checks.
  const classify = (r) => {
    if (r.error) return 'ERROR';
    if (PIPELINE_INVALID_CHECKS.has(r.checkKind)) return 'N/A (check needs per-strategy)';
    if (enabled.size && r.strategy && !enabled.has(r.strategy)) return 'N/A (strategy disabled)';
    return r.quality;
  };

  const fmtSaved = (r) => (r.error ? '—' : `${r.realSavedPct}%`);
  const line = (r) =>
    `| \`${r.suite}/${r.id}\` | \`${r.strategy ?? '?'}\` | ${fmtSaved(r)} | ${classify(r)} | ${r.judge?.score ?? '—'} |`;

  const out = ['# Deployed-config validation (pipeline mode)', ''];
  if (meta) {
    out.push(
      `_Run ${meta.timestamp} · model \`${meta.liveModel}\` · judge \`${meta.judgeModel}\` · ` +
        `enabled strategies: ${[...enabled].join(', ') || '(unknown)'}._`,
      ''
    );
  }
  out.push(
    '> Pipeline mode runs your **whole deployed config** per workload — not the listed ' +
      'hero strategy (several heroes are disabled). For per-strategy verdicts run the ' +
      'per-strategy pass and see `VERDICTS.md`.',
    '',
    '| Workload | Hero (config) | Real saved | Quality | Judge |',
    '|---|---|---:|---|---:|'
  );
  for (const r of rows) out.push(line(r));

  const real = rows.filter((r) => !r.error && classify(r) === r.quality);
  const counts = real.reduce((m, r) => ((m[r.quality] = (m[r.quality] || 0) + 1), m), {});
  const saved = real.map((r) => r.realSavedPct).filter((n) => typeof n === 'number');
  const median = saved.length ? [...saved].sort((a, b) => a - b)[Math.floor((saved.length - 1) / 2)] : 0;
  out.push(
    '',
    '## Summary (real cases only — excludes disabled strategies + pipeline-invalid checks)',
    '',
    `- Quality: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}`,
    `- Median real saved: ${median}% across ${real.length} real cases`,
    `- Excluded: ${rows.length - real.length} (disabled strategies / cache checks that need the per-strategy run)`
  );

  writeFileSync(join(cfg.root, 'PIPELINE.md'), out.join('\n') + '\n');
  return { rows: rows.length, real: real.length, counts, median };
}

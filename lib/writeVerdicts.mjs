// Aggregate the live result files into the per-strategy verdict scorecard (VERDICTS.md).
// Reads each suite's results/live.json, attaches sweep points by workload, and renders
// the synthesized WORKING/TUNE/REWORK table. Run via `npm run verdicts`.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames } from './loadConfig.mjs';
import { synthesize } from './verdict.mjs';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

export function collectRows(cfg = loadConfig()) {
  const rows = [];
  for (const suite of suiteNames(cfg)) {
    const dir = join(cfg.root, suite, 'results');
    if (!existsSync(dir)) continue;
    const live = rd(join(dir, 'live.json')) || [];
    const sweepByWorkload = {};
    for (const f of readdirSync(dir).filter((x) => x.startsWith('sweep-'))) {
      for (const s of rd(join(dir, f)) || []) sweepByWorkload[s.id] = s.points;
    }
    for (const r of live) {
      if (r.error) continue;
      rows.push({ ...r, suite, sweep: sweepByWorkload[r.id] });
    }
  }
  return rows;
}

export function renderVerdicts(cfg = loadConfig()) {
  const rows = collectRows(cfg);
  const verdicts = synthesize(rows, cfg.verdict);
  const order = { REWORK: 0, TUNE: 1, WORKING: 2, 'N/A': 3 };
  verdicts.sort(
    (a, b) => (order[a.verdict] - order[b.verdict]) || a.strategy.localeCompare(b.strategy)
  );
  const meta = rd(join(cfg.root, 'results', 'run-meta.json'));
  const lines = ['# Strategy verdicts', ''];
  if (meta) {
    lines.push(
      `_Generated ${meta.timestamp} · live model \`${meta.liveModel}\` · judge \`${meta.judgeModel}\`._`,
      ''
    );
  }
  lines.push(
    'Verdict per optimizer strategy from live runs (real billed prompt-token savings + ' +
      'answer-vs-answer quality). See `VALIDATION.md` for the methodology.',
    '',
    '| Strategy | Verdict | Real saved (median) | Quality pass-rate | Recommended knob |',
    '|---|---|---:|---:|---|'
  );
  for (const v of verdicts) {
    lines.push(
      `| \`${v.strategy}\` | **${v.verdict}** | ${v.realSavedPct}% | ` +
        `${v.qualityPassRate ?? '—'}${v.qualityPassRate == null ? '' : '%'} | ` +
        `${v.recommendedKnob ? '`' + JSON.stringify(v.recommendedKnob) + '`' : '—'} |`
    );
  }
  lines.push('', `_${verdicts.length} strategies · ${rows.length} workload runs._`);
  writeFileSync(join(cfg.root, 'VERDICTS.md'), lines.join('\n') + '\n');
  return verdicts;
}

#!/usr/bin/env node
// Regenerate the README figures from the committed results — no hand-edited
// numbers. Reads every <suite>/results/{optimized,quality}.json and writes
// light/dark SVGs to assets/. Run: node tools/make-charts.mjs  (npm run charts)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  'agent-ops',
  'code-context',
  'guardrails',
  'logs-and-data',
  'memory-recall',
  'tools-and-rag',
];
const W = 720;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ---- gather from committed results -----------------------------------------
const agg = new Map();
const savedById = new Map();
let totBefore = 0;
let totAfter = 0;
let nWork = 0;
for (const suite of SUITES) {
  const p = join(ROOT, suite, 'results', 'optimized.json');
  if (!existsSync(p)) continue;
  for (const r of JSON.parse(readFileSync(p, 'utf8'))) {
    if (r.tier !== 'accounting') continue; // guardrails report on their own basis
    const a = agg.get(r.strategy) ?? { before: 0, after: 0, n: 0 };
    a.before += r.beforeTok;
    a.after += r.afterTok;
    a.n += 1;
    agg.set(r.strategy, a);
    savedById.set(r.id, r.savedPct);
    totBefore += r.beforeTok;
    totAfter += r.afterTok;
    nWork += 1;
  }
}
const rows = [...agg.entries()]
  .map(([strategy, a]) => ({ strategy, n: a.n, saved: Math.round((1 - a.after / a.before) * 100) }))
  .sort((x, y) => y.saved - x.saved);
const overall = Math.round((1 - totAfter / totBefore) * 100);

const pts = [];
for (const suite of SUITES) {
  const qp = join(ROOT, suite, 'results', 'quality.json');
  if (!existsSync(qp)) continue;
  for (const r of JSON.parse(readFileSync(qp, 'utf8'))) {
    const x = savedById.get(r.id);
    if (x == null || !r.judge) continue;
    pts.push({ id: r.id, x, y: r.judge.coverage, verdict: r.judge.verdict });
  }
}

// ---- chart 1: savings by strategy (horizontal bars) ------------------------
function barChart(theme) {
  const c = {
    light: { text: '#1f2328', sub: '#59636e', bar: '#1a7f5a', track: '#eaeef2', value: '#0f6e56' },
    dark: { text: '#e6edf3', sub: '#9198a1', bar: '#2ea36f', track: '#21262d', value: '#56d4a0' },
  }[theme];
  const labelX = 168;
  const barX = 184;
  const barH = 15;
  const rowH = 28;
  const top = 52;
  const trackW = W - barX - 52;
  const H = top + rows.length * rowH + 16;
  let body =
    `<text x="16" y="26" fill="${c.text}" font-size="16" font-weight="500">Token savings by strategy</text>` +
    `<text x="16" y="44" fill="${c.sub}" font-size="12">${nWork} accounting workloads · ${overall}% overall · tokens at chars/4</text>`;
  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    const bw = Math.max(2, Math.round((trackW * r.saved) / 100));
    body +=
      `<text x="${labelX}" y="${cy + 4}" fill="${c.text}" font-size="13" text-anchor="end">${esc(r.strategy)}</text>` +
      `<rect x="${barX}" y="${cy - barH / 2}" width="${trackW}" height="${barH}" rx="3" fill="${c.track}"/>` +
      `<rect x="${barX}" y="${cy - barH / 2}" width="${bw}" height="${barH}" rx="3" fill="${c.bar}"/>` +
      `<text x="${barX + bw + 6}" y="${cy + 4}" fill="${c.value}" font-size="12" font-weight="500">${r.saved}%</text>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Token savings by Anyray optimizer strategy, ${overall}% overall">` +
    `<title>Token savings by strategy</title>` +
    `<desc>${rows.map((r) => `${esc(r.strategy)} ${r.saved}%`).join(', ')}</desc>` +
    body +
    `</svg>\n`
  );
}

// ---- chart 2: savings vs answer-kept (scatter, colored by judge verdict) ----
function scatter(theme) {
  const c = {
    light: { PASS: '#1a7f5a', MARGINAL: '#bf8700', FAIL: '#cf222e', grid: '#d8dee4', text: '#1f2328', sub: '#59636e' },
    dark: { PASS: '#2ea36f', MARGINAL: '#d4a017', FAIL: '#f85149', grid: '#30363d', text: '#e6edf3', sub: '#9198a1' },
  }[theme];
  const mL = 58;
  const mT = 76;
  const plotH = 220;
  const plotW = W - mL - 20;
  const H = mT + plotH + 46;
  const xs = (v) => mL + (v / 100) * plotW;
  const ys = (v) => mT + plotH - (v / 100) * plotH;
  let g = '';
  for (const t of [0, 25, 50, 75, 100]) {
    g +=
      `<line x1="${xs(t)}" y1="${mT}" x2="${xs(t)}" y2="${mT + plotH}" stroke="${c.grid}" stroke-width="1"/>` +
      `<line x1="${mL}" y1="${ys(t)}" x2="${mL + plotW}" y2="${ys(t)}" stroke="${c.grid}" stroke-width="1"/>` +
      `<text x="${xs(t)}" y="${mT + plotH + 18}" fill="${c.sub}" font-size="11" text-anchor="middle">${t}</text>` +
      `<text x="${mL - 8}" y="${ys(t) + 4}" fill="${c.sub}" font-size="11" text-anchor="end">${t}</text>`;
  }
  g +=
    `<text x="${mL + plotW / 2}" y="${mT + plotH + 38}" fill="${c.sub}" font-size="12" text-anchor="middle">token savings (%)</text>` +
    `<text x="16" y="${mT + plotH / 2}" fill="${c.sub}" font-size="12" text-anchor="middle" transform="rotate(-90 16 ${mT + plotH / 2})">answer kept (%)</text>`;
  for (const p of pts) {
    g += `<circle cx="${xs(p.x).toFixed(1)}" cy="${ys(p.y).toFixed(1)}" r="5.5" fill="${c[p.verdict]}" fill-opacity="0.82"/>`;
  }
  let head =
    `<text x="16" y="26" fill="${c.text}" font-size="16" font-weight="500">Cut the tokens, keep the answer</text>` +
    `<text x="16" y="44" fill="${c.sub}" font-size="12">each dot = one of ${pts.length} workloads · y = Claude Opus 4.8 judge</text>`;
  for (const [k, lab, x] of [['PASS', 'pass', 22], ['MARGINAL', 'marginal', 92], ['FAIL', 'fail', 196]]) {
    head += `<circle cx="${x}" cy="56" r="5" fill="${c[k]}"/><text x="${x + 10}" y="60" fill="${c.sub}" font-size="12">${lab}</text>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Scatter of token savings versus answer kept across ${pts.length} workloads">` +
    `<title>Cut the tokens, keep the answer</title>` +
    `<desc>${pts.map((p) => `${esc(p.id)} ${p.x}% savings ${p.y}% kept ${p.verdict}`).join('; ')}</desc>` +
    g +
    head +
    `</svg>\n`
  );
}

const outDir = join(ROOT, 'assets');
mkdirSync(outDir, { recursive: true });
for (const theme of ['light', 'dark']) {
  writeFileSync(join(outDir, `savings-by-strategy.${theme}.svg`), barChart(theme));
  writeFileSync(join(outDir, `quality-vs-savings.${theme}.svg`), scatter(theme));
}

console.log(
  `wrote 4 svgs to assets/ — ${rows.length} strategies, ${nWork} workloads, ${overall}% overall, ${pts.length} quality points`
);
for (const r of rows) console.log(`  ${r.strategy.padEnd(26)} ${String(r.saved).padStart(3)}%  (n=${r.n})`);

// The local, shareable report page (`report --redact --html`). Built only from the validated body,
// the kit verdict and the run records' content-free fields (costs, turns, check outcomes, the
// exclusion reasons), so it can never reword a verdict or carry client content. Offline by
// construction: no script, no link, no URL, one inline stylesheet and inline SVG.
import { exclusionReasons } from './benchVerdict.mjs';
import { humanRatio, humanInterval, humanVsPrediction } from './kitResults.mjs';

/** Points on the length curve need at least this many pairs, as IntellAgent's chart does. */
export const MIN_CURVE_PAIRS = 5;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'n/a');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One pair as a table row: costs, ratio, turns, both arms' checks, and whether it counted. */
function pairRow(scenarioId, round) {
  const a = round?.sessions?.a?.totals;
  const b = round?.sessions?.b?.totals;
  const reasons = exclusionReasons(round);
  const ratio = Number.isFinite(round?.ratio) ? round.ratio : null;
  const outcome = reasons.length ? 'excluded' : ratio < 1 ? 'saved' : ratio > 1 ? 'cost-more' : 'same';
  const check = (solved) => (solved === true ? 'passed' : solved === false ? 'failed' : 'n/a');
  const status = reasons.length ? `excluded: ${reasons.join(', ')}` : ratio < 1 ? 'cheaper' : ratio > 1 ? 'cost more' : 'same cost';
  const turns = Number.isFinite(a?.turns) ? String(a.turns) : 'n/a';
  return `<tr data-pair data-outcome="${outcome}"><td>${escapeHtml(scenarioId)}</td><td>${escapeHtml(round?.round ?? '')}</td>`
    + `<td>${usd(a?.costUsd)}</td><td>${usd(b?.costUsd)}</td><td>${ratio === null ? 'n/a' : humanRatio(ratio)}</td>`
    + `<td>${turns}</td><td>direct ${check(round?.quality?.a)}, Anyray ${check(round?.quality?.b)}</td><td>${escapeHtml(status)}</td></tr>`;
}

/** Share of pairs cheaper at each session-length threshold that still has enough pairs. */
export function lengthCurve(pairs) {
  const counted = pairs.filter((p) => exclusionReasons(p.round).length === 0 && Number.isFinite(p.round?.sessions?.a?.totals?.turns));
  const thresholds = [...new Set(counted.map((p) => p.round.sessions.a.totals.turns))].sort((x, y) => x - y);
  return thresholds.flatMap((t) => {
    const set = counted.filter((p) => p.round.sessions.a.totals.turns >= t);
    if (set.length < MIN_CURVE_PAIRS) return [];
    const wins = set.filter((p) => p.round.ratio < 1).length;
    return [{ turns: t, pairs: set.length, share: wins / set.length }];
  });
}

function curveSvg(points) {
  const W = 560;
  const H = 220;
  const pad = { l: 44, r: 16, t: 14, b: 34 };
  const xs = points.map((p) => p.turns);
  const lo = Math.min(...xs);
  const span = Math.max(...xs) - lo;
  const x = (t) => pad.l + (span === 0 ? (W - pad.l - pad.r) / 2 : ((t - lo) / span) * (W - pad.l - pad.r));
  const y = (share) => pad.t + (1 - share) * (H - pad.t - pad.b);
  const grid = [0, 0.5, 1].map((g) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${pad.l - 6}" y="${y(g) + 4}" text-anchor="end">${Math.round(g * 100)}%</text>`).join('');
  const line = points.length > 1 ? `<polyline class="curve" points="${points.map((p) => `${x(p.turns)},${y(p.share)}`).join(' ')}"/>` : '';
  const dots = points.map((p) => `<circle cx="${x(p.turns)}" cy="${y(p.share)}" r="4" class="dot"><title>${p.turns}+ turns: ${Math.round(p.share * 100)}% of ${p.pairs} pairs cheaper</title></circle><text x="${x(p.turns)}" y="${H - 14}" text-anchor="middle">${p.turns}+</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of pairs where Anyray was cheaper, by session length">${grid}${line}${dots}<text x="${(W + pad.l) / 2}" y="${H - 1}" text-anchor="middle">Session length (turns, direct arm)</text></svg>`;
}

const STYLE = `
:root{--bg:#fcfcfb;--fg:#1f1e1c;--muted:#6b6a66;--line:#e4e2dc;--card:#fff;--green:#1a7f4b;--red:#b3261e;--green-bg:#e6f4ec;--red-bg:#fbe9e7;--accent:#d97757}
@media (prefers-color-scheme: dark){:root{--bg:#1a1a19;--fg:#ecebe7;--muted:#a3a29c;--line:#3a3935;--card:#2c2c2a;--green:#59c58a;--red:#f1857d;--green-bg:#17352a;--red-bg:#3d1f1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}
.sub{color:var(--muted);margin:0 0 20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.card b{display:block;font-size:24px}.card span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
.wrap{overflow-x:auto}tr[data-outcome=saved] td:nth-child(5){color:var(--green);background:var(--green-bg)}tr[data-outcome=cost-more] td:nth-child(5){color:var(--red);background:var(--red-bg)}tr[data-outcome=excluded]{color:var(--muted)}
svg{width:100%;max-width:560px;height:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}svg text{fill:var(--muted);font-size:11px}.grid{stroke:var(--line)}.curve{fill:none;stroke:var(--accent);stroke-width:2}.dot{fill:var(--accent)}
.note{color:var(--muted);font-size:13px}.bad{color:var(--red)}
`;

/** The page as one string. `records[i]` belongs to `verdict.scenarios[i]`. */
export function renderReportHtml({ body, verdict, records, lock }) {
  const pairs = verdict.scenarios.flatMap((s, i) => (records[i]?.rounds ?? []).map((round) => ({ id: s.id, round })));
  const { direct, anyray } = body.totals.costUsdPerSession;
  const parity = body.scenarios.reduce((sum, s) => (s.parity
    ? { n: sum.n + s.parity.n, passDirect: sum.passDirect + s.parity.passDirect, passAnyray: sum.passAnyray + s.parity.passAnyray, anyrayWorse: sum.anyrayWorse + s.parity.anyrayWorse }
    : sum), { n: 0, passDirect: 0, passAnyray: 0, anyrayWorse: 0 });
  const quality = parity.n
    ? `Anyray passed ${parity.passAnyray} of ${parity.n}, direct ${parity.passDirect} of ${parity.n}${parity.anyrayWorse ? `; <span class="bad">${plural(parity.anyrayWorse, 'pair')} passed only direct</span>` : ''}`
    : 'Not reported by this kit version';
  const scenarioRows = verdict.scenarios.map((s, i) => {
    const b = body.scenarios[i];
    return `<tr><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.source)}</td><td>${escapeHtml(b.shapeId)}</td><td>${escapeHtml(s.rule0)}</td>`
      + `<td>${b.n}</td><td>${pct(b.winRate)}</td><td>${humanRatio(b.median)}</td><td>${humanRatio(b.q3)}</td><td>${humanRatio(b.max)}</td><td>${humanInterval(b.ci95)}</td><td>${escapeHtml(humanVsPrediction(s.vsPrediction))}</td></tr>`;
  }).join('');
  const curve = lengthCurve(pairs);
  const noise = Number.isFinite(lock?.noise?.sd) ? `Run-to-run noise measured before the paired runs: SD ${humanRatio(lock.noise.sd)} of the log cost ratio.` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anyray test report</title><style>${STYLE}</style></head>
<body><main>
<h1>Anyray test report</h1>
<p class="sub">Plan ${escapeHtml(body.planHash.slice(0, 7))} · Claude Code ${escapeHtml(body.clientToolVersion)} · gateway ${escapeHtml(body.gatewayVersion)} · ${escapeHtml(body.model)}</p>
<div class="cards">
<div class="card"><b>${escapeHtml(body.rule0Verdict)}</b><span>Rule 0: a session must never cost more because of us</span></div>
<div class="card"><b>${usd(direct)} vs ${usd(anyray)}</b><span>${direct > 0 ? `Per session, direct vs Anyray: ${Math.round(Math.abs(1 - anyray / direct) * 100)}% ${anyray <= direct ? 'lower' : 'higher'}` : 'Per session, direct vs Anyray'}</span></div>
<div class="card"><b>${body.totals.n} pairs</b><span>${body.totals.excluded} excluded, listed below</span></div>
<div class="card"><b>${parity.n ? `${parity.passAnyray}/${parity.n}` : 'n/a'}</b><span>${quality}</span></div>
</div>
<h2>By scenario</h2>
<div class="wrap"><table><thead><tr><th>Scenario</th><th>Source</th><th>Shape</th><th>Rule 0</th><th>Pairs</th><th>Cheaper</th><th>Median</th><th>Q3</th><th>Worst pair</th><th>95% interval</th><th>Vs prediction</th></tr></thead><tbody>${scenarioRows}</tbody></table></div>
<p class="note">Ratios are Anyray cost divided by direct cost for the same task, pair by pair. Below 1 is cheaper. Rule 0 judges the tail, so Q3 and the worst pair matter as much as the median.</p>
<h2>Savings by session length</h2>
${curve.length ? curveSvg(curve) : `<p class="note">Needs at least ${MIN_CURVE_PAIRS} pairs with recorded turn counts at a length to draw a point. Run more pairs to see where savings hold.</p>`}
<h2>Every pair</h2>
<div class="wrap"><table><thead><tr><th>Scenario</th><th>Round</th><th>Direct</th><th>Anyray</th><th>Ratio</th><th>Turns</th><th>Checks</th><th>Status</th></tr></thead><tbody>${pairs.map((p) => pairRow(p.id, p.round)).join('')}</tbody></table></div>
<p class="note">${escapeHtml(noise)} Task text, repo, diffs and transcripts never leave your machine and are not in this page.</p>
</main></body></html>
`;
}

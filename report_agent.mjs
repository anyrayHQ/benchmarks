#!/usr/bin/env node
// Build results/agent/report.html from results/agent/<scenario>--<compare>.json.
//
// Top: one row per comparison — every round's cost ratio as a dot on a log axis, the
// median tick, the noise band taken from the control rows, and the Rule 0 verdict.
// Below: pick a comparison and a round to see the full detail — repo and files, both
// arms' setup (endpoint, headers, hooks, MCP), what Anyray has turned on and what it
// did, every model request (main agent vs subagents) with cache split and tool calls,
// and each arm's result, check output and diff.
//
// Usage: node report_agent.mjs   (npm run agent:report)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRATEGIES_JS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'strategies.mjs'), 'utf8').replace(/^export /gm, '');

const ROOT = dirname(fileURLToPath(import.meta.url));
const dir = join(ROOT, 'results', 'agent');
const records = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .sort((a, b) => a.scenario.name.localeCompare(b.scenario.name) || (a.compare === 'control' ? -1 : 1));

// Trim bulky fields the page never shows, then embed; `<` escaped for the script tag.
for (const r of records) {
  delete r.scenario.repoInfo?.tree;
  for (const round of r.rounds) for (const s of Object.values(round.sessions ?? {})) s.diffPatch = (s.diffPatch ?? '').slice(0, 8000);
}
const data = JSON.stringify(records).replace(/</g, '\\u003c');

const html = String.raw`<title>Anyray Paired Runs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --bg:#f3f5f7; --panel:#ffffff; --sunk:#eef1f4; --ink:#1b2130; --muted:#5d6676; --line:#dce1e8; --grid:#e8ecf1;
  --a:#6b7488; --a-soft:#e3e7ee; --b:#0e7466; --b-soft:#d6efe9; --band:rgba(107,116,136,.13);
  --good:#1a7f4b; --good-soft:#dff3e7; --warn:#a76a12; --warn-soft:#fbefd9; --bad:#b93a33; --bad-soft:#f9e1df;
  --read:#8aa4c8; --write:#d19a4c; --fresh:#6b7488; --sub:#8a63b8;
  --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --cond:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --bg:#11151b; --panel:#181d25; --sunk:#141920; --ink:#e4e8ee; --muted:#9aa3b2; --line:#2a313c; --grid:#222933;
  --a:#a3adbf; --a-soft:#262d38; --b:#43c2ad; --b-soft:#15332f; --band:rgba(163,173,191,.12);
  --good:#5cc98c; --good-soft:#163324; --warn:#e3a94e; --warn-soft:#3a2c14; --bad:#ef7b72; --bad-soft:#3b1d1b;
  --read:#6f8fbc; --write:#c08a3e; --fresh:#a3adbf; --sub:#b08ee0;
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#11151b; --panel:#181d25; --sunk:#141920; --ink:#e4e8ee; --muted:#9aa3b2; --line:#2a313c; --grid:#222933;
  --a:#a3adbf; --a-soft:#262d38; --b:#43c2ad; --b-soft:#15332f; --band:rgba(163,173,191,.12);
  --good:#5cc98c; --good-soft:#163324; --warn:#e3a94e; --warn-soft:#3a2c14; --bad:#ef7b72; --bad-soft:#3b1d1b;
  --read:#6f8fbc; --write:#c08a3e; --fresh:#a3adbf; --sub:#b08ee0;
}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);padding-inline:16px;padding-block:24px 56px}
main{max-width:1240px;margin:0 auto;display:grid;gap:22px}
h1,h2,h3{font-family:var(--cond);font-weight:600;text-wrap:balance;margin:0}
h1{font-size:26px} h2{font-size:18px}
h3{font-family:var(--sans);font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}
p{margin:0;max-width:72ch;color:var(--muted)}
.mono,code,pre{font-family:var(--mono);font-size:12.5px}
.num{font-variant-numeric:tabular-nums}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.stack{display:grid;gap:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.between{justify-content:space-between}
.muted{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:500;background:var(--sunk);color:var(--muted);border:1px solid var(--line);white-space:nowrap}
.chip.good{background:var(--good-soft);color:var(--good);border-color:transparent}
.chip.warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}
.chip.bad{background:var(--bad-soft);color:var(--bad);border-color:transparent}
.chip.b{background:var(--b-soft);color:var(--b);border-color:transparent}
.chip.a{background:var(--a-soft);color:var(--a);border-color:transparent}
.chip.sub{background:transparent;color:var(--sub);border-color:var(--sub)}
.chart{overflow-x:auto}
.chart svg{display:block;min-width:680px}
svg text{fill:var(--muted);font-family:var(--sans)}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
td.r,th.r{text-align:right}
tr.pick{cursor:pointer}
tr.pick:hover td{background:var(--sunk)}
tr.pick[aria-selected="true"] td{background:var(--b-soft)}
tr.pick:focus-visible{outline:2px solid var(--b);outline-offset:-2px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tab{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);font-weight:500}
.tab[aria-selected="true"]{border-color:var(--b);box-shadow:inset 0 -2px 0 var(--b)}
.tab:focus-visible{outline:2px solid var(--b);outline-offset:2px}
.duo{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:980px){.duo{grid-template-columns:minmax(0,1fr)}}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--panel);padding:11px 13px;display:grid;gap:2px}
.kpi .label{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}
.kpi .v{font-family:var(--cond);font-size:19px;font-weight:600}
.kpi .sub{font-size:12px;color:var(--muted)}
.good-t{color:var(--good)} .bad-t{color:var(--bad)}
.arm-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dot{width:10px;height:10px;border-radius:50%;flex:none}
.dot.a{background:var(--a)} .dot.b{background:var(--b)}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0}
dl.kv dt{color:var(--muted)} dl.kv dd{margin:0;overflow-wrap:anywhere}
.scroll{overflow:auto;max-height:320px;background:var(--sunk);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.req{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;padding:9px 0;border-top:1px solid var(--line)}
.req .n{font-family:var(--cond);font-weight:600;color:var(--muted)}
.bar{display:flex;height:9px;border-radius:3px;overflow:hidden;background:var(--sunk);margin-block:3px}
.bar span{display:block;height:100%}
.bar .read{background:var(--read)} .bar .write{background:var(--write)} .bar .fresh{background:var(--fresh)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
details.call{margin-top:5px;border:1px solid var(--line);border-radius:8px}
details.call summary{cursor:pointer;padding:5px 9px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
details.call pre{margin:0 9px 9px}
.notice{border:1px dashed var(--line);border-radius:8px;padding:10px 12px;color:var(--muted);background:var(--sunk)}
.verdict{font-family:var(--cond);font-weight:600;font-size:15px}
.reasons{margin:0;padding-left:18px;color:var(--muted)}
.step{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:start;border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.step .k{width:22px;height:22px;border-radius:50%;background:var(--ink);color:var(--panel);display:grid;place-items:center;font-size:12px;font-weight:600}
</style>

<main>
  <header class="stack" style="gap:6px">
    <h1>Anyray paired runs</h1>
    <p>Real Claude Code sessions on real repos, free-running with all default tools and subagents allowed. Each round runs the same task in two arms at the same time. A ratio below 1 means arm B was cheaper. The control rows (direct against direct) show how far identical setups drift on their own; a result inside that band cannot be told apart from chance.</p>
  </header>

  <section class="panel stack">
    <div class="row between"><h2>Cost ratio per round, B ÷ A</h2>
      <div class="legend"><span><i style="background:var(--b)"></i>round (Anyray vs direct)</span><span><i style="background:var(--a)"></i>round (control)</span><span><i style="background:var(--ink)"></i>median</span><span><i style="background:var(--band);border:1px solid var(--a)"></i>noise band</span></div></div>
    <div class="chart" id="strip"></div>
    <div class="tablewrap"><table id="summary"></table></div>
  </section>

  <section class="stack">
    <div class="tabs" id="tabs" role="tablist" aria-label="Comparison"></div>
    <div id="detail" class="stack"></div>
  </section>
</main>

<script>
${STRATEGIES_JS}
const RUNS = ${data};
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const usd = (n, d = 3) => (n == null ? '—' : '$' + n.toFixed(d));
const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(0) + ' s');
const x2 = (n) => (n == null ? '—' : n.toFixed(2) + '×');
const NS = 'http://www.w3.org/2000/svg';
// Under --compare gateway both slots go through Anyray; B adds ANYRAY_BENCH_EXTRA_HEADERS.
const armName = (r, key) => r.compare === 'gateway'
  ? 'Through Anyray' + (key === 'b' && r.request?.extraHeaders?.length ? ' + ' + r.request.extraHeaders.join(', ') : ' (baseline)')
  : r.arms[key] === 'anyray' ? 'Through Anyray' : 'Direct';
const label = (r) => r.scenario.name + ({ control: ' · control', gateway: ' · gateway A/B' }[r.compare] ?? ' · Anyray') + (r.label ? ' · ' + r.label : '');
const verdictChip = (v) => '<span class="chip ' + ({ PASS: 'good', FAIL: 'bad', INCONCLUSIVE: 'warn' }[v] || '') + '">' + esc(v) + '</span>';
const okRounds = (r) => r.rounds.filter((x) => !x.error && !x.gatewayRestarted);

function svg(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function text(parent, x, y, s, attrs) { const t = svg('text', Object.assign({ x, y, 'font-size': 12 }, attrs || {}), parent); t.textContent = s; return t; }

function drawStrip() {
  const W = 960, L = 260, R = 20, rowH = 44, T = 26, H = T + RUNS.length * rowH + 28;
  const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': 'Cost ratio per round for each comparison' });
  const lo = Math.log(0.25), hi = Math.log(4), X = (v) => L + ((Math.log(Math.min(4, Math.max(0.25, v))) - lo) / (hi - lo)) * (W - L - R);
  const ctrl = RUNS.filter((r) => r.compare === 'control').flatMap((r) => okRounds(r).map((x) => x.ratio)).filter(Boolean);
  if (ctrl.length > 1) svg('rect', { x: X(Math.min(...ctrl)), y: T - 6, width: X(Math.max(...ctrl)) - X(Math.min(...ctrl)), height: RUNS.length * rowH + 2, style: 'fill:var(--band)' }, s);
  [0.25, 0.5, 1, 2, 4].forEach((v) => { svg('line', { x1: X(v), x2: X(v), y1: T - 8, y2: T + RUNS.length * rowH, style: 'stroke:' + (v === 1 ? 'var(--muted)' : 'var(--grid)') }, s); text(s, X(v), H - 8, v + '×', { 'text-anchor': 'middle', 'font-size': 11 }); });
  text(s, X(0.5), 14, '← B cheaper', { 'text-anchor': 'middle', 'font-size': 11 });
  text(s, X(2), 14, 'B costs more →', { 'text-anchor': 'middle', 'font-size': 11 });
  RUNS.forEach((r, i) => {
    const y = T + i * rowH + rowH / 2;
    if (i) svg('line', { x1: 0, x2: W, y1: T + i * rowH, y2: T + i * rowH, style: 'stroke:var(--grid)' }, s);
    text(s, 0, y - 3, label(r), { 'font-size': 13, style: 'fill:var(--ink)' });
    text(s, 0, y + 13, 'n=' + (r.stats?.n ?? 0) + ' · ' + (r.stats?.verdict ?? ''), { 'font-size': 11 });
    okRounds(r).forEach((x, k) => {
      if (x.ratio == null) return;
      const c = svg('circle', { cx: X(x.ratio), cy: y + ((k % 3) - 1) * 6, r: 5.5, style: 'fill:' + (r.compare === 'control' ? 'var(--a)' : 'var(--b)') + ';stroke:var(--panel);stroke-width:2' }, s);
      svg('title', {}, c).textContent = 'Round ' + x.round + ': ' + x.ratio.toFixed(3) + '× (' + usd(x.sessions.b.totals.costUsd) + ' vs ' + usd(x.sessions.a.totals.costUsd) + ')';
    });
    if (r.stats?.median != null) svg('line', { x1: X(r.stats.median), x2: X(r.stats.median), y1: y - 12, y2: y + 12, style: 'stroke:var(--ink);stroke-width:2.5;stroke-linecap:round' }, s);
  });
  $('#strip').replaceChildren(s);

  $('#summary').innerHTML = '<thead><tr><th>Comparison</th><th class="r">Rounds</th><th class="r">B wins</th><th class="r">Median</th><th class="r">Q3</th><th class="r">Max</th><th class="r">Solved A / B</th><th>Rule 0</th><th>Strategies on in the gateway</th><th>What worked</th></tr></thead><tbody>' +
    RUNS.map((r) => { const st = r.stats || {}; return '<tr><td>' + esc(label(r)) + '</td><td class="r">' + int(st.n) + '</td><td class="r">' + (st.n ? st.wins + '/' + st.n : '—') + '</td><td class="r">' + x2(st.median) + '</td><td class="r">' + x2(st.q3) + '</td><td class="r">' + x2(st.max) + '</td><td class="r">' + (st.n ? st.solvedA + ' / ' + st.solvedB : '—') + '</td><td>' + (r.compare === 'control' ? '<span class="chip">noise reference</span>' : verdictChip(st.verdict)) + '</td>' +
      (r.compare === 'control' ? '<td class="muted">not used (direct)</td><td class="muted">—</td>' : '<td>' + onChips(roundOpt(r, okRounds(r).at(-1))) + '</td><td>' + workedChips(allTraces(r), okRounds(r).some((x) => x.traces?.traces)) + '</td>') + '</tr>'; }).join('') + '</tbody>';
}

const allTraces = (r) => okRounds(r).flatMap((x) => x.traces?.traces ?? []);
const roundOpt = (r, round) => round?.optimizerConfig?.strategies ? round.optimizerConfig : r.anyray?.optimizerConfig;
const NEEDS_KEY = '<span class="muted">needs ANYRAY_ADMIN_KEY</span>';
const VERDICT_CLS = { worked: 'good', 'held by guard': 'warn', 'stood down': 'warn', 'on, never fired': '', off: '' };

function onChips(opt) {
  const eff = effectiveStrategies(opt);
  if (!eff) return NEEDS_KEY;
  const on = eff.filter((x) => x.on);
  return '<span class="num">' + on.length + ' of ' + eff.length + '</span> ' + on.map((x) => '<span class="chip ' + (x.source.startsWith('rule') ? 'b' : '') + '" title="' + esc(x.source) + '">' + esc(x.kind) + '</span>').join(' ');
}
function workedChips(traces, haveTraces) {
  if (!haveTraces) return NEEDS_KEY;
  const w = strategyOutcomes(traces).filter((o) => o.saved);
  return w.length ? w.map((o) => '<span class="chip good">' + esc(o.kind) + ' −' + int(o.tokens) + '</span>').join(' ') : '<span class="muted">nothing saved</span>';
}

function strategyPanel(r, round) {
  const opt = roundOpt(r, round);
  const haveTraces = !!round?.traces?.traces;
  if (!opt?.strategies && !haveTraces) {
    return '<div class="notice">Which strategies were on, and what each one did, comes from the gateway admin API. Set <span class="mono">ANYRAY_ADMIN_KEY</span> (an aak_ key with optimizer:read and traces:read) and re-run to fill this in.' + (round ? ' This round\'s requests are in the console under session <span class="mono">' + esc(round.runTag.sessionId) + '</span>.' : '') + '</div>';
  }
  const rows = strategyTable(opt, round?.traces?.traces ?? []);
  return '<div class="tablewrap"><table><thead><tr><th>Strategy</th><th>On for this test</th><th class="r">Requests it acted on</th><th class="r">Saved on</th><th class="r">Tokens saved</th><th>Result</th><th>Why it stood down</th></tr></thead><tbody>' +
    rows.map((x) => '<tr><td class="mono">' + esc(x.kind) + '</td><td>' + (x.on == null ? '<span class="muted">?</span>' : x.on ? '<span class="chip ' + (x.source.startsWith('rule') ? 'b' : 'good') + '">on · ' + esc(x.source) + '</span>' : '<span class="chip">off</span>') + '</td>' +
      '<td class="r">' + (haveTraces ? int(x.outcome?.requests ?? 0) : '—') + '</td><td class="r">' + (haveTraces ? int(x.outcome?.saved ?? 0) : '—') + '</td><td class="r ' + (x.outcome?.tokens ? 'good-t' : '') + '">' + (haveTraces ? (x.outcome?.tokens ? '−' + int(x.outcome.tokens) : '0') : '—') + '</td>' +
      '<td>' + (haveTraces ? '<span class="chip ' + (VERDICT_CLS[x.verdict] ?? '') + '">' + esc(x.verdict) + '</span>' : '<span class="muted">needs traces:read</span>') + '</td>' +
      '<td class="muted">' + esc((x.outcome?.reasons ?? []).join(' · ')) + (x.outcome?.guard ? ' guard held it ' + x.outcome.guard + '×' : '') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function setupCard(r, key) {
  const s = r.setup[key];
  const hooks = Object.entries(s.hooks || {});
  const mcp = Object.entries(s.mcpServers || {});
  const headers = Object.entries(s.headers || {});
  const cls = key === 'b' && s.arm === 'anyray' ? 'b' : 'a';
  return '<div class="panel"><div class="arm-h"><span class="dot ' + cls + '"></span><h2>' + key.toUpperCase() + ' · ' + armName(r, key) + '</h2></div><dl class="kv">' +
    '<dt>Client</dt><dd>' + esc(s.client) + '</dd><dt>Model</dt><dd class="mono">' + esc(s.model) + '</dd>' +
    '<dt>Endpoint</dt><dd class="mono">' + esc(s.endpoint) + '</dd><dt>Auth</dt><dd>' + esc(s.auth) + '</dd>' +
    '<dt>Headers</dt><dd>' + (headers.length ? headers.map(([k, v]) => '<div class="mono">' + esc(k) + ': ' + esc(typeof v === 'string' ? v : JSON.stringify(v)) + '</div>').join('') : '<span class="muted">none</span>') + '</dd>' +
    '<dt>Tools</dt><dd>' + esc(s.tools) + '</dd>' +
    '<dt>MCP servers</dt><dd>' + (mcp.length ? mcp.map(([k, v]) => '<span class="chip b">' + esc(k) + '</span> <span class="mono muted">' + esc(v.command || v.url) + '</span>').join('<br>') : '<span class="muted">none</span>') + '</dd>' +
    (s.clientSide ? '<dt>Client side</dt><dd>' + esc(s.clientSide) + '</dd>' : '') +
    '<dt>Hooks</dt><dd>' + (hooks.length ? hooks.map(([e, c]) => '<div><span class="mono">' + esc(e) + '</span> <span class="mono muted">' + esc(c.join(', ')) + '</span></div>').join('') : '<span class="muted">none</span>') + '</dd>' +
    '<dt>Settings</dt><dd class="muted">' + esc(s.settingSources) + '</dd><dt>Turn cap</dt><dd class="num">' + esc(s.maxTurns) + '</dd></dl></div>';
}

function anyrayCard(r, round) {
  const a = r.anyray || {};
  const pol = a.connectPolicy || {}, opt = a.optimizerConfig || {}, tr = round?.traces || {};
  const trimmed = round ? round.sessions.b.requests.flatMap((q) => q.blocks).filter((b) => b.type === 'tool_use' && b.result?.trimmedByAnyrayHook) : [];
  const on = '<div class="stack"><h3>Turned on</h3>' +
    '<div><b>Client hooks</b> <span class="muted">anyray-connect on this machine</span><div class="row" style="margin-top:4px"><span class="chip ' + (pol.hooks?.digest === 'on' ? 'good' : '') + '">tool-output digest: ' + esc(pol.hooks?.digest ?? '?') + '</span></div></div>' +
    '<div><b>MCP</b><div class="row" style="margin-top:4px"><span class="chip b">anyray: retrieve / recall</span></div></div>' +
    '<div><b>Gateway optimizer</b> <span class="muted">org config</span><div style="margin-top:4px">' +
    (opt.strategies ? '<div class="row">' + opt.strategies.map((s) => '<span class="chip ' + (s.enabled ? 'good' : '') + '">' + esc(s.kind) + (s.enabled ? '' : ' · off') + '</span>').join('') + '</div>' : '<div class="notice">Not visible: ' + esc(opt.unavailable) + '.</div>') + '</div></div></div>';
  let did = '<div class="stack"><h3>What it did' + (round ? ' in round ' + round.round : '') + '</h3>' +
    '<div><b>Client hook</b>: ' + (trimmed.length ? trimmed.length + ' tool result(s) trimmed' : '<span class="muted">trimmed no tool output</span>') + '</div>';
  if (tr.traces) {
    did += tr.traces.map((t, i) => '<div class="panel" style="padding:10px"><div class="row between"><b>Request ' + (i + 1) + '</b><span class="muted num">' + int(t.promptTokens) + ' in · saved ' + int(t.estimatedTokensSaved) + '</span></div><div class="stack" style="gap:6px;margin-top:6px">' +
      (t.decisions.length ? t.decisions.map((d, j) => '<div class="step"><span class="k">' + (j + 1) + '</span><div><b>' + esc(d.kind) + '</b>' + (d.router ? ' <span class="chip">' + esc(d.router) + '</span>' : '') + '<div class="muted">' + esc(d.summary || '') + '</div></div><span class="num ' + (d.estimatedTokensSaved > 0 ? 'good-t' : 'muted') + '">' + (d.estimatedTokensSaved > 0 ? '−' + int(d.estimatedTokensSaved) : '—') + '</span></div>').join('') : '<span class="muted">no decisions</span>') + '</div></div>').join('');
  } else {
    did += '<div class="notice">Gateway pipeline not visible: ' + esc(tr.unavailable || 'no round selected') + '.' + (round ? ' Find it in the console under session <span class="mono">' + esc(round.runTag.sessionId) + '</span>.' : '') + '</div>';
  }
  did += '</div>';
  return '<div class="panel stack"><div class="arm-h"><span class="dot b"></span><h2>Anyray optimizations</h2></div><div class="duo">' + on + did + '</div></div>';
}

function requestsCard(r, round, key) {
  const s = round.sessions[key];
  const max = Math.max(...['a', 'b'].flatMap((k) => round.sessions[k].requests.map((q) => q.inputTotal || 0)), 1);
  const rows = s.requests.map((q, i) => {
    const u = q.usage || {};
    const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0, fresh = u.input_tokens || 0;
    const w = (n) => (100 * n) / max + '%';
    const calls = q.blocks.filter((b) => b.type === 'tool_use').map((b) => {
      const res = b.result || {};
      const inp = b.input?.command || b.input?.file_path || b.input?.pattern || b.input?.description || JSON.stringify(b.input);
      return '<details class="call"><summary><span class="chip' + (b.name === 'Task' ? ' sub' : '') + '">' + esc(b.name) + '</span><span class="mono">' + esc(String(inp).slice(0, 80)) + '</span><span class="muted num">' + int(res.chars) + ' chars</span>' +
        (res.trimmedByAnyrayHook ? '<span class="chip b">trimmed by Anyray</span>' : '') + (res.isError ? '<span class="chip bad">error</span>' : '') + '</summary><pre class="scroll">' + esc(res.preview) + '</pre></details>';
    }).join('');
    const sub = q.agent !== 'main' ? '<span class="chip sub">subagent: ' + esc(q.agentLabel) + '</span>' : '';
    return '<div class="req"><span class="n num">' + (i + 1) + '</span><div><div class="row between"><span class="row"><span class="num">' + int(q.inputTotal) + ' input tok</span>' + sub + '</span><span class="muted num">' + usd(q.inputCostUsd, 4) + ' input</span></div>' +
      '<div class="bar"><span class="read" style="width:' + w(read) + '"></span><span class="write" style="width:' + w(write) + '"></span><span class="fresh" style="width:' + w(fresh) + '"></span></div>' +
      '<div class="muted num" style="font-size:12px">read ' + int(read) + ' · write ' + int(write) + ' · uncached ' + int(fresh) + '</div>' + calls + '</div></div>';
  }).join('');
  const t = s.totals;
  const cls = key === 'b' && r.arms.b === 'anyray' ? 'b' : 'a';
  return '<div class="panel"><div class="arm-h"><span class="dot ' + cls + '"></span><h2>' + key.toUpperCase() + ' · ' + armName(r, key) + '</h2></div>' +
    '<div class="muted num">' + t.turns + ' turns · ' + t.requests + ' model requests · ' + t.subagents + ' subagents (' + Math.round(t.subagentInputShare * 100) + '% of input cost) · ' + t.toolCalls + ' tool calls' + (t.hookTrimmed ? ' · ' + t.hookTrimmed + ' trimmed' : '') + '</div>' + rows + '</div>';
}

function resultCard(r, round, key) {
  const s = round.sessions[key];
  const cls = key === 'b' && r.arms.b === 'anyray' ? 'b' : 'a';
  const ok = round.quality[key];
  return '<div class="panel stack"><div class="arm-h"><span class="dot ' + cls + '"></span><h2>' + key.toUpperCase() + ' · ' + armName(r, key) + '</h2><span class="chip ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'solved' : 'not solved') + '</span></div>' +
    (r.scenario.check ? '<div><h3>Check · <span class="mono">' + esc(r.scenario.check) + '</span></h3><pre class="scroll" style="max-height:140px">' + esc(s.check?.output || '') + '</pre></div>' : '') +
    (s.citations ? '<div><h3>Citations</h3><div class="num">' + s.citations.resolved + ' of ' + s.citations.total + ' path:line citations resolve to real lines' + (s.citations.unresolved.length ? '<div class="muted mono">unresolved: ' + esc(s.citations.unresolved.join(', ')) + '</div>' : '') + '</div></div>' : '') +
    (s.diff ? '<div><h3>Changes it made</h3><pre class="scroll" style="max-height:220px">' + esc(s.diffPatch || s.diff) + '</pre></div>' : '<div class="muted">No file changes.</div>') +
    '<div><h3>Final answer</h3><pre class="scroll">' + esc(s.result?.text) + '</pre></div>' +
    '<div class="muted num">' + usd(s.totals.costUsd, 4) + ' · ' + int(s.totals.input) + ' in · ' + int(s.totals.output) + ' out · ' + secs(s.totals.wallMs) + ' · models: ' + esc(s.totals.models.join(', ')) + '</div></div>';
}

function kpi(labelText, a, b, fmt, lowerIsBetter = true) {
  const d = a && b != null ? (b - a) / a : null;
  const cls = d == null || Math.abs(d) < 0.001 ? 'muted' : (d < 0) === lowerIsBetter ? 'good-t' : 'bad-t';
  return '<div class="kpi"><span class="label">' + labelText + '</span><span class="v num">' + fmt(a) + ' → ' + fmt(b) + '</span><span class="sub num ' + cls + '">' + (d == null ? '' : (d > 0 ? '+' : '−') + Math.abs(d * 100).toFixed(1) + '%') + '</span></div>';
}

let cur = 0, curRound = 0;
function renderTabs() {
  $('#tabs').innerHTML = RUNS.map((r, i) => '<button class="tab" role="tab" data-i="' + i + '" aria-selected="' + (i === cur) + '">' + esc(label(r)) + '</button>').join('');
}
function renderDetail() {
  const r = RUNS[cur];
  const rounds = okRounds(r);
  const round = rounds[curRound] || rounds[0];
  const repo = r.scenario.repoInfo || {};
  let h = '<section class="panel stack"><div class="row between"><div class="stack" style="gap:2px"><h2>' + esc(r.scenario.title) + '</h2><span class="muted mono">' + esc(repo.git) + ' @ ' + esc((repo.ref || '').slice(0, 10)) + (repo.patch ? ' + ' + esc(repo.patch) : '') + '</span></div>' +
    (r.compare === 'control' ? '<span class="chip">noise reference</span>' : '<span class="row"><span class="verdict">Rule 0</span>' + verdictChip(r.stats?.verdict) + '</span>') + '</div>' +
    (r.stats?.reasons?.length && r.compare !== 'control' ? '<ul class="reasons">' + r.stats.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<div class="duo"><div class="stack"><h3>Task</h3><pre class="scroll">' + esc(r.scenario.task) + '</pre>' +
      '<h3>How it is graded</h3><div>' + (r.scenario.check ? 'Solved when <span class="mono">' + esc(r.scenario.check) + '</span> passes in the session\'s checkout afterwards.' : r.scenario.citations ? 'Solved when the answer cites at least ' + r.scenario.citations.min + ' path:line locations and ' + Math.round((r.scenario.citations.resolveRate ?? 0.9) * 100) + '% of them resolve to real lines.' : 'Solved when the final answer contains every one of: ' + (r.scenario.keyFacts || []).map((f) => '<span class="chip mono">' + esc(f) + '</span>').join(' ')) + '</div></div>' +
    '<div class="stack"><h3>Files the agent can reach</h3><div class="muted num">' + int(repo.files) + ' files · ' + int(repo.lines) + ' lines, a fresh checkout per arm</div><div class="tablewrap"><table><thead><tr><th>Type</th><th class="r">Files</th><th class="r">Lines</th></tr></thead><tbody>' +
      (repo.byExt || []).map(([e, v]) => '<tr><td class="mono">' + esc(e) + '</td><td class="r">' + int(v.files) + '</td><td class="r">' + int(v.lines) + '</td></tr>').join('') + '</tbody></table></div></div></div></section>';

  h += '<section class="stack"><h3>Harness setup</h3><div class="duo">' + setupCard(r, 'a') + setupCard(r, 'b') + '</div></section>';

  h += '<section class="panel stack"><div class="row between"><h2>Rounds</h2><span class="muted">Select a round to inspect it.</span></div><div class="tablewrap"><table><thead><tr><th>Round</th><th class="r">Cost A → B</th><th class="r">Ratio</th><th class="r">Turns A → B</th><th class="r">Subagents A → B</th><th class="r">Input A → B</th><th>Solved A / B</th>' + (r.compare !== 'control' ? '<th>Saved by</th>' : '') + '</tr></thead><tbody>' +
    rounds.map((x, k) => { const a = x.sessions.a.totals, b = x.sessions.b.totals; return '<tr class="pick" tabindex="0" data-k="' + k + '" aria-selected="' + (x === round) + '"><td class="num">' + x.round + '</td><td class="r">' + usd(a.costUsd) + ' → ' + usd(b.costUsd) + '</td><td class="r ' + (x.ratio < 0.999 ? 'good-t' : x.ratio > 1.001 ? 'bad-t' : '') + '">' + x2(x.ratio) + '</td><td class="r">' + a.turns + ' → ' + b.turns + '</td><td class="r">' + a.subagents + ' → ' + b.subagents + '</td><td class="r">' + int(a.input) + ' → ' + int(b.input) + '</td><td>' + (x.quality.a ? '✓' : '✕') + ' / ' + (x.quality.b ? '✓' : '✕') + '</td>' + (r.compare !== 'control' ? '<td>' + workedChips(x.traces?.traces ?? [], !!x.traces?.traces) + '</td>' : '') + '</tr>'; }).join('') + '</tbody></table></div></section>';

  if (!round) { $('#detail').innerHTML = h; return; }
  const a = round.sessions.a.totals, b = round.sessions.b.totals;
  h += '<section class="panel stack"><h2>Round ' + round.round + '</h2><div class="kpis">' +
    kpi('Cost', a.costUsd, b.costUsd, (n) => usd(n)) + kpi('Input tokens', a.input, b.input, int) + kpi('Output tokens', a.output, b.output, int) +
    kpi('Turns', a.turns, b.turns, int) + kpi('Subagents', a.subagents, b.subagents, int) + kpi('Wall time', a.wallMs, b.wallMs, secs) + '</div>' +
    '<div class="legend"><span><i style="background:var(--read)"></i>cache read (0.1×)</span><span><i style="background:var(--write)"></i>cache write (2× for 1h)</span><span><i style="background:var(--fresh)"></i>uncached input</span><span><i style="background:var(--sub)"></i>subagent request</span></div></section>';
  if (r.compare !== 'control') {
    h += anyrayCard(r, round);
    h += '<section class="panel stack"><div class="row between"><h2>Gateway strategies in round ' + round.round + '</h2><span class="muted">On for this test, and what each one did across the round\'s requests</span></div>' + strategyPanel(r, round) + '</section>';
  }
  h += '<section class="stack"><h3>Model requests, in order</h3><div class="duo">' + requestsCard(r, round, 'a') + requestsCard(r, round, 'b') + '</div></section>';
  h += '<section class="stack"><h3>Result</h3><div class="duo">' + resultCard(r, round, 'a') + resultCard(r, round, 'b') + '</div></section>';
  $('#detail').innerHTML = h;
}

drawStrip();
renderTabs();
renderDetail();
$('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (!t) return; cur = Number(t.dataset.i); curRound = 0; renderTabs(); renderDetail(); });
$('#detail').addEventListener('click', (e) => { const t = e.target.closest('tr.pick'); if (!t) return; curRound = Number(t.dataset.k); renderDetail(); });
$('#detail').addEventListener('keydown', (e) => { const t = e.target.closest('tr.pick'); if (!t || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); curRound = Number(t.dataset.k); renderDetail(); });
</script>
`;

writeFileSync(join(dir, 'report.html'), html);
console.log(`Wrote results/agent/report.html — ${records.length} comparison(s)`);

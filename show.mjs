#!/usr/bin/env node
// Walk through ONE workload end to end, human-readable: the prompt as sent, what each
// side billed, both answers, the judge's verdict and the cost difference.
//
// Anyray is a black box here, so the prompt it forwarded upstream is not observable:
// its effect shows up only as the billed input-token delta. Both sides receive the
// identical prompt printed below.
//
// Usage: node show.mjs <suite>/<workload> [--full]
//   --full   print every message body in full instead of a head/tail excerpt

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/loadConfig.mjs';
import { Client } from './lib/client.mjs';
import { compareOne } from './run.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const full = args.includes('--full');
if (!target?.includes('/')) {
  console.error('usage: node show.mjs <suite>/<workload> [--full]');
  process.exit(2);
}
const [suite, id] = target.split('/');

const cfg = loadConfig();
const wl = (cfg.suites[suite]?.workloads ?? []).find((w) => w.id === id);
if (!wl) throw new Error(`no workload ${target}`);
if (wl.skip) throw new Error(`${target} is skipped: ${wl.skip}`);
const request = JSON.parse(readFileSync(join(cfg.root, suite, 'payloads', `${id}.json`), 'utf8'));
const keyFacts = JSON.parse(readFileSync(join(cfg.root, 'keyfacts.json'), 'utf8'))[id] ?? {};

const rule = (t) => `\n${'━'.repeat(4)} ${t} ${'━'.repeat(Math.max(4, 76 - t.length))}`;
const int = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const usd = (n) => (n == null ? '—' : `$${n.toFixed(5)}`);

/** Head/tail excerpt of a long body, with its size, unless --full. */
function excerpt(text, head = 12, tail = 4) {
  const lines = String(text).split('\n');
  const size = `${int(String(text).length)} chars, ${int(lines.length)} lines`;
  if (full || lines.length <= head + tail + 2) return { body: String(text), size };
  const cut = lines.length - head - tail;
  return {
    body: [...lines.slice(0, head), `      … ${int(cut)} more lines …`, ...lines.slice(-tail)].join('\n'),
    size,
  };
}

function blockText(b) {
  if (typeof b === 'string') return b;
  if (b.type === 'text') return b.text;
  if (b.type === 'tool_use') return `[tool_use ${b.name}] ${JSON.stringify(b.input)}`;
  if (b.type === 'tool_result') {
    const c = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('');
    return `[tool_result${b.is_error ? ' ERROR' : ''}]\n${c}`;
  }
  if (b.type === 'thinking') return `[thinking] ${b.thinking}`;
  return `[${b.type}]`;
}

function printPrompt(req) {
  const msgs = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  msgs.push(...(req.messages ?? []));
  msgs.forEach((m, i) => {
    const parts = Array.isArray(m.content) ? m.content.map(blockText) : [m.content ?? ''];
    for (const tc of m.tool_calls ?? []) parts.push(`[tool_call ${tc.function?.name}] ${tc.function?.arguments}`);
    const { body, size } = excerpt(parts.filter(Boolean).join('\n'));
    const who = m.role === 'tool' ? `tool (${m.name ?? m.tool_call_id})` : m.role;
    console.log(`\n  #${i + 1} ${who} · ${size}`);
    console.log(body.replace(/^/gm, '    │ '));
  });
  if (req.tools?.length) {
    const names = req.tools.map((t) => t.function?.name ?? t.name);
    console.log(`\n  tools (${names.length}): ${names.join(', ')} · ${int(JSON.stringify(req.tools).length)} chars of schema`);
  }
}

const { run, pricing } = cfg;
const clients = {
  direct: new Client({ side: 'direct', url: run.directUrl, auth: run.auth, timeoutMs: run.timeoutMs }),
  gateway: new Client({ side: 'gateway', url: run.gatewayUrl, auth: run.auth, timeoutMs: run.timeoutMs }),
};

console.log(rule(`${target} — ${wl.title}`));
console.log(`model ${run.model} · direct ${run.directUrl} · gateway ${run.gatewayUrl}`);
console.log(`question: ${keyFacts.question ?? wl.title}`);
if (keyFacts.keyFacts?.length) console.log(`key facts: ${keyFacts.keyFacts.map((f) => JSON.stringify(f)).join(' · ')}`);

console.log(rule('PROMPT (identical on both sides)'));
printPrompt(request);

process.stdout.write('\nsending to both sides and judging…');
const { row, answers } = await compareOne({ cfg, clients, wl, request, keyFacts, index: 0, judge: true });
process.stdout.write(' done\n');

const d = row.direct;
const g = row.gateway;
const diff = (a, b) => (a == null || b == null ? '—' : `${b - a > 0 ? '+' : ''}${int(b - a)}`);
const diffUsd = (a, b) => (a == null || b == null ? '—' : `${b - a > 0 ? '+' : '−'}$${Math.abs(b - a).toFixed(5)}`);

console.log(rule('WHAT THE PROVIDER BILLED'));
const rows = [
  ['', 'without Anyray', 'with Anyray', 'difference'],
  ['input tokens', int(d.input), int(g.input), `${diff(d.input, g.input)} (${row.inputSavedPct ?? '—'}% saved)`],
  ['  of which cache reads', int(d.cacheRead), int(g.cacheRead), ''],
  ['  of which cache writes', int(d.cacheWrite), int(g.cacheWrite), ''],
  ['output tokens', int(d.output), int(g.output), diff(d.output, g.output)],
  ['cost', usd(d.costUsd), usd(g.costUsd), `${diffUsd(d.costUsd, g.costUsd)} (${row.costSavedPct ?? '—'}% saved)`],
  ['latency', `${int(d.latencyMs)} ms`, `${int(g.latencyMs)} ms`, `${diff(d.latencyMs, g.latencyMs)} ms`],
  ['stop reason', d.finishReason, g.finishReason, ''],
];
const w = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => String(r[c] ?? '').length)));
for (const r of rows) console.log('  ' + r.map((v, c) => (c === 0 ? String(v).padEnd(w[c]) : String(v ?? '').padStart(w[c]))).join('   '));

for (const [label, text] of [['ANSWER — without Anyray (direct)', answers.direct], ['ANSWER — with Anyray (gateway)', answers.gateway]]) {
  console.log(rule(label));
  console.log(text.replace(/^/gm, '  '));
}

console.log(rule(`VERDICT: ${row.quality} (${row.judge.score}/100, judged by ${row.judge.by})`));
if (row.judge.missingFacts.length) console.log(`  missing: ${row.judge.missingFacts.join(' · ')}`);
console.log(`  ${row.judge.rationale}`);

const out = join(cfg.root, 'results', 'show');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${suite}__${id}.json`), JSON.stringify({ row, answers }, null, 2) + '\n');
console.log(`\nfull record: results/show/${suite}__${id}.json`);

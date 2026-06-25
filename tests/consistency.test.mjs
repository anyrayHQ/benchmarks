// Docs ↔ data consistency — the honesty enforcer.
//
// The README's promise is "every number reproducible / no hand-edited numbers".
// This test makes that enforceable: it recomputes every headline figure from the
// committed results JSON and asserts the published markdown actually shows that
// recomputed value. No magic constants live here — the numbers come from the data,
// and a doc that drifts from the data fails CI. Needs no optimizer (reads the
// committed scores), so it runs anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estTokens, savedPct } from '../lib/tokens.mjs';
import { verdictFor } from '../lib/quality.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = ['agent-ops', 'code-context', 'guardrails', 'logs-and-data', 'memory-recall', 'tools-and-rag'];

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const doc = (name) => readFileSync(join(ROOT, name), 'utf8');
const fmt = (n) => n.toLocaleString('en-US'); // 290489 -> "290,489"
const rowsFrom = (file) =>
  SUITES.flatMap((s) => {
    const p = join(ROOT, s, 'results', file);
    return existsSync(p) ? readJson(p).map((r) => ({ ...r, suite: s })) : [];
  });

const accounting = () => rowsFrom('optimized.json').filter((r) => r.tier === 'accounting');
const quality = () => rowsFrom('quality.json');

function aggregate(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const a = m.get(r[key]) ?? { before: 0, after: 0, n: 0 };
    a.before += r.beforeTok;
    a.after += r.afterTok;
    a.n += 1;
    m.set(r[key], a);
  }
  for (const a of m.values()) a.pct = savedPct(a.before, a.after);
  return m;
}

function tally(verdicts) {
  const t = { PASS: 0, MARGINAL: 0, FAIL: 0 };
  for (const v of verdicts) t[v] += 1;
  return t;
}

test('every accounting row: tokens and savedPct derive from chars', () => {
  for (const r of accounting()) {
    const where = `${r.suite}/${r.id}`;
    assert.equal(r.beforeTok, estTokens(r.beforeChars), `${where} beforeTok`);
    assert.equal(r.afterTok, estTokens(r.afterChars), `${where} afterTok`);
    assert.equal(r.savedPct, savedPct(r.beforeChars, r.afterChars), `${where} savedPct`);
  }
});

test('README headline numbers match the committed results', () => {
  const rows = accounting();
  const before = rows.reduce((s, r) => s + r.beforeTok, 0);
  const after = rows.reduce((s, r) => s + r.afterTok, 0);
  const pct = savedPct(before, after);
  const md = doc('README.md');
  assert.ok(md.includes(`${rows.length} real-world workloads`), `README must say "${rows.length} real-world workloads"`);
  assert.ok(md.includes(fmt(before)), `README must show before total ${fmt(before)}`);
  assert.ok(md.includes(fmt(after)), `README must show after total ${fmt(after)}`);
  assert.ok(md.includes(`${pct}%`), `README must show overall ${pct}%`);
});

test('README per-suite table matches the committed results', () => {
  const md = doc('README.md');
  for (const [suite, v] of aggregate(accounting(), 'suite')) {
    const cell = `\`${suite}/\`](${suite}/) | ${v.n} | ${fmt(v.before)} | ${fmt(v.after)} | **${v.pct}%**`;
    assert.ok(md.includes(cell), `README per-suite row drifted for ${suite}: expected "${cell}"`);
  }
});

test('RESULTS savings-by-strategy table matches the committed results', () => {
  const md = doc('RESULTS.md');
  for (const [strategy, v] of aggregate(accounting(), 'strategy')) {
    const cell = `\`${strategy}\` | ${v.n} | ${fmt(v.before)} | ${fmt(v.after)} | **${v.pct}%**`;
    assert.ok(md.includes(cell), `RESULTS per-strategy row drifted for ${strategy}: expected "${cell}"`);
  }
});

test('RESULTS per-workload rows match each committed score', () => {
  const md = doc('RESULTS.md');
  for (const r of accounting()) {
    const tail = `${fmt(r.beforeTok)} | ${fmt(r.afterTok)} | **${r.savedPct}%**`;
    assert.ok(md.includes(tail), `RESULTS row for ${r.suite}/${r.id} drifted: expected "${tail}"`);
  }
});

test('every quality verdict is the one its coverage implies', () => {
  for (const r of quality()) {
    assert.equal(
      r.deterministic.verdict,
      verdictFor(r.deterministic.coverage / 100),
      `${r.id} strict verdict vs coverage`
    );
    if (r.judge && r.judge.error == null) {
      assert.equal(r.judge.verdict, verdictFor(r.judge.coverage / 100), `${r.id} judge verdict vs coverage`);
    }
  }
});

test('quality headline counts match README and QUALITY', () => {
  const rows = quality();
  const strict = tally(rows.map((r) => r.deterministic.verdict));
  const judge = tally(rows.filter((r) => r.judge && r.judge.error == null).map((r) => r.judge.verdict));

  // recomputed from the committed quality.json
  assert.equal(strict.PASS + strict.MARGINAL + strict.FAIL, rows.length);

  const qmd = doc('QUALITY.md');
  assert.ok(
    qmd.includes(`${rows.length} | ${strict.PASS} | ${strict.MARGINAL} | ${strict.FAIL}`),
    `QUALITY strict row must read ${rows.length} | ${strict.PASS} | ${strict.MARGINAL} | ${strict.FAIL}`
  );
  assert.ok(
    qmd.includes(`${rows.length} | ${judge.PASS} | ${judge.MARGINAL} | ${judge.FAIL}`),
    `QUALITY judge row must read ${rows.length} | ${judge.PASS} | ${judge.MARGINAL} | ${judge.FAIL}`
  );

  const md = doc('README.md');
  assert.ok(md.includes(`${strict.PASS} of ${rows.length}`), `README must say "${strict.PASS} of ${rows.length}"`);
  assert.ok(
    md.includes(`${judge.PASS} PASS / ${judge.MARGINAL} MARGINAL / ${judge.FAIL} FAIL`),
    `README must say "${judge.PASS} PASS / ${judge.MARGINAL} MARGINAL / ${judge.FAIL} FAIL"`
  );
  // The "answer kept N/total" badge embeds the count too — keep it from drifting.
  assert.ok(
    md.includes(`kept%20${strict.PASS}%2F${rows.length}`),
    `README badge must read "kept ${strict.PASS}/${rows.length}"`
  );
});

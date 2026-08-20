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

// The harness force-enables each workload's strategy (setStrategy PUTs
// `enabled: true`), so the headline sums rows a stock deployment would never
// produce — 37% of measured savings come from strategies that ship OFF. The
// README states that split; this keeps it true.
//
// UNVERIFIED MIRROR. OFF_BY_DEFAULT copies DEFAULT_CONFIG from the monorepo
// (optimizer/src/config.ts), and NOTHING checks the two still agree — this repo
// cannot see that file, and the monorepo-side test that would have closed the
// loop was not landed (ANY-116). So a default flipped there makes the published
// 37% wrong here, silently, and this guard will keep passing.
//
// Re-check by hand when a strategy's shipped default changes; the list below is
// every `enabled: false` entry in DEFAULT_CONFIG. Closing this properly needs a
// source-scan test in the monorepo reading THIS file (CLAUDE.md #1041) — a
// "must match" comment, which is what this now is, is explicitly the weaker
// option.
const OFF_BY_DEFAULT = new Set([
  'window_budget', 'output_externalize', 'tool_pruning', 'param_tuning',
  'vision_ocr', 'reasoning_budget', 'output_shaping', 'context_quality',
]);

test('README default-state split matches the committed results', () => {
  const md = doc('README.md');
  const rows = accounting();
  const savedOf = (r) => r.beforeTok - r.afterTok;
  const total = rows.reduce((n, r) => n + savedOf(r), 0);
  const off = rows.filter((r) => OFF_BY_DEFAULT.has(r.strategy));
  const offPct = Math.round((100 * off.reduce((n, r) => n + savedOf(r), 0)) / total);
  assert.ok(
    md.includes(`| **${offPct}%** |`),
    `README off-by-default share drifted: expected ${offPct}%`
  );
  assert.ok(
    md.includes(`| **${100 - offPct}%** |`),
    `README on-by-default share drifted: expected ${100 - offPct}%`
  );

  // The default-on subtotal is a second, independent statement of the same
  // thing — a reader who trusts it deserves it to be recomputed too.
  const on = rows.filter((r) => !OFF_BY_DEFAULT.has(r.strategy));
  const b = on.reduce((n, r) => n + r.beforeTok, 0);
  const a = on.reduce((n, r) => n + r.afterTok, 0);
  assert.ok(
    md.includes(`${fmt(b)} → ${fmt(a)} tok, **${savedPct(b, a)}%**`),
    `README default-on subtotal drifted: expected "${fmt(b)} → ${fmt(a)} tok, `
      + `**${savedPct(b, a)}%**"`
  );
});

// COVERAGE.md counts strategies with a WORKLOAD; the headline sums only the ones
// scored on whole-request bytes. Those are different numbers (22 vs 11) and the
// README states both, because reading "22 of 23 covered" next to a headline
// invites the assumption that the headline sums all 22. It does not — most
// notably it omits thinking_trim, currently the fleet's largest single source of
// optimizer savings (ANY-116). If a strategy moves between tiers, this fails.
test('README accounting/own-basis split matches the committed results', () => {
  const md = doc('README.md');
  const all = rowsFrom('optimized.json');
  const inHeadline = [...new Set(all.filter((r) => r.tier === 'accounting')
    .map((r) => r.strategy))];
  const ownBasis = [...new Set(all.filter((r) => r.tier !== 'accounting')
    .map((r) => r.strategy))].filter((s) => !inHeadline.includes(s));

  assert.ok(
    md.includes(`sums the **${inHeadline.length}**`),
    `README headline-strategy count drifted: expected ${inHeadline.length}`
  );
  assert.ok(
    md.includes(`The other ${ownBasis.length} are measured`),
    `README own-basis count drifted: expected ${ownBasis.length}`
  );
  for (const s of [...inHeadline, ...ownBasis]) {
    assert.ok(
      md.includes(`\`${s}\``),
      `README tier table is missing \`${s}\``
    );
  }
});

// The table guard above only reads table CELLS, so the sentence introducing the
// table drifted from it unnoticed: prose said "33% / 26% / 22%" while the column
// below said 32% / 26% / 23%, and the mix was still described as "weighted to
// real coding-agent traffic" after README.md had retracted exactly that claim
// (ANY-116). A published share is a number like any other — recompute it.
test('RESULTS top-three prose shares match the share-of-input column', () => {
  const md = doc('RESULTS.md');
  const rows = aggregate(accounting(), 'strategy');
  const total = [...rows.values()].reduce((n, v) => n + v.before, 0);
  const top3 = ['context_compression', 'window_budget', 'relevance_filter'];
  const shares = top3.map((s) => Math.round((100 * rows.get(s).before) / total));
  assert.ok(
    md.includes(`(${shares.join('% / ')}%)`),
    `RESULTS top-three prose drifted: expected "(${shares.join('% / ')}%)"`
  );
  const sum = top3.reduce((n, s) => n + rows.get(s).before, 0);
  assert.ok(
    Math.round((100 * sum) / total) >= 75,
    'top three no longer hold ~80% of input — the prose claim needs rewriting'
  );
});

// The suite measures its own fixtures, never production traffic. ANY-116 was
// filed because the docs claimed otherwise; this keeps the claim from returning.
test('no doc claims the fixture mix is weighted to production traffic', () => {
  for (const name of ['README.md', 'RESULTS.md', 'SUMMARY.md', 'COVERAGE.md', 'QUALITY.md']) {
    assert.ok(
      !/weighted to (real|production)/i.test(doc(name)),
      `${name} claims the mix is weighted to real traffic — this suite cannot support that`
    );
  }
});

test('RESULTS per-workload rows match each committed score', () => {
  const md = doc('RESULTS.md');
  for (const r of accounting()) {
    const tail = `${fmt(r.beforeTok)} | ${fmt(r.afterTok)} | **${r.savedPct}%**`;
    assert.ok(md.includes(tail), `RESULTS row for ${r.suite}/${r.id} drifted: expected "${tail}"`);
  }
});

test('each per-suite README token table matches that suite\'s committed scores', () => {
  const cache = new Map();
  for (const r of accounting()) {
    if (!cache.has(r.suite)) cache.set(r.suite, doc(join(r.suite, 'README.md')));
    const tail = `${fmt(r.beforeTok)} | ${fmt(r.afterTok)} | **${r.savedPct}%**`;
    assert.ok(
      cache.get(r.suite).includes(tail),
      `${r.suite}/README.md row for ${r.id} drifted: expected "${tail}"`
    );
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

  // The judge lane is OPTIONAL (`run_quality.mjs --judge` needs a model), so the
  // committed data may legitimately carry no judge verdicts. Assert whichever
  // state the data is actually in, rather than assuming the lane ran: a doc
  // claiming judge results that the JSON does not contain is exactly the drift
  // this file exists to catch.
  const judged = judge.PASS + judge.MARGINAL + judge.FAIL;
  if (judged > 0) {
    assert.ok(
      qmd.includes(`${rows.length} | ${judge.PASS} | ${judge.MARGINAL} | ${judge.FAIL}`),
      `QUALITY judge row must read ${rows.length} | ${judge.PASS} | ${judge.MARGINAL} | ${judge.FAIL}`
    );
  } else {
    for (const md of [qmd, doc('README.md')]) {
      assert.ok(
        !/\d+ PASS \/ \d+ MARGINAL \/ \d+ FAIL/.test(md),
        'no judge verdicts are committed, so no doc may quote a judge PASS/MARGINAL/FAIL tally'
      );
    }
  }

  const md = doc('README.md');
  assert.ok(md.includes(`${strict.PASS} of ${rows.length}`), `README must say "${strict.PASS} of ${rows.length}"`);
  if (judged > 0) {
    assert.ok(
      md.includes(`${judge.PASS} PASS / ${judge.MARGINAL} MARGINAL / ${judge.FAIL} FAIL`),
      `README must say "${judge.PASS} PASS / ${judge.MARGINAL} MARGINAL / ${judge.FAIL} FAIL"`
    );
  }
  // The "answer kept N/total" badge embeds the count too — keep it from drifting.
  assert.ok(
    md.includes(`kept%20${strict.PASS}%2F${rows.length}`),
    `README badge must read "kept ${strict.PASS}/${rows.length}"`
  );
});

// --- COVERAGE.md ------------------------------------------------------------
// COVERAGE.md answers "which registered strategies does this suite measure?".
// Two halves, and only one of them is checkable from data in this repo:
//   - which kinds have workloads, and what they scored — derived from
//     config.yaml + optimized.json, so it is enforced exactly like the tables above;
//   - the registry mirror itself (the 23 kinds, cache flags, shipped defaults) —
//     hand-maintained, because the monorepo is not a dependency here. The
//     monorepo owns the drift guard for its own lists (wasteCatalog.test.ts);
//     what this repo can prove is that every strategy it BENCHMARKS is a kind
//     the mirror knows about, which is what catches a renamed or retired id.

test('COVERAGE lists every strategy the suite actually benchmarks', async () => {
  const { REGISTRY_MIRROR, collectMeasured } = await import('../lib/writeCoverage.mjs');
  const known = new Set(REGISTRY_MIRROR.map((r) => r.kind));
  for (const kind of collectMeasured().keys()) {
    assert.ok(
      known.has(kind),
      `config.yaml benchmarks "${kind}" but REGISTRY_MIRROR in lib/writeCoverage.mjs does not list it — ` +
        `re-mirror it from the monorepo REGISTRY (optimizer/src/strategies/index.ts)`
    );
  }
});

test('COVERAGE.md matches the committed results', async () => {
  const { renderCoverage } = await import('../lib/writeCoverage.mjs');
  assert.equal(
    doc('COVERAGE.md').trim(),
    renderCoverage().trim(),
    'COVERAGE.md is stale — regenerate with `npm run coverage`'
  );
});

test('COVERAGE headline counts match the mirror and the results', async () => {
  const { REGISTRY_MIRROR, collectMeasured } = await import('../lib/writeCoverage.mjs');
  const measured = collectMeasured();
  const covered = REGISTRY_MIRROR.filter((r) => measured.has(r.kind)).length;
  const workloads = [...measured.values()].reduce((n, rs) => n + rs.length, 0);
  const total = REGISTRY_MIRROR.length;

  // Every configured workload must appear in the committed scores, or the
  // matrix would claim coverage the data does not back.
  assert.equal(workloads, rowsFrom('optimized.json').filter((r) => r.strategy).length);

  const md = doc('COVERAGE.md');
  assert.ok(
    md.includes(`**${covered} of ${total}**`),
    `COVERAGE must say "**${covered} of ${total}**"`
  );
  assert.ok(
    md.includes(`**${workloads}** workloads`),
    `COVERAGE must say "**${workloads}** workloads"`
  );
  const missing = total - covered;
  const missingPhrase = missing === 1 ? '**1** is not' : `**${missing}** are not`;
  assert.ok(md.includes(missingPhrase), `COVERAGE must say "${missingPhrase}"`);
});

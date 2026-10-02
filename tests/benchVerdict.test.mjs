import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { benchVerdict, tCritical95 } from '../lib/benchVerdict.mjs';
import { formatTable, poolFiles, run } from '../tools/bench-verdict.mjs';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const round = (ratio, index = 1, extra = {}) => ({
  round: index, ratio, quality: { a: true, b: true },
  sessions: { a: { totals: { costUsd: 2, outsideCheckout: 0 } }, b: { totals: { costUsd: 2 * ratio, outsideCheckout: 0 } } },
  ...extra,
});
const repeated = (ratio, n = 8) => Array.from({ length: n }, (_, i) => round(ratio, i + 1));

test('hand-computed paired statistics use sample SD and Student t on log ratios', () => {
  const v = benchVerdict([round(0.5, 1), round(1, 2), round(2, 3)], { minRounds: 3 });
  const margin = tCritical95(2) * Math.log(2) / Math.sqrt(3);
  near(tCritical95(2), 4.30265273);
  near(v.meanRatio, 7 / 6);
  near(v.medianRatio, 1);
  near(v.geometricMeanRatio, 1);
  near(v.meanLogRatio, 0);
  near(v.sampleSdLogRatio, Math.log(2));
  near(v.confidenceInterval95.logLower, -margin);
  near(v.confidenceInterval95.logUpper, margin);
  near(v.confidenceInterval95.lower, Math.exp(-margin));
  near(v.confidenceInterval95.upper, Math.exp(margin));
  near(v.minimumDetectableRatio, Math.exp(-margin));
  near(v.arms.a.meanCost, 2);
  near(v.arms.a.coefficientOfVariation, 0);
  near(v.arms.b.meanCost, 7 / 3);
  near(v.arms.b.coefficientOfVariation, Math.sqrt(7 / 3) / (7 / 3));
  assert.deepEqual([v.wins, v.losses, v.ties], [1, 1, 1]);
});

test('exclusions report failed, unsolved, outside checkout and overlapping reasons', () => {
  const rounds = [round(0.8, 1), round(0.2, 2, { quality: { a: true, b: false } }),
    { round: 3, error: 'synthetic failure' },
    round(0.3, 4, { sessions: { a: { totals: { costUsd: 2, outsideCheckout: 1 } }, b: { totals: { costUsd: 0.6 } } } }),
    round(0.4, 5, { quality: { a: false, b: false }, gatewayRestarted: true }),
    round(0, 6)];
  const v = benchVerdict(rounds);
  assert.equal(v.n, 1);
  assert.equal(v.excludedCount, 5);
  assert.deepEqual(v.excludedByReason, { 'not solved': 3, 'failed round': 2, 'outside checkout': 1, 'gateway restart': 1 });
  assert.deepEqual(v.excluded.map((x) => x.reasons), [['not solved'], ['failed round', 'not solved'], ['outside checkout'], ['gateway restart', 'not solved'], ['failed round']]);
  assert.equal(v.confidenceInterval95, null);
});

test('pass, fail and inconclusive decisions respect the valid-round minimum', () => {
  assert.equal(benchVerdict(repeated(0.8)).verdict, 'pass');
  assert.equal(benchVerdict(repeated(1.2)).verdict, 'fail');
  assert.equal(benchVerdict(Array.from({ length: 8 }, (_, i) => round(i % 2 ? 1.1 : 0.9, i + 1))).verdict, 'inconclusive');
  const short = benchVerdict(repeated(0.8, 7));
  assert.equal(short.verdict, 'inconclusive');
  assert.equal(short.moreRoundsNeeded, 1);
  assert.match(short.reasons.join(' '), /Need 1 more valid round/);
  assert.equal(benchVerdict([round(0.8)]).confidenceInterval95, null);
  assert.equal(benchVerdict([]).n, 0);
  assert.throws(() => benchVerdict([], { minRounds: 0 }), /positive integer/);
  assert.ok(Math.abs(tCritical95(100) - 1.983971518) < 1e-7);
});

function fixture(fn) {
  const dir = mkdtempSync(join(process.cwd(), '.bench-verdict-test-'));
  const file = (name, rounds, overrides = {}) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ scenario: { name: 'synthetic' }, compare: 'control', provider: 'synthetic', setup: { a: { model: 'synthetic-model' } }, rounds, ...overrides }));
    return path;
  };
  try { return fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('pooling refuses mismatched scenario, compare, model or provider unless overridden', () => fixture((file) => {
  const base = file('base.json', [round(0.8)]);
  const changes = [
    ['scenario', { scenario: { name: 'other' } }],
    ['compare', { compare: 'gateway' }],
    ['model', { setup: { a: { model: 'other' } } }],
    ['provider', { provider: 'other' }],
  ];
  for (const [field, override] of changes) {
    const other = file(`${field}.json`, [round(0.9)], override);
    assert.throws(() => poolFiles([base, other]), new RegExp(`different ${field}`));
    const pooled = poolFiles([base, other], { allowMixed: true });
    assert.deepEqual(pooled.differences.map((x) => x.field), [field]);
    assert.equal(pooled.rounds.length, 2);
  }
}));

test('table has box-drawn aligned rows, exclusion status and a verdict block', () => fixture((file) => {
  const path = file('a.json', [round(0.8), round(0.7, 2, { quality: { a: true, b: false } })]);
  const pooled = poolFiles([path]);
  const rendered = formatTable(pooled, benchVerdict(pooled.rounds.map((x) => x.round)));
  assert.match(rendered, /^┌─.*┬.*┐/);
  assert.match(rendered, /├─.*┼.*┤/);
  assert.match(rendered, /└─.*┴.*┘/);
  assert.match(rendered, /not solved/);
  assert.match(rendered, /Verdict: INCONCLUSIVE/);
  const lines = rendered.split('\n').filter((x) => /^[┌├└│]/.test(x));
  assert.equal(new Set(lines.map((x) => [...x].length)).size, 1);
}));

test('CLI exit codes and JSON output match the computed verdict', () => fixture((file) => {
  const cli = new URL('../tools/bench-verdict.mjs', import.meta.url).pathname;
  for (const [name, rounds, expected] of [['pass', repeated(0.8), 0], ['fail', repeated(1.2), 1], ['inconclusive', repeated(0.8, 1), 2]]) {
    const path = file(`${name}.json`, rounds);
    const child = spawnSync(process.execPath, [cli, '--json', path], { encoding: 'utf8' });
    assert.equal(child.status, expected, child.stderr);
    assert.equal(JSON.parse(child.stdout).verdict, name);
  }
  const mixed = file('mixed.json', repeated(0.8), { compare: 'gateway' });
  const base = file('same.json', repeated(0.8));
  const refusal = spawnSync(process.execPath, [cli, base, mixed], { encoding: 'utf8' });
  assert.equal(refusal.status, 2);
  assert.match(refusal.stderr, /different compare/);
  const output = { value: '' };
  const code = run(['--allow-mixed', base, mixed], { out: { write: (s) => { output.value += s; } }, err: { write: () => {} } });
  assert.equal(code, 0);
  assert.match(output.value, /Mixed files \(--allow-mixed\): compare:/);
}));

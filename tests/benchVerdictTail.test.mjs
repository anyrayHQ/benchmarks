// bench-verdict --noise-library: the same pooled verdict, plus the calibrated tail check (ANY-1656).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, run } from '../tools/bench-verdict.mjs';
import { seededNormals } from '../lib/tailSim.mjs';

const round = (i, ratio) => ({ round: i, ratio, quality: { a: true, b: true }, sessions: { a: { totals: { costUsd: 1 } }, b: { totals: { costUsd: ratio } } } });
const rec = (ratios, over = {}) => ({
  scenario: 's', compare: 'gateway', provider: 'anthropic', gateway: 'https://gw.example/', setup: { a: { model: 'm' }, b: { model: 'm' } },
  request: { bareA: true }, claudeVersions: { a: { '2.1.300': 1 }, b: { '2.1.300': 1 } }, rounds: ratios.map((r, i) => round(i + 1, r)), ...over,
});
const dir = mkdtempSync(join(tmpdir(), 'bvt-'));
const write = (name, record) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(record));
  return p;
};
const pp = (n) => rec(seededNormals(1, n).map((z) => Math.exp(z * 0.5)), { request: { bare: true } });
const go = (argv) => {
  let out = '';
  const code = run(argv, { out: { write: (s) => (out += s) }, err: { write: () => {} } });
  return { code, out };
};
const saving = Array(12).fill(0.6);

test('--noise-library is repeatable and takes a file', () => {
  assert.deepEqual(parseArgs(['--noise-library', 'a.json', '--noise-library', 'b.json', 'r.json']).noiseLibrary, ['a.json', 'b.json']);
  assert.deepEqual(parseArgs(['r.json']).noiseLibrary, []);
  assert.throws(() => parseArgs(['--noise-library']), /--noise-library needs a file/);
});

test('without --noise-library the output and exit code are unchanged', () => {
  const r = write('plain.json', rec(saving));
  const { code, out } = go([r]);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /Tail check/);
});

test('a saving that passes the verdict still cannot pass without a calibrated library: exit 2', () => {
  const r = write('t1.json', rec(saving));
  const lib = write('pp-small.json', pp(60));
  const { code, out } = go(['--noise-library', lib, r]);
  assert.match(out, /Verdict: PASS/);
  assert.match(out, /Tail check: insufficient calibration/);
  assert.equal(code, 2);
});

test('with 19 blocks a clean saving passes, and one session at 40x fails the tail even though the mean passes', () => {
  const lib = write('pp-full.json', pp(19 * 12));
  const clean = go(['--noise-library', lib, write('t2.json', rec(saving))]);
  assert.match(clean.out, /Tail check: within noise/);
  assert.equal(clean.code, 0);
  const spiky = go(['--noise-library', lib, write('t3.json', rec([...Array(11).fill(0.3), 40]))]);
  assert.match(spiky.out, /Tail check: excess/);
  assert.equal(spiky.code, 1);
});

test('--json carries the tail check, its anchors and skipped files', () => {
  const lib = write('pp-full2.json', pp(19 * 12));
  const other = write('pp-other.json', { ...pp(30), scenario: 'other' });
  const { out } = go(['--json', '--noise-library', lib, '--noise-library', other, write('t4.json', rec(saving))]);
  const j = JSON.parse(out);
  assert.equal(j.tailCheck.state, 'within_noise');
  assert.deepEqual(j.tailCheck.anchors, ['pp-full2.json']);
  assert.deepEqual(j.tailCheck.skipped, [{ file: 'pp-other.json', reason: 'different scenario' }]);
});

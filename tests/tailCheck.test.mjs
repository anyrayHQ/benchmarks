// The calibrated tail check (ANY-1656): T = max log(B/P) over the N valid pairs, failed when it exceeds
// the maximum of every calibration block drawn from a pooled no-op (P/P) library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_BLOCKS, tailStatistic, calibrationBlocks, tailCheck } from '../lib/tailCheck.mjs';
import { formatTailBlock } from '../lib/tailReport.mjs';
import { seededNormals, falseFailureRate, missRate, wilson } from '../lib/tailSim.mjs';

const ratios = (logs) => logs.map(Math.exp);
/** A library of `blocks` x `n` no-op pairs: spread values, so block maxes differ. */
const library = (blocks, n, seed = 1) => ratios(seededNormals(seed, blocks * n).map((z) => z * 0.5));

test('the statistic is the largest log ratio', () => {
  assert.equal(tailStatistic(ratios([-0.2, 0.7, 0.1])), Math.log(Math.exp(0.7)));
  assert.equal(tailStatistic([]), null);
});

test('blocks of N are cut from the library by a seeded split: same seed same blocks, no pair twice, remainder dropped', () => {
  const lib = library(5, 12).concat(ratios([0.01, 0.02, 0.03]));
  const a = calibrationBlocks(lib, 12, { seed: 7 });
  assert.equal(a.length, 5);
  assert.ok(a.every((b) => b.length === 12));
  assert.deepEqual(calibrationBlocks(lib, 12, { seed: 7 }), a);
  assert.notDeepEqual(calibrationBlocks(lib, 12, { seed: 8 }), a);
  const used = a.flat().map((x) => x.toFixed(9));
  assert.equal(new Set(used).size, used.length);
});

test('fewer than 19 blocks is its own state, never a pass', () => {
  assert.equal(MIN_BLOCKS, 19);
  const r = tailCheck({ ratios: ratios(Array(12).fill(-1)), library: library(18, 12) });
  assert.equal(r.state, 'insufficient_calibration');
  assert.equal(r.blocks, 18);
  assert.equal(r.need.blocks, 19);
  assert.equal(r.need.pairs, 19 * 12);
  assert.equal(r.verdict, undefined);
});

test('19 blocks decide: a pair above every block max is an excess, a typical set is within noise', () => {
  const lib = library(19, 12);
  const worst = Math.max(...lib.map(Math.log));
  const excess = tailCheck({ ratios: ratios([...Array(11).fill(0), worst + 1]), library: lib });
  assert.equal(excess.state, 'excess');
  assert.ok(excess.T > excess.threshold);
  assert.equal(excess.falseFailureBound, 1 / 20);
  const typical = tailCheck({ ratios: ratios(Array(12).fill(0)), library: lib });
  assert.equal(typical.state, 'within_noise');
  assert.ok(typical.T <= typical.threshold);
});

test('a tie with the largest block max is not an excess: the check is strict', () => {
  const lib = library(19, 12);
  const r = tailCheck({ ratios: ratios([...Array(11).fill(0), Math.max(...calibrationBlocks(lib, 12, { seed: 1 }).map((b) => Math.max(...b.map(Math.log))))]), library: lib });
  assert.equal(r.state, 'within_noise');
});

test('no pairs, and ratios that are not positive and finite, are refused', () => {
  assert.equal(tailCheck({ ratios: [], library: library(19, 12) }).state, 'no_pairs');
  assert.throws(() => tailCheck({ ratios: [1, 0], library: library(19, 1) }), /positive and finite/);
  assert.throws(() => tailCheck({ ratios: [1], library: [NaN] }), /positive and finite/);
});

test('no-op false-failure rate: seeded simulation matches 1/(K+1) within its confidence bound', () => {
  const { rate, trials } = falseFailureRate({ n: 12, sd: 0.924, blocks: 19, trials: 4000, seed: 11 });
  const [lo, hi] = wilson(Math.round(rate * trials), trials, 3.29); // 99.9%
  assert.ok(lo <= 1 / 20 && 1 / 20 <= hi, `observed ${rate}, interval ${lo}..${hi}`);
});

test('more blocks only lower the false-failure rate: 1/(K+1) at K=39', () => {
  const { rate, trials } = falseFailureRate({ n: 12, sd: 0.924, blocks: 39, trials: 4000, seed: 12 });
  const [lo, hi] = wilson(Math.round(rate * trials), trials, 3.29);
  assert.ok(lo <= 1 / 40 && 1 / 40 <= hi, `observed ${rate}, interval ${lo}..${hi}`);
});

test('the miss rates are reported, and they are high: at SD 0.924 a doubling is smaller than the noise', () => {
  const one = missRate({ n: 12, sd: 0.924, blocks: 19, trials: 3000, seed: 21, effect: 'one' });
  const all = missRate({ n: 12, sd: 0.924, blocks: 19, trials: 3000, seed: 22, effect: 'all' });
  assert.ok(one.miss > 0.9, `one doubled session missed ${one.miss}`);
  assert.ok(all.miss > 0.6 && all.miss < one.miss, `all sessions doubled missed ${all.miss}`);
  assert.equal(one.factor, 2);
});

test('the printed block names its anchors, counts, statistic, threshold, assumptions and power', () => {
  const lib = library(19, 12);
  const r = tailCheck({ ratios: ratios(Array(12).fill(0)), library: lib });
  const text = formatTailBlock(r, { anchors: ['pp-library.json'], sd: 0.924 });
  for (const part of ['Tail check: within noise', 'pp-library.json', '12 pairs', '19 blocks', 'T = ', 'threshold ', 'false-failure bound 5.0%', 'exchangeable', 'misses ', 'not proof of safety']) {
    assert.ok(text.includes(part), `missing "${part}" in:\n${text}`);
  }
});

test('an insufficient library says what to collect, and prints no statistic', () => {
  const text = formatTailBlock(tailCheck({ ratios: ratios(Array(12).fill(0)), library: library(10, 12) }), { anchors: ['pp-library.json'], sd: 0.924 });
  assert.match(text, /Tail check: insufficient calibration/);
  assert.match(text, /108 more P\/P pairs/);
  assert.doesNotMatch(text, /T = /);
});

test('seeded runs repeat', () => {
  const a = missRate({ n: 6, sd: 0.5, blocks: 19, trials: 200, seed: 3, effect: 'one' });
  assert.deepEqual(missRate({ n: 6, sd: 0.5, blocks: 19, trials: 200, seed: 3, effect: 'one' }), a);
});

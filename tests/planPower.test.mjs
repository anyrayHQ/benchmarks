// The plan's power math (ANY-1486), in lib/benchVerdict.mjs: how many pairs a predicted ratio
// needs at 80% power, two-sided 95%, and the inverse, the smallest effect a number of pairs can
// detect. The ladder ANY-350 published at its paired log-ratio SD of 0.924: a 20% saving needs
// 135 pairs, 10% needs 604, 30% needs 53. Those three reproduce only with the exact normal
// quantiles; the rounded 1.96 + 0.84 gives 603 for the 10% rung.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** The module, with a clear failure while it does not export the planner's math yet. */
async function power() {
  const mod = await import('../lib/benchVerdict.mjs');
  for (const name of ['pairsNeeded', 'detectableRatio']) assert.equal(typeof mod[name], 'function', `lib/benchVerdict.mjs exports ${name}()`);
  return mod;
}

test('the ANY-350 ladder reproduces from the formula: at sd 0.924, 0.8 needs 135 pairs, 0.9 needs 604, 0.7 needs 53', async () => {
  const { pairsNeeded } = await power();
  assert.equal(pairsNeeded(0.8, 0.924), 135);
  assert.equal(pairsNeeded(0.9, 0.924), 604, 'the exact quantiles, not 1.96 + 0.84 (which gives 603)');
  assert.equal(pairsNeeded(0.7, 0.924), 53);
});

test('the prior sd is 0.924 and is the default; the quantiles are exact', async () => {
  const mod = await power();
  assert.equal(mod.PRIOR_LOG_RATIO_SD, 0.924);
  assert.equal(mod.Z_975, 1.959963984540054);
  assert.equal(mod.Z_80, 0.8416212335729143);
  assert.equal(mod.pairsNeeded(0.8), 135, 'pairsNeeded(ratio) uses the prior sd');
  assert.equal(mod.detectableRatio(135), mod.detectableRatio(135, 0.924), 'detectableRatio(pairs) uses the prior sd');
});

test('pairs scale with the variance and are symmetric on the log scale', async () => {
  const { pairsNeeded } = await power();
  assert.equal(pairsNeeded(0.8, 0.462), 34, 'half the sd: a quarter of the pairs (134.58 / 4, rounded up)');
  assert.equal(pairsNeeded(1.25, 0.924), 135, 'a 25% loss is as far from 1 as a 20% saving');
});

test('a predicted ratio of exactly 1 needs no finite number of pairs: null, not Infinity', async () => {
  const { pairsNeeded } = await power();
  assert.equal(pairsNeeded(1, 0.924), null);
});

test('pairsNeeded refuses a ratio or sd that is not finite and positive', async () => {
  const { pairsNeeded } = await power();
  for (const [ratio, sd] of [[0, 0.924], [-0.5, 0.924], [Number.NaN, 0.924], [Number.POSITIVE_INFINITY, 0.924], [0.8, 0], [0.8, -1], [0.8, Number.NaN]]) {
    assert.throws(() => pairsNeeded(ratio, sd), RangeError, `pairsNeeded(${ratio}, ${sd})`);
  }
});

test('detectableRatio is the inverse at each rung: one pair short misses the target ratio, the ladder count reaches it', async () => {
  const { detectableRatio } = await power();
  for (const [pairs, ratio] of [[135, 0.8], [604, 0.9], [53, 0.7]]) {
    assert.ok(detectableRatio(pairs - 1, 0.924) < ratio, `${pairs - 1} pairs cannot detect ${ratio}: ${detectableRatio(pairs - 1, 0.924)}`);
    assert.ok(detectableRatio(pairs, 0.924) > ratio, `${pairs} pairs detect ${ratio}: ${detectableRatio(pairs, 0.924)}`);
    assert.ok(detectableRatio(pairs, 0.924) - ratio < 0.001, `${pairs} pairs detect about ${ratio}, not far beyond it`);
  }
});

test('more pairs detect a smaller effect, and fewer than two pairs detect nothing (null)', async () => {
  const { detectableRatio } = await power();
  assert.ok(detectableRatio(10) < detectableRatio(100) && detectableRatio(100) < detectableRatio(1000) && detectableRatio(1000) < 1);
  assert.equal(detectableRatio(1), null);
  assert.equal(detectableRatio(0), null);
  for (const pairs of [1.5, -1, Number.NaN]) assert.throws(() => detectableRatio(pairs), RangeError, `detectableRatio(${pairs})`);
});

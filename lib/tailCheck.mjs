// The calibrated tail check (ANY-1656). The statistic is T = max log(B/P cost) over the N valid
// pairs. The no-op library is pooled P/P pairs, cut into blocks of N. Under no effect T and the
// block maxima are exchangeable, so T exceeds all K of them with probability 1/(K+1): at most 5%
// no-op false failures from K = 19. Fewer blocks cannot give that bound, so the check says so and
// never passes. "Within noise" is not proof of safety: the power block says what N pairs can see.
import { seededUniform, shuffled } from './seededRandom.mjs';

export const MIN_BLOCKS = 19;

const usable = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const assertRatios = (xs, what) => {
  if (!Array.isArray(xs) || !xs.every(usable)) throw new RangeError(`${what} must be positive and finite`);
};

/** The largest log ratio, or null without pairs. */
export const tailStatistic = (ratios) => (ratios.length ? Math.max(...ratios.map(Math.log)) : null);

/** Blocks of `n` ratios from the library by a seeded split: no pair twice, the remainder dropped. */
export function calibrationBlocks(libraryRatios, n, { seed = 1 } = {}) {
  assertRatios(libraryRatios, 'library ratios');
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  const order = shuffled(libraryRatios, seededUniform(seed));
  const blocks = [];
  for (let i = 0; i + n <= order.length; i += n) blocks.push(order.slice(i, i + n));
  return blocks;
}

/**
 * `state`: `no_pairs`, `insufficient_calibration` (fewer than 19 blocks), `excess` (T above every
 * block max) or `within_noise`. Strict: a tie with the largest block max is not an excess.
 */
export function tailCheck({ ratios, library, seed = 1 }) {
  assertRatios(ratios, 'ratios');
  assertRatios(library, 'library ratios');
  const n = ratios.length;
  if (!n) return { state: 'no_pairs', n, blocks: 0 };
  const blocks = calibrationBlocks(library, n, { seed });
  const K = blocks.length;
  if (K < MIN_BLOCKS) {
    return { state: 'insufficient_calibration', n, blocks: K, libraryPairs: library.length, seed, need: { blocks: MIN_BLOCKS, pairs: MIN_BLOCKS * n, more: Math.max(0, MIN_BLOCKS * n - library.length) } };
  }
  const T = tailStatistic(ratios);
  const blockMaxes = blocks.map(tailStatistic);
  const threshold = Math.max(...blockMaxes);
  return {
    state: T > threshold ? 'excess' : 'within_noise',
    T, threshold, n, blocks: K, libraryPairs: library.length, unusedPairs: library.length - K * n, seed,
    falseFailureBound: 1 / (K + 1),
    pValue: (1 + blockMaxes.filter((m) => m >= T).length) / (K + 1),
  };
}

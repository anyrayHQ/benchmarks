// Seeded simulations of the calibrated tail check: its no-op false-failure rate and what N pairs
// miss. Pairs are log-normal ratios with a paired log-ratio SD of `sd`.
import { seededUniform, normals } from './seededRandom.mjs';
import { tailCheck } from './tailCheck.mjs';

export const seededNormals = (seed, count) => normals(seededUniform(seed), count);

/** Wilson score interval for k of n at z standard errors (3.29 = 99.9%). */
export function wilson(k, n, z = 1.96) {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

const draw = (next, count, sd) => normals(next, count).map((z) => z * sd);

function trialsOf({ n, sd, blocks, trials, seed, shift }) {
  const next = seededUniform(seed);
  let failed = 0;
  for (let t = 0; t < trials; t++) {
    const library = draw(next, blocks * n, sd).map(Math.exp);
    const treated = draw(next, n, sd).map((x, i) => Math.exp(x + shift(i)));
    if (tailCheck({ ratios: treated, library, seed: t + 1 }).state === 'excess') failed++;
  }
  return failed;
}

/** How often a no-op (no effect) set of N pairs is called an excess. Expected 1/(blocks+1). */
export function falseFailureRate({ n, sd, blocks, trials, seed }) {
  const failures = trialsOf({ n, sd, blocks, trials, seed, shift: () => 0 });
  return { rate: failures / trials, failures, trials, bound: 1 / (blocks + 1) };
}

/**
 * How often an excess goes undetected: `one` doubles one session's cost (a single bad pair), `all`
 * doubles every session's. `factor` is the cost multiple.
 */
export function missRate({ n, sd, blocks, trials, seed, effect, factor = 2 }) {
  if (!['one', 'all'].includes(effect)) throw new RangeError('effect is one or all');
  const lift = Math.log(factor);
  const caught = trialsOf({ n, sd, blocks, trials, seed, shift: (i) => (effect === 'all' || i === 0 ? lift : 0) });
  return { miss: 1 - caught / trials, caught: caught / trials, trials, factor, effect, n, sd, blocks };
}

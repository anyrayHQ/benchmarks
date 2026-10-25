// The tail check as the verdict prints it: anchors, counts, statistic, threshold, assumptions, power.
import { MIN_BLOCKS } from './tailCheck.mjs';
import { missRate } from './tailSim.mjs';

const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
const TITLE = { within_noise: 'within noise', excess: 'excess', insufficient_calibration: 'insufficient calibration', no_pairs: 'no pairs' };

/** `anchors`: the library files the check read. `sd`: the paired log-ratio SD the power line assumes. */
export function formatTailBlock(r, { anchors = [], sd }) {
  const lines = [`Tail check: ${TITLE[r.state]}`, `  anchors: ${anchors.length ? anchors.join(', ') : 'none'}`];
  if (r.state === 'no_pairs') return lines.join('\n');
  if (r.state === 'insufficient_calibration') {
    lines.push(`  the library has ${r.blocks} blocks of ${r.n}; the check needs ${r.need.blocks} (${r.need.more} more P/P pairs). It never passes without them.`);
    return lines.join('\n');
  }
  const power = (effect) => missRate({ n: r.n, sd, blocks: r.blocks, trials: 2000, seed: 1, effect }).miss;
  lines.push(
    `  ${r.n} pairs against ${r.blocks} blocks of ${r.n} (${r.blocks * r.n} of ${r.libraryPairs} library pairs used, seed ${r.seed})`,
    `  T = ${r.T.toFixed(3)} (largest log ratio), threshold ${r.threshold.toFixed(3)} (largest of the ${r.blocks} block maxima), false-failure bound ${pct(r.falseFailureBound, 1)}`,
    `  Assumes the no-op pairs and these pairs are exchangeable: the same scenario, model, client version, gateway and upstream lane.`,
    `  Power at ${r.n} pairs, log-ratio SD ${sd}: misses ${pct(power('one'))} of runs where one session costs double, ${pct(power('all'))} where every session does.`,
    `  A run within noise is not proof of safety.`
  );
  return lines.join('\n');
}

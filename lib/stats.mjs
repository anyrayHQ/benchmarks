// Paired statistics and the Rule 0 verdict.
//
// Rule 0: a session must never cost more because of us. A change passes only when,
// paired against the other arm on the same task, its win rate is clearly above the
// noise floor (identical bytes beat a direct connection in 53% of 59 rounds), its
// third quartile still saves, and quality holds. The tail is judged, never the mean.

export const NOISE_FLOOR_WIN_RATE = 0.53;
export const WIN_RATE_MARGIN = 0.1;
export const UNCHANGED_EPSILON = 0.001;

/** Linear-interpolated quantile (numpy.percentile's default). */
export function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Summarize per-round ratios (arm B cost ÷ arm A cost; below 1 = B cheaper) and
 * quality, and give the Rule 0 verdict for B.
 */
export function rule0(rounds) {
  const ratios = rounds.map((r) => r.ratio).filter((x) => x != null && Number.isFinite(x));
  const n = ratios.length;
  const wins = ratios.filter((x) => x < 1 - UNCHANGED_EPSILON).length;
  const losses = ratios.filter((x) => x > 1 + UNCHANGED_EPSILON).length;
  const solved = (arm) => rounds.filter((r) => r.quality?.[arm]).length;
  const s = {
    n,
    wins,
    losses,
    winRate: n ? wins / n : null,
    median: quantile(ratios, 0.5),
    q1: quantile(ratios, 0.25),
    q3: quantile(ratios, 0.75),
    max: n ? Math.max(...ratios) : null,
    min: n ? Math.min(...ratios) : null,
    solvedA: solved('a'),
    solvedB: solved('b'),
  };
  const bar = NOISE_FLOOR_WIN_RATE + WIN_RATE_MARGIN;
  const reasons = [];
  if (n < 5) reasons.push(`only ${n} round(s); Rule 0 needs enough rounds to separate from noise`);
  if (s.winRate != null && s.winRate < bar) reasons.push(`win rate ${(s.winRate * 100).toFixed(0)}% is not above the ${(bar * 100).toFixed(0)}% bar (53% noise floor + 10)`);
  if (s.q3 != null && s.q3 >= 1) reasons.push(`Q3 ratio ${s.q3.toFixed(2)} ≥ 1: at least a quarter of rounds cost more`);
  if (s.solvedB < s.solvedA) reasons.push(`quality dropped: ${s.solvedB}/${n} solved vs ${s.solvedA}/${n}`);
  s.verdict = n === 0 ? 'NO DATA' : reasons.length === 0 ? 'PASS' : n < 5 && reasons.length === 1 ? 'INCONCLUSIVE' : 'FAIL';
  s.reasons = reasons;
  return s;
}

export const MIN_SOLVED_PAIRS = 3;

/** Why a round has no cost (timeout, crash): its error, or the arm(s) that ended without a result. */
function noCostReason(r) {
  if (r.error) return r.error;
  const missing = ['a', 'b'].filter((slot) => r.sessions?.[slot]?.totals?.costUsd == null);
  if (missing.length) return `${missing.map((s) => s.toUpperCase()).join(' and ')} ended without a result (no cost)`;
  if (r.ratio == null || !Number.isFinite(r.ratio)) return 'no ratio';
  return null;
}

/**
 * Rule 0 over solved pairs only (ANY-733). A session that didn't solve the task (e.g.
 * it hit the turn cap) measures cost, not quality: a cheap failure is never a win.
 *   pairs         both arms solved: the only rounds whose ratios are scored
 *   qualityEvents one arm solved: who, reported apart, never as a cost win or loss
 *   neither       no arm solved
 *   noCost        a timeout or crash (no cost): excluded from everything, reported
 * Fewer than MIN_SOLVED_PAIRS pairs: the verdict is INSUFFICIENT.
 */
export function solvedPairVerdict(rounds) {
  const pairs = [];
  const qualityEvents = [];
  const neither = [];
  const noCost = [];
  for (const r of rounds) {
    const reason = noCostReason(r);
    if (reason) noCost.push({ round: r.round, reason });
    else if (r.quality?.a && r.quality?.b) pairs.push(r);
    else if (r.quality?.a || r.quality?.b) qualityEvents.push({ round: r.round, solvedBy: r.quality.a ? 'a' : 'b' });
    else neither.push(r.round);
  }
  const stats = rule0(pairs);
  const k = pairs.length;
  const reasons = stats.reasons.filter((x) => !x.startsWith('quality dropped')); // pairs are solved on both sides
  const only = (slot) => qualityEvents.filter((e) => e.solvedBy === slot).length;
  if (only('a') > only('b')) reasons.push(`quality dropped: only A solved ${only('a')} round(s), only B ${only('b')}`);
  const insufficient = k < MIN_SOLVED_PAIRS;
  if (insufficient) reasons.unshift(`only ${k} solved pair(s); a verdict needs at least ${MIN_SOLVED_PAIRS}`);
  const verdict = insufficient ? 'INSUFFICIENT' : reasons.length === 0 ? 'PASS' : k < 5 && reasons.length === 1 ? 'INCONCLUSIVE' : 'FAIL';
  return { n: rounds.length, k, pairs: pairs.map((r) => r.round), qualityEvents, neither, noCost, stats, insufficient, verdict, reasons };
}

/** A control's noise band: the median and range of its solved-pair ratios (null without any). */
export function noiseBand(controlVerdict) {
  const s = controlVerdict?.stats;
  if (!s?.n) return null;
  return { median: s.median, min: s.min, max: s.max, k: controlVerdict.k };
}

/** Where a median falls against a noise band: 'below', 'inside' or 'above' (null if either is missing). */
export function bandPosition(median, band) {
  if (median == null || !band) return null;
  return median < band.min ? 'below' : median > band.max ? 'above' : 'inside';
}

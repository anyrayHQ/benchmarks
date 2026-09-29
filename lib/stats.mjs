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

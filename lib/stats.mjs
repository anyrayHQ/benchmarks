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

/** The arm under test and its control. Rounds record the ratio as B ÷ A; with
 * `treatment: 'a'` every verdict reads it as A ÷ B, so "below 1" always means
 * "the treatment was cheaper". */
const slotsOf = (treatment = 'b') => {
  if (treatment !== 'a' && treatment !== 'b') throw new Error(`treatment must be a or b, got ${JSON.stringify(treatment)}`);
  return { treatment, control: treatment === 'a' ? 'b' : 'a' };
};
const orientedRatio = (r, treatment) => {
  const x = r.ratio;
  if (x == null || !Number.isFinite(x)) return null;
  if (treatment === 'b') return x;
  return x > 0 ? 1 / x : null;
};

/**
 * Summarize per-round ratios (treatment cost ÷ control cost; below 1 = the
 * treatment was cheaper) and quality, and give the Rule 0 verdict for the
 * treatment arm (B unless `treatment: 'a'`).
 */
export function rule0(rounds, { treatment = 'b' } = {}) {
  const slots = slotsOf(treatment);
  const ratios = rounds.map((r) => orientedRatio(r, slots.treatment)).filter((x) => x != null);
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
    treatment: slots.treatment,
  };
  const bar = NOISE_FLOOR_WIN_RATE + WIN_RATE_MARGIN;
  const reasons = [];
  if (n < 5) reasons.push(`only ${n} round(s); Rule 0 needs enough rounds to separate from noise`);
  if (s.winRate != null && s.winRate < bar) reasons.push(`win rate ${(s.winRate * 100).toFixed(0)}% is not above the ${(bar * 100).toFixed(0)}% bar (53% noise floor + 10)`);
  if (s.q3 != null && s.q3 >= 1) reasons.push(`Q3 ratio ${s.q3.toFixed(2)} ≥ 1: at least a quarter of rounds cost more`);
  const solvedTreatment = solved(slots.treatment);
  const solvedControl = solved(slots.control);
  if (solvedTreatment < solvedControl) reasons.push(`quality dropped: ${solvedTreatment}/${n} solved vs ${solvedControl}/${n}`);
  s.verdict = n === 0 ? 'NO DATA' : reasons.length === 0 ? 'PASS' : n < 5 && reasons.length === 1 ? 'INCONCLUSIVE' : 'FAIL';
  s.reasons = reasons;
  return s;
}

// The census reads every request and applies on every one; it edits nothing.
const EDIT_EXEMPT_KINDS = new Set(['content_census']);

/** Edits a session's optimization tally reports (null without a tally: an older record, a control run). */
export function editsIn(tally) {
  if (!tally || typeof tally !== 'object') return null;
  let edits = 0;
  for (const [kind, c] of Object.entries(tally.byKind ?? {})) if (!EDIT_EXEMPT_KINDS.has(kind)) edits += c?.applied ?? 0;
  for (const [kind, n] of Object.entries(tally.otherApplied ?? {})) if (!EDIT_EXEMPT_KINDS.has(kind)) edits += n ?? 0;
  return edits;
}

/** A round's optimization tally for one arm, as `recordRound` stores them. */
const tallyOf = (r, slot) => (slot === 'a' ? r.optimizationA : r.optimization) ?? null;

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
export function solvedPairVerdict(rounds, { treatment = 'b' } = {}) {
  const slots = slotsOf(treatment);
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
  const stats = rule0(pairs, { treatment: slots.treatment });
  const k = pairs.length;
  const reasons = stats.reasons.filter((x) => !x.startsWith('quality dropped')); // pairs are solved on both sides
  const only = (slot) => qualityEvents.filter((e) => e.solvedBy === slot).length;
  if (only(slots.control) > only(slots.treatment)) {
    reasons.push(`quality dropped: only ${slots.control.toUpperCase()} solved ${only(slots.control)} round(s), only ${slots.treatment.toUpperCase()} ${only(slots.treatment)}`);
  }
  let insufficient = k < MIN_SOLVED_PAIRS;
  if (insufficient) reasons.unshift(`only ${k} solved pair(s); a verdict needs at least ${MIN_SOLVED_PAIRS}`);
  // A treatment that never acted has nothing to measure: its ratios are session
  // noise (2026-10-12: the request planner read "neutral" over 19 pairs in which
  // the planner-on arm edited nothing). Only rounds that carry a tally can say.
  const tallied = pairs.filter((r) => editsIn(tallyOf(r, slots.treatment)) != null);
  const treatmentEdits = tallied.filter((r) => editsIn(tallyOf(r, slots.treatment)) > 0).length;
  if (k > 0 && tallied.length === k && treatmentEdits === 0) {
    insufficient = true;
    reasons.unshift(`treatment arm ${slots.treatment.toUpperCase()} applied no optimization in any of the ${k} solved pairs: nothing to measure`);
  }
  const verdict = insufficient ? 'INSUFFICIENT' : reasons.length === 0 ? 'PASS' : k < 5 && reasons.length === 1 ? 'INCONCLUSIVE' : 'FAIL';
  return {
    n: rounds.length, k, pairs: pairs.map((r) => r.round), qualityEvents, neither, noCost, stats, insufficient, verdict, reasons,
    treatment: slots.treatment, treatmentEdits: tallied.length ? treatmentEdits : null,
  };
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

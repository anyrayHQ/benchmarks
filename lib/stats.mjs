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

/**
 * Edits a session's optimization tally reports (null without a tally: an older record, a
 * control run). `only` counts just those kinds.
 */
export function editsIn(tally, only = null) {
  if (!tally || typeof tally !== 'object') return null;
  const counts = (kind) => !EDIT_EXEMPT_KINDS.has(kind) && (!only || only.includes(kind));
  let edits = 0;
  for (const [kind, c] of Object.entries(tally.byKind ?? {})) if (counts(kind)) edits += c?.applied ?? 0;
  for (const [kind, n] of Object.entries(tally.otherApplied ?? {})) if (counts(kind)) edits += n ?? 0;
  return edits;
}

/**
 * The kinds two gateway arms differ by (`--kinds` on A, `--kinds-b` on B): { a: only A
 * requests them, b: only B does }, or null when B requests no kinds of its own or the same.
 */
export function kindDifference(kindsA, kindsB) {
  if (!kindsB) return null;
  const a = (kindsA ?? []).filter((k) => !kindsB.includes(k));
  const b = kindsB.filter((k) => !(kindsA ?? []).includes(k));
  return a.length || b.length ? { a, b } : null;
}

/** A round's optimization tally for one arm, as `recordRound` stores them. */
const tallyOf = (r, slot) => (slot === 'a' ? r.optimizationA : r.optimization) ?? null;

/**
 * Whether a round exercised the treatment: null when it carries no tally to say. Under a
 * kinds difference only those kinds count, each on the arm that requests it (the other
 * arm's own strategies acting is no part of the treatment: 2026-10-15, repeat_factor on
 * vs off read "applied in 3/3" while it acted in 2, command_digest in all 3). Otherwise
 * any edit on the treatment arm counts.
 */
function treated(r, slot, differing) {
  if (!differing) {
    const e = editsIn(tallyOf(r, slot));
    return e == null ? null : e > 0;
  }
  const sides = ['a', 'b'].filter((s) => differing[s].length);
  const edits = sides.map((s) => editsIn(tallyOf(r, s), differing[s]));
  if (edits.some((e) => e == null)) return null;
  return edits.some((e) => e > 0);
}

export const MIN_SOLVED_PAIRS = 3;

/**
 * Whether the kinds two arms differ by would act on this arm's session, from the gateway's
 * shadow answers (ANY-1307): 'on', 'off', or null when some kind has no answer to read.
 * The shadow runs on the client's bytes, which arrive untreated in both arms, so this is
 * the same test on either arm: keeping the pairs that are 'on' in both picks sessions of
 * one shape from each arm, where dropping only the treatment's idle pairs would keep the
 * treatment's on-shape sessions against all of the control's.
 */
function shapeOf(r, slot, kinds) {
  const shadow = tallyOf(r, slot)?.shadow;
  if (!shadow || kinds.some((k) => (shadow[k]?.wouldApply ?? 0) + (shadow[k]?.wouldNot ?? 0) === 0)) return null;
  return kinds.some((k) => shadow[k].wouldApply > 0) ? 'on' : 'off';
}

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
/** The connect client-tool calls each session records (0 when it did not record them). */
const CLIENT_TOOL_CALLS = ['readBatchCalls', 'searchContextCalls'];

/** Under `--client-tool-policy-b`: the treatment arm made more calls of some connect client tool than the control arm. */
const clientToolActed = (r, slots) =>
  CLIENT_TOOL_CALLS.some((k) => (r.sessions?.[slots.treatment]?.totals?.[k] ?? 0) > (r.sessions?.[slots.control]?.totals?.[k] ?? 0));

/**
 * `clientToolTreatment`: the arms differ by a connect client-tool switch
 * (`--client-tool-policy-b`). Their kinds are the same, so their optimizer edits say nothing
 * about the treatment: it acts through client-tool calls (batch reads, Symbol context
 * searches) the control arm did not make.
 */
export function solvedPairVerdict(rounds, { treatment = 'b', differingKinds = null, clientToolTreatment = false } = {}) {
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
  // Under a kinds difference with shadow answers on every solved pair, only the pairs whose
  // two sessions both gave the kinds something to act on are scored: in the rest the arms sent
  // identical bytes for a reason that is not the treatment, so their ratios are session noise.
  const shadowKinds = differingKinds ? [...differingKinds.a, ...differingKinds.b] : [];
  let scored = pairs;
  let offShapePairs = null;
  let shapeNote = null;
  if (shadowKinds.length && pairs.length) {
    const unread = ['a', 'b'].map((slot) => [slot, pairs.filter((r) => shapeOf(r, slot, shadowKinds) === null).map((r) => r.round)]).filter(([, rs]) => rs.length);
    if (unread.length) {
      shapeNote = `no shadow answer for ${shadowKinds.join(', ')} ${unread.map(([slot, rs]) => `on ${slot.toUpperCase()} in round(s) ${rs.join(', ')}`).join('; ')}: every solved pair is scored`;
    } else {
      const onShape = (r) => shapeOf(r, 'a', shadowKinds) === 'on' && shapeOf(r, 'b', shadowKinds) === 'on';
      scored = pairs.filter(onShape);
      offShapePairs = pairs.filter((r) => !onShape(r)).map((r) => r.round);
    }
  }
  const stats = rule0(scored, { treatment: slots.treatment });
  const k = scored.length;
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
  const clientOnly = clientToolTreatment && !differingKinds;
  const tallied = clientOnly ? scored : scored.filter((r) => treated(r, slots.treatment, differingKinds) != null);
  const acted = (r) => (clientToolTreatment && clientToolActed(r, slots)) || (!clientOnly && treated(r, slots.treatment, differingKinds) === true);
  const idle = tallied.filter((r) => !acted(r)).map((r) => r.round);
  const treatmentEdits = tallied.length - idle.length;
  if (k > 0 && tallied.length === k && treatmentEdits === 0) {
    insufficient = true;
    reasons.unshift(clientOnly
      ? `treatment arm ${slots.treatment.toUpperCase()} made no connect client-tool call (batch read, Symbol context search) the control arm did not, in any of the ${k} solved pairs: nothing to measure`
      : differingKinds
      ? `the kinds A and B differ by (${differingNames(differingKinds)}) applied nothing in any of the ${k} solved pairs: nothing to measure`
      : `treatment arm ${slots.treatment.toUpperCase()} applied no optimization in any of the ${k} solved pairs: nothing to measure`);
  }
  const verdict = insufficient ? 'INSUFFICIENT' : reasons.length === 0 ? 'PASS' : k < 5 && reasons.length === 1 ? 'INCONCLUSIVE' : 'FAIL';
  return {
    n: rounds.length, k, solved: pairs.length, pairs: scored.map((r) => r.round), offShapePairs, shapeNote, qualityEvents, neither, noCost, stats, insufficient, verdict, reasons,
    treatment: slots.treatment, treatmentEdits: tallied.length ? treatmentEdits : null,
    idlePairs: tallied.length ? idle : null, differingKinds, ...(clientToolTreatment ? { clientToolTreatment: true } : {}),
  };
}

/** `repeat_factor on A` / `x on A, y on B`: the kinds a pair differs by, for a printout. */
export const differingNames = (d) => ['a', 'b'].filter((s) => d[s].length).map((s) => `${d[s].join(',')} on ${s.toUpperCase()}`).join(', ');

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

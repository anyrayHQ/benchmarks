// Booked vs measured savings for one paired round (--compare anyray): what the gateway's own
// per-request records claimed it saved (trace `savingsUsd`, the figure its spend rows and the
// console report) against what the two sessions actually cost (direct minus Anyray, gateway
// pings included). Rule 0 for savings: a round where Anyray cost the client more must book no
// saving. The gateway cannot see the direct arm, so this bench is where an overclaim shows.

/** Below this, a difference is rounding in per-request pricing, not a claim. */
export const SAVINGS_TOLERANCE_USD = 0.001;

/** What the gateway booked as saved for one session: the sum of its traces' `savingsUsd`. */
export const bookedSavingsUsd = (traces) =>
  (traces?.traces ?? []).reduce((sum, t) => sum + (Number.isFinite(t?.savingsUsd) ? t.savingsUsd : 0), 0);

/**
 * One round's check, or null when it cannot be made (no traces, or an arm without a cost).
 * - `lostButBooked`: Anyray cost more, yet the gateway booked a saving.
 * - `overclaim`: the gateway booked more than the round actually saved (includes lostButBooked).
 */
export const savingsCheck = ({ directUsd, anyrayUsd, traces }) => {
  if (!traces || !Number.isFinite(directUsd) || !Number.isFinite(anyrayUsd)) return null;
  const bookedUsd = bookedSavingsUsd(traces);
  const measuredUsd = directUsd - anyrayUsd;
  return {
    bookedUsd,
    measuredUsd,
    overclaim: bookedUsd > Math.max(0, measuredUsd) + SAVINGS_TOLERANCE_USD,
    lostButBooked: measuredUsd < -SAVINGS_TOLERANCE_USD && bookedUsd > SAVINGS_TOLERANCE_USD,
  };
};

/** The log line for one round's check; louder when the gateway booked a saving on a lost round. */
export const savingsCheckNote = (round, check) => {
  if (!check) return '';
  const fmt = (x) => `$${x.toFixed(3)}`;
  const base = `  round ${round} gateway booked ${fmt(check.bookedUsd)} saved vs measured ${fmt(check.measuredUsd)}`;
  if (check.lostButBooked)
    return `${base}\n  round ${round} WARNING: the gateway booked a saving on a round Anyray lost; it claims savings the client did not get`;
  if (check.overclaim) return `${base} (booked more than the round saved)`;
  return base;
};

/** Run-level summary over the rounds that carry a check. */
export const savingsCheckSummary = (rounds) => {
  const checked = rounds.map((r) => r.savingsCheck).filter(Boolean);
  return {
    rounds: checked.length,
    lostButBooked: checked.filter((c) => c.lostButBooked).length,
    overclaim: checked.filter((c) => c.overclaim).length,
    bookedUsd: checked.reduce((s, c) => s + c.bookedUsd, 0),
    measuredUsd: checked.reduce((s, c) => s + c.measuredUsd, 0),
  };
};

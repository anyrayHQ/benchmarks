// A paired cost verdict. Ratios are B / A; values below one favor B.
import { quantile } from './stats.mjs';

export const DEFAULT_MIN_ROUNDS = 8;

// Two-sided 95% Student t critical values, indexed by degrees of freedom.
const T_975 = [null, 12.706204736, 4.30265273, 3.182446305, 2.776445105,
  2.570581836, 2.446911851, 2.364624252, 2.306004135, 2.262157163,
  2.228138852, 2.20098516, 2.17881283, 2.160368656, 2.144786688,
  2.131449546, 2.119905299, 2.109815578, 2.10092204, 2.093024054,
  2.085963447, 2.079613845, 2.073873068, 2.06865761, 2.063898562,
  2.059538553, 2.055529439, 2.051830516, 2.048407142, 2.045229642,
  2.042272456];

export function tCritical95(df) {
  if (!Number.isInteger(df) || df < 1) throw new RangeError('degrees of freedom must be a positive integer');
  if (df <= 30) return T_975[df];
  // Cornish-Fisher expansion at z_0.975; error is negligible above 30 df.
  const z = 1.959963984540054;
  const z2 = z * z;
  return z + (z ** 3 + z) / (4 * df)
    + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2)
    + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3);
}

const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const sampleSd = (xs, avg) => xs.length < 2 ? null
  : Math.sqrt(xs.reduce((sum, x) => sum + (x - avg) ** 2, 0) / (xs.length - 1));

export function exclusionReasons(round) {
  const reasons = [];
  const a = round?.sessions?.a?.totals;
  const b = round?.sessions?.b?.totals;
  if (round?.error || !Number.isFinite(round?.ratio) || round.ratio <= 0
      || !Number.isFinite(a?.costUsd) || a.costUsd <= 0
      || !Number.isFinite(b?.costUsd) || b.costUsd <= 0) reasons.push('failed round');
  if (round?.gatewayRestarted) reasons.push('gateway restart');
  if (a?.outsideCheckout || b?.outsideCheckout) reasons.push('outside checkout');
  if (round?.quality?.a !== true || round?.quality?.b !== true) reasons.push('not solved');
  return reasons;
}

/** Pure summary of the rounds supplied; costs and ratios come from recorded results. */
export function benchVerdict(rounds, { minRounds = DEFAULT_MIN_ROUNDS } = {}) {
  if (!Array.isArray(rounds)) throw new TypeError('rounds must be an array');
  if (!Number.isInteger(minRounds) || minRounds < 1) throw new RangeError('minRounds must be a positive integer');
  const excluded = [];
  const valid = [];
  for (const [index, round] of rounds.entries()) {
    const reasons = exclusionReasons(round);
    if (reasons.length) excluded.push({ index, round: round?.round ?? null, reasons });
    else valid.push(round);
  }
  const n = valid.length;
  const ratios = valid.map((r) => r.ratio);
  const costsA = valid.map((r) => r.sessions.a.totals.costUsd);
  const costsB = valid.map((r) => r.sessions.b.totals.costUsd);
  const logs = ratios.map(Math.log);
  const meanLog = n ? mean(logs) : null;
  const logSd = n > 1 ? sampleSd(logs, meanLog) : null;
  const margin = n > 1 ? tCritical95(n - 1) * logSd / Math.sqrt(n) : null;
  const ci = margin === null ? null : { logLower: meanLog - margin, logUpper: meanLog + margin,
    lower: Math.exp(meanLog - margin), upper: Math.exp(meanLog + margin) };
  const arm = (xs) => {
    if (!n) return { meanCost: null, coefficientOfVariation: null };
    const avg = mean(xs);
    return { meanCost: avg, coefficientOfVariation: n > 1 ? sampleSd(xs, avg) / avg : null };
  };
  const moreRoundsNeeded = Math.max(0, minRounds - n);
  let verdict = 'inconclusive';
  if (n >= minRounds && ci?.upper < 1) verdict = 'pass';
  else if (ci?.lower > 1) verdict = 'fail';
  const reasons = [];
  if (moreRoundsNeeded) reasons.push(`Need ${moreRoundsNeeded} more valid round(s) to reach the minimum of ${minRounds}.`);
  if (!ci) reasons.push('At least two valid rounds are needed for a confidence interval.');
  else if (verdict === 'inconclusive' && !moreRoundsNeeded) reasons.push('The 95% interval includes a ratio of 1.');
  return {
    verdict, reasons, minRounds, moreRoundsNeeded, totalRounds: rounds.length, n,
    excludedCount: excluded.length,
    excludedByReason: {
      'not solved': excluded.filter((x) => x.reasons.includes('not solved')).length,
      'failed round': excluded.filter((x) => x.reasons.includes('failed round')).length,
      'outside checkout': excluded.filter((x) => x.reasons.includes('outside checkout')).length,
      'gateway restart': excluded.filter((x) => x.reasons.includes('gateway restart')).length,
    },
    excluded,
    meanRatio: n ? mean(ratios) : null,
    medianRatio: quantile(ratios, 0.5),
    geometricMeanRatio: n ? Math.exp(meanLog) : null,
    meanLogRatio: meanLog,
    sampleSdLogRatio: logSd,
    confidenceInterval95: ci,
    wins: ratios.filter((x) => x < 1).length,
    losses: ratios.filter((x) => x > 1).length,
    ties: ratios.filter((x) => x === 1).length,
    arms: { a: arm(costsA), b: arm(costsB) },
    // A point estimate below this ratio would clear the two-sided 95% threshold
    // at the observed variance and n. This is not an 80%-power calculation.
    minimumDetectableRatio: margin === null ? null : Math.exp(-margin),
  };
}

const number = (x, digits = 3) => x === null ? 'n/a' : x.toFixed(digits);

export function formatVerdictBlock(v) {
  const ci = v.confidenceInterval95;
  return [
    `Verdict: ${v.verdict.toUpperCase()}  (${v.n}/${v.totalRounds} valid; minimum ${v.minRounds})`,
    `Excluded: ${v.excludedCount}  (not solved ${v.excludedByReason['not solved']}, failed round ${v.excludedByReason['failed round']}, outside checkout ${v.excludedByReason['outside checkout']}, gateway restart ${v.excludedByReason['gateway restart']}; reasons may overlap)`,
    ...(v.excludedCount ? [`Excluded rounds: ${v.excluded.map((x) => `${x.round ?? x.index + 1} (${x.reasons.join(', ')})`).join('; ')}`] : []),
    `Ratio B/A: mean ${number(v.meanRatio)}, median ${number(v.medianRatio)}, geometric mean ${number(v.geometricMeanRatio)}`,
    `95% t interval for geometric mean: ${ci ? `[${number(ci.lower)}, ${number(ci.upper)}]` : 'n/a'}`,
    `Wins/losses/ties: ${v.wins}/${v.losses}/${v.ties}`,
    `Mean cost / CV: A ${number(v.arms.a.meanCost, 4)} / ${number(v.arms.a.coefficientOfVariation)}; B ${number(v.arms.b.meanCost, 4)} / ${number(v.arms.b.coefficientOfVariation)}`,
    `Minimum detectable B/A ratio at observed variance: ${number(v.minimumDetectableRatio)} (95% threshold; no power guarantee)`,
    ...v.reasons,
  ].join('\n');
}

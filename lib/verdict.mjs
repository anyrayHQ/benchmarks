// Roll per-workload rows up to one verdict per strategy.
//   WORKING  — median saved >= minSavedPct AND no FAIL (MARGINAL within allowance)
//   TUNE     — a FAIL/MARGINAL exists but a sweep knob recovers PASS at decent savings
//   REWORK   — FAIL with no recoverable knob, OR negligible savings everywhere
//   N/A      — readonly strategies (every row quality === 'N/A')

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

// A workload "recovers" if its OWN sweep has a PASS point at acceptable savings.
// (Per-workload — never pool sweep points across workloads, or one workload's
// recovery would mask another's unrecoverable failure.)
const recovers = (g, minSavedPct) =>
  (g.sweep ?? []).some((s) => s.quality === 'PASS' && (s.realSavedPct ?? 0) >= minSavedPct);

export function synthesize(rows, thresholds) {
  const { minSavedPct, allowMarginal } = thresholds;
  const negligibleSavedPct = thresholds.negligibleSavedPct ?? 5;
  const byStrategy = new Map();
  for (const r of rows) {
    if (!byStrategy.has(r.strategy)) byStrategy.set(r.strategy, []);
    byStrategy.get(r.strategy).push(r);
  }
  const out = [];
  for (const [strategy, group] of byStrategy) {
    const savedMedian = median(group.map((g) => g.realSavedPct ?? 0));
    const qualities = group.map((g) => g.quality);
    if (qualities.every((q) => q === 'N/A')) {
      out.push({ strategy, verdict: 'N/A', realSavedPct: savedMedian, qualityPassRate: null, recommendedKnob: null });
      continue;
    }
    const failRows = group.filter((g) => g.quality === 'FAIL');
    const marginals = qualities.filter((q) => q === 'MARGINAL').length;
    const passRate = Math.round((qualities.filter((q) => q === 'PASS').length / qualities.length) * 100);
    const qualityClean = failRows.length === 0 && marginals <= allowMarginal;

    let verdict;
    if (failRows.length > 0 && !failRows.every((g) => recovers(g, minSavedPct))) {
      verdict = 'REWORK'; // a FAIL that no per-workload knob recovers — genuinely broken
    } else if (qualityClean && savedMedian >= minSavedPct) {
      verdict = 'WORKING';
    } else if (savedMedian < negligibleSavedPct && failRows.length === 0) {
      verdict = 'REWORK'; // earns ~nothing and doesn't even break — replace it
    } else {
      verdict = 'TUNE'; // recoverable fails, too many marginals, or below-bar savings
    }

    // Recommend a knob only when tuning. Prefer one that makes EVERY imperfect
    // workload PASS; else the highest-savings PASS point seen in any sweep.
    let recommendedKnob = null;
    if (verdict === 'TUNE') {
      const needFix = group.filter((g) => g.quality === 'FAIL' || g.quality === 'MARGINAL');
      const passKnobs = needFix.map(
        (g) =>
          new Set(
            (g.sweep ?? [])
              .filter((s) => s.quality === 'PASS' && (s.realSavedPct ?? 0) >= minSavedPct)
              .map((s) => JSON.stringify(s.knob))
          )
      );
      const common =
        passKnobs.length && passKnobs.every((s) => s.size)
          ? [...passKnobs[0]].find((k) => passKnobs.every((s) => s.has(k)))
          : undefined;
      if (common) recommendedKnob = JSON.parse(common);
      else {
        const best = group
          .flatMap((g) => g.sweep ?? [])
          .filter((s) => s.quality === 'PASS' && (s.realSavedPct ?? 0) >= minSavedPct)
          .sort((a, b) => (b.realSavedPct ?? 0) - (a.realSavedPct ?? 0))[0];
        recommendedKnob = best?.knob ?? null;
      }
    }

    out.push({ strategy, verdict, realSavedPct: savedMedian, qualityPassRate: passRate, recommendedKnob });
  }
  return out;
}

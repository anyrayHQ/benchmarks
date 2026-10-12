// Pairwise cost comparison for an sdk-app-scanner result file. The lane has three arms —
// A (gateway, harness-retrieval off), B (gateway, on), C (direct Bedrock) — so the Rule 0
// read is per PAIR: B/A and B/C are the flip's win conditions (D5), A/C is the gateway
// overhead baseline. For each pair this reports, over rounds where BOTH arms solved and
// both costs are finite and positive, the per-round ratios, win count (ratio < 1),
// median, Q3 and max, plus the quality check (recall parity). Reading only; no model
// traffic. Run: node tools/compare-sdk-app.mjs results/agent/sdk-app-scanner--<label>.json

import { readFileSync } from 'node:fs';
import { quantile } from '../lib/stats.mjs';

const EPS = 0.001;

/** Rounds usable for a pair: both arms present, both solved, both costs finite and > 0. */
export const pairRounds = (rounds, treatment, control) =>
  rounds.filter((r) => {
    const t = r.sessions?.[treatment]?.totals;
    const c = r.sessions?.[control]?.totals;
    return (
      r.quality?.[treatment] === true &&
      r.quality?.[control] === true &&
      Number.isFinite(t?.costUsd) && t.costUsd > 0 &&
      Number.isFinite(c?.costUsd) && c.costUsd > 0
    );
  });

/** One pair's summary: ratios treatment/control, wins (< 1), median, Q3, max, and the
 *  recall deltas per round so a cost win bought by lost findings is visible. */
export const comparePair = (rounds, treatment, control) => {
  const used = pairRounds(rounds, treatment, control);
  const ratios = used.map((r) => r.sessions[treatment].totals.costUsd / r.sessions[control].totals.costUsd);
  const wins = ratios.filter((x) => x < 1 - EPS).length;
  const losses = ratios.filter((x) => x > 1 + EPS).length;
  const recallDelta = used.map((r) => (r.recall?.[treatment] ?? r.sessions[treatment]?.recall ?? 0) - (r.recall?.[control] ?? r.sessions[control]?.recall ?? 0));
  return {
    treatment,
    control,
    n: used.length,
    wins,
    losses,
    winRate: used.length ? wins / used.length : null,
    median: quantile(ratios, 0.5),
    q3: quantile(ratios, 0.75),
    max: used.length ? Math.max(...ratios) : null,
    min: used.length ? Math.min(...ratios) : null,
    ratios: used.map((r, i) => ({ round: r.round, ratio: ratios[i], recallDelta: recallDelta[i] })),
    recallNeverWorseBy2: recallDelta.every((d) => d > -2),
  };
};

/** Which pairs to compute, by the arms the file actually ran. */
export const pairsFor = (arms) => {
  const has = (x) => arms.includes(x);
  const out = [];
  if (has('B') && has('A')) out.push(['B', 'A']);
  if (has('B') && has('C')) out.push(['B', 'C']);
  if (has('A') && has('C')) out.push(['A', 'C']);
  return out;
};

/** The whole file's comparison: every applicable pair, plus the recorded retrieval
 *  evidence so the D4 precondition can be read beside the D5 ratios. */
export const compareFile = (record) => {
  const arms = record.arms ?? ['A', 'B', 'C'];
  const rounds = record.rounds ?? [];
  return {
    scenario: record.scenario ?? 'sdk-app-scanner',
    model: record.model ?? null,
    arms,
    rounds: rounds.length,
    pairs: pairsFor(arms).map(([t, c]) => comparePair(rounds, t, c)),
    retrievalEvidence: record.retrievalEvidence ?? null,
  };
};

const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tools/compare-sdk-app.mjs <result.json>');
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const out = compareFile(record);
  console.log(`sdk-app-scanner [${out.arms.join(',')}] ${out.rounds} round(s), model ${out.model ?? 'n/a'}`);
  for (const p of out.pairs) {
    console.log(
      `  ${p.treatment}/${p.control}: solved pairs ${p.n}, wins ${p.wins}/${p.n}, median ${fmt(p.median)}, Q3 ${fmt(p.q3)}, max ${fmt(p.max)}` +
        (p.recallNeverWorseBy2 ? '' : '  [recall dropped 2+ on a pair]')
    );
    for (const r of p.ratios) console.log(`    round ${r.round}: ${fmt(r.ratio)} (recall Δ ${r.recallDelta >= 0 ? '+' : ''}${r.recallDelta})`);
  }
  if (out.retrievalEvidence) {
    for (const [arm, ev] of Object.entries(out.retrievalEvidence)) {
      console.log(`  retrieval evidence ${arm}: ${JSON.stringify(ev)}`);
    }
  }
}

// RED stubs (replaced in the green step)
export const d4Precondition = () => ({});
export const formatReport = () => "";

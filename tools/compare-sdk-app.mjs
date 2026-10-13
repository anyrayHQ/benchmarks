// Pairwise cost comparison for an sdk-app lane result file (sdk-app-scanner,
// sdk-app-code-scan). The arms share one gateway — A (harness-retrieval off), B (on),
// C (optimize-off baseline bypass), D (B plus connect's anyray_read_batch) — so
// the Rule 0 read is per PAIR: B/A and B/C are the flip's win conditions (D5), A/C is what
// the gateway's other strategies do on this shape. The report states the D4 precondition
// first (did B's mechanism run at all), then for each pair, over rounds where BOTH arms
// are valid and both costs are finite and positive, the per-round ratios, win count
// (ratio < 1), median, Q3 and max, plus recall and turn medians. Reading only; no model
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
  const recallOf = (r, arm) => r.recall?.[arm] ?? r.sessions[arm]?.recall ?? 0;
  const recallDelta = used.map((r) => recallOf(r, treatment) - recallOf(r, control));
  const medianOf = (pick) => quantile(used.map(pick).filter(Number.isFinite), 0.5);
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
    recall: { treatment: medianOf((r) => recallOf(r, treatment)), control: medianOf((r) => recallOf(r, control)) },
    turns: { treatment: medianOf((r) => r.sessions[treatment].totals.turns), control: medianOf((r) => r.sessions[control].totals.turns) },
  };
};

/**
 * D4, read before any ratio: did B's mechanism run? A B session counts as minted only
 * when its per-session evidence shows `direct` requests AND fresh handles above zero; an
 * unknown mint count (null) or an unread session is not proof. At least half the B
 * sessions must have minted, and a file with no B session never passes.
 */
export const d4Precondition = (rounds) => {
  const withB = rounds.filter((r) => r.sessions?.B);
  const mintedRounds = withB
    .filter((r) => {
      const ev = r.sessions.B.retrieval;
      return (ev?.evidence?.direct ?? 0) > 0 && Number.isFinite(ev?.freshEmitted) && ev.freshEmitted > 0;
    })
    .map((r) => r.round);
  const required = Math.ceil(withB.length / 2);
  return { sessions: withB.length, minted: mintedRounds.length, mintedRounds, required, pass: withB.length > 0 && mintedRounds.length >= required };
};

/** Which pairs to compute, by the arms the file actually ran. */
export const pairsFor = (arms) => {
  const has = (x) => arms.includes(x);
  const out = [];
  if (has('B') && has('A')) out.push(['B', 'A']);
  if (has('B') && has('C')) out.push(['B', 'C']);
  if (has('A') && has('C')) out.push(['A', 'C']);
  // D is B plus connect's batch read: D/B isolates the batch read, D/A is D against the
  // retrieval-off SDK app.
  if (has('D') && has('B')) out.push(['D', 'B']);
  if (has('D') && has('A')) out.push(['D', 'A']);
  // E is D with connect's sdk source (initialize instructions): E/B is the batch read with
  // its guidance, E/D isolates the guidance.
  if (has('E') && has('B')) out.push(['E', 'B']);
  if (has('E') && has('D')) out.push(['E', 'D']);
  // P is B plus connect's profile surface, S the same with the sdk instructions: S/P is
  // the hint alone.
  if (has('S') && has('P')) out.push(['S', 'P']);
  return out;
};

/**
 * D's precondition, read before any D ratio: did the batch read run? A D session counts
 * when its agents called anyray_read_batch at least once with at least one call not
 * errored. At least half the D sessions must have, and a file with no D session never
 * passes. A D that never batch-read measured B plus the tool's prefix bytes, not the tool.
 */
export const readBatchPrecondition = (rounds, arm = 'D') => {
  const withD = rounds.filter((r) => r.sessions?.[arm]);
  const usedRounds = withD
    .filter((r) => {
      const rb = r.sessions[arm].totals?.readBatch;
      return Number.isFinite(rb?.calls) && rb.calls > 0 && rb.calls > (rb.errors ?? 0);
    })
    .map((r) => r.round);
  const required = Math.ceil(withD.length / 2);
  return { sessions: withD.length, used: usedRounds.length, usedRounds, required, pass: withD.length > 0 && usedRounds.length >= required };
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
    d4: d4Precondition(rounds),
    readBatch: readBatchPrecondition(rounds),
    readBatchByArm: Object.fromEntries(['D', 'E', 'P', 'S', 'S2'].filter((a) => arms.includes(a)).map((a) => [a, readBatchPrecondition(rounds, a)])),
    pairs: pairsFor(arms).map(([t, c]) => comparePair(rounds, t, c)),
    retrievalEvidence: record.retrievalEvidence ?? null,
  };
};

const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));
const num = (x) => (x == null ? 'n/a' : String(Math.round(x * 10) / 10));

/** The text report: header, the D4 precondition, then each pair. */
export const formatReport = (out) => {
  const lines = [`${out.scenario ?? 'sdk-app-scanner'} [${out.arms.join(',')}] ${out.rounds} round(s), model ${out.model ?? 'n/a'}`];
  const d = out.d4;
  if (!d || d.sessions === 0) lines.push('D4 precondition: n/a, no B session in this file');
  else {
    lines.push(
      `D4 precondition (B sessions with evidence direct and fresh handles > 0): ${d.minted}/${d.sessions}, need ${d.required} -> ${d.pass ? 'PASS' : 'FAIL: the mechanism did not run, so no ratio below is a verdict'}` +
        (d.mintedRounds.length ? ` (rounds ${d.mintedRounds.join(', ')})` : '')
    );
  }
  for (const [arm, rb] of Object.entries(out.readBatchByArm ?? { D: out.readBatch })) {
    if (!rb || rb.sessions === 0) continue;
    lines.push(
      `read_batch precondition ${arm} (${arm} sessions that called anyray_read_batch with a call not errored): ${rb.used}/${rb.sessions}, need ${rb.required} -> ${rb.pass ? 'PASS' : `FAIL: the batch read did not run, so no ${arm} ratio below is a verdict`}` +
        (rb.usedRounds.length ? ` (rounds ${rb.usedRounds.join(', ')})` : '')
    );
  }
  for (const p of out.pairs) {
    lines.push(
      `  ${p.treatment}/${p.control}: valid pairs ${p.n}, wins ${p.wins}/${p.n}, median ${fmt(p.median)}, Q3 ${fmt(p.q3)}, max ${fmt(p.max)}` +
        ` | recall median ${num(p.recall?.treatment)} vs ${num(p.recall?.control)}, turns median ${num(p.turns?.treatment)} vs ${num(p.turns?.control)}` +
        (p.recallNeverWorseBy2 ? '' : '  [recall dropped 2+ on a pair]')
    );
    for (const r of p.ratios) lines.push(`    round ${r.round}: ${fmt(r.ratio)} (recall Δ ${r.recallDelta >= 0 ? '+' : ''}${r.recallDelta})`);
  }
  if (out.retrievalEvidence) {
    for (const [arm, ev] of Object.entries(out.retrievalEvidence)) lines.push(`  retrieval evidence ${arm}: ${JSON.stringify(ev)}`);
  }
  return lines.join('\n');
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node tools/compare-sdk-app.mjs <result.json>');
    process.exit(2);
  }
  console.log(formatReport(compareFile(JSON.parse(readFileSync(file, 'utf8')))));
}

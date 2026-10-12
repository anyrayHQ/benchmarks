// Pairwise cost comparison for an sdk-app-scanner result file. The lane has three arms on
// one gateway — A (harness-retrieval off), B (on), C (optimize-off baseline bypass) — so
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
  const totalsOf = (r, arm) => r.sessions[arm].totals;
  const turnsOf = (r, arm) => totalsOf(r, arm).mainTurns ?? totalsOf(r, arm).turns;
  // Subagent threads pooled over every round, so one long thread is weighed as one thread.
  const pooledSubTurns = (arm) => quantile(used.flatMap((r) => totalsOf(r, arm).subagentTurns ?? []).filter(Number.isFinite), 0.5);
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
    ratios: used.map((r, i) => ({
      round: r.round,
      ratio: ratios[i],
      recallDelta: recallDelta[i],
      spawns: { treatment: totalsOf(r, treatment).subagentSpawns ?? null, control: totalsOf(r, control).subagentSpawns ?? null },
    })),
    recallNeverWorseBy2: recallDelta.every((d) => d > -2),
    recall: { treatment: medianOf((r) => recallOf(r, treatment)), control: medianOf((r) => recallOf(r, control)) },
    // Turns are main-thread API requests where the session counted them; the SDK's own
    // num_turns counts per tool call (48 for a 13-request thread in the ANY-1105 smoke).
    turns: { treatment: medianOf((r) => turnsOf(r, treatment)), control: medianOf((r) => turnsOf(r, control)) },
    spawns: { treatment: medianOf((r) => totalsOf(r, treatment).subagentSpawns), control: medianOf((r) => totalsOf(r, control).subagentSpawns) },
    parallel: { treatment: used.filter((r) => totalsOf(r, treatment).spawnedInParallel === true).length, control: used.filter((r) => totalsOf(r, control).spawnedInParallel === true).length },
    subagentTurns: { treatment: pooledSubTurns(treatment), control: pooledSubTurns(control) },
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
    d4: d4Precondition(rounds),
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
  for (const p of out.pairs) {
    lines.push(
      `  ${p.treatment}/${p.control}: valid pairs ${p.n}, wins ${p.wins}/${p.n}, median ${fmt(p.median)}, Q3 ${fmt(p.q3)}, max ${fmt(p.max)}` +
        ` | recall median ${num(p.recall?.treatment)} vs ${num(p.recall?.control)}, turns median ${num(p.turns?.treatment)} vs ${num(p.turns?.control)}` +
        (p.spawns ? `, spawns median ${num(p.spawns.treatment)} vs ${num(p.spawns.control)}, parallel ${p.parallel.treatment}/${p.n} vs ${p.parallel.control}/${p.n}, subagent turns median ${num(p.subagentTurns.treatment)} vs ${num(p.subagentTurns.control)}` : '') +
        (p.recallNeverWorseBy2 ? '' : '  [recall dropped 2+ on a pair]')
    );
    for (const r of p.ratios) {
      const sp = r.spawns && r.spawns.treatment != null ? `, spawns ${r.spawns.treatment} vs ${r.spawns.control}` : '';
      lines.push(`    round ${r.round}: ${fmt(r.ratio)} (recall Δ ${r.recallDelta >= 0 ? '+' : ''}${r.recallDelta}${sp})`);
    }
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

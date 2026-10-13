// Pairwise cost comparison for an sdk-app-scanner result file. The lane has three arms on
// one gateway — A (harness-retrieval off), B (on), C (optimize-off baseline bypass) — so
// the Rule 0 read is per PAIR: B/A and B/C are the flip's win conditions (D5), A/C is what
// the gateway's other strategies do on this shape. R/K is one strategy's paired verdict:
// both arms pin their kinds by header and R adds one (repeat_factor, ANY-1154); its report
// first states whether that kind acted (folded on R, never decided on K, from the trace
// metadata each session recorded), and a round where the session gate held a kind out of
// either arm is excluded from the ratios and listed, since it compares other strategy sets. The report states the D4 precondition
// first (did B's mechanism run at all), then for each pair, over rounds where BOTH arms
// are valid and both costs are finite and positive, the per-round ratios, win count
// (ratio < 1), median, Q3 and max, plus recall and turn medians. Reading only; no model
// traffic. Run: node tools/compare-sdk-app.mjs results/agent/<scenario>--<label>.json
// [--spend-mints <file>], the file giving B's fresh mints per round from its spend rows.

import { readFileSync } from 'node:fs';
import { quantile } from '../lib/stats.mjs';

const EPS = 0.001;

/**
 * The kinds the gateway's session gate withheld from one session: named by the response
 * feedback the arm's pass-through tallied, or by the trace metadata's suppression ledger.
 * A session that pinned no kinds has none.
 */
export const heldOutOf = (session) => {
  const fromFeedback = Array.isArray(session?.optimization?.heldOut) ? session.optimization.heldOut : [];
  const fromTraces = Object.entries(session?.kindEvidence?.kinds ?? {}).filter(([, e]) => e?.holdout === true).map(([k]) => k);
  return [...new Set([...fromFeedback, ...fromTraces])].sort();
};

/** Rounds both arms completed with finite, positive costs (holdouts not yet removed). */
const completedRounds = (rounds, treatment, control) =>
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

const heldOutIn = (r, arm) => heldOutOf(r.sessions?.[arm]);

/** The CLI's model switches in one session, as `from->to@afterRequest`. */
const fallbacksIn = (r, arm) => (Array.isArray(r.sessions?.[arm]?.modelFallbacks) ? r.sessions[arm].modelFallbacks : []).map((f) => `${f.from}->${f.to}@${f.afterRequest}`);

/** Rounds usable for a pair: both arms present, both solved, both costs finite and > 0,
 *  and no kind held out of either session by the gateway's session gate. */
export const pairRounds = (rounds, treatment, control) =>
  completedRounds(rounds, treatment, control).filter((r) => !heldOutIn(r, treatment).length && !heldOutIn(r, control).length);

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
  // The billed read: the same rounds by the SDK's own total_cost_usd, which equals what the
  // gateway billed (the priced usage misses subagent output deltas and requests the stream
  // never surfaced). Rounds missing it on either side drop out of this read only.
  const billedUsed = used.filter((r) => [treatment, control].every((arm) => Number.isFinite(r.sessions[arm].totals.sdkCostUsd) && r.sessions[arm].totals.sdkCostUsd > 0));
  const billedRatios = billedUsed.map((r) => r.sessions[treatment].totals.sdkCostUsd / r.sessions[control].totals.sdkCostUsd);
  const billedByRound = new Map(billedUsed.map((r, i) => [r.round, billedRatios[i]]));
  const billed = {
    n: billedUsed.length,
    wins: billedRatios.filter((x) => x < 1 - EPS).length,
    losses: billedRatios.filter((x) => x > 1 + EPS).length,
    median: quantile(billedRatios, 0.5),
    q3: quantile(billedRatios, 0.75),
    max: billedUsed.length ? Math.max(...billedRatios) : null,
    ratios: billedUsed.map((r, i) => ({ round: r.round, ratio: billedRatios[i] })),
  };
  const heldOutRounds = completedRounds(rounds, treatment, control)
    .filter((r) => heldOutIn(r, treatment).length || heldOutIn(r, control).length)
    .map((r) => ({ round: r.round, treatment: heldOutIn(r, treatment), control: heldOutIn(r, control) }));
  return {
    treatment,
    control,
    n: used.length,
    billed,
    modelFallbackRounds: used
      .map((r) => ({ round: r.round, treatment: fallbacksIn(r, treatment), control: fallbacksIn(r, control) }))
      .filter((x) => x.treatment.length || x.control.length),
    heldOutRounds,
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
      billedRatio: billedByRound.get(r.round) ?? null,
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
 * when its per-session evidence shows `direct` requests AND fresh handles above zero. A
 * mint count the self-check could not read (null) is UNKNOWN, kept apart from a read of
 * zero: it is not proof of a mint, and not proof the mechanism never ran either.
 * `spendMints` ({ [round]: { B: n } }, counted from the B key's spend rows by an operator
 * with database access) answers an unknown; the self-check's own count wins when it has
 * one. At least half the B sessions must have minted; no B session never passes.
 */
export const d4Precondition = (rounds, { spendMints = null } = {}) => {
  const withB = rounds.filter((r) => r.sessions?.B);
  const mintedRounds = [];
  const unknownRounds = [];
  for (const r of withB) {
    const ev = r.sessions.B.retrieval;
    if (!((ev?.evidence?.direct ?? 0) > 0)) continue;
    const spend = spendMints?.[r.round]?.B;
    const fresh = Number.isFinite(ev.freshEmitted) ? ev.freshEmitted : Number.isFinite(spend) ? spend : null;
    if (fresh === null) unknownRounds.push(r.round);
    else if (fresh > 0) mintedRounds.push(r.round);
  }
  const required = Math.ceil(withB.length / 2);
  return {
    sessions: withB.length,
    minted: mintedRounds.length,
    mintedRounds,
    unknown: unknownRounds.length,
    unknownRounds,
    required,
    pass: withB.length > 0 && mintedRounds.length >= required,
  };
};

/** Which pairs to compute, by the arms the file actually ran. */
export const pairsFor = (arms) => {
  const has = (x) => arms.includes(x);
  const out = [];
  if (has('B') && has('A')) out.push(['B', 'A']);
  if (has('B') && has('C')) out.push(['B', 'C']);
  if (has('A') && has('C')) out.push(['A', 'C']);
  if (has('R') && has('K')) out.push(['R', 'K']);
  return out;
};

/** The kinds the treatment pins and the control does not (both must pin a list). */
const addedKinds = (record, treatment, control) => {
  const t = record.armSpecs?.[treatment]?.kinds;
  const c = record.armSpecs?.[control]?.kinds;
  return Array.isArray(t) && Array.isArray(c) ? t.filter((k) => !c.includes(k)) : [];
};

/**
 * Did the kind the treatment adds act? Per kind, from each session's trace-metadata
 * evidence: the treatment sessions that folded (a fresh fold, or blocks factored), the
 * control sessions where the kind decided anything at all (must be none), the sessions
 * whose evidence could not be read (unknown, never zero), and the treatment sessions the
 * session gate held the kind out of (no evidence either way). Passes when at least one
 * readable treatment session folded and no control session decided; null when nothing
 * was readable.
 */
export const kindEvidenceFor = (record, treatment, control) => {
  const kinds = addedKinds(record, treatment, control);
  const rounds = record.rounds ?? [];
  const byKind = kinds.map((kind) => {
    const sessions = [];
    const heldOutRounds = [];
    let unknown = 0;
    let controlDecided = 0;
    let controlRead = 0;
    for (const r of rounds) {
      const tEv = r.sessions?.[treatment]?.kindEvidence?.kinds?.[kind];
      const cSession = r.sessions?.[control];
      const cEv = cSession?.kindEvidence?.kinds?.[kind];
      if (cEv) {
        controlRead++;
        if (cEv.requestsWithKind > 0) controlDecided++;
      } else if (cSession) unknown++;
      if (!r.sessions?.[treatment]) continue;
      if (!tEv) {
        unknown++;
        continue;
      }
      if (tEv.holdout || heldOutIn(r, treatment).includes(kind)) {
        heldOutRounds.push(r.round);
        continue;
      }
      sessions.push({
        round: r.round,
        holdout: false,
        requestsWithKind: tEv.requestsWithKind,
        freshFolds: tEv.freshFolds,
        blocksFactored: tEv.blocksFactored,
        freshTokens: tEv.freshTokens,
        replays: tEv.replays,
        replayTokens: tEv.replayTokens,
        tokensSaved: tEv.tokensSaved,
        declines: tEv.declines ?? {},
        suppressed: tEv.suppressed ?? {},
        controlDecided: cEv ? cEv.requestsWithKind : null,
      });
    }
    const foldedRounds = sessions.filter((x) => x.freshFolds > 0 || x.blocksFactored > 0).map((x) => x.round);
    const readable = sessions.length > 0 && controlRead > 0;
    return {
      kind,
      treatmentSessions: sessions.length,
      folded: foldedRounds.length,
      foldedRounds,
      controlSessions: controlRead,
      controlDecided,
      unknown,
      heldOutRounds,
      sessions,
      pass: readable ? foldedRounds.length > 0 && controlDecided === 0 : null,
    };
  });
  return { treatment, control, kinds, byKind };
};

/** The whole file's comparison: every applicable pair, plus the recorded retrieval
 *  evidence so the D4 precondition can be read beside the D5 ratios. */
export const compareFile = (record, { spendMints = null } = {}) => {
  const arms = record.arms ?? ['A', 'B', 'C'];
  const rounds = record.rounds ?? [];
  return {
    scenario: record.scenario ?? 'sdk-app-scanner',
    model: record.model ?? null,
    arms,
    rounds: rounds.length,
    d4: d4Precondition(rounds, { spendMints }),
    pairs: pairsFor(arms).map(([t, c]) => comparePair(rounds, t, c)),
    kindEvidence: pairsFor(arms).map(([t, c]) => kindEvidenceFor(record, t, c)).filter((e) => e.kinds.length),
    retrievalEvidence: record.retrievalEvidence ?? null,
  };
};

const fmt = (x) => (x == null ? 'n/a' : x.toFixed(3));
const num = (x) => (x == null ? 'n/a' : String(Math.round(x * 10) / 10));

/** The text report: header, the D4 precondition, then each pair. */
export const formatReport = (out) => {
  const lines = [`${out.scenario ?? 'sdk-app-scanner'} [${out.arms.join(',')}] ${out.rounds} round(s), model ${out.model ?? 'n/a'}`];
  const d = out.d4;
  if (!d || d.sessions === 0) {
    if (!out.arms.includes('B')) {
      // No B arm: D4 (the harness flip's mechanism) does not apply to this file.
    } else lines.push('D4 precondition: n/a, no B session in this file');
  }
  else {
    const unknownCanPass = !d.pass && d.minted + (d.unknown ?? 0) >= d.required;
    const verdict = d.pass
      ? 'PASS'
      : unknownCanPass
        ? `UNKNOWN: the self-check could not count mints for round(s) ${d.unknownRounds.join(', ')}; count them from the B key's spend rows and pass --spend-mints`
        : 'FAIL: the mechanism did not run, so no ratio below is a verdict';
    lines.push(
      `D4 precondition (B sessions with evidence direct and fresh handles > 0): ${d.minted}/${d.sessions}, need ${d.required} -> ${verdict}` +
        (d.mintedRounds.length ? ` (rounds ${d.mintedRounds.join(', ')})` : '')
    );
  }
  for (const ev of out.kindEvidence ?? []) {
    for (const k of ev.byKind) {
      const verdict = k.pass === null ? 'UNKNOWN: no readable evidence (pass --admin-token-file to the runner)' : k.pass ? 'PASS' : 'FAIL: no ratio below is a verdict on this kind';
      lines.push(
        `${k.kind} evidence (${ev.treatment} folds, ${ev.control} never decides): folded in ${k.folded}/${k.treatmentSessions} ${ev.treatment} session(s), ${ev.control} decided in ${k.controlDecided}/${k.controlSessions} -> ${verdict}` +
          (k.unknown ? ` [${k.unknown} session(s) unread]` : '') +
          (k.heldOutRounds.length ? ` [held out of ${ev.treatment} in round(s) ${k.heldOutRounds.join(', ')}]` : '')
      );
      for (const x of k.sessions) {
        const reasons = (o) => Object.entries(o).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
        lines.push(
          `    round ${x.round} ${ev.treatment} ${k.kind}: fresh folds ${num(x.freshFolds)} (${num(x.blocksFactored)} blocks, ${num(x.freshTokens)} tokens), replays ${num(x.replays)} (${num(x.replayTokens)} tokens), on ${x.requestsWithKind} requests; declines ${reasons(x.declines)}; ${ev.control} decided ${x.controlDecided ?? 'unread'}`
        );
      }
    }
  }
  for (const p of out.pairs) {
    lines.push(
      `  ${p.treatment}/${p.control}: valid pairs ${p.n}, wins ${p.wins}/${p.n}, median ${fmt(p.median)}, Q3 ${fmt(p.q3)}, max ${fmt(p.max)}` +
        ` | recall median ${num(p.recall?.treatment)} vs ${num(p.recall?.control)}, turns median ${num(p.turns?.treatment)} vs ${num(p.turns?.control)}` +
        (p.spawns ? `, spawns median ${num(p.spawns.treatment)} vs ${num(p.spawns.control)}, parallel ${p.parallel.treatment}/${p.n} vs ${p.parallel.control}/${p.n}, subagent turns median ${num(p.subagentTurns.treatment)} vs ${num(p.subagentTurns.control)}` : '') +
        (p.recallNeverWorseBy2 ? '' : '  [recall dropped 2+ on a pair]')
    );
    if (p.billed?.n) lines.push(`  ${p.treatment}/${p.control} billed (SDK total_cost_usd): valid pairs ${p.billed.n}, wins ${p.billed.wins}/${p.billed.n}, median ${fmt(p.billed.median)}, Q3 ${fmt(p.billed.q3)}, max ${fmt(p.billed.max)}`);
    for (const f of p.modelFallbackRounds ?? []) {
      const who = [f.treatment.length && `${p.treatment} ${f.treatment.join(',')}`, f.control.length && `${p.control} ${f.control.join(',')}`].filter(Boolean).join('; ');
      lines.push(`    model fallback: round ${f.round} ${who}`);
    }
    for (const h of p.heldOutRounds ?? []) {
      const who = [h.treatment.length && `${p.treatment} ${h.treatment.join(',')}`, h.control.length && `${p.control} ${h.control.join(',')}`].filter(Boolean).join('; ');
      lines.push(`    held out (excluded): round ${h.round} ${who}`);
    }
    for (const r of p.ratios) {
      const sp = r.spawns && r.spawns.treatment != null ? `, spawns ${r.spawns.treatment} vs ${r.spawns.control}` : '';
      const billedNote = r.billedRatio != null ? `, billed ${fmt(r.billedRatio)}` : '';
      lines.push(`    round ${r.round}: ${fmt(r.ratio)} (recall Δ ${r.recallDelta >= 0 ? '+' : ''}${r.recallDelta}${billedNote}${sp})`);
    }
  }
  if (out.retrievalEvidence) {
    for (const [arm, ev] of Object.entries(out.retrievalEvidence)) lines.push(`  retrieval evidence ${arm}: ${JSON.stringify(ev)}`);
  }
  return lines.join('\n');
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--spend-mints');
  const spendMints = at >= 0 ? JSON.parse(readFileSync(argv[at + 1], 'utf8')) : null;
  const [file] = argv.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (!file) {
    console.error('usage: node tools/compare-sdk-app.mjs <result.json> [--spend-mints <{ "<round>": { "B": n } }.json>]');
    process.exit(2);
  }
  console.log(formatReport(compareFile(JSON.parse(readFileSync(file, 'utf8')), { spendMints })));
}

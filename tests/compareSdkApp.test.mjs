import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRounds, comparePair, pairsFor, compareFile, d4Precondition, formatReport, heldOutOf, kindEvidenceFor } from '../tools/compare-sdk-app.mjs';

const roundOf = (round, costs, solved, recall) => ({
  round,
  sessions: Object.fromEntries(Object.entries(costs).map(([arm, costUsd]) => [arm, { totals: { costUsd } }])),
  quality: solved,
  recall,
});

test('pairRounds keeps only rounds both arms solved with positive finite costs', () => {
  const rounds = [
    roundOf(1, { A: 1.0, C: 0.8 }, { A: true, C: true }, { A: 10, C: 10 }),
    roundOf(2, { A: 1.0, C: 0.8 }, { A: true, C: false }, { A: 10, C: 9 }), // C not solved
    roundOf(3, { A: 0, C: 0.8 }, { A: true, C: true }, { A: 10, C: 10 }), // A cost 0
    roundOf(4, { A: 1.0, C: 1.2 }, { A: true, C: true }, { A: 10, C: 10 }),
  ];
  assert.deepEqual(pairRounds(rounds, 'A', 'C').map((r) => r.round), [1, 4]);
});

test('comparePair reports wins, median, Q3 and max over the treatment/control ratios', () => {
  // Ratios B/A: 0.5, 0.8, 1.2, 1.6 → wins 2/4, median 1.0, Q3 1.3, max 1.6.
  const rounds = [
    roundOf(1, { A: 1.0, B: 0.5 }, { A: true, B: true }, { A: 10, B: 10 }),
    roundOf(2, { A: 1.0, B: 0.8 }, { A: true, B: true }, { A: 10, B: 10 }),
    roundOf(3, { A: 1.0, B: 1.2 }, { A: true, B: true }, { A: 10, B: 10 }),
    roundOf(4, { A: 1.0, B: 1.6 }, { A: true, B: true }, { A: 10, B: 10 }),
  ];
  const p = comparePair(rounds, 'B', 'A');
  assert.equal(p.n, 4);
  assert.equal(p.wins, 2);
  assert.equal(p.losses, 2);
  assert.equal(p.median, 1.0);
  assert.equal(p.q3, 1.3);
  assert.equal(p.max, 1.6);
  assert.equal(p.ratios.length, 4);
  assert.equal(p.ratios[0].ratio, 0.5);
});

test('comparePair flags a cost win that dropped two or more findings', () => {
  const good = comparePair([roundOf(1, { B: 0.5, A: 1.0 }, { A: true, B: true }, { A: 10, B: 9 })], 'B', 'A');
  assert.equal(good.recallNeverWorseBy2, true);
  assert.equal(good.ratios[0].recallDelta, -1);
  const bad = comparePair([roundOf(1, { B: 0.5, A: 1.0 }, { A: true, B: true }, { A: 10, B: 8 })], 'B', 'A');
  assert.equal(bad.recallNeverWorseBy2, false);
});

test('pairsFor computes only the pairs the arms support', () => {
  assert.deepEqual(pairsFor(['A', 'B', 'C']), [['B', 'A'], ['B', 'C'], ['A', 'C']]);
  assert.deepEqual(pairsFor(['A', 'C']), [['A', 'C']]);
  assert.deepEqual(pairsFor(['A']), []);
});

test('compareFile summarizes the file and carries the retrieval evidence through', () => {
  const record = {
    scenario: 'sdk-app-scanner',
    model: 'claude-haiku-4-5',
    arms: ['A', 'C'],
    rounds: [roundOf(1, { A: 1.0, C: 0.9 }, { A: true, C: true }, { A: 10, C: 10 })],
    retrievalEvidence: { key: { state: 'measured', freshEmitted: 0 } },
  };
  const out = compareFile(record);
  assert.equal(out.arms.join(','), 'A,C');
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs[0].treatment, 'A');
  assert.equal(out.pairs[0].control, 'C');
  assert.deepEqual(out.retrievalEvidence, { key: { state: 'measured', freshEmitted: 0 } });
});

const bSession = (direct, freshEmitted) => ({ totals: { costUsd: 1 }, retrieval: { requests: 10, evidence: direct ? { direct } : { no_discovery: 10 }, freshEmitted } });

test('d4Precondition counts B sessions that minted: evidence direct AND fresh handles above zero', () => {
  const rounds = [
    { round: 1, sessions: { B: bSession(8, 3) } }, // minted
    { round: 2, sessions: { B: bSession(8, 0) } }, // direct but nothing minted
    { round: 3, sessions: { B: bSession(0, 5) } }, // mints counted but never direct
    { round: 4, sessions: { B: bSession(8, null) } }, // mint count unknown: not proof
    { round: 5, sessions: { B: { totals: { costUsd: 1 } } } }, // no evidence read
    { round: 6, sessions: { A: { totals: { costUsd: 1 } } } }, // no B session: not counted
  ];
  const d = d4Precondition(rounds);
  assert.equal(d.sessions, 5);
  assert.equal(d.minted, 1);
  assert.deepEqual(d.mintedRounds, [1]);
  assert.equal(d.required, 3);
  assert.equal(d.pass, false);
  const ok = d4Precondition([1, 2, 3, 4].map((round) => ({ round, sessions: { B: bSession(round < 3 ? 5 : 0, round < 3 ? 2 : 0) } })));
  assert.equal(ok.minted, 2);
  assert.equal(ok.required, 2);
  assert.equal(ok.pass, true);
  assert.equal(d4Precondition([]).pass, false, 'no B sessions is never a pass');
});

test('the report states the D4 precondition before any ratio', () => {
  const record = {
    arms: ['A', 'B', 'C'],
    rounds: [1, 2].map((round) => ({
      round,
      sessions: { A: { totals: { costUsd: 1, turns: 10 } }, B: { ...bSession(4, 2), totals: { costUsd: 0.8, turns: 11 } }, C: { totals: { costUsd: 0.9, turns: 10 } } },
      quality: { A: true, B: true, C: true },
      recall: { A: 9, B: 9, C: 8 },
    })),
  };
  const text = formatReport(compareFile(record));
  const d4At = text.indexOf('D4');
  const firstRatio = text.search(/B\/A|B\/C|A\/C/);
  assert.ok(d4At >= 0, 'the report names D4');
  assert.ok(firstRatio > d4At, 'D4 comes before the first pair');
  for (const pair of ['B/A', 'B/C', 'A/C']) assert.ok(text.includes(pair), `report covers ${pair}`);
});

test('comparePair carries recall and turns medians for each side', () => {
  const rounds = [1, 2, 3].map((round) => ({
    round,
    sessions: { A: { totals: { costUsd: 1, turns: 10 } }, B: { totals: { costUsd: 0.9, turns: 10 + round } } },
    quality: { A: true, B: true },
    recall: { A: 9, B: 8 + round % 2 },
  }));
  const p = comparePair(rounds, 'B', 'A');
  assert.equal(p.recall.control, 9);
  assert.equal(p.recall.treatment, 9);
  assert.equal(p.turns.control, 10);
  assert.equal(p.turns.treatment, 12);
});

const shapedRound = (round, shape) => ({
  round,
  sessions: Object.fromEntries(Object.entries(shape).map(([arm, s]) => [arm, { totals: { costUsd: s.cost, turns: s.turns, mainTurns: s.turns, subagentSpawns: s.spawns, spawnedInParallel: s.parallel, subagentTurns: s.subTurns } }])),
  quality: Object.fromEntries(Object.keys(shape).map((arm) => [arm, true])),
  recall: Object.fromEntries(Object.keys(shape).map((arm) => [arm, 15])),
});

test('comparePair carries subagent spawns, parallel launches and subagent thread turns for each side', () => {
  const rounds = [
    shapedRound(1, { B: { cost: 1, turns: 70, spawns: 6, parallel: true, subTurns: [12, 14, 9] }, A: { cost: 2, turns: 64, spawns: 4, parallel: false, subTurns: [20, 22] } }),
    shapedRound(2, { B: { cost: 1, turns: 80, spawns: 4, parallel: true, subTurns: [10] }, A: { cost: 2, turns: 66, spawns: 6, parallel: true, subTurns: [18, 30, 16] } }),
  ];
  const p = comparePair(rounds, 'B', 'A');
  assert.deepEqual(p.spawns, { treatment: 5, control: 5 });
  assert.deepEqual(p.parallel, { treatment: 2, control: 1 });
  assert.deepEqual(p.subagentTurns, { treatment: 11, control: 20 });
  assert.deepEqual(p.turns, { treatment: 75, control: 65 });
  // Each round names its spawn counts, so a ratio is read beside who delegated more.
  assert.deepEqual(p.ratios.map((r) => r.spawns), [{ treatment: 6, control: 4 }, { treatment: 4, control: 6 }]);
  const report = formatReport({ scenario: 'sdk-app-scanner-long', arms: ['A', 'B'], rounds: 2, model: 'm', d4: { sessions: 0 }, pairs: [p] });
  assert.match(report, /^sdk-app-scanner-long /);
  assert.match(report, /spawns median 5 vs 5/);
  assert.match(report, /parallel 2\/2 vs 1\/2/);
  assert.match(report, /subagent turns median 11 vs 20/);
});

test('comparePair reads turns as main-thread requests when the session counted them', () => {
  // The SDK's num_turns counted 48 for a 13-request main thread; mainTurns is the request count.
  const r = (round, b, a) => ({
    round,
    sessions: { B: { totals: { costUsd: 1, turns: b * 4, mainTurns: b } }, A: { totals: { costUsd: 1, turns: a * 4, mainTurns: a } } },
    quality: { A: true, B: true },
    recall: { A: 1, B: 1 },
  });
  const p = comparePair([r(1, 60, 70), r(2, 80, 90)], 'B', 'A');
  assert.deepEqual(p.turns, { treatment: 70, control: 80 });
});

test('D4 keeps an unknown mint count apart from a session that minted nothing', () => {
  // The self-check could not count mints (its sdk-agent readBack row had no emitted).
  const rounds = [{ round: 1, sessions: { B: bSession(169, null) } }];
  const d = d4Precondition(rounds);
  assert.equal(d.pass, false);
  assert.equal(d.unknown, 1);
  assert.deepEqual(d.unknownRounds, [1]);
  const text = formatReport({ scenario: 's', arms: ['B'], rounds: 1, model: 'm', d4: d, pairs: [] });
  assert.match(text, /D4 precondition .*UNKNOWN/);
  assert.doesNotMatch(text, /did not run/, 'an unread count is not proof the mechanism never ran');
  // A session that read zero is still a FAIL, not unknown.
  const zero = d4Precondition([{ round: 1, sessions: { B: bSession(169, 0) } }]);
  assert.equal(zero.unknown, 0);
  assert.match(formatReport({ scenario: 's', arms: ['B'], rounds: 1, model: 'm', d4: zero, pairs: [] }), /FAIL/);
});

test('D4 reads a spend-row mint count for a round the self-check could not count', () => {
  const rounds = [{ round: 1, sessions: { B: bSession(169, null) } }, { round: 2, sessions: { B: bSession(150, null) } }];
  const d = d4Precondition(rounds, { spendMints: { 1: { B: 53 }, 2: { B: 0 } } });
  assert.equal(d.minted, 1);
  assert.deepEqual(d.mintedRounds, [1]);
  assert.equal(d.unknown, 0);
  assert.equal(d.pass, true);
  // The self-check's own count wins when it has one; spend rows fill only an unknown.
  const own = d4Precondition([{ round: 1, sessions: { B: bSession(10, 0) } }], { spendMints: { 1: { B: 9 } } });
  assert.equal(own.minted, 0);
  // A malformed spend count is no evidence.
  assert.equal(d4Precondition(rounds, { spendMints: { 1: { B: 'lots' } } }).unknown, 2);
  assert.equal(compareFile({ arms: ['B'], rounds }, { spendMints: { 1: { B: 53 } } }).d4.minted, 1);
});

// ---- R/K: one kind added by header, its evidence, and session-gate holdouts (ANY-1154) ----

const K_SPEC = { harnessRetrieval: 'on', optimize: null, readPath: true, kinds: ['observation_mask', 'code_graph'] };
const R_SPEC = { ...K_SPEC, kinds: [...K_SPEC.kinds, 'repeat_factor'] };
const rf = (o = {}) => ({ requests: 40, requestsWithKind: 0, freshFolds: 0, blocksFactored: 0, freshTokens: 0, replays: 0, pinsReplayed: 0, replayTokens: 0, tokensSaved: 0, suppressed: {}, declines: {}, holdout: false, detailUnread: 0, ...o });
const kindSession = (cost, evidence, heldOut = []) => ({
  totals: { costUsd: cost, mainTurns: 40, turns: 40 },
  optimization: { requested: [], heldOut },
  kindEvidence: evidence === null ? { unavailable: 'no admin token' } : { requests: 40, kinds: { repeat_factor: evidence } },
});
const rkRound = (round, r, k) => ({ round, sessions: { R: r, K: k }, quality: { R: true, K: true }, recall: { R: 12, K: 12 } });

test('pairsFor adds R/K beside the existing pairs', () => {
  assert.deepEqual(pairsFor(['K', 'R']), [['R', 'K']]);
  assert.deepEqual(pairsFor(['A', 'B', 'C', 'K', 'R']), [['B', 'A'], ['B', 'C'], ['A', 'C'], ['R', 'K']]);
});

test('heldOutOf reads a holdout from the response feedback or from the trace metadata', () => {
  assert.deepEqual(heldOutOf(kindSession(1, rf(), ['code_graph'])), ['code_graph']);
  assert.deepEqual(heldOutOf(kindSession(1, rf({ holdout: true }))), ['repeat_factor']);
  assert.deepEqual(heldOutOf(kindSession(1, rf({ holdout: true }), ['repeat_factor'])), ['repeat_factor']);
  assert.deepEqual(heldOutOf({ totals: { costUsd: 1 } }), [], 'a session without kinds has nothing held out');
});

test('a round where the session gate held a kind out of either arm is excluded from the pair and listed', () => {
  const rounds = [
    rkRound(1, kindSession(0.9, rf({ freshFolds: 2 })), kindSession(1.0, rf())),
    rkRound(2, kindSession(1.0, rf({ holdout: true })), kindSession(1.0, rf())), // R ran without repeat_factor
    rkRound(3, kindSession(0.8, rf({ freshFolds: 1 })), kindSession(1.0, rf(), ['observation_mask'])), // K lost a kind
    rkRound(4, kindSession(1.1, rf({ freshFolds: 1 })), kindSession(1.0, rf())),
  ];
  assert.deepEqual(pairRounds(rounds, 'R', 'K').map((r) => r.round), [1, 4]);
  const p = comparePair(rounds, 'R', 'K');
  assert.equal(p.n, 2);
  assert.equal(p.wins, 1);
  assert.deepEqual(p.heldOutRounds, [
    { round: 2, treatment: ['repeat_factor'], control: [] },
    { round: 3, treatment: [], control: ['observation_mask'] },
  ]);
  // The existing pairs never carry kinds, so nothing of theirs is excluded.
  assert.deepEqual(comparePair([roundOf(1, { A: 1, B: 0.9 }, { A: true, B: true }, { A: 1, B: 1 })], 'B', 'A').heldOutRounds, []);
});

test('kindEvidenceFor: the kind R adds folded on R and never decided on K, per session', () => {
  const record = {
    arms: ['K', 'R'],
    armSpecs: { K: K_SPEC, R: R_SPEC },
    rounds: [
      rkRound(1, kindSession(0.9, rf({ requestsWithKind: 6, freshFolds: 4, blocksFactored: 9, freshTokens: 5200, replays: 3, pinsReplayed: 7, replayTokens: 2100, tokensSaved: 7300, declines: { payback_premium: 2 } })), kindSession(1, rf())),
      rkRound(2, kindSession(1.0, rf({ declines: { no_candidate_span: 30 } })), kindSession(1, rf())),
    ],
  };
  const ev = kindEvidenceFor(record, 'R', 'K');
  assert.deepEqual(ev.kinds, ['repeat_factor']);
  const [k] = ev.byKind;
  assert.equal(k.kind, 'repeat_factor');
  assert.equal(k.treatmentSessions, 2);
  assert.equal(k.folded, 1);
  assert.deepEqual(k.foldedRounds, [1]);
  assert.equal(k.controlDecided, 0);
  assert.equal(k.unknown, 0);
  assert.equal(k.pass, true);
  assert.deepEqual(k.sessions[0], { round: 1, holdout: false, requestsWithKind: 6, freshFolds: 4, blocksFactored: 9, freshTokens: 5200, replays: 3, replayTokens: 2100, tokensSaved: 7300, declines: { payback_premium: 2 }, suppressed: {}, controlDecided: 0 });
  assert.deepEqual(k.sessions[1].declines, { no_candidate_span: 30 });
});

test('kindEvidenceFor fails when K decided the kind, or R never folded; unread evidence is unknown', () => {
  const spec = { arms: ['K', 'R'], armSpecs: { K: K_SPEC, R: R_SPEC } };
  const leaked = kindEvidenceFor({ ...spec, rounds: [rkRound(1, kindSession(1, rf({ freshFolds: 1, blocksFactored: 1 })), kindSession(1, rf({ requestsWithKind: 2 })))] }, 'R', 'K').byKind[0];
  assert.equal(leaked.controlDecided, 1);
  assert.equal(leaked.pass, false);
  const never = kindEvidenceFor({ ...spec, rounds: [rkRound(1, kindSession(1, rf()), kindSession(1, rf()))] }, 'R', 'K').byKind[0];
  assert.equal(never.folded, 0);
  assert.equal(never.pass, false);
  const unread = kindEvidenceFor({ ...spec, rounds: [rkRound(1, kindSession(1, null), kindSession(1, null))] }, 'R', 'K').byKind[0];
  assert.equal(unread.unknown, 2, 'both sessions unread, counted per session');
  assert.equal(unread.pass, null, 'nothing read is not a verdict either way');
  // A held-out R session is no evidence about folding: it neither passes nor fails the gate.
  const held = kindEvidenceFor({ ...spec, rounds: [rkRound(1, kindSession(1, rf({ holdout: true })), kindSession(1, rf())), rkRound(2, kindSession(1, rf({ freshFolds: 1, blocksFactored: 2 })), kindSession(1, rf()))] }, 'R', 'K').byKind[0];
  assert.equal(held.treatmentSessions, 1);
  assert.deepEqual(held.heldOutRounds, [1]);
  assert.equal(held.pass, true);
  // Pairs without a kinds difference carry no kind evidence.
  assert.deepEqual(kindEvidenceFor({ arms: ['A', 'B'], armSpecs: { A: { harnessRetrieval: 'off' }, B: { harnessRetrieval: 'on' } }, rounds: [] }, 'B', 'A').kinds, []);
});

test('the report states the kind gate before the R/K ratios and lists holdouts and per-session folds', () => {
  const record = {
    scenario: 'sdk-app-scanner-long',
    model: 'claude-opus-4-6',
    arms: ['K', 'R'],
    armSpecs: { K: K_SPEC, R: R_SPEC },
    rounds: [
      rkRound(1, kindSession(0.9, rf({ requestsWithKind: 5, freshFolds: 3, blocksFactored: 4, freshTokens: 2500, tokensSaved: 2500 })), kindSession(1.0, rf())),
      rkRound(2, kindSession(1.0, rf({ holdout: true })), kindSession(1.0, rf())),
    ],
  };
  const text = formatReport(compareFile(record));
  const gateAt = text.indexOf('repeat_factor evidence');
  const pairAt = text.indexOf('R/K:');
  assert.ok(gateAt >= 0 && pairAt > gateAt, 'the kind gate precedes the ratios');
  assert.match(text, /repeat_factor evidence \(R folds, K never decides\): folded in 1\/1 R session\(s\), K decided in 0\/2 -> PASS/);
  assert.match(text, /R\/K: valid pairs 1, wins 1\/1/);
  assert.match(text, /held out \(excluded\): round 2 R repeat_factor/);
  assert.match(text, /round 1 R repeat_factor: fresh folds 3 \(4 blocks, 2500 tokens\)/);
  assert.doesNotMatch(text, /D4 precondition .*FAIL/, 'no B session: D4 does not apply');
});

test('comparePair also reads the pair on the billed basis (the SDK total, which the gateway bills) when both arms report it', () => {
  const r = (round, t, c) => ({ round, sessions: { R: { totals: { costUsd: t[0], sdkCostUsd: t[1] } }, K: { totals: { costUsd: c[0], sdkCostUsd: c[1] } } }, quality: { R: true, K: true }, recall: { R: 1, K: 1 } });
  const p = comparePair([r(1, [2.7, 2.9], [3.6, 4.8]), r(2, [3.0, 3.3], [3.0, 3.0]), r(3, [1.0, 1.1], [1.0, 1.0])], 'R', 'K');
  assert.equal(p.billed.n, 3);
  assert.equal(p.billed.wins, 1);
  assert.equal(p.billed.losses, 2);
  assert.equal(p.billed.ratios[0].ratio, 2.9 / 4.8);
  assert.equal(p.billed.max, 1.1);
  // A round missing the SDK figure on either side drops out of the billed read only.
  const partial = comparePair([r(1, [2.7, null], [3.6, 4.8]), r(2, [3.0, 3.3], [3.0, 3.0])], 'R', 'K');
  assert.equal(partial.n, 2);
  assert.equal(partial.billed.n, 1);
  const text = formatReport({ scenario: 's', arms: ['K', 'R'], rounds: 3, model: 'm', d4: { sessions: 0 }, pairs: [p] });
  assert.match(text, /R\/K billed \(SDK total_cost_usd\): valid pairs 3, wins 1\/3, median 1\.100, Q3 1\.100, max 1\.100/);
  assert.match(text, /round 1: 0\.750 \(recall Δ \+0, billed 0\.604\)/);
});

test('the report names each valid pair whose sessions the CLI moved to another model', () => {
  const fb = [{ subtype: 'model_refusal_fallback', from: 'claude-sonnet-5-5', to: 'claude-sonnet-5', afterRequest: 15 }];
  const r = (round, rf, kf) => ({ round, sessions: { R: { totals: { costUsd: 1 }, modelFallbacks: rf }, K: { totals: { costUsd: 1 }, modelFallbacks: kf } }, quality: { R: true, K: true }, recall: { R: 1, K: 1 } });
  const p = comparePair([r(1, fb, fb), r(2, [], [])], 'R', 'K');
  assert.deepEqual(p.modelFallbackRounds, [{ round: 1, treatment: ['claude-sonnet-5-5->claude-sonnet-5@15'], control: ['claude-sonnet-5-5->claude-sonnet-5@15'] }]);
  const text = formatReport({ scenario: 's', arms: ['K', 'R'], rounds: 2, model: 'm', d4: { sessions: 0 }, pairs: [p] });
  assert.match(text, /model fallback: round 1 R claude-sonnet-5-5->claude-sonnet-5@15; K claude-sonnet-5-5->claude-sonnet-5@15/);
});

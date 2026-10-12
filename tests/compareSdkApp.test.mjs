import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRounds, comparePair, pairsFor, compareFile, d4Precondition, formatReport } from '../tools/compare-sdk-app.mjs';

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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRounds, comparePair, pairsFor, compareFile } from '../tools/compare-sdk-app.mjs';

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

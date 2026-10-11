import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bookedSavingsUsd, savingsCheck, savingsCheckNote, savingsCheckSummary } from '../lib/savingsCheck.mjs';

const traces = (...savings) => ({ traces: savings.map((savingsUsd) => ({ savingsUsd })) });

test('bookedSavingsUsd sums the traces and ignores missing or non-numeric savings', () => {
  assert.equal(bookedSavingsUsd(traces(0.01, 0.02)), 0.03);
  assert.equal(bookedSavingsUsd({ traces: [{}, { savingsUsd: 'x' }, { savingsUsd: 0.005 }] }), 0.005);
  assert.equal(bookedSavingsUsd(null), 0);
});

test('a round Anyray lost that still booked a saving is flagged', () => {
  // Anyray cost $0.065 more, while five requests booked savings.
  const check = savingsCheck({ directUsd: 1.901, anyrayUsd: 1.966, traces: traces(0.0078, 0.0157, 0.0459, 0.0089, 0.0436) });
  assert.equal(check.lostButBooked, true);
  assert.equal(check.overclaim, true);
  assert.ok(Math.abs(check.measuredUsd + 0.065) < 1e-9);
  assert.match(savingsCheckNote(3, check), /round 3 WARNING: the gateway booked a saving on a round Anyray lost/);
});

test('booking more than the round saved is an overclaim, not a loss', () => {
  const check = savingsCheck({ directUsd: 1.436, anyrayUsd: 1.421, traces: traces(0.0839) });
  assert.equal(check.lostButBooked, false);
  assert.equal(check.overclaim, true);
  assert.match(savingsCheckNote(1, check), /booked more than the round saved/);
});

test('a winning round that booked no more than it saved passes', () => {
  const check = savingsCheck({ directUsd: 2.0, anyrayUsd: 1.0, traces: traces(0.2) });
  assert.deepEqual([check.overclaim, check.lostButBooked], [false, false]);
  assert.doesNotMatch(savingsCheckNote(2, check), /WARNING|more than/);
});

test('a lost round that booked nothing is not an overclaim, and rounding is tolerated', () => {
  assert.equal(savingsCheck({ directUsd: 0.05, anyrayUsd: 0.06, traces: traces(0) }).overclaim, false);
  assert.equal(savingsCheck({ directUsd: 0.05, anyrayUsd: 0.05, traces: traces(0.0005) }).overclaim, false);
});

test('no check without traces or a cost on either arm', () => {
  assert.equal(savingsCheck({ directUsd: 1, anyrayUsd: 0.5, traces: null }), null);
  assert.equal(savingsCheck({ directUsd: undefined, anyrayUsd: 0.5, traces: traces(0.1) }), null);
  assert.equal(savingsCheckNote(1, null), '');
});

test('savingsCheckSummary counts the rounds that carry a check', () => {
  const rounds = [
    { savingsCheck: savingsCheck({ directUsd: 1.901, anyrayUsd: 1.966, traces: traces(0.122) }) },
    { savingsCheck: savingsCheck({ directUsd: 1.436, anyrayUsd: 1.421, traces: traces(0.0839) }) },
    { savingsCheck: savingsCheck({ directUsd: 2, anyrayUsd: 1, traces: traces(0.2) }) },
    { error: 'no cost' },
  ];
  const s = savingsCheckSummary(rounds);
  assert.equal(s.rounds, 3);
  assert.equal(s.lostButBooked, 1);
  assert.equal(s.overclaim, 2);
});

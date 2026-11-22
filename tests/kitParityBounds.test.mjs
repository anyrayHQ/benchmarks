// The kit's copy of the gateway's parity check refuses counts no run can produce, as the gateway
// does (monorepo #4807): a pair only direct passed needs a direct pass, and one only Anyray passed
// needs a direct fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientTestBodySchema } from '../lib/clientTestBody.mjs';

const parity = clientTestBodySchema.shape.scenarios.element.shape.parity.unwrap();
const ok = { n: 10, passDirect: 8, passAnyray: 9, anyrayWorse: 1, anyrayBetter: 2 };

test('possible counts pass', () => {
  assert.equal(parity.safeParse(ok).success, true);
});

test('a loss and a win when direct passed every pair is refused', () => {
  assert.equal(parity.safeParse({ n: 10, passDirect: 10, passAnyray: 10, anyrayWorse: 1, anyrayBetter: 1 }).success, false);
});

test('a loss when direct passed nothing is refused', () => {
  assert.equal(parity.safeParse({ n: 10, passDirect: 0, passAnyray: 1, anyrayWorse: 1, anyrayBetter: 2 }).success, false);
});

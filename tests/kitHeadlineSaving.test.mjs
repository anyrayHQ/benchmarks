// The report leads with one number: the % cost saving per session. It is the measured mean, never
// dressed up: a verdict that is not PASS says so beside it, and a rise in cost reads as a rise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headlineBasis, headlineSaving } from '../lib/kitResults.mjs';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { kitIn, pairRound, syntheticPlan, writeRecord } from './kitRunFixtures.mjs';

test('a cheaper Anyray arm leads with the percent lower', () => {
  const h = headlineSaving({ direct: 2, anyray: 1.26 }, 'PASS');
  assert.equal(h.big, '37%');
  assert.equal(h.label, 'lower cost per session');
  assert.equal(h.caveat, null);
});

test('a verdict that is not PASS is stated beside the number', () => {
  for (const v of ['INCONCLUSIVE', 'INSUFFICIENT', 'FAIL', 'NO DATA']) {
    assert.match(headlineSaving({ direct: 2, anyray: 1.26 }, v).caveat, new RegExp(`Rule 0 ${v}`));
  }
});

test('a higher cost reads as higher, not as a negative saving', () => {
  const h = headlineSaving({ direct: 1, anyray: 1.2 }, 'FAIL');
  assert.equal(h.big, '20%');
  assert.equal(h.label, 'higher cost per session');
});

test('no direct cost means no headline number', () => {
  assert.equal(headlineSaving({ direct: 0, anyray: 0 }, 'NO DATA'), null);
});

// Eight pairs: Anyray costs half of direct on seven, 1.1x on one. Mean per session: 0.5 vs 1.
async function planned(t) {
  const root = tempDir(t, 'kit-headline-');
  const env = kitEnv(join(root, 'home'));
  const built = await syntheticPlan(root, { env, records: false });
  const rounds = [0.5, 0.55, 0.48, 1.1, 0.51, 0.49, 0.53, 0.5].map((b, i) => pairRound(i + 1, 1, b));
  writeRecord(built.dir, built.lock, 'check-long', rounds);
  return { ...built, env };
}

test('the text report opens with the headline', async (t) => {
  const { copy, dir, env } = await planned(t);
  const child = await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact'], { env });
  assert.equal(child.status, 0, child.stderr.slice(-300));
  assert.match(child.stdout.split('\n')[0], /^\d+% lower cost per session/);
});

test('the page leads with the headline before the cards', async (t) => {
  const { copy, dir, env } = await planned(t);
  await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--html'], { env });
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  const hero = page.indexOf('class="hero"');
  assert.ok(hero > 0, 'no headline block');
  assert.ok(hero < page.indexOf('class="cards"'), 'the headline comes before the cards');
  assert.match(page, /<b>\d+%<\/b><span>lower cost per session/);
});

const round = (n, a, b, over = {}) => ({ round: n, ratio: b / a, sessions: { a: { totals: { costUsd: a } }, b: { totals: { costUsd: b } } }, quality: { a: true, b: true }, ...over });

test('the headline compares cost over the pairs that count when there are any', () => {
  const basis = headlineBasis([{ rounds: [
    round(1, 1, 0.5),
    round(2, 1, 0.6, { quality: { a: true, b: false } }),
    { round: 3, failure: 'timeout', sessions: { a: { totals: {} }, b: { totals: {} } } },
  ] }]);
  assert.deepEqual(basis, { direct: 1, anyray: 0.5, n: 1, unsolved: 0 }, 'a pair one arm failed would pull the mean down: a failed arm often costs less');
});

test('when no pair counts, the pairs priced on both arms stand in and the failed checks are counted', () => {
  const basis = headlineBasis([{ rounds: [
    round(1, 1, 0.5, { quality: { a: true, b: false } }),
    round(2, 1, 0.6, { quality: { a: true, b: false } }),
    { round: 3, failure: 'timeout', sessions: { a: { totals: {} }, b: { totals: {} } } },
    round(4, 1, 0.1, { sessions: { a: { totals: { costUsd: 1, outsideCheckout: 1 } }, b: { totals: { costUsd: 0.1 } } } }),
  ] }]);
  assert.deepEqual(basis, { direct: 1, anyray: 0.55, n: 2, unsolved: 2 });
});

test('no priced pair means no basis', () => {
  assert.equal(headlineBasis([{ rounds: [] }, {}]), null);
});

test('a pair that failed the check is named beside the number, whatever the verdict', () => {
  const h = headlineSaving({ direct: 1, anyray: 0.55, n: 2, unsolved: 2 }, 'PASS');
  assert.equal(h.big, '45%');
  assert.match(h.caveat, /2 of 2 pairs failed the check on at least one arm/);
  assert.match(headlineSaving({ direct: 1, anyray: 0.55, n: 4, unsolved: 1 }, 'INCONCLUSIVE').caveat, /1 of 4 pairs failed the check.*Rule 0 INCONCLUSIVE/);
});

// Every pair priced on both arms, Anyray failed the check on all of them: no pair counts, so the kit's own mean is empty.
async function allUnsolved(t) {
  const root = tempDir(t, 'kit-headline-unsolved-');
  const env = kitEnv(join(root, 'home'));
  const built = await syntheticPlan(root, { env, records: false });
  const rounds = [0.5, 0.55, 0.48].map((b, i) => pairRound(i + 1, 1, b, { solved: [true, false] }));
  writeRecord(built.dir, built.lock, 'check-long', rounds);
  return { ...built, env };
}

test('when no pair counts the text report still leads with the cost comparison and the failed checks', async (t) => {
  const { copy, dir, env } = await allUnsolved(t);
  const child = await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact'], { env });
  assert.equal(child.status, 0, child.stderr.slice(-300));
  assert.match(child.stdout.split('\n')[0], /^49% lower cost per session \(3 of 3 pairs failed the check on at least one arm; Rule 0 /);
  assert.match(child.stdout, /Cost per session: direct \$1\.00, Anyray \$0\.51 \(49% lower\)/);
});

test('when no pair counts the page still leads with the cost comparison and the failed checks', async (t) => {
  const { copy, dir, env } = await allUnsolved(t);
  await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--html'], { env });
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.match(page, /<b>49%<\/b><span>lower cost per session/);
  assert.match(page, /3 of 3 pairs failed the check on at least one arm/);
  assert.match(page, /<b>\$1\.00 vs \$0\.51<\/b>/, 'the dollar card uses the same pairs as the headline');
});

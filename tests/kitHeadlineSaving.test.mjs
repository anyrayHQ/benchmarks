// The report leads with one number: the % cost saving per session. It is the measured mean, never
// dressed up: a verdict that is not PASS says so beside it, and a rise in cost reads as a rise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headlineSaving } from '../lib/kitResults.mjs';
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

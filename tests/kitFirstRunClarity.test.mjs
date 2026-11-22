// What a first-time client reads must not mislead: the plan says what a small budget cannot do, the
// two verdict words (the interval's and Rule 0's) are labeled so they do not look like a
// disagreement, a result inside the noise of parity says so, and "run more pairs" is worded
// differently once Rule 0 has already failed. Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, syntheticPlan } from './kitRunFixtures.mjs';

const scenario = (id) => ({ id, source: 'client', shapeId: null, prediction: { status: 'none', reason: 'unknown_shape' }, predictedHitRate: null });

test('a budget-only plan says noise alone is 12 sessions per scenario, so a small budget is not a surprise', async () => {
  const { budgetPlan, formatPlan, loadCatalog } = await import('../lib/planner.mjs');
  const catalog = loadCatalog();
  const one = budgetPlan([scenario('client-1')], { budgetUsd: 2 });
  assert.equal(one.noiseSessions, 12, 'the JSON carries the count');
  const text = formatPlan(one, catalog);
  assert.match(text, /Noise alone is 12 sessions \(6 rounds of two direct sessions\)/);
  assert.match(text, /budget must cover them before any pair runs/i);
  const two = budgetPlan([scenario('client-1'), scenario('proposed-1')], { budgetUsd: 4 });
  assert.equal(two.noiseSessions, 24, 'noise runs for every scenario');
  assert.match(formatPlan(two, catalog), /Noise alone is 24 sessions/);
});

test('a plan that already knows the session cost keeps its own breakdown and adds nothing about noise sessions', async () => {
  const { budgetPlan, formatPlan, loadCatalog } = await import('../lib/planner.mjs');
  const text = formatPlan(budgetPlan([scenario('client-1')], { budgetUsd: 60, sessionCostUsd: 1.3 }), loadCatalog());
  assert.doesNotMatch(text, /Noise alone is/);
  assert.match(text, /noise: 6 rounds/);
});

test('tieNote: a result whose interval includes 1 says there is no clear difference, unless it passed', async () => {
  const { tieNote } = await import('../lib/kitResults.mjs');
  assert.equal(tieNote({ ci95: { lower: 0.966, upper: 1.085 }, rule0: 'FAIL' }), 'No clear difference from direct: the interval includes 1.');
  assert.equal(tieNote({ ci95: { lower: 0.4, upper: 3.5 }, rule0: 'INSUFFICIENT' }), 'No clear difference from direct: the interval includes 1.');
  assert.equal(tieNote({ ci95: { lower: 0.7, upper: 0.9 }, rule0: 'FAIL' }), null, 'an interval wholly below 1 is a difference');
  assert.equal(tieNote({ ci95: { lower: 1.2, upper: 1.4 }, rule0: 'FAIL' }), null, 'wholly above 1 is a loss, not a tie');
  assert.equal(tieNote({ ci95: { lower: 0.9, upper: 1.1 }, rule0: 'PASS' }), null, 'a pass needs no excuse');
  assert.equal(tieNote({ ci95: null, rule0: 'NO DATA' }), null);
});

test('nextStep: once Rule 0 has already failed, more pairs are for seeing whether the worst pair repeats, not for a verdict', async () => {
  const { nextStep } = await import('../lib/kitResults.mjs');
  const failed = nextStep({ verdict: 'inconclusive', rule0: 'FAIL', n: 6, median: 1.02, sd: 0.05, pairCostUsd: 0.15 });
  assert.equal(failed, 'Rule 0 already failed on these 6 pairs. Run 2 more pairs (about $0.30) to see whether the worst pair repeats.');
  assert.equal(nextStep({ verdict: 'inconclusive', rule0: 'FAIL', n: 7, median: 1.02, sd: 0.05, pairCostUsd: 1 }),
    'Rule 0 already failed on these 7 pairs. Run 1 more pair (about $1.00) to see whether the worst pair repeats.');
  assert.equal(nextStep({ verdict: 'fail', rule0: 'FAIL', n: 9, median: 1.3, sd: 0.1, pairCostUsd: 1 }), null, 'enough pairs: the failure stands');
});

test('the human verdict labels the interval word and the Rule 0 word apart and prints the tie note', async (t) => {
  const root = tempDir(t, 'kit-clarity-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const human = (await kitIn(copy.root, ['verdict', '--scenarios-dir', dir], { env })).stdout;
  assert.match(human, /^facts: interval inconclusive; median 1\.000; CI 0\.278-3\.560; Rule 0 INSUFFICIENT$/m);
  assert.match(human, /facts: .*\n\s*Note: No clear difference from direct: the interval includes 1\./);
  assert.doesNotMatch(human, /check-long: .*\n\s*Note:/, 'a pass has no tie note');

  const report = (await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact'], { env })).stdout;
  assert.match(report, /facts \(.*\): .*; interval inconclusive; Rule 0 INSUFFICIENT/);
  assert.match(report, /Note: No clear difference from direct/);

  const out = json(await kitIn(copy.root, ['verdict', '--scenarios-dir', dir, '--json'], { env }), 'verdict --json');
  const by = Object.fromEntries(out.scenarios.map((s) => [s.id, s]));
  assert.equal(by.facts.tieNote, 'No clear difference from direct: the interval includes 1.');
  assert.equal(by.facts.verdict, 'inconclusive', 'the machine words are unchanged');
  assert.equal(by['check-long'].tieNote, null);
});

// `npm run plan -- --budget-usd B` without `--session-cost-usd` (ANY-1515): a client knows their
// budget before they know what one of their sessions costs; the noise rounds measure that. So the
// plan answers without a pair count (`pairsPlanned: null` on every scenario), its spend ceiling
// is the budget itself, and the human plan says the pairs come after noise. With both flags the
// plan is unchanged (kitPlan.test.mjs keeps those numbers).
//
// Driven through the CLI of a kit copy with the test catalog, against a fake gateway that serves
// the session-gate read: no network, no session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, writeScenariosDir } from './kitFixtures.mjs';
import { byId, fakeGateway, kitCopy, planOk, planRun, shapedScenarios } from './kitPlanFixtures.mjs';

const PAIRS_LATER = 'Pairs: set after the noise rounds measure your session cost';

/** Four scenarios: two predicted bands (check-long, short-task), a shape with no band (docs), no shape (facts). */
function fourScenarios(t) {
  const all = shapedScenarios();
  return writeScenariosDir(tempDir(t), { 'check-long': all['check-long'], 'short-task': all['short-task'], docs: all.docs, facts: all.facts });
}

test('plan --budget-usd alone answers ok before the session cost is known: pairsPlanned null on every scenario, the spend ceiling is the budget', async (t) => {
  const copy = kitCopy(t);
  const dir = fourScenarios(t);
  const gateway = await fakeGateway(t);
  const out = planOk(await planRun(t, dir, gateway, ['--budget-usd', '40', '--json'], { kitRoot: copy.root }), 'plan --budget-usd 40 --json (no session cost)');
  assert.equal(out.command, 'plan');
  assert.equal(out.budgetUsd, 40);
  assert.equal(out.spendCeilingUsd, 40, 'with no session cost yet, the most the plan may spend is the budget');
  assert.deepEqual(out.scenarios.map((s) => s.id), ['check-long', 'docs', 'facts', 'short-task']);
  for (const s of out.scenarios) assert.equal(s.pairsPlanned, null, `${s.id}: no pair count until noise measures a session`);

  // The plan still did its reads and its classification: the same shapes, predictions and
  // tenant as the plan that names a session cost.
  const both = planOk(await planRun(t, dir, gateway, ['--budget-usd', '40', '--session-cost-usd', '0.15', '--json'], { kitRoot: copy.root }), 'plan with both flags');
  for (const s of both.scenarios) assert.equal(typeof s.pairsPlanned, 'number', `${s.id}: with a session cost the pair count is today's number`);
  const withCost = byId(both.scenarios);
  for (const s of out.scenarios) {
    assert.deepEqual({ shapeId: s.shapeId, prediction: s.prediction, features: s.features }, { shapeId: withCost[s.id].shapeId, prediction: withCost[s.id].prediction, features: withCost[s.id].features }, `${s.id}: classified as with a session cost`);
  }
  assert.deepEqual(out.tenant, both.tenant, 'the session gate was read as before');
  assert.ok(gateway.requests.some((r) => r.path === '/admin/v1/optimizer/session-gate'), 'the budget-only plan read the session gate');
});

test('the human budget-only plan says the pairs are set after the noise rounds, and prints no broken number', async (t) => {
  const copy = kitCopy(t);
  const dir = fourScenarios(t);
  const gateway = await fakeGateway(t);
  const human = await planRun(t, dir, gateway, ['--budget-usd', '40'], { kitRoot: copy.root });
  assert.equal(human.status, 0, `the human plan failed: ${human.stdout.slice(0, 300)} ${human.stderr.slice(-300)}`);
  const lines = human.stdout.split('\n');
  assert.ok(lines.includes(PAIRS_LATER), `a line reads "${PAIRS_LATER}": ${JSON.stringify(human.stdout.slice(0, 800))}`);
  assert.doesNotMatch(human.stdout, /\bNaN\b|\bnull\b|\bundefined\b|Infinity/, 'no missing value is printed as a number');
  for (const id of ['check-long', 'docs', 'facts', 'short-task']) assert.ok(human.stdout.includes(id), `the plan still lists ${id}`);

  // With a session cost the plan prints today's pair counts, not the deferral.
  const priced = await planRun(t, dir, gateway, ['--budget-usd', '40', '--session-cost-usd', '0.15'], { kitRoot: copy.root });
  assert.equal(priced.status, 0, `the priced human plan failed: ${priced.stderr.slice(-300)}`);
  assert.ok(!priced.stdout.split('\n').includes(PAIRS_LATER), 'a plan that knows the session cost does not defer the pairs');
});

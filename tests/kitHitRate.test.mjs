// The predicted band's hit rate (ANY-1492): once predictions.yaml carries a shape's calibration
// block, `plan` says how often that band was right in earlier client tests ("band right in 3 of
// 4 earlier tests"), and the report body carries the rate per scenario for the console's "Your
// test" line. A shape under 8 calibration rounds has no rate (null, never 0). Driven through
// the CLI against kit copies; the report test freezes a plan, then calibrates the copy's catalog
// as a later release would. Synthetic records; no session runs; no network beyond 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientTestBodySchema } from '../lib/clientTestBody.mjs';
import { kitEnv, tempDir, writeScenariosDir } from './kitFixtures.mjs';
import {
  TEST_SHAPES, byId, expectedPrediction, fakeGateway, json, kitCopy, planOk, planRun, shapedScenarios,
} from './kitPlanFixtures.mjs';
import { git, kitIn, syntheticPlan } from './kitRunFixtures.mjs';
import { storedResult } from './kitReleaseFixtures.mjs';
import {
  CALIBRATED_CATALOG, assertHitRateBody, blockOf, catalogWithBlock, docShape, hitRateBodySchema, withoutHitRate,
} from './kitCalibrationFixtures.mjs';

const BUDGET = ['--budget-usd', '500', '--session-cost-usd', '0.15'];
const shape = (id) => TEST_SHAPES.find((s) => s.id === id);

/** The human plan's line for scenario `id` (a whole-token match: `check-long` is not `mcp-check-long`). */
const lineOf = (stdout, id) => stdout.split('\n').find((l) => l.split(/[^A-Za-z0-9_-]+/).includes(id));

// ---- plan ------------------------------------------------------------------------------------------

test('plan --json carries predictedHitRate per scenario: the band\'s calibrated hit rate, or null under 8 calibration rounds, without a block, without a band, or without a shape', async (t) => {
  const calibrated = kitCopy(t, CALIBRATED_CATALOG);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: calibrated.root }), 'plan --json (calibrated catalog)');
  for (const s of out.scenarios) assert.ok(Object.hasOwn(s, 'predictedHitRate'), `${s.id}: every scenario carries predictedHitRate, null included`);
  const s = byId(out.scenarios);
  assert.equal(s['check-long'].predictedHitRate, 0.75, 't-cc-check-long: right in 3 of 4 earlier tests over 23 rounds');
  assert.equal(s['short-task'].predictedHitRate, 0.4, 't-cc-short: exactly 8 calibration rounds publish a rate');
  assert.equal(s.paused.predictedHitRate, null, 't-cc-medium-pause: 7 calibration rounds publish none');
  assert.equal(s['mcp-check-long'].predictedHitRate, null, 't-mcp-many: no calibration block');
  assert.equal(s.docs.predictedHitRate, null, 't-docs-few is calibrated, but seven PUBLIC rounds predict no band, so there is no band to rate');
  assert.equal(s.facts.predictedHitRate, null, 'no shape, no rate');
  for (const id of ['check-long', 'short-task', 'paused']) {
    assert.deepEqual(s[id].prediction, expectedPrediction(shape(s[id].shapeId)), `${id}: the prediction keeps exactly its ANY-1486 keys; the block never rides inside it`);
  }

  // Calibration adds the rate and nothing else: the same plan on the uncalibrated catalog.
  const plain = kitCopy(t);
  const base = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: plain.root }), 'plan --json (test catalog)');
  for (const x of base.scenarios) assert.equal(x.predictedHitRate, null, `${x.id}: no block anywhere, so null (the key is still there)`);
  const strip = ({ benchmarksCommit, scenarios, ...rest }) => ({ ...rest, scenarios: scenarios.map(withoutHitRate) });
  assert.deepEqual(strip(out), strip(base), 'the bands, pairs, budget and resolvability do not depend on the calibration');
});

test('the human plan says "band right in H of R earlier tests" on a scenario\'s line exactly when its hit rate is not null', async (t) => {
  const calibrated = kitCopy(t, CALIBRATED_CATALOG);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  const human = await planRun(t, dir, gateway, BUDGET, { kitRoot: calibrated.root });
  assert.equal(human.status, 0, `plan (human): exit ${human.status}: ${human.stdout.slice(0, 300)} ${human.stderr.slice(0, 300)}`);
  for (const id of Object.keys(shapedScenarios())) assert.ok(lineOf(human.stdout, id), `the human plan has a line for ${id}`);
  assert.match(lineOf(human.stdout, 'check-long'), /band right in 3 of 4 earlier tests/, 'hits and results of t-cc-check-long\'s block');
  assert.match(lineOf(human.stdout, 'short-task'), /band right in 2 of 5 earlier tests/, 'hits and results of t-cc-short\'s block');
  for (const id of ['paused', 'mcp-check-long', 'docs', 'facts']) {
    assert.ok(!lineOf(human.stdout, id).includes('band right in'), `${id}: no rate, so no "band right in": ${JSON.stringify(lineOf(human.stdout, id))}`);
  }
  assert.equal(human.stdout.split('band right in').length - 1, 2, 'said once per rated scenario, nowhere else');
});

test('a committed calibration block that breaks the rules is the kit\'s own bug: plan answers kit_failed (a rate under 8 rounds, a dropped miss, a shapeId inside the block)', async (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'short-task': shapedScenarios()['short-task'] });
  const gateway = await fakeGateway(t);
  // The control: the same shape with its valid block plans.
  const ok = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: kitCopy(t, CALIBRATED_CATALOG).root }), 'plan --json (valid block)');
  assert.equal(ok.scenarios[0].predictedHitRate, 0.4);
  const valid = blockOf(docShape('t-cc-short'));
  for (const [label, block] of [
    ['a rate under 8 rounds', { ...valid, rounds: 7 }],
    ['a dropped miss (5 results, 2 hits, 2 misses)', { ...valid, misses: valid.misses.slice(0, 2) }],
    ['a shapeId inside the block', { shapeId: 't-cc-short', ...valid }],
  ]) {
    const child = await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: kitCopy(t, catalogWithBlock('t-cc-short', block)).root });
    const out = json(child, `plan --json (${label})`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'plan', code: 'kit_failed' }, label);
    assert.equal(child.status, 1, `${label}: exit ${child.status}`);
  }
});

// ---- the report body --------------------------------------------------------------------------------

test('report --redact --json carries predictedHitRate once the catalog is calibrated: the band\'s rate, null for a calibrated shape frozen without a band, no key without a shape; nothing else changes', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env });
  const report = () => kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env });
  assert.deepEqual(lock.scenarios.map((s) => s.id), ['check-long', 'docs', 'facts', 'short-task'], 'the body\'s scenario order');

  const plain = await report();
  const before = json(plain, 'report --redact --json (test catalog)');
  assert.equal(plain.status, 0, `report failed: ${plain.stdout.slice(0, 300)} ${plain.stderr.slice(-300)}`);
  for (const s of before.scenarios) assert.ok(!Object.hasOwn(s, 'predictedHitRate'), `${s.shapeId}: an uncalibrated catalog adds no key, so the body is exactly today's`);

  // A later release calibrates the catalog; the plan stays frozen.
  writeFileSync(join(copy.root, 'predictions.yaml'), CALIBRATED_CATALOG);
  git(copy.root, ['commit', '-q', '-am', 'calibrate the catalog']);
  const child = await report();
  const body = json(child, 'report --redact --json (calibrated catalog)');
  assert.equal(child.status, 0, `report failed: ${child.stdout.slice(0, 300)} ${child.stderr.slice(-300)}`);
  const [checkLong, docs, facts, shortTask] = body.scenarios;
  assert.equal(checkLong.predictedHitRate, 0.75, 'check-long (band 0.75-0.85): its shape\'s rate');
  assert.ok(Object.hasOwn(docs, 'predictedHitRate') && docs.predictedHitRate === null, `docs (t-docs-few, frozen as prediction none): a calibrated shape without a band is null: ${JSON.stringify(docs.predictedHitRate)}`);
  assert.ok(!Object.hasOwn(facts, 'predictedHitRate'), 'facts (no shape): no key');
  assert.equal(shortTask.predictedHitRate, 0.4, 'short-task (parity band 0.85-0.95): its shape\'s rate');
  assert.deepEqual({ ...body, scenarios: body.scenarios.map(withoutHitRate) }, before, 'the rate is the only addition: the frozen bands, statistics and verdicts are unchanged');
  assertHitRateBody(body, 'report --json (calibrated)');
});

test('the kit\'s copy of the gateway body schema takes an optional predictedHitRate: a number in [0, 1] or null', () => {
  const { id, receivedAt, ...body } = storedResult('a'.repeat(64), '1.10.520', '2026-10-20T09:00:00.000Z');
  const [scenario] = body.scenarios;
  const parses = (schema, rate) => schema.safeParse({ ...body, scenarios: [{ ...scenario, predictedHitRate: rate }] }).success;
  for (const [name, schema] of [['lib/clientTestBody.mjs', clientTestBodySchema], ['the test copy of the gateway schema', hitRateBodySchema]]) {
    assert.equal(schema.safeParse(body).success, true, `${name}: absent is fine (an uncalibrated shape)`);
    for (const rate of [0, 0.4, 1, null]) assert.equal(parses(schema, rate), true, `${name}: predictedHitRate ${JSON.stringify(rate)}`);
    for (const rate of [1.5, -0.1, '0.75', true]) assert.equal(parses(schema, rate), false, `${name}: predictedHitRate ${JSON.stringify(rate)} is refused`);
  }
});

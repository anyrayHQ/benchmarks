// Socket-free checks for the release's provenance and the shared validation guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { calibrationDocumentSchema, calibrationEntrySchema, classify, predictedHitRate, budgetPlan, formatPlan } from '../lib/planner.mjs';
import { tempDir } from './kitFixtures.mjs';
import { kitAsync, kitCopy, shapedScenarios, TEST_SHAPES } from './kitPlanFixtures.mjs';
import { blockOf, calibrationDoc, docShape, writeJson } from './kitCalibrationFixtures.mjs';

test('calibration preserves the published provenance and parsed catalog, and an empty document clears all blocks', async (t) => {
  const original = readFileSync(new URL('../predictions.yaml', import.meta.url), 'utf8');
  const comments = original.match(/^#.*$/gm).join('\n');
  const copy = kitCopy(t, original);
  const firstShape = yaml.load(original).shapes[0].id;
  const entry = { ...docShape('t-cc-check-long'), shapeId: firstShape };
  const file = writeJson(join(tempDir(t), 'calibration.json'), calibrationDoc([entry]));
  const run = () => kitAsync(t, ['calibrate', '--from', file, '--json'], { kitRoot: copy.root });
  assert.equal((await run()).status, 0);
  const after = readFileSync(join(copy.root, 'predictions.yaml'), 'utf8');
  assert.equal(after.match(/^#.*$/gm).join('\n'), comments);
  const parsed = yaml.load(after);
  assert.deepEqual(parsed.shapes[0].calibration, blockOf(entry));
  delete parsed.shapes[0].calibration;
  assert.deepEqual(parsed, yaml.load(original));
  assert.equal((await run()).status, 0);
  assert.equal(readFileSync(join(copy.root, 'predictions.yaml'), 'utf8'), after);
  writeJson(file, calibrationDoc([]));
  assert.equal((await run()).status, 0);
  const cleared = readFileSync(join(copy.root, 'predictions.yaml'), 'utf8');
  assert.deepEqual(yaml.load(cleared), yaml.load(original));
  assert.equal(cleared.match(/^#.*$/gm).join('\n'), comments);
});

test('the shared validator refuses nested unknown keys, nonpositive misses, and non-UTC timestamps', () => {
  const invalid = [
    (s) => { s.misses[0].tenant = 'private'; },
    (s) => { s.misses[0].band.tenant = 'private'; },
    (s) => { s.misses[0].median = 0; },
    (s) => { s.misses[0].median = Infinity; },
    (s) => { s.misses[0].band.lo = -1; },
    (s) => { s.misses[0].band.hi = Infinity; },
  ];
  for (const mutate of invalid) {
    const entry = structuredClone(docShape('t-cc-check-long'));
    mutate(entry);
    assert.equal(calibrationEntrySchema.safeParse(blockOf(entry)).success, false);
    assert.equal(calibrationDocumentSchema.safeParse(calibrationDoc([entry])).success, false);
  }
  for (const generatedAt of ['not-a-date', '2026-10-22', '2026-10-22T00:00:00+02:00']) {
    assert.equal(calibrationDocumentSchema.safeParse(calibrationDoc([], { generatedAt })).success, false);
  }
  for (const band of [null, { lo: 0, hi: 1 }, { lo: 1, hi: Infinity }, { lo: 1, hi: 2, extra: 1 }]) {
    const entry = structuredClone(docShape('t-cc-check-long'));
    entry.misses[0].band = band;
    const result = calibrationDocumentSchema.safeParse(calibrationDoc([entry]));
    assert.equal(result.success, false);
    assert.ok(result.error.issues.some(({ path }) => JSON.stringify(path) === JSON.stringify(['shapes', 0, 'misses', 0, 'band'])));
  }
  assert.equal(calibrationDocumentSchema.safeParse(calibrationDoc([])).success, true);
});

test('offline plans show a hit rate only for a calibrated band, including zero hits', () => {
  const catalog = { shapes: TEST_SHAPES.map((s) => ({ ...s, ...(docShape(s.id) ? { calibration: blockOf(docShape(s.id)) } : {}) })) };
  const scenarios = Object.entries(shapedScenarios()).map(([id, bundle]) => {
    const classified = classify(bundle.doc, 'claude-code', catalog);
    const shape = catalog.shapes.find((s) => s.id === classified.shapeId);
    return { id, ...classified, predictedHitRate: predictedHitRate(shape, classified.prediction) };
  });
  const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
  assert.equal(byId['check-long'].predictedHitRate, 0.75);
  assert.equal(byId['short-task'].predictedHitRate, 0.4);
  for (const id of ['docs', 'facts', 'paused', 'mcp-check-long']) assert.equal(byId[id].predictedHitRate, null);
  const human = formatPlan(budgetPlan(scenarios, { budgetUsd: 500, sessionCostUsd: 0.15 }), catalog);
  assert.match(human, /check-long:.*band right in 3 of 4 earlier tests/);
  assert.match(human, /short-task:.*band right in 2 of 5 earlier tests/);
  assert.equal(human.split('band right in').length - 1, 2);
  const shape = catalog.shapes.find((s) => s.id === 't-cc-check-long');
  shape.calibration = { rounds: 8, results: 1, hits: 0, hitRate: 0, misses: [shape.calibration.misses[0]] };
  assert.equal(calibrationEntrySchema.safeParse(shape.calibration).success, true);
  assert.equal(predictedHitRate(shape, byId['check-long'].prediction), 0);
});

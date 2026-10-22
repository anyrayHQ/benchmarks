// `npm run calibrate -- --from <file>` (ANY-1492): each release regenerates predictions.yaml
// from vendor-admin's calibration document, so every band carries how often it was right in
// earlier client tests, misses included. Driven through the CLI against a COPY of the kit
// (kitCopy, ANY-1486's test catalog), so the file written is the copy's, never the real one.
// The document's rules are the shared contract with the monorepo: a shape under 8 rounds
// publishes null (never 0), hits <= results, every miss listed with the side it fell on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { tempDir, writeScenariosDir } from './kitFixtures.mjs';
import { TEST_SHAPES, byId, fakeGateway, json, kitAsync, kitCopy, npmRunAsync, planEnv, planOk, planRun, shapeScenario } from './kitPlanFixtures.mjs';
import {
  DOC_SHAPES, STALE_CATALOG, STALE_SHAPES, UNKNOWN_SHAPE, assertIssues, blockOf, calibrationDoc, catalogText, docShape, manyMisses, miss,
  readCatalogAt, withoutBlock, writeJson,
} from './kitCalibrationFixtures.mjs';

const calibrate = (t, copy, args) => kitAsync(t, ['calibrate', ...args], { kitRoot: copy.root });
const docFile = (t, doc) => writeJson(join(tempDir(t, 'calibration-'), 'calibration.json'), doc);

/** A successful calibrate answer, or a failure that says what came back instead. */
function calibrateOk(child, what) {
  const out = json(child, what);
  assert.equal(out.ok, true, `${what}: calibrate refused: ${child.stdout.slice(0, 400)} ${child.stderr.slice(0, 400)}`);
  assert.equal(out.command, 'calibrate', what);
  assert.equal(child.status, 0, `${what}: exit ${child.status}`);
  return out;
}

// ---- writing the blocks ----------------------------------------------------------------------------

test('calibrate writes each document shape\'s block into its catalog shape, clears a stale block, reports an unknown shape id without inventing it, and leaves everything else as it was', async (t) => {
  const copy = kitCopy(t, STALE_CATALOG);
  const file = docFile(t, calibrationDoc());
  const out = calibrateOk(await calibrate(t, copy, ['--from', file, '--json']), 'calibrate --json');
  assert.deepEqual(out.updated, ['t-cc-check-long', 't-cc-medium-pause', 't-cc-short', 't-docs-few'], 'the catalog shapes that now carry a block, sorted');
  assert.deepEqual(out.unknown, [UNKNOWN_SHAPE], 'a document shape id the catalog does not have is reported');

  const after = readCatalogAt(copy.root);
  assert.deepEqual(Object.keys(after).sort(), ['shapes', 'version'], 'the catalog keeps exactly its top-level keys');
  assert.equal(after.version, 1);
  assert.deepEqual(after.shapes.map((s) => s.id), TEST_SHAPES.map((s) => s.id), 'the same shapes in the same order: no shape is added for an unknown id');
  for (const [i, shape] of after.shapes.entries()) {
    assert.deepEqual(withoutBlock(shape), withoutBlock(STALE_SHAPES[i]), `${shape.id}: id, match, expect, band, rounds and source are untouched`);
    const entry = docShape(shape.id);
    if (entry) assert.deepEqual(shape.calibration, blockOf(entry), `${shape.id}: the block is the document entry minus its shapeId`);
    else assert.ok(!Object.hasOwn(shape, 'calibration'), `${shape.id}: a shape the document does not name keeps no block (t-mcp-many's stale one is removed)`);
  }
  assert.equal(after.shapes.find((s) => s.id === 't-cc-medium-pause').calibration.hitRate, null, 'under 8 rounds the rate stays null, never 0');
  assert.ok(!catalogText(copy.root).includes(UNKNOWN_SHAPE), 'the unknown id is not written anywhere in the catalog');

  // Same document again: same bytes (no second block, no reordering).
  const once = catalogText(copy.root);
  calibrateOk(await calibrate(t, copy, ['--from', file, '--json']), 'calibrate --json, twice');
  assert.equal(catalogText(copy.root), once, 'calibrate is idempotent');

  // The written catalog is one the planner loads, and the rate reaches the plan.
  const gateway = await fakeGateway(t);
  const dir = writeScenariosDir(tempDir(t), { 'check-long': shapeScenario({ requests: 'long', outcome: 'check' }) });
  const plan = planOk(await planRun(t, dir, gateway, ['--budget-usd', '500', '--session-cost-usd', '0.15', '--json'], { kitRoot: copy.root }), 'plan --json after calibrate');
  assert.equal(byId(plan.scenarios)['check-long'].predictedHitRate, 0.75, 'plan reads the block calibrate wrote');
});

test('a miss is never dropped: twelve misses on one shape round-trip into predictions.yaml, in order, each with its plan, median, band and side', async (t) => {
  const copy = kitCopy(t);
  const misses = manyMisses();
  const entry = { shapeId: 't-cc-check-long', rounds: 40, results: 20, hits: 8, hitRate: 0.4, misses };
  calibrateOk(await calibrate(t, copy, ['--from', docFile(t, calibrationDoc([entry])), '--json']), 'calibrate --json (12 misses)');
  const block = readCatalogAt(copy.root).shapes.find((s) => s.id === 't-cc-check-long').calibration;
  assert.equal(block.misses.length, 12, 'every miss is listed');
  assert.deepEqual(block.misses, misses, 'each miss exactly as the document listed it');
  assert.deepEqual(new Set(block.misses.map((m) => m.side)), new Set(['below', 'above']), 'misses on both sides of the band');
});

test('calibrate with no matching shape at all still succeeds: unknown ids are listed (human mode names them), no block is written', async (t) => {
  const copy = kitCopy(t);
  const before = catalogText(copy.root);
  const doc = calibrationDoc([docShape(UNKNOWN_SHAPE)]);
  const out = calibrateOk(await calibrate(t, copy, ['--from', docFile(t, doc), '--json']), 'calibrate --json (only unknown)');
  assert.deepEqual([out.updated, out.unknown], [[], [UNKNOWN_SHAPE]]);
  const shapes = readCatalogAt(copy.root).shapes;
  assert.ok(shapes.every((s) => !Object.hasOwn(s, 'calibration')), 'no block for a document that names no catalog shape');
  assert.deepEqual(shapes, TEST_SHAPES, 'the catalog parses as before');

  const human = await calibrate(t, copy, ['--from', docFile(t, doc)]);
  assert.equal(human.status, 0, `calibrate (human): exit ${human.status}: ${human.stderr.slice(0, 400)}`);
  assert.ok(human.stdout.includes(UNKNOWN_SHAPE), `the human answer names the unknown shape id: ${JSON.stringify(human.stdout.slice(0, 400))}`);
  assert.deepEqual(readCatalogAt(copy.root), yaml.load(before), 'still no block');
});

// ---- refusals ----------------------------------------------------------------------------------------

/** The one valid shape the refusal cases start from (t-cc-check-long: 3 of 4, one miss above). */
const base = () => structuredClone(docShape('t-cc-check-long'));
const one = (mutate) => { const s = base(); mutate(s); return calibrationDoc([s]); };

test('calibrate refuses a document that breaks the shared rules (calibration_invalid, exit 4, an issue at the offending path) and leaves predictions.yaml byte-for-byte unchanged', async (t) => {
  const copy = kitCopy(t, STALE_CATALOG);
  const before = catalogText(copy.root);
  const cases = [
    ['version 2', calibrationDoc(DOC_SHAPES, { version: 2 }), { at: ['version'] }],
    ['no version', (() => { const d = calibrationDoc(); delete d.version; return d; })(), { at: ['version'] }],
    ['minRounds 5 (the floor is the kit\'s 8)', calibrationDoc(DOC_SHAPES, { minRounds: 5 }), { at: ['minRounds'] }],
    ['shapes not a list', calibrationDoc(DOC_SHAPES, { shapes: {} }), { at: ['shapes'] }],
    ['a rate under 8 rounds', one((s) => { s.rounds = 7; }), { at: ['shapes', 0, 'hitRate'] }],
    ['a rate of 0 under 8 rounds (null, never 0)', one((s) => Object.assign(s, { rounds: 7, results: 1, hits: 0, hitRate: 0 })), { at: ['shapes', 0, 'hitRate'] }],
    ['null at exactly 8 rounds', one((s) => Object.assign(s, { rounds: 8, hitRate: null })), { at: ['shapes', 0, 'hitRate'] }],
    ['a rate that is not hits / results', one((s) => { s.hitRate = 0.8; }), { at: ['shapes', 0, 'hitRate'] }],
    ['more hits than results', one((s) => Object.assign(s, { hits: 5, hitRate: 1.25, misses: [] })), { at: ['shapes', 0, 'hits'] }],
    ['a dropped miss (4 results, 2 hits, 1 miss)', one((s) => Object.assign(s, { hits: 2, hitRate: 0.5 })), { at: ['shapes', 0, 'misses'] }],
    ['an extra miss (4 results, 3 hits, 2 misses)', one((s) => s.misses.push(miss('fedcba98', 0.5, 0.75, 0.85, 'below'))), { at: ['shapes', 0, 'misses'] }],
    ['a miss above its band labelled below', one((s) => { s.misses[0].side = 'below'; }), { at: ['shapes', 0, 'misses', 0, 'side'] }],
    ['a "miss" whose median is inside its band', one((s) => { s.misses[0].median = 0.8; }), { at: ['shapes', 0, 'misses', 0, 'side'] }],
    ['a side that is neither below nor above', one((s) => { s.misses[0].side = 'inside'; }), { at: ['shapes', 0, 'misses', 0, 'side'] }],
    ['a full planHash instead of its 8-hex prefix', one((s) => { s.misses[0].plan = '0123abcd'.repeat(8); }), { at: ['shapes', 0, 'misses', 0, 'plan'] }],
    ['an uppercase plan prefix', one((s) => { s.misses[0].plan = '0123ABCD'; }), { at: ['shapes', 0, 'misses', 0, 'plan'] }],
    ['a miss band with lo above hi', one((s) => { s.misses[0].band = { lo: 0.85, hi: 0.75 }; }), { at: ['shapes', 0, 'misses', 0, 'band'] }],
    ['fractional rounds', one((s) => { s.rounds = 23.5; }), { at: ['shapes', 0, 'rounds'] }],
    ['a shapeId that is not catalog form', one((s) => { s.shapeId = 'T_CC'; }), { at: ['shapes', 0, 'shapeId'] }],
    ['a duplicate shapeId', calibrationDoc([base(), base()]), { at: ['shapes', 1, 'shapeId'] }],
    ['a tenant id on a shape (the document is content-free)', one((s) => { s.tenantId = 'acme'; }), { under: ['shapes', 0] }],
    ['a deployment list at the top level', calibrationDoc(DOC_SHAPES, { deployments: ['dep-1'] }), { under: [] }],
  ];
  for (const [label, doc, { at, under }] of cases) {
    const child = await calibrate(t, copy, ['--from', docFile(t, doc), '--json']);
    const out = json(child, `calibrate --json (${label})`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'calibrate', code: 'calibration_invalid' }, label);
    assert.equal(child.status, 4, `${label}: exit ${child.status}`);
    assertIssues(out, label);
    const paths = out.issues.map((i) => JSON.stringify(i.path));
    if (at) assert.ok(paths.includes(JSON.stringify(at)), `${label}: an issue at ${JSON.stringify(at)}; got ${paths.join(' ')}`);
    if (under) assert.ok(out.issues.some((i) => JSON.stringify(i.path.slice(0, under.length)) === JSON.stringify(under)), `${label}: an issue under ${JSON.stringify(under)}; got ${paths.join(' ')}`);
    assert.equal(catalogText(copy.root), before, `${label}: predictions.yaml changed`);
  }

  // Bytes that are not a document at all, and a file that does not exist.
  const notJson = join(tempDir(t, 'calibration-'), 'calibration.json');
  writeJson(notJson, 'x');
  const raw = join(tempDir(t, 'calibration-'), 'raw.json');
  writeFileSync(raw, '{ "version": 1, ');
  for (const [label, file] of [['a JSON string, not an object', notJson], ['truncated JSON', raw], ['a missing file', join(tempDir(t), 'nope.json')]]) {
    const child = await calibrate(t, copy, ['--from', file, '--json']);
    const out = json(child, `calibrate --json (${label})`);
    assert.deepEqual({ ok: out.ok, code: out.code }, { ok: false, code: 'calibration_invalid' }, label);
    assert.equal(child.status, 4, label);
    assert.equal(catalogText(copy.root), before, `${label}: predictions.yaml changed`);
  }

  // Without --json: one stderr line starting with the code, nothing on stdout.
  const human = await calibrate(t, copy, ['--from', docFile(t, one((s) => { s.rounds = 7; }))]);
  assert.equal(human.status, 4);
  assert.equal(human.stdout, '', 'nothing on stdout');
  assert.match(human.stderr, /^calibration_invalid/m);
  assert.equal(catalogText(copy.root), before);

  // The control: the same copy accepts the valid document, so each refusal above was about its one change.
  calibrateOk(await calibrate(t, copy, ['--from', docFile(t, calibrationDoc()), '--json']), 'calibrate --json (valid)');
  assert.notEqual(catalogText(copy.root), before, 'a valid document does change the catalog');
});

test('calibrate usage: --from is required and takes a value, and no other flag is accepted (usage, exit 2, file untouched)', async (t) => {
  const copy = kitCopy(t);
  const before = catalogText(copy.root);
  const file = docFile(t, calibrationDoc());
  // The control: --from <file> alone is a complete command line (on a second copy, so the file under test stays as it was).
  calibrateOk(await calibrate(t, kitCopy(t), ['--from', file, '--json']), 'calibrate --from <file> --json');
  for (const [label, args] of [
    ['no --from', ['--json']],
    ['--from without a value', ['--from', '--json']],
    ['an unknown flag', ['--from', file, '--write', 'yes', '--json']],
    ['--scenarios-dir is not a calibrate flag', ['--from', file, '--scenarios-dir', tempDir(t), '--json']],
  ]) {
    const child = await calibrate(t, copy, args);
    const out = json(child, `calibrate (${label})`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'calibrate', code: 'usage' }, label);
    assert.equal(child.status, 2, label);
    assert.equal(catalogText(copy.root), before, `${label}: predictions.yaml changed`);
  }
});

test('npm run -s calibrate: JSON only on stdout, and a relative --from resolves from where npm was run', async (t) => {
  const copy = kitCopy(t);
  const parent = tempDir(t, 'client-');
  mkdirSync(join(parent, 'release'));
  writeJson(join(parent, 'release', 'calibration.json'), calibrationDoc());
  const child = await npmRunAsync(t, 'calibrate', ['--from', join('release', 'calibration.json'), '--json'], { kitRoot: copy.root, cwd: parent, env: planEnv(t) });
  const out = calibrateOk(child, 'npm run -s calibrate -- --json');
  assert.deepEqual(out.unknown, [UNKNOWN_SHAPE]);
  assert.deepEqual(readCatalogAt(copy.root).shapes.find((s) => s.id === 't-cc-short').calibration, blockOf(docShape('t-cc-short')));
});

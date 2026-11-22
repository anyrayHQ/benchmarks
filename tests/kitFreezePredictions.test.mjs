// Freeze writes the prediction down (ANY-1486): plan.lock.json carries each scenario's shapeId
// and predicted band, plus the commit of the kit (and so of predictions.yaml) that made them,
// and the plan hash covers both, so neither side can move a band after the results. Verify keeps
// the FROZEN prediction even when the catalog changes later. Also: an error the kit did not
// expect is `kit_failed`, exit 1, and its message is never printed (ANY-1485 review fix).
// Driven through the CLIs; most cases freeze with a kit copy that carries a test catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PINS, PIN_FLAGS, kit, lockPath, onlyJson, readLock, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import {
  HEX40, TEST_SHAPES, expectedPrediction, fakeGateway, json, kitAsync, kitCopy, planOk, planRun, shapeScenario, shapedScenarios,
} from './kitPlanFixtures.mjs';

const shape = (id) => TEST_SHAPES.find((s) => s.id === id);
const flagsFor = (client) => PIN_FLAGS.map((f, i) => (PIN_FLAGS[i - 1] === '--client' ? client : f));

/** Freeze `dir` with the kit copy and the standard pins; returns the answer and the lock. */
async function freezeIn(t, copy, dir, { client = PINS.client, extra = [] } = {}) {
  const child = await kitAsync(t, ['freeze', '--scenarios-dir', dir, ...flagsFor(client), ...extra, '--json'], { kitRoot: copy.root });
  const out = json(child, 'freeze --json (kit copy)');
  assert.equal(out.ok, true, `freeze must succeed before this test can check anything: ${JSON.stringify(out)} ${child.stderr.slice(0, 400)}`);
  assert.equal(child.status, 0);
  return { out, lock: readLock(dir) };
}

const verifyIn = (t, copy, dir) => kitAsync(t, ['verify', '--scenarios-dir', dir, '--json'], { kitRoot: copy.root });

/** shapeId per scenario of shapedScenarios() under the test catalog, claude-code. */
const CC_SHAPES = { 'check-long': 't-cc-check-long', 'short-task': 't-cc-short', paused: 't-cc-medium-pause', 'mcp-check-long': 't-mcp-many', docs: 't-docs-few', facts: null };

test('freeze writes benchmarksCommit (the kit\'s git HEAD) and every scenario\'s shapeId and prediction into the lock, and they match plan --json', async (t) => {
  const copy = kitCopy(t);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const { out, lock } = await freezeIn(t, copy, dir);

  assert.match(lock.benchmarksCommit ?? '', HEX40);
  assert.equal(lock.benchmarksCommit, copy.head, 'the commit whose predictions.yaml made the bands');
  assert.ok(Array.isArray(lock.predictions), 'the lock has a predictions list');
  assert.deepEqual(lock.predictions.map((p) => p.id), lock.scenarios.map((s) => s.id), 'one prediction per scenario, sorted by id like the scenarios');
  for (const p of lock.predictions) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'prediction', 'shapeId'], p.id);
    const keys = { band: ['expect', 'hi', 'lo', 'rounds', 'status'], none: p.prediction?.reason === 'too_few_rounds' ? ['reason', 'rounds', 'status'] : ['reason', 'status'] }[p.prediction?.status];
    assert.deepEqual(Object.keys(p.prediction ?? {}).sort(), keys, `${p.id}: an allowlist, so no content can ride along`);
    assert.equal(p.shapeId, CC_SHAPES[p.id], p.id);
    assert.deepEqual(p.prediction, expectedPrediction(CC_SHAPES[p.id] && shape(CC_SHAPES[p.id])), p.id);
  }
  for (const s of lock.scenarios) assert.deepEqual(Object.keys(s).sort(), ['hash', 'id', 'source'], `${s.id}: scenario entries are unchanged`);

  assert.equal(out.benchmarksCommit, lock.benchmarksCommit, 'the freeze answer carries benchmarksCommit');
  assert.deepEqual(out.predictions, lock.predictions, 'the freeze answer carries the predictions');

  const gateway = await fakeGateway(t);
  const plan = planOk(await planRun(t, dir, gateway, ['--budget-usd', '500', '--session-cost-usd', '0.15', '--json'], { kitRoot: copy.root }), 'plan --json');
  assert.deepEqual(
    plan.scenarios.map(({ id, shapeId, prediction }) => ({ id, shapeId, prediction })),
    lock.predictions,
    'plan and freeze classify the same dir the same way',
  );
});

test('freeze classifies with the pinned client: under --client codex the lock carries the codex shapes', async (t) => {
  const copy = kitCopy(t);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const { lock } = await freezeIn(t, copy, dir, { client: 'codex' });
  assert.equal(lock.pins.client, 'codex');
  const p = Object.fromEntries((lock.predictions ?? []).map((x) => [x.id, x]));
  assert.equal(p.facts?.shapeId, 't-codex-parity');
  assert.deepEqual(p.facts?.prediction, { status: 'band', expect: 'parity', lo: 0.9, hi: 1.1, rounds: 8 });
  assert.equal(p['mcp-check-long']?.shapeId, 't-mcp-many');
});

test('the bands are covered by the plan hash: a hand edit of a band, an expectation, a shapeId or benchmarksCommit is plan_lock_invalid (self_hash)', async (t) => {
  const flip = (hex) => `${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  const pick = (l, id) => l.predictions.find((p) => p.id === id);
  const edits = [
    ['band lo widened', (l) => { pick(l, 'check-long').prediction.lo = 0.5; }],
    ['band hi moved', (l) => { pick(l, 'check-long').prediction.hi = 0.95; }],
    ['saving relabelled parity', (l) => { pick(l, 'check-long').prediction.expect = 'parity'; }],
    ['unknown shape given a shapeId', (l) => { pick(l, 'facts').shapeId = 't-cc-short'; }],
    ['benchmarksCommit edited', (l) => { l.benchmarksCommit = flip(l.benchmarksCommit); }],
  ];
  const copy = kitCopy(t);
  for (const [what, edit] of edits) {
    const dir = writeScenariosDir(tempDir(t), shapedScenarios());
    const { lock } = await freezeIn(t, copy, dir);
    assert.ok(lock.predictions && lock.benchmarksCommit, `${what}: the lock must carry predictions and benchmarksCommit to edit`);
    const ok = await verifyIn(t, copy, dir);
    assert.equal(json(ok, `verify --json before the ${what} edit`).ok, true, `${what}: an untouched lock verifies`);
    edit(lock);
    writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2));
    const child = await verifyIn(t, copy, dir);
    const out = json(child, `verify --json (${what})`);
    assert.deepEqual({ code: out.code, reason: out.reason }, { code: 'plan_lock_invalid', reason: 'self_hash' }, what);
    assert.equal(child.status, 3, what);
  }
});

test('verify keeps the frozen prediction: a catalog change after the freeze changes nothing, and freeze --replace re-classifies at the new commit', async (t) => {
  const copy = kitCopy(t);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const { lock } = await freezeIn(t, copy, dir);
  assert.equal(lock.benchmarksCommit, copy.head, 'the freeze recorded the commit it classified at');
  assert.ok(Array.isArray(lock.predictions) && lock.predictions.length > 0, 'the freeze recorded predictions');
  const frozen = readFileSync(lockPath(dir), 'utf8');

  const moved = TEST_SHAPES.map((s) => (s.id === 't-cc-check-long' ? { ...s, band: { lo: 0.5, hi: 0.6 } } : s));
  const newHead = copy.recommit(yaml.dump({ version: 1, shapes: moved }));
  assert.notEqual(newHead, lock.benchmarksCommit);

  const v = await verifyIn(t, copy, dir);
  const vOut = json(v, 'verify --json after the catalog changed');
  assert.equal(vOut.ok, true, JSON.stringify(vOut));
  assert.equal(vOut.planHash, lock.planHash);
  assert.deepEqual(vOut.predictions, lock.predictions, 'verify answers the frozen predictions, not the current catalog\'s');
  assert.equal(vOut.benchmarksCommit, lock.benchmarksCommit);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), frozen, 'verify never rewrites the lock');

  const { lock: replaced } = await freezeIn(t, copy, dir, { extra: ['--replace'] });
  assert.equal(replaced.benchmarksCommit, newHead);
  assert.deepEqual(replaced.predictions.find((p) => p.id === 'check-long').prediction, { status: 'band', expect: 'saving', lo: 0.5, hi: 0.6, rounds: 9 });
});

test('freeze refuses an mcpTools that is not a whole number of tools (scenario_invalid, field mcpTools) and writes no lock', (t) => {
  for (const bad of [-1, 2.5, '200']) {
    const dir = writeScenariosDir(tempDir(t), { seat: shapeScenario({}, { mcpTools: bad }) });
    const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
    const out = onlyJson(child, `freeze --json (mcpTools ${JSON.stringify(bad)})`);
    assert.deepEqual({ code: out.code, scenario: out.scenario, field: out.field }, { code: 'scenario_invalid', scenario: 'seat', field: 'mcpTools' }, `mcpTools ${JSON.stringify(bad)}`);
    assert.equal(child.status, 4);
    assert.ok(!existsSync(lockPath(dir)), 'a refused freeze leaves no lock');
  }
});

// ---- kit_failed --------------------------------------------------------------------------------

test('an error the kit did not expect is kit_failed, exit 1, with the thrown name and never its message (not a usage error)', (t) => {
  // plan.lock.json is a dangling symlink: existsSync says no lock, and the O_EXCL write throws EEXIST.
  const parent = tempDir(t);
  const dir = writeScenariosDir(parent, twoScenarios());
  const target = join(parent, 'nowhere', 'lock.json');
  symlinkSync(target, lockPath(dir));

  const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
  const out = onlyJson(child, 'freeze --json over a dangling lock symlink');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code, error: out.error }, { ok: false, command: 'freeze', code: 'kit_failed', error: 'Error' });
  assert.equal(child.status, 1);

  const human = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS]);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /^kit_failed\b/m, 'the human line starts with its code');

  for (const [mode, run] of [['--json', child], ['human', human]]) {
    for (const raw of ['EEXIST', 'already exists', target]) {
      assert.ok(!run.stdout.includes(raw) && !run.stderr.includes(raw), `${mode}: the thrown message reached the output (${raw})`);
    }
  }
  assert.ok(!existsSync(target), 'nothing was written through the symlink');
});

// `twinOf` (ANY-1491): the optional scenario.yaml field naming the client plan (its planHash) a
// PUBLIC scenario stands in for. The vendor-admin release rows join a twin's result to a tenant's
// plan through it, so it is a 64-char lowercase hex plan hash or absent: never a placeholder (64
// zeros would read as a plan hash everywhere downstream), and never on a client's own scenario.
// Like every scenario value it is inside the plan hash. The report carries it only when present,
// so a plan without twins still prints a body today's strict gateway accepts.
// Real kit for freeze/verify, a kit copy and synthetic records for the report; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PIN_FLAGS, docsScenario, fixScenario, freezeOk, kit, kitEnv, lockPath, onlyJson, tempDir, writeScenariosDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { assertGatewayBody, factsScenario, freezeWith, kitIn, kitRunCopy, pairRound, writeDir, writeRecord } from './kitRunFixtures.mjs';
import { TWIN_OF, TWIN_OF_2, assertTwinBody, twinScenario } from './kitReleaseFixtures.mjs';

const freeze = (t, dir) => kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);

test('a proposed scenario may name the client plan it stands in for (twinOf: 64 lowercase hex)', (t) => {
  const root = tempDir(t);
  const dir = writeScenariosDir(root, { 'acme-fix': fixScenario(), 'acme-docs': docsScenario({ twinOf: TWIN_OF }) });
  const { out } = freezeOk(t, dir);
  assert.deepEqual(out.scenarios.map((s) => s.id).sort(), ['acme-docs', 'acme-fix']);
});

test('freeze refuses a malformed twinOf, the 64-zero placeholder included (scenario_invalid, field twinOf), and writes no lock', (t) => {
  const bad = {
    '63 hex': TWIN_OF.slice(1),
    '65 hex': `${TWIN_OF}a`,
    uppercase: TWIN_OF.toUpperCase(),
    'a non-hex character': `${TWIN_OF.slice(0, 63)}g`,
    '64 zeros (a placeholder)': '0'.repeat(64),
    'the empty string': '',
    'a number': 12345,
  };
  for (const [what, value] of Object.entries(bad)) {
    const root = tempDir(t);
    const dir = writeScenariosDir(root, { 'acme-fix': fixScenario(), 'acme-docs': docsScenario({ twinOf: value }) });
    const child = freeze(t, dir);
    const out = onlyJson(child, `freeze --json, twinOf ${what}`);
    assert.deepEqual({ ok: out.ok, code: out.code, scenario: out.scenario, field: out.field }, { ok: false, code: 'scenario_invalid', scenario: 'acme-docs', field: 'twinOf' }, what);
    assert.equal(child.status, 4, `${what}: exit ${child.status}`);
    assert.ok(!existsSync(lockPath(dir)), `${what}: no lock written`);
  }
});

test('twinOf names the client plan a PUBLIC scenario stands in for: on the client\'s own scenario it is refused', (t) => {
  const root = tempDir(t);
  const dir = writeScenariosDir(root, { 'acme-fix': fixScenario({ twinOf: TWIN_OF }), 'acme-docs': docsScenario() });
  const child = freeze(t, dir);
  const out = onlyJson(child, 'freeze --json, twinOf on a client scenario');
  assert.deepEqual({ ok: out.ok, code: out.code, scenario: out.scenario, field: out.field }, { ok: false, code: 'scenario_invalid', scenario: 'acme-fix', field: 'twinOf' });
  assert.equal(child.status, 4);
  assert.ok(!existsSync(lockPath(dir)), 'no lock written');
});

test('the plan hash covers twinOf: pointing a frozen twin at another client plan is plan_hash_mismatch; the lock itself never holds it', (t) => {
  const root = tempDir(t);
  const docs = docsScenario({ twinOf: TWIN_OF });
  const dir = writeScenariosDir(root, { 'acme-fix': fixScenario(), 'acme-docs': docs });
  const { lock } = freezeOk(t, dir);
  for (const s of lock.scenarios) assert.deepEqual(Object.keys(s).sort(), ['hash', 'id', 'source'], 'scenario entries stay { id, source, hash }');
  assert.ok(!JSON.stringify(lock).includes(TWIN_OF), 'the lock does not copy twinOf out of the scenario');

  writeFileSync(join(dir, 'acme-docs', 'scenario.yaml'), yaml.dump({ ...docs.doc, twinOf: TWIN_OF_2 }));
  const child = kit(t, ['verify', '--scenarios-dir', dir, '--json']);
  const out = onlyJson(child, 'verify --json after twinOf changed');
  assert.deepEqual({ code: out.code, expected: out.expected, changed: out.changed }, { code: 'plan_hash_mismatch', expected: lock.planHash, changed: ['acme-docs'] });
  assert.equal(child.status, 3);
});

test('report --redact --json carries twinOf for the twin and no twinOf key at all for the scenario without one', async (t) => {
  const root = tempDir(t, 'kit-twinof-');
  const env = kitEnv(join(root, 'home'));
  const origin = { git: 'https://git.example.test/public/lint-demo.git', ref: '0123456789abcdef0123456789abcdef01234567', patchText: '--- a/lib.js\n+++ b/lib.js\n@@ -1 +1,2 @@\n export const one = 1;\n+export const two = 2;\n' };
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'lint-twin': twinScenario(origin), facts: factsScenario(origin) }, 'twins-plan');
  const lock = await freezeWith(copy.root, dir, 'https://gw.example.test', env);
  const rounds = [0.5, 0.55, 0.48, 0.52, 0.51, 0.49, 0.53, 0.5].map((b, i) => pairRound(i + 1, 1, b));
  for (const id of ['facts', 'lint-twin']) writeRecord(dir, lock, id, rounds);

  const child = await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env });
  const body = json(child, 'report --redact --json');
  assert.equal(child.status, 0, `report failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-400)}`);
  assert.deepEqual(body.scenarios?.map((s) => s.source), ['proposed', 'proposed'], 'facts, then lint-twin (the lock\'s order)');
  assert.equal(body.scenarios[1].twinOf, TWIN_OF, 'the twin names the client plan it stands in for');
  assert.ok(!Object.hasOwn(body.scenarios[0], 'twinOf'), 'no twinOf key (not null, not "") for a scenario without one');
  assertTwinBody(body, 'report --json with a twin');
  const { twinOf, ...withoutTwinOf } = body.scenarios[1];
  assert.equal(twinOf, TWIN_OF);
  assertGatewayBody({ ...body, scenarios: [body.scenarios[0], withoutTwinOf] }, 'the same body without twinOf (twinOf is the only addition)');
});

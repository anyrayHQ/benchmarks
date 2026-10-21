// `patch` may be one file or a list (README "Scenarios"; scenarioPatches in lib/agentRun.mjs),
// and our own gin-test-triage and gin-ci-paste use a list. Freeze must accept the list form,
// hash every listed patch, and still refuse a list entry that leaves the scenario dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATCH_TEXT, PIN_FLAGS, fixScenario, freezeOk, kit, onlyJson, tempDir, writeScenariosDir } from './kitFixtures.mjs';

const listScenario = (patch) => {
  const base = fixScenario({ patch });
  return { ...base, files: { ...base.files, 'second.patch': PATCH_TEXT.replace('tokenizer', 'tokeniser') } };
};

test('freeze accepts a patch list and the plan covers every listed patch', (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'acme-fix': listScenario(['bug.patch', 'second.patch']) });
  const { lock } = freezeOk(t, dir);
  assert.ok(lock.scenarios.some((s) => s.id === 'acme-fix'), 'the list-patch scenario is in the plan');

  writeFileSync(join(dir, 'acme-fix', 'second.patch'), PATCH_TEXT + '\n');
  const verify = kit(t, ['verify', '--scenarios-dir', dir, '--json']);
  const out = onlyJson(verify, 'verify --json');
  assert.equal(out.code, 'plan_hash_mismatch', 'a change to the SECOND listed patch moves the plan hash');
  assert.deepEqual(out.changed, ['acme-fix']);
});

test('freeze refuses a patch list entry that escapes the scenario dir', (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'acme-fix': listScenario(['bug.patch', '../outside.patch']) });
  const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
  const out = onlyJson(child, 'freeze --json');
  assert.equal(out.ok, false);
  assert.equal(out.field, 'patch', `refused on the patch field: ${JSON.stringify(out)}`);
});

// A scenario may say, in the client's own words, what a passing run looks like (`expect`). It is
// frozen in the plan hash with the rest of the scenario, validated, and shown beside the quality
// line in the local report and page. It is client text, so it never enters the validated JSON body
// or anything published. Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { PIN_FLAGS, fixScenario, kit, kitEnv, onlyJson, tempDir, writeScenariosDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, syntheticPlan } from './kitRunFixtures.mjs';

const EXPECT = 'The repo test run exits 0 and src/api.ts no longer imports lodash.';
const report = (copy, dir, env, args = []) => kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', ...args], { env });

test('freeze refuses an expectation that is empty, not text, too long or holds a control character', (t) => {
  for (const [label, expect] of [['empty', '  '], ['a list', ['a']], ['too long', 'x'.repeat(301)], ['a control character', 'bad\u0007bell']]) {
    const dir = writeScenariosDir(tempDir(t), { 'acme-fix': fixScenario({ expect }) });
    const out = onlyJson(kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']), `freeze (${label})`);
    assert.equal(out.code, 'scenario_invalid', label);
    assert.equal(out.field, 'expect', label);
  }
});

test('freeze accepts a plain-language expectation, and changing it afterwards breaks verify', (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'acme-fix': fixScenario({ expect: EXPECT }) });
  assert.equal(onlyJson(kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']), 'freeze').ok, true);
  assert.equal(onlyJson(kit(t, ['verify', '--scenarios-dir', dir, '--json']), 'verify').ok, true);
  const file = join(dir, 'acme-fix', 'scenario.yaml');
  const doc = yaml.load(readFileSync(file, 'utf8'));
  writeFileSync(file, yaml.dump({ ...doc, expect: 'Anything passes.' }));
  assert.equal(onlyJson(kit(t, ['verify', '--scenarios-dir', dir, '--json']), 'verify after edit').ok, false);
});

test('the text report states each scenario\'s expected result, or that none was stated', async (t) => {
  const root = tempDir(t, 'kit-expect-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env, expect: EXPECT });
  const lines = (await report(copy, dir, env)).stdout.split('\n');
  const at = lines.findIndex((l) => l.startsWith('check-long '));
  assert.ok(at >= 0, 'check-long line present');
  assert.match(lines.slice(at + 1, at + 4).join('\n'), new RegExp(`Expected: ${EXPECT.replaceAll('.', '\\.')}`));
  const other = lines.findIndex((l) => l.startsWith('short-task '));
  assert.match(lines.slice(other + 1, other + 4).join('\n'), /Expected: not stated/);
});

test('the expectation never reaches the validated JSON body that is published', async (t) => {
  const root = tempDir(t, 'kit-expect-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env, expect: EXPECT });
  const out = (await report(copy, dir, env, ['--json'])).stdout;
  assert.ok(!out.includes('lodash') && !out.includes('expect'), `body carries the expectation: ${out.slice(0, 200)}`);
  json(await report(copy, dir, env, ['--json']), 'report --json');
});

test('the page shows the expectation, escaped', async (t) => {
  const root = tempDir(t, 'kit-expect-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env, expect: 'Exit 0 and <b>no</b> lodash & done.' });
  assert.equal((await report(copy, dir, env, ['--html'])).status, 0);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.ok(page.includes('Exit 0 and &lt;b&gt;no&lt;/b&gt; lodash &amp; done.'), 'escaped expectation missing');
  assert.ok(!page.includes('<b>no</b>'), 'unescaped markup in the page');
  assert.match(page, /Expected: not stated/);
});

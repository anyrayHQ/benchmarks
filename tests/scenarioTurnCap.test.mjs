import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

import { APP_SCENARIOS, CONNECT_WORK_MODE_MIN_TURNS, SDK_SCENARIOS, connectWorkMode, effectiveScenario, parseArgs } from '../run_agent.mjs';

const root = join(import.meta.dirname, '..', 'scenarios');
const claudeCodeScenarios = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !SDK_SCENARIOS.includes(entry.name) && !APP_SCENARIOS.includes(entry.name))
  .map((entry) => ({ name: entry.name, scenario: parseYaml(readFileSync(join(root, entry.name, 'scenario.yaml'), 'utf8')) }));

test('the scenario list is not empty', () => {
  assert.ok(claudeCodeScenarios.length > 10, `found ${claudeCodeScenarios.length} Claude Code scenarios`);
});

test("every Claude Code scenario's turn cap leaves connect's work mode on, as production has it", () => {
  const below = claudeCodeScenarios
    .filter(({ scenario }) => !(scenario.maxTurns >= CONNECT_WORK_MODE_MIN_TURNS))
    .map(({ name, scenario }) => `${name}: ${scenario.maxTurns}`);
  assert.deepEqual(below, []);
});

test('connect work mode reads off under a cap below 80, on at 80 and above', () => {
  assert.equal(CONNECT_WORK_MODE_MIN_TURNS, 80);
  assert.equal(connectWorkMode('pyrepo-docs', { maxTurns: 30 }), 'off_turn_cap');
  assert.equal(connectWorkMode('pyrepo-docs', { maxTurns: 79 }), 'off_turn_cap');
  assert.equal(connectWorkMode('pyrepo-docs', { maxTurns: 80 }), 'on');
  assert.equal(connectWorkMode('pyrepo-docs', { maxTurns: 120 }), 'on');
});

test('the default cap the harness spawns with (40) reads off', () => {
  assert.equal(connectWorkMode('pyrepo-docs', {}), 'off_turn_cap');
});

test('SDK scenarios run no Claude Code hooks, so they have no work mode', () => {
  for (const name of SDK_SCENARIOS) assert.equal(connectWorkMode(name, { maxTurns: 30 }), null);
});

test('--max-turns below 80 turns work mode off for the run', () => {
  const args = parseArgs(['--scenario', 'pyrepo-docs', '--kinds', 'content_census', '--max-turns', '30']);
  assert.equal(connectWorkMode('pyrepo-docs', effectiveScenario({ maxTurns: 80 }, args)), 'off_turn_cap');
});

test('the Agent SDK app lane is refused here: run_sdk_app.mjs drives it', () => {
  assert.throws(() => parseArgs(['--scenario', 'sdk-app-scanner']), /run_sdk_app\.mjs/);
});

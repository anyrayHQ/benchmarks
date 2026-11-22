// `pastes:` puts one file's text into several turns, byte for byte the same each time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fillPastes, readScenarioFile } from '../run_agent.mjs';

const files = { 'log.txt': 'line 1\nline 2\n' };
const read = (file) => files[file];

test('fillPastes: each {{name}} in the task and follow-ups becomes the file, its last newline dropped', () => {
  const s = fillPastes({ pastes: { log: 'log.txt' }, task: 'a\n{{log}}\nb', followups: ['again: {{log}}', 'recap'], check: 'x' }, read);
  assert.equal(s.task, 'a\nline 1\nline 2\nb');
  assert.deepEqual(s.followups, ['again: line 1\nline 2', 'recap']);
  assert.equal(s.check, 'x');
});

test('fillPastes: a scenario without pastes is returned as it is', () => {
  const s = { task: 'keep {{this}}' };
  assert.equal(fillPastes(s, read), s);
});

test('fillPastes: an unknown placeholder, an unused paste or a path outside the scenario is an error', () => {
  assert.throws(() => fillPastes({ pastes: { log: 'log.txt' }, task: '{{log}} {{other}}' }, read), /\{\{other\}\}, which is not in pastes/);
  assert.throws(() => fillPastes({ pastes: { log: 'log.txt' }, task: 'nothing' }, read), /pastes log appear in no turn/);
  assert.throws(() => fillPastes({ pastes: { log: '../log.txt' }, task: '{{log}}' }, read), /must be a file name beside scenario.yaml/);
});

test('gin-ci-paste: the same CI log in four of its five turns', () => {
  const dir = join(import.meta.dirname, '..', 'scenarios', 'gin-ci-paste');
  const s = readScenarioFile(dir);
  const log = readFileSync(join(dir, 'ci-log.txt'), 'utf8').replace(/\n$/, '');
  assert.deepEqual([s.task, ...s.followups].map((t) => t.includes(log)), [true, true, true, true, false]);
  assert.match(log, /--- FAIL: TestContextQueryAndPostForm/);
  assert.doesNotMatch(log, /\/Users\/|\/private\/|\/var\/folders\//, 'no local paths');
});

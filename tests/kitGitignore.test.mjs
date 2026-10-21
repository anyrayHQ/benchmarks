// The kit's .gitignore (ANY-1485) mirrors anyrayHQ/simulator: the directory a client keeps
// their own scenarios in is ignored wholesale (their code, tasks and logs never reach a
// commit of this repo), only shipped examples are tracked, and run outputs stay out.
// Checked through git itself against path names, so the patterns are free to change as
// long as the behavior holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { KIT_ROOT } from './kitFixtures.mjs';

/** true: ignored, false: tracked. `--no-index` checks the rules alone, whatever is staged. */
function ignored(path) {
  const child = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.ok(child.status === 0 || child.status === 1, `git check-ignore failed on ${path}: ${child.stderr}`);
  return child.status === 0;
}

test('client scenarios kept in the kit checkout are ignored wholesale; shipped examples and our own suite stay tracked; run outputs stay out', () => {
  for (const path of [
    'client-scenarios/acme-fix/scenario.yaml',
    'client-scenarios/acme-fix/bug.patch',
    'client-scenarios/acme-fix/ci-log.txt',
    'client-scenarios/plan.lock.json',
    'client-scenarios/notes.md',
  ]) assert.equal(ignored(path), true, `${path} would be committed`);
  for (const path of [
    'client-scenarios/example-hello/scenario.yaml',
    'scenarios/cobra-dispatch/scenario.yaml',
    'tests/kitGitignore.test.mjs',
  ]) assert.equal(ignored(path), false, `${path} is ignored but must stay tracked`);
  // Run records hold the task text, so they stay out wherever a run writes them.
  for (const path of ['results/agent/acme-fix--anyray.json', 'client-scenarios/acme-fix/results/round-1.json', '.env']) {
    assert.equal(ignored(path), true, `${path} would be committed`);
  }
});

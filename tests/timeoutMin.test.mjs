import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveScenario, parseArgs, requestRecord } from '../run_agent.mjs';

const KINDS = ['--kinds', 'cache_optimizer,relevance_filter,code_graph,observation_mask,content_census,cache_lint'];
const base = ['--scenario', 's', '--compare', 'gateway', ...KINDS];

test('--timeout-min overrides the scenario session cap; without it the scenario stands', () => {
  const scn = { timeoutMin: 10, maxTurns: 30 };
  const args = parseArgs([...base, '--timeout-min', '20']);
  assert.equal(args.timeoutMin, 20);
  assert.deepEqual(effectiveScenario(scn, args), { timeoutMin: 20, maxTurns: 30 });
  assert.equal(scn.timeoutMin, 10, 'the scenario itself is untouched');
  const none = parseArgs(base);
  assert.equal(effectiveScenario(scn, none), scn);
});

test('--timeout-min composes with --max-turns', () => {
  const args = parseArgs([...base, '--timeout-min', '20', '--max-turns', '80']);
  assert.deepEqual(effectiveScenario({ timeoutMin: 10, maxTurns: 30 }, args), { timeoutMin: 20, maxTurns: 80 });
});

test('--timeout-min is recorded, and absent when unset', () => {
  assert.equal(requestRecord(parseArgs([...base, '--timeout-min', '20'])).timeoutMin, 20);
  assert.equal('timeoutMin' in requestRecord(parseArgs(base)), false);
});

test('--timeout-min refuses a non-positive or non-integer value', () => {
  for (const bad of ['0', '-5', 'abc', '2.5']) {
    assert.throws(() => parseArgs([...base, '--timeout-min', bad]), /--timeout-min needs a positive integer/);
  }
});

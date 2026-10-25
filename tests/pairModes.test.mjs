// Pairs that need no --kinds override (ANY-1643): P vs P is two pass-through gateway arms;
// --bare-a is P vs B, a pass-through arm A against arm B on the tenant's stored defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, slotOptions, armsFor, resultFileName, requestRecord } from '../run_agent.mjs';

const opts = (argv, extra = {}) => {
  const args = { ...parseArgs(argv), ...extra };
  const arms = armsFor(args.compare);
  return { args, a: slotOptions(args, arms, 'a'), b: slotOptions(args, arms, 'b') };
};
const pp = ['--scenario', 's', '--compare', 'gateway', '--bare'];
const pb = ['--scenario', 's', '--compare', 'gateway', '--bare-a'];

test('P vs P: both gateway arms are bare, with no kinds', () => {
  const { a, b } = opts(pp);
  for (const o of [a, b]) assert.deepEqual([o.arm, o.bare, o.kinds], ['anyray', true, null]);
});

test('P vs P on a frozen plan asks for no tenant defaults on either arm', () => {
  const { a, b } = opts(pp, { scenariosDir: '/plan' });
  assert.equal(a.tenantDefaults, undefined);
  assert.equal(b.tenantDefaults, undefined);
});

test('--bare-a: A is bare, B is the Anyray arm on the tenant defaults', () => {
  // A frozen plan parses without --kinds; parseArgs outside one needs them, so clear them after.
  const { args, a, b } = opts([...pb, '--kinds', 'observation_mask'], { scenariosDir: '/plan', kinds: null });
  assert.equal(args.bareA, true);
  assert.deepEqual([a.arm, a.bare, a.kinds, a.tenantDefaults], ['anyray', true, null, undefined]);
  assert.deepEqual([b.arm, b.bare, b.kinds, b.tenantDefaults], ['anyray', false, null, true]);
});

test('--bare-a with --kinds: B requests them, A stays pass-through', () => {
  const { a, b } = opts([...pb, '--kinds', 'observation_mask']);
  assert.deepEqual([a.bare, a.kinds], [true, null]);
  assert.deepEqual([b.bare, b.kinds], [false, ['observation_mask']]);
});

test('--bare-a files its rounds apart and records the mode', () => {
  const { args } = opts([...pb, '--kinds', 'observation_mask']);
  assert.match(resultFileName(args), /bare-a/);
  assert.equal(requestRecord(args).bareA, true);
  assert.equal(requestRecord(parseArgs(pp)).bareA, undefined);
});

test('--bare-a refuses what makes the pair mean something else', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'anyray', '--bare-a', '--kinds', 'observation_mask']), /--bare-a needs --compare gateway/);
  assert.throws(() => parseArgs([...pb, '--bare']), /--bare-a.*--bare/);
  assert.throws(() => parseArgs([...pb, '--kinds', 'observation_mask', '--kinds-b', 'thinking_trim']), /--bare-a.*--kinds-b/);
  assert.throws(() => parseArgs([...pb, '--kinds', 'observation_mask', '--read-trim']), /--bare-a.*--read-trim/);
});

test('--bare-a without kinds or a frozen plan has nothing for B to run', () => {
  assert.throws(() => parseArgs(pb), /needs --kinds/);
});

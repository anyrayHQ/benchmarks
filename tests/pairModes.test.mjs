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

// ---- found on the first real pair: the round printout and warning must describe the arms as they are ----
import { armLabel } from '../run_agent.mjs';

test('arm labels: --bare-a names A pass-through and B what it runs; P/P names both pass-through', () => {
  const a = parseArgs([...pb, '--kinds', 'observation_mask']);
  const arms = armsFor(a.compare);
  assert.equal(armLabel(a, arms, 'a'), 'anyray (pass-through)');
  assert.equal(armLabel(a, arms, 'b'), 'anyray + kinds=observation_mask');
  const defaults = { ...a, kinds: null }; // a frozen plan: B runs the tenant's stored defaults
  assert.equal(armLabel(defaults, arms, 'b'), 'anyray + tenant defaults');
  const bare = parseArgs(pp);
  assert.equal(armLabel(bare, armsFor(bare.compare), 'a'), 'anyray (pass-through)');
  assert.equal(armLabel(bare, armsFor(bare.compare), 'b'), 'anyray (pass-through)');
});

test('arm labels are unchanged for the other gateway pairs', () => {
  const a = parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask']);
  assert.equal(armLabel(a, armsFor('gateway'), 'a'), 'anyray (baseline)');
});

test('--bare-a is Claude Code only: Codex refuses it as it refuses --bare', () => {
  assert.throws(() => parseArgs([...pb, '--kinds', 'observation_mask', '--client', 'codex']), /--bare-a/);
});

test('a --bare-a pair is not warned about as "the same arm": its arms differ by design', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../run_agent.mjs', import.meta.url), 'utf8');
  const guard = src.slice(src.indexOf("args.compare === 'gateway' && !args.bareA"), src.indexOf("A and B are the same arm (a gateway noise floor)'", src.indexOf("args.compare === 'gateway' && !args.bareA")));
  assert.ok(guard.includes('!args.bareA'), 'the warning is skipped when arm A is pass-through');
});

// --kinds-b / --read-trim-b: under --compare gateway, arm B alone requests a different
// strategy set or turns on connect's nested-Read trim, so the pair isolates that one change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armLabel, armsFor, armSetups, controlArgs, parseArgs, requestRecord, slotOptions } from '../run_agent.mjs';

const SIX = 'cache_optimizer,relevance_filter,code_graph,observation_mask,content_census,cache_lint';
const gw = (...more) => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', SIX, ...more]);
const arms = armsFor('gateway');

test('--kinds-b: B requests its own kinds, A keeps --kinds', () => {
  const args = { ...gw('--kinds-b', `${SIX},context_dedupe`), extraHeaders: [] };
  assert.deepEqual(slotOptions(args, arms, 'a').kinds, SIX.split(','));
  assert.deepEqual(slotOptions(args, arms, 'b').kinds, [...SIX.split(','), 'context_dedupe']);
  assert.equal(slotOptions(args, arms, 'b').kindsSource, '--kinds-b');
  assert.equal(slotOptions(args, arms, 'a').kindsSource, '--kinds');
});

test('--kinds-b: refused outside --compare gateway, without --kinds, or when equal to --kinds', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', SIX, '--kinds-b', 'cache_lint']), /--kinds-b needs --compare gateway/);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds-b', 'cache_lint']), /--kinds-b needs --kinds/);
  assert.throws(() => gw('--kinds-b', SIX), /--kinds-b must differ from --kinds/);
});

test('--read-trim-b: only B gets the nested-Read trim', () => {
  const args = { ...gw('--read-trim-b', '--integration-level', 'gateway_hooks_mcp'), extraHeaders: [] };
  assert.equal(slotOptions(args, arms, 'a').readTrim, false);
  assert.equal(slotOptions(args, arms, 'b').readTrim, true);
});

test('--read-trim-b: refused outside --compare gateway, beside --read-trim, or below gateway_hooks_mcp', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', SIX, '--read-trim-b']), /--read-trim-b needs --compare gateway/);
  assert.throws(() => gw('--read-trim', '--read-trim-b'), /--read-trim already turns it on for both arms/);
  assert.throws(() => gw('--read-trim-b', '--integration-level', 'gateway_hooks'), /--read-trim-b needs --integration-level gateway_hooks_mcp/);
});

test('requestRecord, armLabel and armSetups name the B-only treatment', () => {
  const args = { ...gw('--kinds-b', `${SIX},context_dedupe`, '--read-trim-b'), extraHeaders: [] };
  const rec = requestRecord(args);
  assert.deepEqual(rec.kindsB, [...SIX.split(','), 'context_dedupe']);
  assert.equal(rec.readTrimB, true);
  assert.equal(armLabel(args, arms, 'a'), 'anyray (baseline)');
  assert.equal(armLabel(args, arms, 'b'), 'anyray + kinds+context_dedupe + read-trim');
  const setups = armSetups(args, arms, { model: 'm', gatewayUrl: 'https://gateway.test.invalid' }, { maxTurns: 40 });
  assert.deepEqual(setups.a.optimizationKinds.requested, SIX.split(','));
  assert.deepEqual(setups.b.optimizationKinds.requested, [...SIX.split(','), 'context_dedupe']);
  assert.match(setups.a.readTrim, /^off/);
  assert.doesNotMatch(setups.b.readTrim, /^off/);
});

test('neither flag set: the record and labels are unchanged, and controlArgs drops both', () => {
  const args = { ...gw(), extraHeaders: [] };
  const rec = requestRecord(args);
  assert.equal('kindsB' in rec, false);
  assert.equal('readTrimB' in rec, false);
  assert.equal(armLabel(args, arms, 'b'), 'anyray (baseline)');
  const c = controlArgs({ ...gw('--kinds-b', `${SIX},context_dedupe`, '--read-trim-b'), extraHeaders: [] });
  assert.equal(c.kindsB, null);
  assert.equal(c.readTrimB, false);
});

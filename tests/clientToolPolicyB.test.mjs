// --client-tool-policy-b: under --compare gateway, arm B alone gets these connect
// client-tool switches, so the pair isolates one switch (for example batch read off on A,
// on by default on B, read with --treatment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armLabel, armsFor, controlArgs, parseArgs, requestRecord, slotOptions, summarize } from '../run_agent.mjs';

const gw = (...more) => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'cache_optimizer', ...more]);
const arms = armsFor('gateway');

test('--client-tool-policy-b: only B gets the switch, on top of the shared ones', () => {
  const args = gw('--client-tool-policy', 'readBatchRanges=true', '--client-tool-policy-b', 'readBatch=false');
  assert.deepEqual(slotOptions(args, arms, 'a').clientToolPolicies, { readBatchRanges: true });
  assert.deepEqual(slotOptions(args, arms, 'b').clientToolPolicies, { readBatchRanges: true, readBatch: false });
});

test('--client-tool-policy-b alone: A carries no policy, B carries its own', () => {
  const args = gw('--client-tool-policy-b', 'readBatch=false', '--client-tool-policy-b', 'readBatchNudge=false');
  assert.equal('clientToolPolicies' in slotOptions(args, arms, 'a'), false);
  assert.deepEqual(slotOptions(args, arms, 'b').clientToolPolicies, { readBatch: false, readBatchNudge: false });
});

test('--client-tool-policy-b: refused outside --compare gateway, beside the same shared switch, or with --bare', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'cache_optimizer', '--client-tool-policy-b', 'readBatch=false']), /--client-tool-policy-b needs --compare gateway/);
  assert.throws(() => gw('--client-tool-policy', 'readBatch=true', '--client-tool-policy-b', 'readBatch=false'), /--client-tool-policy already sets readBatch/);
  assert.throws(() => gw('--client-tool-policy-b', 'readBatch'), /name=true\|false/);
  assert.throws(() => gw('--bare', '--client-tool-policy-b', 'readBatch=false'), /--bare runs without anyray-connect/);
});

test('requestRecord and armLabel name the B-only switch; controlArgs drops it', () => {
  const args = { ...gw('--client-tool-policy-b', 'readBatch=false'), extraHeaders: [] };
  assert.deepEqual(requestRecord(args).clientToolPoliciesB, { readBatch: false });
  assert.equal(armLabel(args, arms, 'a'), 'anyray (baseline)');
  assert.equal(armLabel(args, arms, 'b'), 'anyray + policy:readBatch=false');
  const c = controlArgs(args);
  assert.equal(c.clientToolPoliciesB, null);
  assert.equal('clientToolPoliciesB' in requestRecord({ ...c, extraHeaders: [] }), false);
});

test('without the flag the record and labels are unchanged', () => {
  const args = { ...gw(), extraHeaders: [] };
  assert.equal('clientToolPoliciesB' in requestRecord(args), false);
  assert.equal(armLabel(args, arms, 'b'), 'anyray (baseline)');
  assert.equal('clientToolPolicies' in slotOptions(args, arms, 'b'), false);
});

test('summarize counts batch reads per session, main and subagents, and the ones that failed', () => {
  const call = (agent, isError) => ({ agent, model: 'm', usage: {}, blocks: [{ type: 'tool_use', id: `t${agent}${isError}`, name: 'mcp__anyray__anyray_read_batch', input: {}, result: { isError, preview: '' } }] });
  const read = { agent: 'main', model: 'm', usage: {}, blocks: [{ type: 'tool_use', id: 'r', name: 'Read', input: {}, result: { isError: false, preview: '' } }] };
  const t = summarize({ requests: [call('main', false), call('sub1', false), call('main', true), read], subagents: [], result: { costUsd: 1, modelUsage: {} } }, {});
  assert.equal(t.readBatchCalls, 3);
  assert.equal(t.readBatchOk, 2);
  const none = summarize({ requests: [read], subagents: [], result: { costUsd: 1, modelUsage: {} } }, {});
  assert.equal(none.readBatchCalls, 0, 'a session with no batch read reads 0, not undefined');
});

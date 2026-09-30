import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArmEnv, withArmEnv } from '../lib/armEnv.mjs';

test('parseArmEnv: no flag leaves both arms with no extra env', () => {
  assert.deepEqual(parseArmEnv([]), { a: {}, b: {} });
});

test('parseArmEnv: an arm prefix targets that arm only; no prefix targets both', () => {
  assert.deepEqual(parseArmEnv(['b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000']), {
    a: {},
    b: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' },
  });
  assert.deepEqual(parseArmEnv(['X=1,Y=two=2', 'a:Z=']), { a: { X: '1', Y: 'two=2', Z: '' }, b: { X: '1', Y: 'two=2' } });
});

test('parseArmEnv refuses a malformed pair or an unknown arm', () => {
  assert.throws(() => parseArmEnv(['NOEQUALS']), /KEY=VALUE/);
  assert.throws(() => parseArmEnv(['c:X=1']), /KEY=VALUE/);
  assert.throws(() => parseArmEnv(['=1']), /KEY=VALUE/);
});

test('withArmEnv lays the arm env over the session settings, the way connect writes settings.json', () => {
  const gateway = { env: { ANTHROPIC_BASE_URL: 'http://gw' }, hooks: { Stop: [] } };
  assert.deepEqual(withArmEnv(gateway, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' }), {
    env: { ANTHROPIC_BASE_URL: 'http://gw', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' },
    hooks: { Stop: [] },
  });
  assert.deepEqual(withArmEnv({ env: {} }, { X: '1' }), { env: { X: '1' } });
});

test('withArmEnv with no arm env returns the settings unchanged', () => {
  assert.deepEqual(withArmEnv({ env: {} }, {}), { env: {} });
  assert.deepEqual(withArmEnv({ env: {} }, undefined), { env: {} });
});

test('describeSetup records the arm env, and leaves setup as it was without one', async () => {
  const { describeSetup } = await import('../lib/agentRun.mjs');
  const base = { arm: 'direct', model: 'm', gatewayUrl: null, runTag: 't', maxTurns: 5 };
  assert.deepEqual(describeSetup({ ...base, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' } }).env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' });
  assert.equal('env' in describeSetup(base), false);
  assert.equal('env' in describeSetup({ ...base, env: {} }), false);
});

test('parseSession records each compaction with its trigger and pre-compaction size', async () => {
  const { parseSession } = await import('../lib/agentRun.mjs');
  const lines = [
    { type: 'system', subtype: 'init', model: 'm' },
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 190000 } },
    { type: 'result', subtype: 'success', result: 'ok', num_turns: 1 },
  ].map((j) => JSON.stringify(j));
  assert.deepEqual(parseSession(lines).compactions, [{ trigger: 'auto', preTokens: 190000 }]);
  assert.deepEqual(parseSession(lines.filter((l) => !l.includes('compact'))).compactions, []);
});

test('withArmEnv: a value of "-" removes the key, so an arm can run without a setting connect writes', () => {
  const connect = { env: { ANTHROPIC_BASE_URL: 'http://gw', ENABLE_TOOL_SEARCH: 'auto:20' } };
  assert.deepEqual(withArmEnv(connect, { ENABLE_TOOL_SEARCH: '-' }), { env: { ANTHROPIC_BASE_URL: 'http://gw' } });
});

// --upstream api-key: the arms run on an Anthropic API key (base URL only), not the seat's OAuth token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, slotOptions, armsFor, resultFileName, requestRecord } from '../run_agent.mjs';
import { armConfig, runCheck, upstreamProcEnv } from '../lib/agentRun.mjs';
import { captureApiKey } from '../lib/upstreamKey.mjs';

const KEY = 'sk-ant-synthetic-key-123456';
const base = ['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask'];

test('--upstream defaults to the seat and accepts api-key', () => {
  assert.equal(parseArgs(base).upstream, 'seat');
  assert.equal(parseArgs([...base, '--upstream', 'api-key']).upstream, 'api-key');
  assert.throws(() => parseArgs([...base, '--upstream', 'oauth']), /--upstream seat\|api-key/);
});

test('--upstream api-key refuses Bedrock and files its rounds apart', () => {
  assert.throws(() => parseArgs([...base, '--upstream', 'api-key', '--provider', 'bedrock']), /--upstream api-key.*Bedrock/);
  const a = parseArgs([...base, '--upstream', 'api-key']);
  assert.match(resultFileName(a), /api-key/);
  assert.doesNotMatch(resultFileName(parseArgs(base)), /api-key/);
});

test('both slots carry the upstream, and the run records it without the key', () => {
  const a = parseArgs([...base, '--upstream', 'api-key']);
  const arms = armsFor(a);
  for (const slot of ['a', 'b']) assert.equal(slotOptions(a, slot, arms).upstream, 'api-key');
  assert.equal(requestRecord(a).upstream, 'api-key');
  assert.equal(requestRecord(parseArgs(base)).upstream, undefined);
});

test('captureApiKey takes the key out of the inherited environment', () => {
  const env = { ANTHROPIC_API_KEY: KEY, PATH: '/bin' };
  assert.equal(captureApiKey(env), KEY);
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal(env.PATH, '/bin');
});

test('captureApiKey refuses an absent or blank key', () => {
  assert.throws(() => captureApiKey({}), /ANTHROPIC_API_KEY/);
  assert.throws(() => captureApiKey({ ANTHROPIC_API_KEY: '  ' }), /ANTHROPIC_API_KEY/);
});

test('the api-key lane hands the arm the key and no seat token', () => {
  const env = upstreamProcEnv({ provider: 'anthropic', upstream: 'api-key', apiKey: KEY, oauth: () => assert.fail('the seat token must not be read') });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: KEY });
});

test('the seat lane is unchanged and Bedrock carries neither', () => {
  assert.deepEqual(upstreamProcEnv({ provider: 'anthropic', upstream: 'seat', oauth: () => 'tok' }), { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  assert.deepEqual(upstreamProcEnv({ provider: 'bedrock', upstream: 'seat', oauth: () => assert.fail('no seat token on Bedrock') }), {});
});

test('the key never reaches the arm settings, mcp file or arm-env record', () => {
  for (const arm of ['direct', 'anyray']) {
    const cfg = armConfig({
      arm, gatewayUrl: 'https://gw.example', runTag: { sessionId: 's' }, cfgDir: mkdtempSync(join(tmpdir(), 'key-')), bare: true,
      deps: { connect: () => ({ gateway: 'https://gw.example', clientKey: 'ark_synthetic-profile' }), clientKey: () => 'ark_synthetic-bench', serviceKey: () => 'ark_synthetic-bench' },
    });
    assert.equal(JSON.stringify({ settings: cfg.settings, mcp: cfg.mcp, procEnv: cfg.procEnv }).includes(KEY), false);
  }
});

test('--arm-env cannot smuggle the key in either', () => {
  assert.throws(() => parseArgs([...base, '--arm-env', `ANTHROPIC_API_KEY=${KEY}`]), /ANTHROPIC_API_KEY/);
});

test('a grader does not inherit the key once it is captured', () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: KEY };
  captureApiKey(env);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = KEY;
  try {
    captureApiKey(process.env);
    assert.equal(runCheck('echo "key=${ANTHROPIC_API_KEY:-absent}"', tmpdir()).output.trim(), 'key=absent');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

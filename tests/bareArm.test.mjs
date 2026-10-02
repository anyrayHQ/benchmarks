// --bare: the Anyray arm as a seat that changed only its base URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, slotOptions, armsFor, resultFileName, controlArgs } from '../run_agent.mjs';
import { armConfig, describeSetup } from '../lib/agentRun.mjs';
import { tallyNotice, tallyReason } from '../lib/resultProxy.mjs';
import { whyNot } from '../run_agent.mjs';

const deps = {
  connect: () => ({ gateway: 'https://gw.example', clientKey: 'ark_synthetic-profile' }),
  clientKey: () => 'ark_synthetic-bench',
  serviceKey: () => 'ark_synthetic-bench',
  anyrayHooks: () => ({ PostToolUse: [{ hooks: [{ command: 'anyray-connect __anyray-hook' }] }] }),
  binExists: () => true,
  bin: '/x/anyray-connect',
  configureArm: () => {
    throw new Error('--bare must not run anyray-connect');
  },
};
const bareConfig = (over = {}) =>
  armConfig({ arm: 'anyray', gatewayUrl: 'https://gw.example', runTag: { sessionId: 's' }, cfgDir: mkdtempSync(join(tmpdir(), 'bare-')), bare: true, deps, ...over });

test('--bare needs no kinds and files its rounds apart', () => {
  const a = parseArgs(['--scenario', 's', '--compare', 'gateway', '--bare']);
  assert.equal(a.bare, true);
  assert.equal(a.kinds, null);
  assert.equal(resultFileName(a), 's--gateway--bare.json');
  assert.equal(resultFileName(parseArgs(['--scenario', 's', '--bare', '--label', 'notice'])), 's--anyray--bare-notice.json');
});

test('--bare refuses what it cannot run with', () => {
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--bare']), /--bare needs --compare anyray or gateway/);
  for (const extra of [['--kinds', 'observation_mask'], ['--strategy', 'thinking_trim'], ['--read-trim', '--kinds', 'observation_mask'], ['--provider', 'bedrock', '--kinds', 'observation_mask']]) {
    assert.throws(() => parseArgs(['--scenario', 's', '--bare', ...extra]), /--bare runs with optimization off/);
  }
});

test('only the Anyray slots are bare, and the control never is', () => {
  const a = parseArgs(['--scenario', 's', '--compare', 'anyray', '--bare']);
  assert.equal(slotOptions(a, armsFor('anyray'), 'a').bare, false);
  assert.equal(slotOptions(a, armsFor('anyray'), 'b').bare, true);
  assert.equal(controlArgs(a).bare, false);
});

test('a bare arm is the base URL and headers only', () => {
  const c = bareConfig({ extraHeaders: ['x-anyray-cc-budget-notice: on'] });
  assert.deepEqual(Object.keys(c.settings.env).sort(), ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']);
  assert.equal(c.settings.env.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.deepEqual(c.settings.env.ANTHROPIC_CUSTOM_HEADERS.split('\n'), [
    'x-anyray-provider: anthropic',
    'x-anyray-auth-mode: passthrough',
    'x-anyray-api-key: ark_synthetic-bench',
    'x-anyray-optimize: off',
    'x-anyray-tool-defer: off',
    'x-anyray-metadata: {"sessionId":"s"}',
    'x-anyray-cc-budget-notice: on',
  ]);
  assert.equal(c.settings.hooks, undefined);
  assert.deepEqual(c.mcp, { mcpServers: {} });
  assert.equal(c.home, null);
  assert.equal(c.settingSources, '');
  assert.equal(c.setup.configuredBy, 'harness (bare base URL)');
});

test('the recorded setup of a bare arm names no hooks, MCP server or key', () => {
  const s = describeSetup({ arm: 'anyray', model: 'm', gatewayUrl: 'https://gw.example', runTag: '<per round>', maxTurns: 20, bare: true, tenant: { keyVar: 'ANYRAY_CLIENT_KEY' }, extraHeaders: ['x-anyray-cc-budget-notice: on'] });
  assert.deepEqual(s.hooks, {});
  assert.deepEqual(s.mcpServers, {});
  assert.equal(s.headers['x-anyray-optimize'], 'off');
  assert.equal(s.headers['x-anyray-api-key'], '<client key>');
  assert.equal(s.headers['x-anyray-cc-budget-notice'], '<ANYRAY_BENCH_EXTRA_HEADERS>');
  assert.match(s.clientSide, /bare base URL/);
});

test('the budget-notice outcome is counted per response', () => {
  const t = { applied: 0, notApplied: 0, absent: 0 };
  tallyNotice(t, '{"applied":true}');
  tallyNotice(t, '{"applied":true}');
  tallyNotice(t, '{"applied":false}');
  tallyNotice(t, undefined);
  tallyNotice(t, 'not json');
  assert.deepEqual(t, { applied: 2, notApplied: 1, absent: 2 });
});

test('a rewrite that stood aside is counted by its named reason', () => {
  const r = {};
  tallyReason(r, '{"applied":false,"reason":"already_present"}');
  tallyReason(r, '{"applied":false,"reason":"already_present"}');
  tallyReason(r, '{"applied":false,"reason":"client_tool_search"}');
  tallyReason(r, '{"applied":false}');
  tallyReason(r, '{"applied":true,"deferred":3}');
  tallyReason(r, undefined);
  tallyReason(r, 'not json');
  assert.deepEqual(r, { already_present: 2, client_tool_search: 1, unnamed: 1 });
  assert.equal(whyNot(r), ' (already_present 2, client_tool_search 1, unnamed 1)');
  assert.equal(whyNot({}), '');
  assert.equal(whyNot(undefined), '');
});

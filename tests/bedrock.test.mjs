import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockOptions, bedrockDirectEnv, probeGatewayRoute, assertBedrockRoute, canonicalModel } from '../lib/bedrock.mjs';
import { checkConnectConfig, checkConnectSession, failedChecks, assertChecks, customHeaders } from '../lib/connectChecks.mjs';
import { priceFor } from '../lib/cost.mjs';
import { armConfig, describeSetup, restoredKeys } from '../lib/agentRun.mjs';
import { parseArgs, resolveBedrock, resultFileName, slotOptions } from '../run_agent.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GW = 'https://gateway.test.invalid';
const KEY = 'ark_svc_test_fake';
const hook = [{ matcher: '*', hooks: [{ type: 'command', command: '/x/.anyray/bin/anyray-connect __anyray-hook' }] }];
const mcpServers = {
  anyray: { type: 'stdio', command: '/x/.anyray/bin/anyray-connect', args: ['__anyray-mcp-server', 'claude'] },
  'anyray-connectors': { type: 'http', url: `${GW}/mcp/org`, headers: { 'x-anyray-api-key': KEY } },
};
/** What `anyray-connect --org` writes for Claude Code. */
const orgSettings = () => ({
  env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_CUSTOM_HEADERS: 'x-anyray-metadata: {"tool":"claude-code"}', ENABLE_TOOL_SEARCH: 'auto:20', _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1' },
  apiKeyHelper: '/x/.anyray/bin/anyray-connect print-key',
  hooks: { PostToolUse: hook, PostToolUseFailure: hook },
  permissions: { allow: ['mcp__anyray__anyray_retrieve'] },
});
const orgConfig = (over = {}) => ({ settings: orgSettings(), mcpServers, skills: ['anyray'], gatewayUrl: GW, lane: 'org', helperPrintsKey: true, ...over });

test('--provider: bedrock is parsed, labels its own result file, and reaches both slots', () => {
  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--provider', 'bedrock']);
  assert.equal(args.provider, 'bedrock');
  assert.equal(resultFileName(args), 's--anyray--bedrock.json');
  args.bedrock = { profile: 'p', region: 'us-east-1', model: 'us.anthropic.claude-sonnet-5' };
  for (const slot of ['a', 'b']) assert.equal(slotOptions(args, { a: 'direct', b: 'anyray' }, slot).bedrock.model, 'us.anthropic.claude-sonnet-5');
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']).provider, 'anthropic');
  assert.throws(() => parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--provider', 'vertex']), /--provider anthropic\|bedrock/);
});

test('bedrockOptions: profile, region and model come from the environment, with defaults', () => {
  assert.deepEqual(bedrockOptions({}), { profile: 'default', region: 'us-east-1', model: null });
  assert.deepEqual(bedrockOptions({ ANYRAY_BEDROCK_PROFILE: 'bench', ANYRAY_BEDROCK_REGION: 'eu-central-1', ANYRAY_BEDROCK_MODEL: 'eu.anthropic.claude-sonnet-5' }), { profile: 'bench', region: 'eu-central-1', model: 'eu.anthropic.claude-sonnet-5' });
  assert.deepEqual(bedrockDirectEnv({ profile: 'bench', region: 'us-east-1' }), { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bench', AWS_REGION: 'us-east-1' });
});

test('probeGatewayRoute: sends the org lane (bearer key, no provider header) and reads the route back', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ model: 'us.anthropic.claude-sonnet-5' }), { status: 200, headers: { 'x-anyray-provider': 'bedrock' } });
  };
  const route = await probeGatewayRoute({ gatewayUrl: GW, clientKey: KEY, model: 'claude-sonnet-5', fetchImpl });
  assert.deepEqual(route, { provider: 'bedrock', model: 'us.anthropic.claude-sonnet-5' });
  assert.equal(seen.url, `${GW}/v1/messages`);
  assert.equal(seen.init.headers.authorization, `Bearer ${KEY}`);
  assert.equal('x-anyray-provider' in seen.init.headers, false);
  assert.equal(JSON.parse(seen.init.body).max_tokens, 1);
  assert.equal(assertBedrockRoute(route), 'us.anthropic.claude-sonnet-5');
});

test('probeGatewayRoute: a refusal is reported without the key; a non-Bedrock route is refused', async () => {
  const refuse = async () => new Response(`no provider key for ${KEY}`, { status: 424 });
  await assert.rejects(probeGatewayRoute({ gatewayUrl: GW, clientKey: KEY, model: 'm', fetchImpl: refuse }), (e) => /HTTP 424/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(probeGatewayRoute({ gatewayUrl: GW, clientKey: null, model: 'm' }), /ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY/);
  assert.throws(() => assertBedrockRoute({ provider: 'anthropic', model: 'claude-sonnet-5' }), /routed the org lane to "anthropic"/);
  assert.throws(() => assertBedrockRoute({ provider: 'bedrock', model: 'claude-sonnet-5' }), /not a Bedrock Anthropic id; set ANYRAY_BEDROCK_MODEL/);
  // The native InvokeModel lane echoes the client's model id: a pinned id stands in.
  assert.equal(assertBedrockRoute({ provider: 'bedrock', model: 'claude-sonnet-5' }, { pinned: 'us.anthropic.claude-sonnet-5' }), null);
});

test('resolveBedrock: the direct arm takes the id the gateway serves, unless one is pinned', async () => {
  const probe = async () => ({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-5' });
  const env = { ANYRAY_CLIENT_KEY: KEY };
  const b = await resolveBedrock({ gatewayUrl: GW, model: 'claude-sonnet-5' }, { env, probe });
  assert.deepEqual(b, { profile: 'default', region: 'us-east-1', model: 'us.anthropic.claude-sonnet-5', modelSource: 'gateway route probe', gatewayServedAs: 'us.anthropic.claude-sonnet-5' });
  const pinned = await resolveBedrock({ gatewayUrl: GW, model: 'claude-sonnet-5' }, { env: { ...env, ANYRAY_BEDROCK_MODEL: 'global.anthropic.claude-sonnet-5' }, probe });
  assert.equal(pinned.model, 'global.anthropic.claude-sonnet-5');
  assert.equal(pinned.gatewayServedAs, 'us.anthropic.claude-sonnet-5');
  await assert.rejects(resolveBedrock({ gatewayUrl: null, model: 'm' }, { env: {}, probe }), /needs ANYRAY_BEDROCK_MODEL/);
});

test('Bedrock model ids price as their canonical model', () => {
  const pricing = { models: { 'claude-sonnet-5': { input: 3, output: 15 }, 'claude-haiku-4-5': { input: 1, output: 5 } } };
  assert.equal(canonicalModel('us.anthropic.claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(canonicalModel('anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5-20251001');
  assert.deepEqual(priceFor(pricing, 'us.anthropic.claude-sonnet-5'), { input: 3, output: 15 });
  assert.deepEqual(priceFor(pricing, 'global.anthropic.claude-haiku-4-5-20251001-v1:0'), { input: 1, output: 5 });
  assert.deepEqual(priceFor(pricing, 'claude-sonnet-5'), { input: 3, output: 15 });
});

test('checkConnectConfig: what connect --org writes passes every check', () => {
  const checks = checkConnectConfig(orgConfig());
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.ok(checks.length >= 12);
  assert.ok(!JSON.stringify(checks).includes(KEY), 'no check detail carries the key');
});

test('checkConnectConfig: each part of a broken org setup is named', () => {
  const broken = (edit) => {
    const cfg = orgConfig();
    edit(cfg);
    return failedChecks(checkConnectConfig(cfg)).map((c) => c.name);
  };
  assert.deepEqual(broken((c) => (c.settings.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com')), ['env.ANTHROPIC_BASE_URL is the gateway']);
  assert.deepEqual(broken((c) => (c.settings.env.CLAUDE_CODE_USE_BEDROCK = '1')), ['env: no direct-cloud switch']);
  const AUTH = 'auth: the gateway key reaches Claude Code (apiKeyHelper or ANTHROPIC_AUTH_TOKEN)';
  assert.deepEqual(broken((c) => delete c.settings.apiKeyHelper), [AUTH]);
  assert.deepEqual(broken((c) => (c.helperPrintsKey = false)), [AUTH]);
  // A key written straight into the env is the other valid shape.
  assert.deepEqual(broken((c) => { delete c.settings.apiKeyHelper; c.settings.env.ANTHROPIC_AUTH_TOKEN = KEY; }), []);
  assert.deepEqual(broken((c) => (c.settings.env.ANTHROPIC_CUSTOM_HEADERS += '\nx-anyray-provider: anthropic')), ['header: no x-anyray-provider pin']);
  assert.deepEqual(broken((c) => delete c.settings.hooks.PostToolUseFailure), ['hook PostToolUseFailure: anyray-connect __anyray-hook']);
  assert.deepEqual(broken((c) => (c.mcpServers = {})), ['mcp anyray: stdio anyray-connect __anyray-mcp-server']);
  assert.deepEqual(broken((c) => (c.settings.permissions = {})), ['permission mcp__anyray__anyray_retrieve allowed']);
  assert.deepEqual(broken((c) => (c.skills = [])), ['skill anyray installed']);
  // Advisory checks are reported but never stop the arm.
  assert.deepEqual(broken((c) => delete c.settings.env.ENABLE_TOOL_SEARCH), []);
  assert.throws(() => assertChecks(checkConnectConfig(orgConfig({ skills: [] })), 'misconfigured'), /misconfigured: skill anyray installed \(none\)/);
});

test('checkConnectConfig: the subscription lane expects the passthrough headers instead', () => {
  const settings = orgSettings();
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  settings.env.ANTHROPIC_CUSTOM_HEADERS = `x-anyray-provider: anthropic\nx-anyray-auth-mode: passthrough\nx-anyray-api-key: ${KEY}\nx-anyray-metadata: {"tool":"claude-code"}`;
  assert.deepEqual(failedChecks(checkConnectConfig({ settings, mcpServers, skills: ['anyray'], gatewayUrl: GW, lane: 'subscription' })), []);
  // An org-lane config is not a subscription client.
  assert.deepEqual(failedChecks(checkConnectConfig(orgConfig({ lane: 'subscription' }))).map((c) => c.name), [
    'header x-anyray-auth-mode: passthrough', 'header x-anyray-provider: anthropic', 'header x-anyray-api-key present',
  ]);
  assert.deepEqual(customHeaders({ ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1\nx-b: {"c":"d:e"}' }), { 'x-a': '1', 'x-b': '{"c":"d:e"}' });
});

test('checkConnectSession: the session must have the anyray MCP server connected and its tool', () => {
  const init = { mcpServers: [{ name: 'anyray', status: 'connected' }], tools: ['Read', 'mcp__anyray__anyray_retrieve'], skills: ['anyray'] };
  assert.deepEqual(checkConnectSession({ init, activity: { anyrayFiles: ['connect.json'] } }).filter((c) => !c.ok), []);
  const failed = failedChecks(checkConnectSession({ init: { mcpServers: [{ name: 'anyray', status: 'failed' }], tools: ['Read'] }, activity: null }));
  assert.deepEqual(failed.map((c) => c.name), ['session: mcp anyray connected', 'session: tool mcp__anyray__anyray_retrieve available']);
});

test('armConfig on bedrock: direct gets the AWS env; the anyray arm asks connect for the org lane and is checked', () => {
  const bedrock = { profile: 'bench', region: 'us-east-1', model: 'us.anthropic.claude-sonnet-5' };
  const cfgDir = () => mkdtempSync(join(tmpdir(), 'bedrock-cfg-'));
  const direct = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock });
  assert.deepEqual(direct.procEnv, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bench', AWS_REGION: 'us-east-1' });
  assert.deepEqual(armConfig({ arm: 'direct', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir() }).procEnv, {});

  let asked;
  const deps = (c) => ({
    binExists: () => true, serviceKey: () => KEY, clientKey: () => KEY, realClaudeJson: () => ({}),
    configureArm: (o) => ((asked = o), c),
  });
  const ok = { configured: true, settings: orgSettings(), mcpServers, checks: checkConnectConfig(orgConfig()), setup: { lane: 'org', env: {} } };
  const arm = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's1' }, cfgDir: cfgDir(), provider: 'bedrock', bedrock, kinds: ['observation_mask'], deps: deps(ok) });
  assert.equal(asked.lane, 'org');
  assert.equal(arm.setup.lane, 'org');
  assert.equal(arm.setup.connectChecks.every((c) => c.ok), true);
  const headers = customHeaders(arm.settings.env);
  assert.equal(headers['x-anyray-provider'], undefined, 'nothing pins a provider on the org lane');
  assert.equal(JSON.parse(headers['x-anyray-metadata']).sessionId, 's1');
  assert.equal(headers['x-anyray-optimization-kinds'], 'observation_mask');

  const bad = { ...ok, checks: checkConnectConfig(orgConfig({ skills: [] })) };
  assert.throws(() => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock, deps: deps(bad) }), /left the arm misconfigured: skill anyray installed/);
  assert.throws(() => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock, deps: deps({ configured: false, reason: 'no key' }) }), /needs anyray-connect to configure the Anyray arm: no key/);
});

test('describeSetup on bedrock names the AWS route for direct and the org lane for anyray', () => {
  const bedrock = { profile: 'bench', region: 'us-east-1', model: 'us.anthropic.claude-sonnet-5' };
  const a = describeSetup({ arm: 'direct', model: 'claude-sonnet-5', gatewayUrl: GW, runTag: {}, maxTurns: 3, provider: 'bedrock', bedrock });
  assert.equal(a.model, 'us.anthropic.claude-sonnet-5');
  assert.match(a.endpoint, /^bedrock-runtime\.us-east-1/);
  assert.match(a.auth, /AWS profile "bench"/);
  const b = describeSetup({ arm: 'anyray', model: 'claude-sonnet-5', gatewayUrl: GW, runTag: {}, maxTurns: 3, enrolled: false, provider: 'bedrock', bedrock, tenant: { keyVar: 'ANYRAY_CLIENT_KEY' } });
  assert.equal(b.model, 'claude-sonnet-5');
  assert.match(b.auth, /^org lane/);
  assert.equal(b.headers['x-anyray-provider'], undefined);
});

test('an --arm-env unset on the connect arm turns connect refresh off, and a key written back is caught', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'unset-cfg-'));
  const ok = { configured: true, settings: orgSettings(), mcpServers, checks: checkConnectConfig(orgConfig()), setup: { lane: 'org', env: {} } };
  const deps = { binExists: () => true, serviceKey: () => KEY, clientKey: () => KEY, realClaudeJson: () => ({}), configureArm: () => ok };
  const arm = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir, provider: 'bedrock', bedrock: {}, env: { ENABLE_TOOL_SEARCH: '-' }, deps });
  assert.deepEqual(arm.procEnv, { ANYRAY_REFRESH_DISABLE: 'true' });
  assert.deepEqual(arm.unsetKeys, ['ENABLE_TOOL_SEARCH']);
  assert.equal('ENABLE_TOOL_SEARCH' in arm.settings.env, false);
  assert.match(arm.setup.refresh, /^off for this session/);
  // Without an unset, refresh stays as connect runs it.
  const plain = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: mkdtempSync(join(tmpdir(), 'unset-cfg-')), provider: 'bedrock', bedrock: {}, deps });
  assert.deepEqual(plain.procEnv, {});
  assert.equal('refresh' in plain.setup, false);

  const home = mkdtempSync(join(tmpdir(), 'unset-home-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: GW } }));
  assert.deepEqual(restoredKeys(home, ['ENABLE_TOOL_SEARCH']), []);
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: GW, ENABLE_TOOL_SEARCH: 'auto:20' } }));
  assert.deepEqual(restoredKeys(home, ['ENABLE_TOOL_SEARCH']), ['ENABLE_TOOL_SEARCH']);
  assert.deepEqual(restoredKeys(home, []), []);
});

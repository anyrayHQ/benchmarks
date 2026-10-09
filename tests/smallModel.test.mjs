// Both arms run Claude Code's small/fast side calls (WebFetch's page summarizer, …) on the
// same model: on Bedrock the direct arm gets Haiku 5.5, as the gateway arm's Claude Code
// picks for itself, instead of falling back to the main model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bedrockSmallModel, bedrockDirectEnv, smallModelInEnv, modelMismatch, SMALL_MODEL_ENV } from '../lib/bedrock.mjs';
import { armConfig, describeSetup, smallFastModelSetup } from '../lib/agentRun.mjs';
import { armSetups, parseArgs, resolveBedrock } from '../run_agent.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = 'ark_svc_test_fake';
const HAIKU = 'us.anthropic.claude-haiku-5-5';
const bedrock = { profile: 'bench', region: 'us-east-1', model: 'us.anthropic.claude-sonnet-5', smallModel: HAIKU, smallModelSource: 'default' };
const cfgDir = () => mkdtempSync(join(tmpdir(), 'small-model-cfg-'));

test('the direct arm on Bedrock defaults to Haiku 5.5 in the main model\'s inference profile; ANYRAY_BEDROCK_SMALL_MODEL overrides', () => {
  assert.equal(SMALL_MODEL_ENV, 'ANTHROPIC_DEFAULT_HAIKU_MODEL');
  assert.equal(bedrockSmallModel('us.anthropic.claude-sonnet-5').smallModel, HAIKU);
  assert.equal(bedrockSmallModel('global.anthropic.claude-sonnet-5').smallModel, 'global.anthropic.claude-haiku-5-5');
  assert.equal(bedrockSmallModel('eu.anthropic.claude-sonnet-5').smallModel, 'eu.anthropic.claude-haiku-5-5');
  assert.equal(bedrockSmallModel('anthropic.claude-sonnet-5-v1:0').smallModel, HAIKU, 'no profile prefix: us');
  assert.equal(bedrockSmallModel(null).smallModel, HAIKU);
  assert.deepEqual(bedrockSmallModel('us.anthropic.claude-sonnet-5', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'), { smallModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', smallModelSource: 'ANYRAY_BEDROCK_SMALL_MODEL' });
});

test('resolveBedrock adds the small model on both paths: the gateway probe and a pinned id', async () => {
  const probe = async () => ({ provider: 'bedrock', model: 'global.anthropic.claude-sonnet-5' });
  const probed = await resolveBedrock({ gatewayUrl: GW, model: 'claude-sonnet-5' }, { env: { ANYRAY_CLIENT_KEY: KEY }, probe });
  assert.equal(probed.smallModel, 'global.anthropic.claude-haiku-5-5', 'same geo as the id the gateway serves');
  const pinned = await resolveBedrock({ gatewayUrl: GW, model: 'claude-sonnet-5' }, { env: { ANYRAY_CLIENT_KEY: KEY, ANYRAY_BEDROCK_SMALL_MODEL: 'us.anthropic.claude-haiku-x' }, probe });
  assert.deepEqual([pinned.smallModel, pinned.smallModelSource], ['us.anthropic.claude-haiku-x', 'ANYRAY_BEDROCK_SMALL_MODEL']);
  const offline = await resolveBedrock({ gatewayUrl: null, model: 'claude-sonnet-5' }, { env: { ANYRAY_BEDROCK_MODEL: 'us.anthropic.claude-sonnet-5' }, probe });
  assert.equal(offline.smallModel, HAIKU);
});

test('the direct Bedrock session env names the small model; no other arm gets one from the harness', () => {
  assert.deepEqual(bedrockDirectEnv(bedrock), { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bench', AWS_REGION: 'us-east-1', ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU });
  assert.equal(SMALL_MODEL_ENV in bedrockDirectEnv({ profile: 'p', region: 'r' }), false, 'no small model resolved: Claude Code keeps its own');

  const direct = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock });
  assert.equal(direct.procEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, HAIKU);
  const seat = armConfig({ arm: 'direct', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir() });
  assert.deepEqual(seat.procEnv, {}, 'on the Anthropic API Claude Code already picks Haiku');

  const ok = { configured: true, settings: { env: { ANTHROPIC_BASE_URL: GW } }, mcpServers: {}, setup: { lane: 'org', env: {} } };
  const deps = { binExists: () => true, bin: '/nonexistent/anyray-connect', serviceKey: () => KEY, clientKey: () => KEY, realClaudeJson: () => ({}), configureArm: () => ok };
  const gateway = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock, deps });
  assert.equal(SMALL_MODEL_ENV in gateway.procEnv, false);
  assert.equal(SMALL_MODEL_ENV in gateway.settings.env, false, 'the gateway arm asks for Claude Code\'s own Haiku');
  assert.equal('smallFastModel' in gateway.setup, false);
});

test('each arm\'s setup records its small/fast model and where it came from', () => {
  const a = describeSetup({ arm: 'direct', model: 'claude-sonnet-5', gatewayUrl: GW, runTag: {}, maxTurns: 3, provider: 'bedrock', bedrock });
  assert.deepEqual(a.smallFastModel, { model: HAIKU, env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', source: 'default' });
  const b = describeSetup({ arm: 'anyray', model: 'claude-sonnet-5', gatewayUrl: GW, runTag: {}, maxTurns: 3, enrolled: false, provider: 'bedrock', bedrock });
  assert.deepEqual(b.smallFastModel, { model: null, env: null, source: "unset: Claude Code's own pick (its current Haiku on the Anthropic API)" });
  // Without a resolved small model the direct Bedrock arm says what Claude Code then does.
  assert.match(smallFastModelSetup({ arm: 'direct', provider: 'bedrock', bedrock: { model: 'm' } }).source, /main model/);
  // --arm-env wins, and Claude Code reads ANTHROPIC_SMALL_FAST_MODEL first.
  assert.deepEqual(smallFastModelSetup({ arm: 'direct', provider: 'bedrock', bedrock, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x' } }), { model: 'x', env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', source: '--arm-env' });
  assert.deepEqual(smallModelInEnv({ ANTHROPIC_DEFAULT_HAIKU_MODEL: 'x', ANTHROPIC_SMALL_FAST_MODEL: 'y' }), { model: 'y', env: 'ANTHROPIC_SMALL_FAST_MODEL' });
  assert.equal(smallModelInEnv({ ANTHROPIC_DEFAULT_HAIKU_MODEL: ' ' }), null);

  const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--provider', 'bedrock']);
  args.bedrock = bedrock;
  const setup = armSetups(args, { a: 'direct', b: 'anyray' }, { model: 'claude-sonnet-5', gatewayUrl: GW }, { maxTurns: 3 });
  assert.equal(setup.a.smallFastModel.model, HAIKU);
  assert.equal(setup.b.smallFastModel.model, null);
});

test('a small/fast model connect writes is recorded on the gateway arm as connect\'s', () => {
  const ok = { configured: true, settings: { env: { ANTHROPIC_BASE_URL: GW, ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-5-5' } }, mcpServers: {}, setup: { lane: 'org', env: {} } };
  const deps = { binExists: () => true, bin: '/nonexistent/anyray-connect', serviceKey: () => KEY, clientKey: () => KEY, realClaudeJson: () => ({}), configureArm: () => ok };
  const arm = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock, deps });
  assert.deepEqual(arm.setup.smallFastModel, { model: 'claude-haiku-5-5', env: 'ANTHROPIC_SMALL_FAST_MODEL', source: 'anyray-connect' });
  const overridden = armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: {}, cfgDir: cfgDir(), provider: 'bedrock', bedrock, env: { ANTHROPIC_SMALL_FAST_MODEL: 'z' }, deps });
  assert.deepEqual(overridden.setup.smallFastModel, { model: 'z', env: 'ANTHROPIC_SMALL_FAST_MODEL', source: '--arm-env' });
});

test('modelMismatch names a family the arms ran on different models, and nothing else', () => {
  const sonnetA = 'us.anthropic.claude-sonnet-5';
  assert.deepEqual(modelMismatch([sonnetA, 'us.anthropic.claude-haiku-4-5-20251001-v1:0'], ['claude-sonnet-5', 'claude-haiku-5-5']), {
    haiku: { a: ['claude-haiku-4-5-20251001'], b: ['claude-haiku-5-5'] },
  });
  assert.deepEqual(modelMismatch([sonnetA, HAIKU], ['claude-sonnet-5', 'claude-haiku-5-5']), {}, 'a Bedrock id and its first-party name are one model');
  assert.deepEqual(modelMismatch([sonnetA], ['claude-sonnet-5', 'claude-haiku-5-5']), {}, 'a side call only one arm made is not a mismatch');
  assert.deepEqual(modelMismatch(undefined, undefined), {});
});

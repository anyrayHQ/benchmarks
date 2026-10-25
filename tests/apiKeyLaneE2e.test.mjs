// A P/P pair on the API-key lane, through the real run_agent.mjs CLI with a stand-in Claude and gateway
// (ANY-1643). Proves the plumbing: the key reaches each Claude process and nothing else. Costs nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnAsync } from './kitPlanFixtures.mjs';
import { BENCH_KEY, fakeClaude, fakeRunGateway, kitRunCopy, once, originRepo, poisonClaude, runEnv, runScenario, sharedTemp, writeDir } from './kitRunFixtures.mjs';

const KEY = 'sk-ant-synthetic-e2e-key-987654';
const SHA = createHash('sha256').update(KEY).digest('hex').slice(0, 12);
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

const ran = once(async () => {
  const root = sharedTemp('key-lane-');
  const origin = originRepo(root);
  const kit = kitRunCopy(join(root, 'kit'));
  // The check prints what a grader inherits: the key must read as absent.
  writeDir(kit.root, { 'key-twin': runScenario(origin, { over: { check: 'echo "key=${ANTHROPIC_API_KEY:-absent}"; cat check-out.log' } }) }, 'scenarios');
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'));
  // The seat token is in the environment too: the api-key lane must not hand it to an arm.
  const env = runEnv(join(root, 'home'), { gateway, poison, extra: { ANTHROPIC_API_KEY: KEY } });
  const child = await spawnAsync(process.execPath, [realpathSync(join(kit.root, 'run_agent.mjs')) /* the entry guard compares argv[1] with the resolved URL */, '--scenario', 'key-twin', '--compare', 'gateway', '--bare', '--upstream', 'api-key', '--rounds', '1', '--claude-bin', claude.bin], { env, cwd: kit.root, timeout: 170_000 });
  if (child.status !== 0) return { child, claude, poison, gateway, files: [], texts: [] };
  const dir = join(kit.root, 'results', 'agent');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return { child, claude, poison, gateway, files, texts: files.map((f) => readFileSync(join(dir, f), 'utf8')) };
});

test('the pair ran, on its own result file', async () => {
  const r = await ran();
  assert.equal(r.child.status, 0, `${r.child.stdout.slice(-600)}${r.child.stderr.slice(-600)}`);
  assert.deepEqual(r.files.length, 1);
  assert.match(r.files[0], /api-key/);
  assert.equal(JSON.parse(r.texts[0]).request.upstream, 'api-key');
});

test('every Claude process got the key and no seat token, and the key is not in its settings', async () => {
  const r = await ran();
  const sessions = r.claude.sessions();
  assert.equal(sessions.length, 2, 'both arms ran');
  for (const s of sessions) assert.deepEqual(s.procCreds, { apiKey: true, apiKeySha: SHA, oauth: false, keyInSettings: false });
  assert.equal(r.poison.calls(), 0, 'the `claude` on PATH never ran');
});

test('the key is in no result file, no output, and the gateway never saw it', async () => {
  const r = await ran();
  for (const text of [...r.texts, r.child.stdout, r.child.stderr]) assert.equal(text.includes(KEY), false);
  assert.equal(JSON.stringify(r.gateway.requests).includes(KEY), false);
});

test('the grader read the key as absent', async () => {
  const r = await ran();
  assert.ok(r.texts[0].includes('key=absent'));
});

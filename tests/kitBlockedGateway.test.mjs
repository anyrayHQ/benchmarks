// ANY-1496: a gateway listed in config.yaml run.blocked_gateways is refused by every kit command
// that would plan for it or send traffic toward it, up front and by name (plan_gateway_blocked,
// exit 3). Before, plan and freeze accepted it and the paid noise phase died as a bare
// run_failed. Our hosted gateway is not blocked: clients on it run their tests like anyone else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { KIT_ROOT, LOCK, PINS, tempDir, writeScenariosDir } from './kitFixtures.mjs';
import { fakeGateway, json, kitAsync, kitCopy, planRun, shapedScenarios } from './kitPlanFixtures.mjs';
import {
  fakeClaude, fakeRunGateway, freezeWith, git, kitIn, kitRunCopy, originRepo, runEnv, runScenario, sharedTemp, writeDir,
} from './kitRunFixtures.mjs';

const BUDGET = ['--budget-usd', '500', '--session-cost-usd', '0.15'];

/** Commit a config.yaml in `root` whose run.blocked_gateways is `blocked`. */
function blockIn(root, blocked) {
  const config = yaml.load(readFileSync(join(root, 'config.yaml'), 'utf8'));
  config.run = { ...config.run, blocked_gateways: blocked };
  writeFileSync(join(root, 'config.yaml'), yaml.dump(config));
  git(root, ['commit', '-q', '-am', 'block a gateway']);
}

function assertBlocked(child, command, gateway) {
  const out = json(child, `${command} --json (blocked gateway)`);
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command, code: 'plan_gateway_blocked' });
  assert.equal(out.gateway, gateway, 'the refusal names the gateway');
  assert.ok(typeof out.message === 'string' && out.message.length > 0, 'the refusal says why');
  assert.equal(child.status, 3);
}

test('the committed config does not block our hosted gateway', () => {
  const run = yaml.load(readFileSync(join(KIT_ROOT, 'config.yaml'), 'utf8')).run ?? {};
  const hosts = (run.blocked_gateways ?? []).map((u) => new URL(u).hostname);
  assert.equal(hosts.some((h) => h === 'gateway.anyray.ai'), false, `blocked: ${JSON.stringify(hosts)}`);
});

test('plan refuses a blocked gateway before it reads the session gate, with or without a trailing slash in the block list', async (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'check-long': shapedScenarios()['check-long'] });
  const gateway = await fakeGateway(t);
  for (const listed of [gateway.url, `${gateway.url}/`]) {
    const copy = kitCopy(t);
    blockIn(copy.root, [listed]);
    assertBlocked(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: copy.root }), 'plan', gateway.url);
    const human = await planRun(t, dir, gateway, BUDGET, { kitRoot: copy.root });
    assert.equal(human.status, 3, `human plan exit ${human.status}`);
  }
  assert.deepEqual(gateway.requests, [], 'a blocked gateway is never contacted');

  // The control: the same copy without the block plans.
  const open = kitCopy(t);
  const ok = json(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: open.root }), 'plan --json (not blocked)');
  assert.equal(ok.ok, true, `unblocked plan refused: ${JSON.stringify(ok)}`);
});

test('freeze refuses a blocked gateway and writes no lock', async (t) => {
  const dir = writeScenariosDir(tempDir(t), { 'check-long': shapedScenarios()['check-long'] });
  const copy = kitCopy(t);
  const url = `https://${PINS.gatewayHost}`;
  blockIn(copy.root, [url]);
  const pins = ['--model', PINS.model, '--provider', PINS.provider, '--client', PINS.client, '--client-version', PINS.clientVersion, '--gateway', url];
  assertBlocked(await kitAsync(t, ['freeze', '--scenarios-dir', dir, ...pins, '--json'], { kitRoot: copy.root }), 'freeze', url);
  assert.ok(!existsSync(join(dir, LOCK)), 'a refused freeze wrote plan.lock.json');
});

test('noise refuses when the environment points at a blocked gateway, before any session starts (not run_failed)', async (t) => {
  const root = sharedTemp('kit-blocked-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const blocked = 'https://blocked.example.test';
  blockIn(copy.root, [blocked]);
  const dir = writeDir(root, { 'acme-fix': runScenario(origin) });
  const gateway = await fakeRunGateway();
  t.after(() => gateway.close());
  const claude = fakeClaude(join(root, 'claude'));
  const env = runEnv(join(root, 'home'), { gateway });
  await freezeWith(copy.root, dir, gateway.url, env);

  const child = await kitIn(copy.root, ['noise', '--scenarios-dir', dir, '--claude-bin', claude.bin, '--json'], { env: { ...env, ANYRAY_GATEWAY_URL: blocked } });
  assertBlocked(child, 'noise', blocked);
  assert.equal(claude.sessions().length, 0, 'no session ran against a blocked configuration');
});

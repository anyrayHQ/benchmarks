// Claude Code refuses --dangerously-skip-permissions as root unless IS_SANDBOX=1 is in its own
// environment, and exits 1 before printing anything. The kit starts every session with a fixed
// environment, so a root CI container (CodeBuild runs jobs as root) that set IS_SANDBOX=1 for the
// kit still had both arms crash at once: run_failed, reason crash, consecutive 2, $0 spent
// (anyrayHQ/monorepo client-test-twins.yml, 2026-11-08). The session env carries the caller's
// IS_SANDBOX=1 through, and nothing else it was not already given.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { sessionEnv } from '../lib/agentRun.mjs';
import { spawnAsync } from './kitPlanFixtures.mjs';
import { fakeClaude, fakeRunGateway, kitRunCopy, originRepo, poisonClaude, runEnv, runScenario, sharedTemp, writeDir } from './kitRunFixtures.mjs';

const BEDROCK = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'bench', AWS_REGION: 'us-east-1' };

test('a caller that set IS_SANDBOX=1 hands it to the session', () => {
  const env = sessionEnv({ home: '/h', provider: 'bedrock', procEnv: BEDROCK, env: { PATH: '/bin', IS_SANDBOX: '1' } });
  assert.equal(env.IS_SANDBOX, '1');
});

test('without it, the session gets none: the kit never turns the root check off by itself', () => {
  for (const value of [undefined, '', '0', 'true']) {
    const env = sessionEnv({ home: '/h', provider: 'bedrock', procEnv: BEDROCK, env: { PATH: '/bin', ...(value === undefined ? {} : { IS_SANDBOX: value }) } });
    assert.equal('IS_SANDBOX' in env, false, `IS_SANDBOX=${value}`);
  }
});

test('the rest of the session env is what it was: PATH, HOME, GOFLAGS and the arm env; nothing else inherited', () => {
  const env = sessionEnv({
    home: '/h', provider: 'bedrock', procEnv: BEDROCK,
    env: { PATH: '/bin', IS_SANDBOX: '1', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-placeholder', ANYRAY_ADMIN_KEY: 'aak_synthetic-placeholder' },
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', IS_SANDBOX: '1', GOFLAGS: '-mod=mod', ...BEDROCK });
});

test('the arm env still wins over what the kit sets itself', () => {
  const env = sessionEnv({ home: '/h', provider: 'bedrock', procEnv: { GOFLAGS: '-mod=vendor' }, env: { PATH: '/bin' } });
  assert.equal(env.GOFLAGS, '-mod=vendor');
});

// Wiring: the same through the real run_agent.mjs CLI, with a stand-in Claude and gateway. Costs nothing.
const KEY = 'sk-ant-synthetic-sandbox-key-123456';
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

async function pairWith(extra) {
  const root = sharedTemp('sandbox-env-');
  const origin = originRepo(root);
  const kit = kitRunCopy(join(root, 'kit'));
  writeDir(kit.root, { 'sandbox-twin': runScenario(origin) }, 'scenarios');
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'));
  const env = runEnv(join(root, 'home'), { gateway, poison, extra: { ANTHROPIC_API_KEY: KEY, ...extra } });
  const child = await spawnAsync(process.execPath, [realpathSync(join(kit.root, 'run_agent.mjs')), '--scenario', 'sandbox-twin', '--compare', 'gateway', '--bare', '--upstream', 'api-key', '--rounds', '1', '--claude-bin', claude.bin], { env, cwd: kit.root, timeout: 170_000 });
  return { child, sessions: claude.sessions(), poison };
}

test('through the CLI: every Claude process of a pair gets IS_SANDBOX=1 when the kit was given it, and none when not', async () => {
  for (const [extra, want] of [[{ IS_SANDBOX: '1' }, '1'], [{}, null]]) {
    const r = await pairWith(extra);
    assert.equal(r.child.status, 0, `${r.child.stdout.slice(-600)}${r.child.stderr.slice(-600)}`);
    assert.equal(r.sessions.length, 2, 'both arms ran');
    for (const s of r.sessions) assert.equal(s.sandbox, want, `IS_SANDBOX given as ${JSON.stringify(extra.IS_SANDBOX)}`);
    assert.equal(r.poison.calls(), 0, 'the `claude` on PATH never ran');
  }
});

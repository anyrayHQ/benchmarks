// `freeze --kinds a,b` pins the optimizer kinds a test evaluates, for a gateway where the
// tenant-defaults route is not available (multi-tenant fleet mode). The list is canonical (sorted,
// deduplicated), sits inside the plan hash like every pin, and is sent as x-anyray-optimization-kinds
// on the Anyray arm only. A plan without it is exactly today's: no pin, no header. Stand-in Claude
// and gateway; no network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { json } from './kitPlanFixtures.mjs';
import {
  PIN_ARGS, fakeClaude, fakeRunGateway, kitIn, kitRunCopy, originRepo, pairRound, poisonClaude, runEnv, runScenario, sharedTemp, writeDir, writeNoise,
} from './kitRunFixtures.mjs';

const ID = 'acme-fix';
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

async function plan({ kinds = null } = {}) {
  const root = sharedTemp('kit-kinds-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { [ID]: runScenario(origin) });
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1], anyray: [0.5] } });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const freeze = await kitIn(copy.root, ['freeze', '--scenarios-dir', dir, ...PIN_ARGS(gateway.url), ...(kinds === null ? [] : ['--kinds', kinds]), '--json'], { env });
  const lockFile = join(dir, 'plan.lock.json');
  return { root, copy, dir, gateway, claude, env, freeze, lockFile, lock: () => JSON.parse(readFileSync(lockFile, 'utf8')) };
}

test('freeze --kinds pins a canonical list: sorted, deduplicated, comma-joined', async () => {
  const p = await plan({ kinds: 'relevance_filter,observation_mask,relevance_filter' });
  const out = json(p.freeze, 'freeze --json');
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(p.lock().pins.kinds, 'observation_mask,relevance_filter');
  const verify = json(await kitIn(p.copy.root, ['verify', '--scenarios-dir', p.dir, '--json'], { env: p.env }), 'verify --json');
  assert.equal(verify.ok, true, 'a lock with the pin verifies');
});

test('the kinds pin is inside the plan hash: editing it by hand is a changed plan', async () => {
  const p = await plan({ kinds: 'observation_mask' });
  const lock = p.lock();
  lock.pins.kinds = 'observation_mask,code_graph';
  writeFileSync(p.lockFile, JSON.stringify(lock, null, 2) + '\n');
  const verify = json(await kitIn(p.copy.root, ['verify', '--scenarios-dir', p.dir, '--json'], { env: p.env }), 'verify --json');
  assert.equal(verify.ok, false);
  assert.equal(verify.code, 'plan_lock_invalid');
});

test('a plan frozen without --kinds has no kinds pin, as before', async () => {
  const p = await plan();
  assert.equal(json(p.freeze, 'freeze --json').ok, true);
  assert.ok(!('kinds' in p.lock().pins), 'the pins are exactly the five of today');
});

test('--kinds that is not a list of kind ids is a usage error and writes no lock', async () => {
  for (const bad of ['', 'Bad Kind', 'a,,b', 'a;b', 'x'.repeat(200)]) {
    const p = await plan({ kinds: bad });
    const out = json(p.freeze, `freeze --kinds ${JSON.stringify(bad).slice(0, 20)}`);
    assert.equal(out.ok, false, `accepted ${JSON.stringify(bad).slice(0, 30)}`);
    assert.equal(out.code, 'usage');
    assert.equal(p.freeze.status, 2);
  }
});

test('with kinds pinned the Anyray arm sends the header and the direct arm does not; without, no request does', async () => {
  const pinned = await plan({ kinds: 'relevance_filter,observation_mask' });
  writeNoise(pinned.dir, { sd: 0.3 });
  const run = await kitIn(pinned.copy.root, ['run', '--scenarios-dir', pinned.dir, '--claude-bin', pinned.claude.bin, '--rounds', '1', '--json'], { env: pinned.env });
  assert.equal(json(run, 'run --json (kinds pinned)').ok, true, `${run.stdout.slice(0, 200)} ${run.stderr.slice(-300)}`);
  const sent = pinned.gateway.inference();
  assert.ok(sent.length > 0, 'the Anyray arm reached the gateway');
  assert.ok(sent.every((r) => r.kindsHeader === 'observation_mask,relevance_filter'), `header on every request: ${JSON.stringify(sent.map((r) => r.kindsHeader))}`);

  const plain = await plan();
  writeNoise(plain.dir, { sd: 0.3 });
  const run2 = await kitIn(plain.copy.root, ['run', '--scenarios-dir', plain.dir, '--claude-bin', plain.claude.bin, '--rounds', '1', '--json'], { env: plain.env });
  assert.equal(json(run2, 'run --json (no kinds)').ok, true);
  assert.ok(plain.gateway.inference().every((r) => r.kindsHeader === null), 'no kinds pin, no header');
});

void pairRound;

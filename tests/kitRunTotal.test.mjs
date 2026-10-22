// `npm run run` rounds are a total, not an increment; every paid round reports progress; an
// underpowered round count is warned about before it is spent; and an inconclusive verdict says
// why instead of reading like a failure next to Rule 0.
//
// Driven through the CLI of a kit copy with the stand-in Claude Code and fake gateway of kitRunFixtures.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { json } from './kitPlanFixtures.mjs';
import {
  fakeClaude, fakeRunGateway, freezeWith, kitIn, kitRunCopy, originRepo, poisonClaude, readRecord, runEnv, runScenario, sharedTemp, writeDir, writeNoise,
} from './kitRunFixtures.mjs';

const gateways = [];
after(async () => { for (const g of gateways) await g.close(); });

async function setup({ costs = { direct: [1, 1.2], anyray: [0.5, 0.6] }, noiseSd = 0.3 } = {}) {
  const root = sharedTemp('kit-total-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'acme-fix': runScenario(origin, {}) });
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs, marked: false });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const lock = await freezeWith(copy.root, dir, gateway.url, env);
  writeNoise(dir, { sd: noiseSd });
  return { copy, dir, claude, env, lock, gateway };
}
const run = (s, rounds, extra = []) => kitIn(s.copy.root, ['run', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, '--rounds', String(rounds), ...extra], { env: s.env });

test('--rounds is the total a scenario ends with: a second run of the same number spends nothing and says so', async () => {
  const s = await setup();
  assert.equal((await run(s, 3)).status, 0);
  const after1 = s.claude.sessions().length;
  assert.equal(after1, 6, 'three paired rounds are six sessions');
  const again = await run(s, 3);
  assert.equal(again.status, 0);
  assert.equal(s.claude.sessions().length, after1, 'no session started');
  assert.match(again.stderr, /Nothing to run: every scenario already has 3 or more rounds/);
  assert.equal(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray').rounds.length, 3);
});

test('a higher --rounds tops the plan up to that total, and an interrupted count resumes where it stopped', async () => {
  const s = await setup();
  await run(s, 2);
  const topUp = await run(s, 5);
  assert.equal(topUp.status, 0);
  assert.equal(s.claude.sessions().length, 10, 'two rounds, then three more: five pairs in all, not seven');
  assert.deepEqual(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray').rounds.map((r) => r.round), [1, 2, 3, 4, 5]);
});

test('every paid round prints its number, the planned total, its ratio and the spend so far', async () => {
  const s = await setup();
  const child = await run(s, 2);
  const lines = child.stderr.split('\n').filter((l) => /round \d+\/2 done/.test(l));
  assert.equal(lines.length, 2, child.stderr.slice(-600));
  assert.match(lines[0], /^acme-fix: round 1\/2 done \(1\/2 this run\); ratio 0\.50; spent so far \$1\.50$/);
  assert.match(lines[1], /round 2\/2 done \(2\/2 this run\); ratio 0\.50; spent so far \$3\.30$/);
});

test('rounds that cannot resolve the predicted band at the measured noise are warned about before any session starts', async () => {
  const s = await setup({ noiseSd: 0.9 });
  const child = await run(s, 2);
  assert.match(child.stderr, /acme-fix: 2 rounds is under the \d+ this scenario needs at your measured noise/);
  const enough = await setup({ noiseSd: 0.05 });
  assert.doesNotMatch((await run(enough, 2)).stderr, /rounds is under/);
});

test('rounds recorded on another gateway release are refused, not topped up into one verdict', async () => {
  const s = await setup();
  await run(s, 1);
  const rec = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.equal(rec.gatewayVersion, '1.10.515');
  const { writeFileSync } = await import('node:fs');
  const { resultsDir } = await import('./kitRunFixtures.mjs');
  writeFileSync(join(resultsDir(s.dir, s.lock.planHash), 'acme-fix--anyray.json'), JSON.stringify({ ...rec, gatewayVersion: '1.10.400' }));
  const before = s.claude.sessions().length;
  const child = await run(s, 2);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /run_results_other_release/);
  assert.equal(s.claude.sessions().length, before, 'no session started');
});

test('an inconclusive verdict says why and what it would take; a pass or fail stays bare', async () => {
  const noisy = await setup({ costs: { direct: [0.6, 2.4, 1.0, 1.9, 0.8, 2.2], anyray: [0.7, 1.1, 2.3, 0.6, 1.8, 0.9] } });
  await run(noisy, 6);
  const few = await kitIn(noisy.copy.root, ['verdict', '--scenarios-dir', noisy.dir], { env: noisy.env });
  assert.match(few.stdout, /^acme-fix: inconclusive \(6 valid pairs, 8 needed; about \d+ pairs at your measured noise\)/m);
  await run(noisy, 10);
  const text = await kitIn(noisy.copy.root, ['verdict', '--scenarios-dir', noisy.dir], { env: noisy.env });
  assert.match(text.stdout, /^acme-fix: inconclusive \(the 95% interval includes no change/m);
  const report = await kitIn(noisy.copy.root, ['report', '--scenarios-dir', noisy.dir, '--redact'], { env: noisy.env });
  assert.match(report.stdout, /inconclusive \(the 95% interval includes no change/);
  const body = json(await kitIn(noisy.copy.root, ['report', '--scenarios-dir', noisy.dir, '--redact', '--json'], { env: noisy.env }), 'report --json');
  assert.equal(body.scenarios[0].verdict, 'inconclusive', 'the published body keeps the bare word');
  assert.equal(JSON.stringify(body).includes('95% interval'), false, 'the explanation is local text, never in what is published');

  const clear = await setup({ costs: { direct: [1.3], anyray: [0.8] } });
  await run(clear, 8);
  const clearText = await kitIn(clear.copy.root, ['verdict', '--scenarios-dir', clear.dir], { env: clear.env });
  assert.match(clearText.stdout, /^acme-fix: pass; Rule 0 PASS$/m);
});

test('--max-spend-usd stops between rounds before the next one would cross the cap, and keeps the rounds so far', async () => {
  const s = await setup(); // a paired round costs $1.50 then $1.80 in the stand-in
  const child = await run(s, 5, ['--max-spend-usd', '4']);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /run_spend_cap_reached: Stopped at \$3\.30 of the \$4 cap after 2 round\(s\)/);
  assert.equal(s.claude.sessions().length, 4, 'two paired rounds ran, the third never started');
  assert.equal(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray').rounds.length, 2, 'the finished rounds are kept');
  const resumed = await run(s, 3, ['--max-spend-usd', '10']);
  assert.equal(resumed.status, 0, 'a higher cap continues from the kept rounds');
  assert.equal(s.claude.sessions().length, 6);
});

test('a cap that is not a positive number is a usage error and nothing runs', async () => {
  const s = await setup();
  for (const bad of ['0', '-1', 'abc']) assert.notEqual((await run(s, 2, ['--max-spend-usd', bad])).status, 0, bad);
  assert.equal(s.claude.sessions().length, 0);
  assert.equal((await run(s, 1, ['--max-spend-usd', '50'])).status, 0, 'a cap above the spend changes nothing');
});

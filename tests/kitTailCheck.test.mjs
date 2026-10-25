// The kit's verdict carries the tail check (ANY-1656). A plan's `noise` step is a direct-vs-direct
// (control) run with the plan's own pins, so its valid pairs are the no-op library for the plan's
// direct-vs-Anyray pairs. Local only: the published body is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, pairRound, syntheticPlan, writeRecord } from './kitRunFixtures.mjs';
import { clientTestBody } from '../lib/clientTestBody.mjs';
import { readKitRecords, tailLine } from '../lib/kitResults.mjs';
import { seededNormals } from '../lib/tailSim.mjs';

const controls = (n, sd, seed) => seededNormals(seed, n).map((z, i) => pairRound(i + 1, 1, Math.exp(z * sd)));
const verdict = (copy, dir, env, args = ['--json']) => kitIn(copy.root, ['verdict', '--scenarios-dir', dir, ...args], { env });
const byId = (answer) => Object.fromEntries(answer.scenarios.map((s) => [s.id, s.tail]));

async function plan(t) {
  const root = tempDir(t, 'kit-tail-');
  const env = kitEnv(join(root, 'home'));
  const p = await syntheticPlan(root, { env });
  return { ...p, env };
}

test('a plan with no control pairs reads insufficient calibration per scenario, with what to collect', async (t) => {
  const { copy, dir, env } = await plan(t);
  const tails = byId(json(await verdict(copy, dir, env), 'verdict --json'));
  assert.equal(tails['check-long'].state, 'insufficient_calibration');
  assert.deepEqual([tails['check-long'].n, tails['check-long'].need.pairs, tails['check-long'].need.more], [8, 152, 152]);
  assert.equal(tails.facts.need.pairs, 38);
  assert.equal(tails.docs.state, 'no_pairs');
});

test('19 blocks of the plan\'s own control pairs decide: a saving is within noise, a pair above the noise is an excess', async (t) => {
  const { copy, dir, lock, env } = await plan(t);
  writeRecord(dir, lock, 'check-long', controls(152, 0.5, 1), { compare: 'control' });
  writeRecord(dir, lock, 'facts', controls(38, 0.02, 2), { compare: 'control' }); // a quiet scenario: 1.1 is far outside it
  const tails = byId(json(await verdict(copy, dir, env), 'verdict --json'));
  assert.equal(tails['check-long'].state, 'within_noise');
  assert.equal(tails['check-long'].blocks, 19);
  assert.equal(tails.facts.state, 'excess');
  assert.ok(tails.facts.T > tails.facts.threshold);
  assert.equal(tails['short-task'].state, 'insufficient_calibration', 'a scenario with no control pairs of its own stays uncalibrated');
});

test('the words say it plainly and never pass an uncalibrated scenario', async (t) => {
  const { copy, dir, lock, env } = await plan(t);
  writeRecord(dir, lock, 'facts', controls(38, 0.02, 2), { compare: 'control' });
  const out = (await verdict(copy, dir, env, [])).stdout;
  assert.match(out, /check-long:.*\n(?:.*\n)*?\s+Tail check: insufficient calibration, needs 152 control pairs \(152 more\)/);
  assert.match(out, /facts:.*\n(?:.*\n)*?\s+Tail check: excess, T 0\.\d+ above every noise block \(max 0\.\d+\)/);
});

test('the published body is unchanged: no tail field travels', async (t) => {
  const { dir, lock } = await plan(t);
  writeRecord(dir, lock, 'facts', controls(38, 0.02, 2), { compare: 'control' });
  const body = clientTestBody(lock, readKitRecords(dir, lock), '0.0.0', { scenarios: [] });
  assert.equal(JSON.stringify(body).includes('tail'), false);
});

// ---- the instruction the verdict prints must work: `noise --rounds N` tops the control pairs up ----
import { readLock } from './kitFixtures.mjs';
import { fakeClaude, freezeWith, kitRunCopy, noiseHash, originRepo, poisonClaude, readRecord, runEnv, runScenario, sharedTemp, writeDir } from './kitRunFixtures.mjs';

test('noise run again with --rounds 6 adds 6 control pairs, keeps the noise block valid, and the verdict counts them', async () => {
  const root = sharedTemp('kit-tail-topup-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'check-long': runScenario(origin) });
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1.0, 1.3, 0.85, 1.1, 0.95, 1.2, 0.9], anyray: [0.5] } });
  const env = runEnv(join(root, 'home'), { poison: poisonClaude(join(root, 'poison')) });
  const lock = await freezeWith(copy.root, dir, 'https://gw.example.test', env);
  const noise = (rounds) => kitIn(copy.root, ['noise', '--scenarios-dir', dir, '--claude-bin', claude.bin, '--rounds', String(rounds), '--json'], { env });
  assert.equal(json(await noise(6), 'noise 6').ok, true);
  const more = json(await noise(6), 'noise 6 more');
  assert.equal(more.ok, true, JSON.stringify(more));
  assert.equal(readRecord(dir, lock.planHash, 'check-long', 'control').rounds.length, 12, 'the second run appended');
  const after = readLock(dir);
  assert.equal(after.noise.rounds, 12);
  assert.equal(after.noise.hash, noiseHash(after, after.noise), 'the noise block still verifies');
  writeRecord(dir, lock, 'check-long', Array.from({ length: 8 }, (_, i) => pairRound(i + 1, 1, 0.5)));
  const tail = json(await verdict(copy, dir, env), 'verdict --json').scenarios[0].tail;
  assert.deepEqual([tail.state, tail.libraryPairs, tail.need.more], ['insufficient_calibration', 12, 152 - 12]);
});

test('the printed command never asks for fewer rounds than noise accepts', () => {
  const line = (more) => tailLine({ state: 'insufficient_calibration', need: { pairs: 152, more } });
  assert.match(line(4), /--rounds 6 /);
  assert.match(line(140), /--rounds 140 /);
});

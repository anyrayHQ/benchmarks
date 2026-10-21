// `npm run noise` (ANY-1487): before any savings number, the client's own run-to-run variance.
// Direct-vs-direct rounds (`--compare control`) for every frozen scenario, at least six,
// one round at a time and interleaved across scenarios; the measured paired log-ratio SD is
// written into the lock as a `noise` block with its own HMAC (the plan hash does not move),
// and pairs needed is printed again from that SD instead of the prior.
//
// Driven through the CLI of a kit copy whose catalog is the test catalog, with a stand-in
// Claude Code and a local git repo: no network, no model call, no real session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exclusionReasons } from '../lib/benchVerdict.mjs';
import { HEX64, PINS, lockPath, readLock } from './kitFixtures.mjs';
import { TEST_SHAPES, formulaPairs, json, PRIOR_SD } from './kitPlanFixtures.mjs';
import {
  NOISE_MIN_ROUNDS, factsScenario, fakeClaude, filesUnder, fakeRunGateway, freezeWith, kitIn, kitRunCopy, leaks,
  noiseHash, once, originRepo, poisonClaude, pooledSd, readRecord, runEnv, runScenario, sharedTemp, writeDir,
  writeNoise,
} from './kitRunFixtures.mjs';

const GW = 'https://gw.example.test'; // pinned at freeze; a control run never touches a gateway
const CHECK_LONG = TEST_SHAPES.find((s) => s.id === 't-cc-check-long');
const TARGET = (CHECK_LONG.band.lo + CHECK_LONG.band.hi) / 2;
// Direct costs that differ round to round, so the measured SD is far from the 0.924 prior.
const DIRECT_COSTS = [1.0, 1.3, 0.85, 1.1, 0.95, 1.2, 0.9];

/** A frozen plan with `scenarios`, a kit copy, a stand-in Claude and a poisoned PATH, in one temp root. */
async function setup(scenarios) {
  const root = sharedTemp('kit-noise-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, scenarios(origin));
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: DIRECT_COSTS, anyray: [0.5] } });
  const env = runEnv(join(root, 'home'), { poison });
  const lock = await freezeWith(copy.root, dir, GW, env);
  return { root, copy, dir, poison, claude, env, lock };
}

const noise = (s, args) => kitIn(s.copy.root, ['noise', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, ...args], { env: s.env });

// Two scenarios, six rounds each, `--json`: run once, read by the leaf tests below.
const twoScenarioNoise = once(async () => {
  const s = await setup((origin) => ({ 'check-long': runScenario(origin, { marked: true }), facts: factsScenario(origin) }));
  const child = await noise(s, ['--json']);
  return { ...s, child };
});

/** The valid ratios of a control record: the rounds benchVerdict would score. */
const validRatios = (record) => record.rounds.filter((r) => exclusionReasons(r).length === 0).map((r) => r.ratio);
const sampleSd = (xs) => pooledSd([xs]);
const close = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${what}: ${actual} vs ${expected}`);

test('noise runs six direct-vs-direct rounds for every frozen scenario, one at a time and interleaved across scenarios, on the pinned binary', async () => {
  const s = await twoScenarioNoise();
  const out = json(s.child, 'noise --json');
  assert.equal(out.ok, true, `noise refused: ${s.child.stdout.slice(0, 400)} ${s.child.stderr.slice(-400)}`);
  assert.equal(s.child.status, 0);
  assert.equal(out.command, 'noise');

  const records = ['check-long', 'facts'].map((id) => readRecord(s.dir, s.lock.planHash, id, 'control'));
  for (const [i, r] of records.entries()) {
    assert.equal(r.compare, 'control', `record ${i}`);
    assert.equal(r.rounds.length, NOISE_MIN_ROUNDS, `${r.scenario?.id}: the default is the minimum, six rounds`);
  }
  // Direct vs direct: every session is a direct one, and every one ran from --claude-bin.
  const sessions = s.claude.sessions();
  assert.equal(sessions.length, 2 * 2 * NOISE_MIN_ROUNDS, 'two arms per round, six rounds, two scenarios');
  assert.ok(sessions.every((x) => x.kind === 'direct'), 'a noise round never goes through a gateway');
  assert.equal(s.poison.calls(), 0, 'the `claude` on PATH was never run');

  // One round at a time, round k of every scenario (in id order) before round k+1 of any.
  const order = records
    .flatMap((r) => r.rounds.map((x) => ({ id: r.scenario?.id, at: Date.parse(x.startedAt) })))
    .sort((x, y) => x.at - y.at)
    .map((x) => x.id);
  assert.deepEqual(order, Array.from({ length: 2 * NOISE_MIN_ROUNDS }, (_, k) => (k % 2 ? 'facts' : 'check-long')), 'rounds interleave across scenarios');
});

test('noise writes the measured pooled log-ratio SD into the lock as a signed noise block, and the plan hash does not move', async () => {
  const s = await twoScenarioNoise();
  assert.equal(json(s.child, 'noise --json').ok, true, 'noise must succeed before its lock can be read');
  const lock = readLock(s.dir);
  const { noise: block, ...rest } = lock;
  assert.ok(block, 'the lock has a noise block');
  assert.deepEqual(rest, s.lock, 'every frozen key is unchanged: the plan hash, the pins, the predictions');
  assert.deepEqual(Object.keys(block).sort(), ['byScenario', 'hash', 'measuredAt', 'rounds', 'sd']);

  const ratios = Object.fromEntries(['check-long', 'facts'].map((id) => [id, validRatios(readRecord(s.dir, lock.planHash, id, 'control'))]));
  close(block.sd, pooledSd(Object.values(ratios)), 'sd is the pooled sample SD of ln(B/A) over the valid control rounds');
  assert.notEqual(block.sd, PRIOR_SD);
  assert.equal(block.rounds, ratios['check-long'].length + ratios.facts.length, 'rounds counts the valid control rounds');
  assert.deepEqual(block.byScenario.map((b) => b.id), ['check-long', 'facts']);
  for (const b of block.byScenario) {
    assert.deepEqual(Object.keys(b).sort(), ['id', 'n', 'sd'], b.id);
    assert.equal(b.n, ratios[b.id].length, `${b.id}: n`);
    close(b.sd, sampleSd(ratios[b.id]), `${b.id}: sd`);
  }
  assert.match(block.measuredAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(block.hash, HEX64);
  assert.equal(block.hash, noiseHash(lock, block), 'hash = HMAC-SHA256(nonce, canon({ planHash, sd, rounds, byScenario, measuredAt }))');
});

test('noise prints pairs needed again from the measured SD, not the 0.924 prior', async () => {
  const s = await twoScenarioNoise();
  const out = json(s.child, 'noise --json');
  assert.equal(out.ok, true, 'noise must succeed before its answer can be read');
  const lock = readLock(s.dir);
  assert.deepEqual(out.sd, { value: lock.noise.sd, source: 'measured', rounds: lock.noise.rounds });
  assert.equal(out.planHash, lock.planHash);
  const byId = Object.fromEntries((out.scenarios ?? []).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['check-long', 'facts']);

  const cl = byId['check-long'];
  assert.equal(cl.shapeId, 't-cc-check-long');
  assert.deepEqual(cl.prediction, lock.predictions.find((p) => p.id === 'check-long').prediction, 'the frozen prediction');
  assert.equal(cl.target, TARGET);
  assert.equal(cl.pairsNeeded, formulaPairs(TARGET, lock.noise.sd), 'pairs needed at the measured SD');
  assert.notEqual(cl.pairsNeeded, formulaPairs(TARGET, PRIOR_SD), 'the measured SD changed the number');
  assert.equal(cl.n, lock.noise.byScenario.find((b) => b.id === 'check-long').n);

  assert.equal(byId.facts.shapeId, null);
  assert.equal(byId.facts.pairsNeeded, null, 'no prediction, no pairs needed');
});

test('noise without --json prints each scenario with its pairs needed at the measured SD', async () => {
  const s = await setup((origin) => ({ 'check-long': runScenario(origin) }));
  const child = await noise(s, []);
  assert.equal(child.status, 0, `noise failed: ${child.stderr.slice(-600)}`);
  const lock = readLock(s.dir);
  assert.ok(lock.noise, 'the lock has a noise block');
  const pairs = formulaPairs(TARGET, lock.noise.sd);
  const line = child.stdout.split('\n').find((l) => l.includes('check-long') && l.split(/[^0-9]+/).includes(String(pairs)));
  assert.ok(line, `stdout names check-long with ${pairs} pairs needed: ${JSON.stringify(child.stdout.slice(0, 800))}`);
  assert.ok(!child.stdout.includes(lock.nonce) && !child.stderr.includes(lock.nonce), 'the nonce is never printed');
});

test('noise records keep ids, hashes, counts and costs, never task text, patch, pastes, repo URL or transcripts', async () => {
  const s = await twoScenarioNoise();
  assert.equal(json(s.child, 'noise --json').ok, true, 'noise must succeed before its records can be read');
  const files = filesUnder(join(s.dir, '.kit-results'));
  assert.ok(files.length >= 2, 'the records are kept under <scenarios-dir>/.kit-results/');
  for (const f of files) assert.deepEqual(leaks(readFileSync(f, 'utf8')), [], `${f} carries client content`);
  assert.deepEqual(leaks(s.child.stdout), [], 'noise --json carries client content');
  assert.equal(readFileSync(join(s.dir, '.kit-results', '.gitignore'), 'utf8'), '*\n', 'the results dir ignores itself in the client repo');
  assert.ok(!existsSync(join(s.copy.root, 'results')), 'nothing is written under the kit\'s own results/');

  const lockEntry = s.lock.scenarios.find((x) => x.id === 'check-long');
  const record = readRecord(s.dir, s.lock.planHash, 'check-long', 'control');
  assert.equal(record.planHash, s.lock.planHash);
  assert.deepEqual(record.scenario, lockEntry, 'the scenario is its id, source and frozen hash, nothing else');
  for (const r of record.rounds) {
    assert.ok(Number.isFinite(r.ratio), `round ${r.round}: the ratio stays`);
    assert.ok(r.sessions.a.totals.costUsd > 0 && r.sessions.b.totals.costUsd > 0, `round ${r.round}: both costs stay`);
    assert.equal(typeof r.sessions.a.totals.turns, 'number', `round ${r.round}: counts stay`);
    assert.equal(r.quality.a, true, `round ${r.round}: the check outcome stays`);
  }
});

test('noise refuses fewer than six rounds (usage) and never invokes Claude', async () => {
  const s = await setup((origin) => ({ 'check-long': runScenario(origin) }));
  // The command exists and reads the plan first: a dir with no lock is plan_lock_missing, not usage.
  const unfrozen = writeDir(s.root, { 'check-long': runScenario(originRepo(s.root, 'other-origin')) }, 'unfrozen');
  const missing = json(await kitIn(s.copy.root, ['noise', '--scenarios-dir', unfrozen, '--claude-bin', s.claude.bin, '--json'], { env: s.env }), 'noise --json without a lock');
  assert.equal(missing.code, 'plan_lock_missing', JSON.stringify(missing));
  const before = readFileSync(lockPath(s.dir), 'utf8');
  for (const rounds of ['5', '0', 'six']) {
    const child = await noise(s, ['--rounds', rounds, '--json']);
    const out = json(child, `noise --rounds ${rounds}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'noise', code: 'usage' }, `--rounds ${rounds}`);
    assert.equal(child.status, 2, `--rounds ${rounds}`);
  }
  assert.deepEqual(s.claude.versions(), [], 'not even --version');
  assert.deepEqual(s.claude.sessions(), []);
  assert.equal(readFileSync(lockPath(s.dir), 'utf8'), before, 'the lock is untouched');
});

test('the noise block is signed: a hand-edited SD, a block from another plan or an unknown key is refused by verify and run', async () => {
  const s = await setup((origin) => ({ 'check-long': runScenario(origin) }));
  const gateway = await fakeRunGateway();
  const verify = () => kitIn(s.copy.root, ['verify', '--scenarios-dir', s.dir, '--json'], { env: s.env });
  const run = () => kitIn(s.copy.root, ['run', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, '--rounds', '1', '--json'], { env: runEnv(join(s.root, 'home'), { gateway, poison: s.poison }) });
  try {
    writeNoise(s.dir, { sd: 0.3 });
    const ok = json(await verify(), 'verify --json with a signed noise block');
    assert.equal(ok.ok, true, `a block signed per the contract verifies: ${JSON.stringify(ok)}`);
    const signed = readLock(s.dir);

    const edits = [
      ['the SD lowered by hand', (l) => { l.noise.sd = 0.1; }, 'noise_hash'],
      ['a scenario n raised by hand', (l) => { l.noise.byScenario[0].n = 60; }, 'noise_hash'],
      ['a block signed for another plan', (l) => { l.noise.hash = noiseHash({ ...l, planHash: `${l.planHash.slice(0, -1)}${l.planHash.endsWith('0') ? '1' : '0'}` }, l.noise); }, 'noise_hash'],
      ['an unknown key in the block', (l) => { l.noise.note = 'x'; }, 'schema'],
    ];
    for (const [what, edit, reason] of edits) {
      const lock = structuredClone(signed);
      edit(lock);
      writeFileSync(lockPath(s.dir), JSON.stringify(lock, null, 2));
      for (const [name, cmd] of [['verify', verify], ['run', run]]) {
        const child = await cmd();
        const out = json(child, `${name} --json (${what})`);
        assert.deepEqual({ code: out.code, reason: out.reason }, { code: 'plan_lock_invalid', reason }, `${name}: ${what}`);
        assert.equal(child.status, 3, `${name}: ${what}`);
      }
    }
    assert.deepEqual(s.claude.sessions(), [], 'no session ran on a tampered lock');
    assert.deepEqual(gateway.requests, [], 'and no gateway request was made');
  } finally {
    await gateway.close();
  }
});

test('the pin check still applies: a Claude Code build other than the frozen one is refused after reading only its version', async () => {
  const s = await setup((origin) => ({ 'check-long': runScenario(origin) }));
  const other = fakeClaude(join(s.root, 'other-claude'), { version: '2.1.299' });
  const child = await kitIn(s.copy.root, ['noise', '--scenarios-dir', s.dir, '--claude-bin', other.bin, '--json'], { env: s.env });
  const out = json(child, 'noise --json with another Claude Code build');
  assert.deepEqual({ code: out.code, pin: out.pin, expected: out.expected, found: out.found }, { code: 'plan_pin_mismatch', pin: 'clientVersion', expected: PINS.clientVersion, found: '2.1.299' });
  assert.equal(child.status, 3);
  assert.deepEqual(other.sessions(), [], 'no session ran');
  assert.ok(!readLock(s.dir).noise, 'no noise block was written');
});

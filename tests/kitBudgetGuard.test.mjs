// `npm run noise|run -- --budget-usd B` (ANY-1515): the runtime spend guard. Spent is every session
// cost already recorded for the plan (control and anyray records). Before each round after the
// first of a command, the kit stops when spent plus the most expensive round recorded so far would
// cross B, and answers { ok: true, command, stopped: 'budget_reached', spentUsd, budgetUsd, rounds }
// (exit 0); a refused round never starts. `run --budget-usd B` without --rounds sizes itself:
// floor((B - spent) / mean recorded pair cost), capped at the band's pairs needed, at least 1.
// Every finished round prints one content-free progress line on stderr:
//   <id> round k/N: direct $a, anyray $b, ratio r · spent $s of $B · ~m min left
//
// Driven through the CLI of a kit copy, with a stand-in Claude Code whose session costs are fixed
// per arm, a fake gateway on 127.0.0.1 and a local git repo: no network, no model call. Earlier
// noise rounds are a control record as `noise` keeps it, written with the kit's own fixture.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formulaPairs, json, TEST_SHAPES } from './kitPlanFixtures.mjs';
import {
  BENCH_KEY, fakeClaude, fakeRunGateway, freezeWith, kitIn, kitRunCopy, leaks, originRepo, pairRound, poisonClaude, readRecord, runEnv,
  runScenario, sharedTemp, writeDir, writeNoise, writeRecord,
} from './kitRunFixtures.mjs';

const ID = 'acme-fix';
const CHECK_LONG = TEST_SHAPES.find((s) => s.id === 't-cc-check-long');
const TARGET = (CHECK_LONG.band.lo + CHECK_LONG.band.hi) / 2; // runScenario matches t-cc-check-long
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/** `n` control rounds whose two direct sessions cost `a` and `b`. */
const controlRounds = (n, a, b) => Array.from({ length: n }, (_, i) => pairRound(i + 1, a, b));

/**
 * A frozen one-scenario plan (kit copy, test catalog), a fake gateway, a stand-in Claude with the
 * given per-arm costs and a poisoned PATH. `sd`: a signed noise block at that SD (null: none).
 * `control`: control rounds already recorded for the plan, as `noise` would have left them.
 */
async function setup({ costs = { direct: [1], anyray: [0.5] }, sd = 0.3, control = null, marked = false } = {}) {
  const root = sharedTemp('kit-budget-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { [ID]: runScenario(origin, { marked }) });
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs, marked });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const lock = await freezeWith(copy.root, dir, gateway.url, env);
  if (sd !== null) writeNoise(dir, { sd });
  if (control) writeRecord(dir, lock, ID, control, { compare: 'control' });
  return { root, origin, copy, dir, gateway, poison, claude, env, lock };
}

const cli = (s, command, args) => kitIn(s.copy.root, [command, '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, ...args], { env: s.env });
const sessionsOf = (s, kind) => s.claude.sessions().filter((x) => x.kind === kind).length;

/** The answer of a command that must have succeeded (a clear failure otherwise). */
function answered(child, what) {
  const out = json(child, what);
  assert.equal(out.ok, true, `${what} refused or failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-800)}`);
  assert.equal(child.status, 0, `${what}: exit ${child.status}`);
  return out;
}

const stopFields = (out) => ({ ok: out.ok, command: out.command, stopped: out.stopped, spentUsd: out.spentUsd, budgetUsd: out.budgetUsd, rounds: out.rounds });
const near = (actual, expected, what, tol = 0.005) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected}`);
const roundCost = (r) => r.sessions.a.totals.costUsd + r.sessions.b.totals.costUsd;

// ---- progress lines ----------------------------------------------------------------------------

const PROGRESS = /\bround (\d+)\/(\d+)\b/;

/** The stderr lines that report a finished round (`round k/N`), parsed: k, N, every $ amount, the ratio. */
function progressLines(stderr) {
  return stderr.split('\n').filter((l) => PROGRESS.test(l)).map((line) => {
    const [, k, n] = line.match(PROGRESS);
    const ratio = line.match(/\bratio (\d+(?:\.\d+)?)/);
    return { line, k: Number(k), n: Number(n), dollars: [...line.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])), ratio: ratio ? Number(ratio[1]) : null };
  });
}

/**
 * One progress line per finished round of `record` (the rounds this command ran are its last
 * `ran`), in order, each with the pair's two costs, the ratio, the plan's spend after the round
 * (`spentBefore` plus the rounds so far) and the budget.
 */
function assertProgress(stderr, record, { ran, planned, spentBefore, budget, what }) {
  const lines = progressLines(stderr);
  assert.equal(lines.length, ran, `${what}: one progress line per finished round; stderr=${JSON.stringify(stderr.slice(-1500))}`);
  const rounds = record.rounds.slice(-ran);
  let spent = spentBefore;
  lines.forEach((p, i) => {
    const r = rounds[i];
    spent += roundCost(r);
    assert.equal(p.k, i + 1, `${what}: line ${i + 1} is round ${i + 1}: ${p.line}`);
    assert.equal(p.n, planned, `${what}: of ${planned} planned: ${p.line}`);
    assert.ok(p.line.includes(ID), `${what}: names the scenario id: ${p.line}`);
    assert.equal(p.dollars.length, 4, `${what}: four amounts (the pair's two costs, spent, budget): ${p.line}`);
    const [a, b, s, budgetShown] = p.dollars;
    near(a, r.sessions.a.totals.costUsd, `${what} round ${i + 1}: the direct (A) cost`);
    near(b, r.sessions.b.totals.costUsd, `${what} round ${i + 1}: the second arm's (B) cost`);
    near(p.ratio, r.ratio, `${what} round ${i + 1}: the ratio B/A`);
    near(s, spent, `${what} round ${i + 1}: spent so far, earlier records included`);
    near(budgetShown, budget, `${what} round ${i + 1}: the budget`);
  });
  return lines;
}

// ---- the guard -----------------------------------------------------------------------------------

test('noise --budget-usd stops before a round that would cross the budget: budget_reached with spent, budget and rounds, exit 0, and no refused round ever started', async () => {
  // Every noise round costs $2 (two direct sessions; the per-session costs vary so the pair ratio
  // does). $7: rounds 1-3 spend $6; round 4 would reach $8, so it never starts.
  const s = await setup({ costs: { direct: [1, 1, 1.5, 0.5], anyray: [0.5] }, sd: null });
  const child = await cli(s, 'noise', ['--budget-usd', '7', '--json']);
  const out = answered(child, 'noise --budget-usd 7 --json');
  assert.deepEqual(stopFields(out), { ok: true, command: 'noise', stopped: 'budget_reached', spentUsd: 6, budgetUsd: 7, rounds: 3 });
  assert.equal(s.claude.sessions().length, 6, 'three rounds of two direct sessions started, and not one session of the refused round');
  assert.equal(sessionsOf(s, 'anyray'), 0, 'noise never goes through the gateway');
  const record = readRecord(s.dir, s.lock.planHash, ID, 'control');
  assert.equal(record.rounds.length, 3, 'the three rounds are recorded');

  // Progress: a noise line names both direct sessions (no Anyray arm) and the spend of the budget.
  const lines = assertProgress(child.stderr, record, { ran: 3, planned: 6, spentBefore: 0, budget: 7, what: 'noise progress' });
  for (const p of lines) assert.ok(!/anyray/i.test(p.line), `a noise round has no Anyray arm: ${p.line}`);
});

test('run --budget-usd counts every session already recorded for the plan (control and earlier anyray records) and stops before the round that would cross it', async () => {
  // Spent before: $6 of noise (six control rounds at $0.50 + $0.50) and one earlier paired round
  // ($1 + $0.50) = $7.50. At $12 each paired round adds $1.50: $9, $10.50, then $12 (not over),
  // and the fourth would reach $13.50: three rounds run. Counting only this command's rounds
  // would run eight; forgetting either earlier record runs more than three.
  const s = await setup({ control: controlRounds(6, 0.5, 0.5) });
  answered(await cli(s, 'run', ['--rounds', '1', '--json']), 'the earlier run --rounds 1');
  assert.equal(sessionsOf(s, 'anyray'), 1);

  const child = await cli(s, 'run', ['--rounds', '10', '--budget-usd', '12', '--json']);
  const out = answered(child, 'run --rounds 10 --budget-usd 12 --json');
  assert.deepEqual(stopFields(out), { ok: true, command: 'run', stopped: 'budget_reached', spentUsd: 12, budgetUsd: 12, rounds: 3 });
  assert.deepEqual({ direct: sessionsOf(s, 'direct'), anyray: sessionsOf(s, 'anyray') }, { direct: 4, anyray: 4 }, 'the earlier pair plus three: the refused fourth round started no session');
  const record = readRecord(s.dir, s.lock.planHash, ID, 'anyray');
  assert.equal(record.rounds.length, 4, 'the earlier round and the three this command ran');
  assert.equal(s.poison.calls(), 0);
});

test('run --budget-usd without --rounds runs floor((budget - spent) / mean recorded pair cost) rounds', async () => {
  // $12 of noise at $2 a pair: (20 - 12) / 2 = 4 rounds. Each paired round costs $1.50, so the
  // guard never needs to stop them: the plan completes, not budget_reached.
  const s = await setup({ control: controlRounds(6, 1, 1) });
  assert.ok(formulaPairs(TARGET, 0.3) > 4, 'precondition: the band needs more pairs than the budget buys, so no cap applies');
  const out = answered(await cli(s, 'run', ['--budget-usd', '20', '--json']), 'run --budget-usd 20 --json');
  assert.equal(out.stopped, undefined, `the rounds the budget sized all ran: ${JSON.stringify(out)}`);
  assert.deepEqual({ direct: sessionsOf(s, 'direct'), anyray: sessionsOf(s, 'anyray') }, { direct: 4, anyray: 4 }, 'four pairs');
  assert.equal(readRecord(s.dir, s.lock.planHash, ID, 'anyray').rounds.length, 4);
});

test('budget-sized rounds are capped at the band\'s pairs needed at the measured SD', async () => {
  // A noise SD of 0.1 needs 2 pairs for the 0.8 midpoint; $1000 would buy 494.
  const s = await setup({ control: controlRounds(6, 1, 1), sd: 0.1 });
  const needed = formulaPairs(TARGET, 0.1);
  assert.equal(needed, 2, 'precondition: pairs needed at SD 0.1');
  const out = answered(await cli(s, 'run', ['--budget-usd', '1000', '--json']), 'run --budget-usd 1000 --json');
  assert.equal(out.stopped, undefined, JSON.stringify(out));
  assert.deepEqual({ direct: sessionsOf(s, 'direct'), anyray: sessionsOf(s, 'anyray') }, { direct: needed, anyray: needed }, 'no more pairs than the band needs');
});

test('budget-sized rounds are at least one, even when the budget left buys less than a pair', async () => {
  // (13 - 12) / 2 rounds down to 0; the run still runs one round.
  const s = await setup({ control: controlRounds(6, 1, 1) });
  const out = answered(await cli(s, 'run', ['--budget-usd', '13', '--json']), 'run --budget-usd 13 --json');
  assert.equal(out.stopped, undefined, JSON.stringify(out));
  assert.deepEqual({ direct: sessionsOf(s, 'direct'), anyray: sessionsOf(s, 'anyray') }, { direct: 1, anyray: 1 });
});

test('--budget-usd on noise and run is a positive number; anything else is usage, exit 2, before any session', async () => {
  const s = await setup({ control: controlRounds(6, 1, 1) });
  for (const command of ['noise', 'run']) {
    for (const bad of ['0', '-5', 'abc', 'NaN', 'Infinity']) {
      const child = await cli(s, command, ['--rounds', command === 'noise' ? '6' : '1', '--budget-usd', bad, '--json']);
      const out = json(child, `${command} --budget-usd ${bad}`);
      assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command, code: 'usage' }, `${command} --budget-usd ${bad}`);
      assert.equal(child.status, 2, `${command} --budget-usd ${bad}`);
    }
  }
  assert.deepEqual(s.claude.sessions(), [], 'no session ran on a bad budget');
  // The control: a positive budget is accepted by the same command line.
  const ok = await cli(s, 'run', ['--rounds', '1', '--budget-usd', '100', '--json']);
  answered(ok, 'run --rounds 1 --budget-usd 100 --json');
  assert.equal(sessionsOf(s, 'anyray'), 1);
});

// ---- progress ------------------------------------------------------------------------------------

test('run prints one progress line per finished round on stderr: round k/N, both costs, the ratio and the spend of the budget; stdout stays one JSON value', async () => {
  const s = await setup({ costs: { direct: [1, 1.2], anyray: [0.5, 0.6] }, control: controlRounds(6, 0.5, 0.5), marked: true });
  const child = await cli(s, 'run', ['--rounds', '3', '--budget-usd', '50', '--json']);
  answered(child, 'run --rounds 3 --budget-usd 50 --json');
  const record = readRecord(s.dir, s.lock.planHash, ID, 'anyray');
  const lines = assertProgress(child.stderr, record, { ran: 3, planned: 3, spentBefore: 6, budget: 50, what: 'run progress' });
  for (const p of lines) assert.ok(/direct/i.test(p.line) && /anyray/i.test(p.line), `the line names both arms: ${p.line}`);
});

test('progress lines never carry task text, follow-ups, pastes, the patch or its file name, the repo, answers, tool I/O, paths or keys', async () => {
  const s = await setup({ costs: { direct: [1, 1.2], anyray: [0.5, 0.6] }, control: controlRounds(6, 0.5, 0.5), marked: true });
  const child = await cli(s, 'run', ['--rounds', '2', '--budget-usd', '50', '--json']);
  answered(child, 'run --rounds 2 --budget-usd 50 --json (marked scenario)');
  const lines = progressLines(child.stderr);
  assert.equal(lines.length, 2, `the progress lines this check reads were printed: ${JSON.stringify(child.stderr.slice(-1200))}`);
  assert.deepEqual(leaks(child.stderr), [], 'stderr carries client content');
  for (const { line } of lines) {
    assert.ok(!line.includes(s.root), `no path: ${line}`);
    assert.ok(!/\.(?:ya?ml|json|patch|txt|log|js)\b/.test(line), `no file name: ${line}`);
    assert.ok(!line.includes(BENCH_KEY), 'no key');
  }
  assert.ok(!child.stdout.includes(BENCH_KEY) && !child.stderr.includes(BENCH_KEY), 'the kit\'s key is never printed');
});

// A failed round no longer ends a kit run (ANY-1515). Each failed round carries a content-free
// `failure` enum (timeout, no_result, crash, gateway_error for a gateway 5xx or the proxy's own
// 502, auth_error for 401/403), is recorded and excluded from the verdict as before, and the run
// CONTINUES to the rounds it was asked for. It stops with run_failed { reason: <failure>,
// consecutive } after two failed rounds in a row, or at once on auth_error.
//
// Driven through the CLI of a kit copy, with a stand-in Claude Code told to hang or to end
// without a result on chosen sessions, a fake gateway that answers chosen inference requests with
// an error status, and a local git repo: no network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { json } from './kitPlanFixtures.mjs';
import {
  BENCH_KEY, fakeClaude, fakeRunGateway, freezeWith, kitIn, kitRunCopy, once, originRepo, poisonClaude, readRecord, runEnv, runScenario,
  sharedTemp, writeDir, writeNoise,
} from './kitRunFixtures.mjs';

const ID = 'acme-fix';
const FAILURES = ['timeout', 'no_result', 'crash', 'gateway_error', 'auth_error'];
// A six-second session cap, so a hung session times out quickly; a stand-in session answers in
// well under a second.
const TIMEOUT_MIN = 0.1;
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/** A frozen one-scenario plan with its noise measured, a fake gateway, a stand-in Claude and a poisoned PATH. */
async function setup({ behave = {}, inferenceStatus = null } = {}) {
  const root = sharedTemp('kit-fail-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { [ID]: runScenario(origin, { over: { timeoutMin: TIMEOUT_MIN } }) });
  const gateway = await fakeRunGateway({ inferenceStatus });
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1], anyray: [0.5] }, behave, marked: false });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const lock = await freezeWith(copy.root, dir, gateway.url, env);
  writeNoise(dir);
  return { root, copy, dir, gateway, poison, claude, env, lock };
}

const run = (s, args) => kitIn(s.copy.root, ['run', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, ...args], { env: s.env });
const pairs = (s) => ({ direct: s.claude.sessions().filter((x) => x.kind === 'direct').length, anyray: s.claude.sessions().filter((x) => x.kind === 'anyray').length });
const failureOf = (record) => Object.fromEntries(record.rounds.map((r) => [r.round, r.failure ?? null]));

// Seven rounds; three of them fail, never two in a row: round 2's direct session hangs past the
// session cap (timeout), round 4's Anyray session ends without a result (no_result), and the
// gateway answers round 6's Anyray session with a 503 (gateway_error). Run once, read below.
const isolated = once(async () => {
  const s = await setup({ behave: { direct: { 1: 'hang' }, anyray: { 3: 'noresult' } }, inferenceStatus: { 5: 503 } });
  const child = await run(s, ['--rounds', '7', '--json']);
  return { ...s, child };
});

test('isolated failed rounds do not end the run: it continues to the rounds asked for, ok and exit 0', async () => {
  const s = await isolated();
  const out = json(s.child, 'run --rounds 7 --json (three isolated failures)');
  assert.equal(out.ok, true, `a failed round ended the run: ${s.child.stdout.slice(0, 400)} ${s.child.stderr.slice(-600)}`);
  assert.equal(s.child.status, 0);
  assert.equal(out.stopped, undefined, 'not stopped: every round asked for ran');
  assert.deepEqual(pairs(s), { direct: 7, anyray: 7 }, 'seven rounds started, the failed ones included');
  assert.equal(s.poison.calls(), 0);
});

test('each failed round is recorded with its content-free failure: timeout, no_result, gateway_error; the rounds between keep their ratio', async () => {
  const s = await isolated();
  assert.equal(json(s.child, 'run --json').ok, true, 'the run must finish before its record can be read');
  const record = readRecord(s.dir, s.lock.planHash, ID, 'anyray');
  assert.deepEqual(record.rounds.map((r) => r.round), [1, 2, 3, 4, 5, 6, 7], 'every round is recorded, in order');
  assert.deepEqual(failureOf(record), { 1: null, 2: 'timeout', 3: null, 4: 'no_result', 5: null, 6: 'gateway_error', 7: null });
  for (const r of record.rounds) {
    if (r.failure) assert.ok(FAILURES.includes(r.failure), `round ${r.round}: ${r.failure} is one of the enum`);
    else assert.ok(Number.isFinite(r.ratio) && r.ratio > 0, `round ${r.round}: a good round keeps its ratio`);
  }
});

test('a failed round is excluded from the verdict as a failed round, and the good rounds are scored', async () => {
  const s = await isolated();
  assert.equal(json(s.child, 'run --json').ok, true, 'the run must finish before its verdict can be read');
  const v = await kitIn(s.copy.root, ['verdict', '--scenarios-dir', s.dir, '--json'], { env: s.env });
  const verdict = json(v, 'verdict --json');
  assert.equal(verdict.ok, true, JSON.stringify(verdict).slice(0, 400));
  const scenario = verdict.scenarios.find((x) => x.id === ID);
  assert.deepEqual(scenario.excluded.map((e) => e.round), [2, 4, 6], 'the three failed rounds, and only those');
  for (const e of scenario.excluded) assert.ok(e.reasons.includes('failed round'), `round ${e.round}: ${JSON.stringify(e.reasons)}`);
  assert.equal(scenario.n, 4, 'rounds 1, 3, 5 and 7 are scored');
});

test('two failed rounds in a row stop the run: run_failed with the failure and consecutive 2, exit 1, and no further round starts', async () => {
  const s = await setup({ behave: { direct: { 1: 'noresult', 2: 'noresult' } } });
  const child = await run(s, ['--rounds', '5', '--json']);
  const out = json(child, 'run --rounds 5 --json (rounds 2 and 3 fail)');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code, reason: out.reason, consecutive: out.consecutive },
    { ok: false, command: 'run', code: 'run_failed', reason: 'no_result', consecutive: 2 }, JSON.stringify(out));
  assert.equal(child.status, 1);
  assert.deepEqual(pairs(s), { direct: 3, anyray: 3 }, 'round 1 and the two failed rounds; round 4 never started');
  const record = readRecord(s.dir, s.lock.planHash, ID, 'anyray');
  assert.deepEqual(failureOf(record), { 1: null, 2: 'no_result', 3: 'no_result' }, 'both failed rounds are recorded with their failure');
});

test('an auth failure stops the run at once: the gateway refusing the kit\'s key (401 or 403) is run_failed auth_error after one round, and no key is printed', async () => {
  for (const status of [401, 403]) {
    const s = await setup({ inferenceStatus: status });
    const child = await run(s, ['--rounds', '3', '--json']);
    const out = json(child, `run --rounds 3 --json (gateway answers ${status})`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code, reason: out.reason, consecutive: out.consecutive },
      { ok: false, command: 'run', code: 'run_failed', reason: 'auth_error', consecutive: 1 }, `${status}: ${JSON.stringify(out)}`);
    assert.equal(child.status, 1, `${status}`);
    assert.deepEqual(pairs(s), { direct: 1, anyray: 1 }, `${status}: one round, then nothing more`);
    assert.ok(s.gateway.inference().length > 0, `${status}: the Anyray arm did reach the gateway`);
    const record = readRecord(s.dir, s.lock.planHash, ID, 'anyray');
    assert.deepEqual(failureOf(record), { 1: 'auth_error' }, `${status}: the round is recorded as an auth failure`);
    assert.ok(!child.stdout.includes(BENCH_KEY) && !child.stderr.includes(BENCH_KEY), `${status}: the kit's key is never printed`);
  }
});

// `npm run run` (ANY-1487): the paired rounds of a frozen plan, direct vs Anyray, on the tenant's
// own defaults. The Anyray arm names no kinds (the kinds the gateway reports are recorded as
// kindsObserved); a pair whose Anyray session the gateway drew into a holdout is drawn again,
// each draw recorded, and a pair still drawn after the last redraw is excluded with that reason;
// one pinned Claude Code binary runs both arms; every Anyray request carries the kit's tag
// (x-anyray-metadata tool anyray-bench) on the kit's own key; and the run records keep ids,
// hashes, counts and costs, never the client's task, patch, pastes, repo URL or transcripts.
//
// Driven through the CLI of a kit copy, with a stand-in Claude Code that sends the Anyray arm's
// requests to a fake gateway on 127.0.0.1, and a local git repo: no network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINS } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import {
  BENCH_KEY, GATEWAY_VERSION, HELD_KIND, OBSERVED_KINDS, fakeClaude, fakeRunGateway, filesUnder, freezeWith, kitIn, kitRunCopy,
  leaks, once, originRepo, poisonClaude, readRecord, runEnv, runScenario, sharedTemp, writeDir, writeNoise,
} from './kitRunFixtures.mjs';

const SHARED_CLIENT_KEY = 'ark_synthetic-123456'; // kitEnv's ANYRAY_CLIENT_KEY: never the kit's key
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/** A frozen one-scenario plan with a fake gateway, a stand-in Claude and a poisoned PATH. */
async function setup({ holdout = 'none', marked = false, noise = true } = {}) {
  const root = sharedTemp('kit-run-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'acme-fix': runScenario(origin, { marked }) });
  const gateway = await fakeRunGateway({ holdout });
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1, 1.2], anyray: [0.5, 0.6] }, marked });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const lock = await freezeWith(copy.root, dir, gateway.url, env);
  if (noise) writeNoise(dir);
  return { root, copy, dir, gateway, poison, claude, env, lock };
}

const run = (s, args, env = s.env) => kitIn(s.copy.root, ['run', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, ...args], { env });

// Two paired rounds of a scenario carrying a marker in every content field; the gateway draws the
// first Anyray session it sees into a holdout. Run once, read by the leaf tests below.
const markedRun = once(async () => {
  const s = await setup({ holdout: 'first', marked: true });
  const child = await run(s, ['--rounds', '2', '--redraw-holdout', '2', '--json']);
  return { ...s, child };
});

/** The run's answer, asserting it succeeded (a clear failure otherwise). */
function ranOk(s) {
  const out = json(s.child, 'run --json');
  assert.equal(out.ok, true, `run refused or failed: ${s.child.stdout.slice(0, 400)} ${s.child.stderr.slice(-800)}`);
  assert.equal(s.child.status, 0);
  return out;
}

const countedRounds = (record) => record.rounds.filter((r) => Number.isFinite(r.ratio));

test('run measures the tenant\'s own defaults: no kinds header on any request, and the kinds the gateway reported are recorded as kindsObserved', async () => {
  const s = await markedRun();
  const out = ranOk(s);
  assert.equal(out.command, 'run');
  assert.equal(out.planHash, s.lock.planHash);
  const inference = s.gateway.inference();
  assert.ok(inference.length > 0, 'the Anyray arm reached the gateway');
  assert.deepEqual(inference.filter((r) => r.kindsHeader !== null), [], 'no request named its kinds (x-anyray-optimization-kinds)');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.deepEqual(record.kindsObserved, OBSERVED_KINDS, 'what the gateway reported running (applied, skipped or preserved), sorted');
  const counted = countedRounds(record);
  assert.equal(counted.length, 2);
  for (const r of counted) assert.deepEqual(r.kindsObserved, OBSERVED_KINDS, `round ${r.round}`);
});

test('every Anyray request carries the kit\'s tag: exactly one x-anyray-metadata with tool anyray-bench and a session id per attempt, on the kit\'s own key', async () => {
  const s = await markedRun();
  ranOk(s);
  const inference = s.gateway.inference();
  for (const r of inference) {
    assert.ok(r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata), `one x-anyray-metadata JSON object per request (a second header would be joined and fail to parse): ${r.metadataRaw}`);
    assert.equal(r.metadata?.tool, 'anyray-bench', 'the kit\'s tag wins over anything the client declares');
    assert.equal(typeof r.metadata?.sessionId, 'string');
    assert.equal(r.apiKey, BENCH_KEY, 'the Anyray arm runs on ANYRAY_BENCH_CLIENT_KEY');
  }
  assert.ok(!s.gateway.requests.some((r) => r.apiKey === SHARED_CLIENT_KEY), 'ANYRAY_CLIENT_KEY is never the kit\'s key');
  const sessionIds = [...new Set(inference.map((r) => r.metadata?.sessionId))];
  assert.equal(sessionIds.length, 3, 'two rounds plus the one attempt drawn into a holdout, each its own session');

  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  const tagged = countedRounds(record).map((r) => r.runTag?.sessionId);
  assert.ok(tagged.every((id) => sessionIds.includes(id)), 'each counted round records the session id it sent');
  assert.ok(!tagged.includes(s.gateway.heldSessions()[0]), 'the drawn session is not a counted round\'s');
});

test('both arms of every pair run the one pinned Claude Code binary', async () => {
  const s = await markedRun();
  ranOk(s);
  const sessions = s.claude.sessions();
  assert.equal(sessions.filter((x) => x.kind === 'anyray').length, 3, 'three Anyray sessions: two rounds and the drawn attempt');
  assert.ok(sessions.filter((x) => x.kind === 'direct').length >= 2, 'the direct arm ran from the same binary');
  assert.ok(sessions.every((x) => x.bin === s.claude.realBin), 'every session was the --claude-bin build');
  assert.equal(s.poison.calls(), 0, 'the `claude` on PATH never ran');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  for (const r of countedRounds(record)) {
    for (const slot of ['a', 'b']) assert.equal(r.sessions[slot].setup?.claudeVersion, PINS.clientVersion, `round ${r.round} ${slot}: the frozen build`);
  }
  assert.equal(record.claudeVersion, PINS.clientVersion);
});

test('a pair whose Anyray session drew a holdout is drawn again, and the draw is recorded on the round', async () => {
  const s = await markedRun();
  ranOk(s);
  assert.equal(s.gateway.heldSessions().length, 1, 'the gateway drew exactly one session into a holdout');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.deepEqual(record.rounds.map((r) => r.round), [1, 2]);
  const [first, second] = record.rounds;
  assert.deepEqual(first.redraws, [{ b: [HELD_KIND] }], 'round 1: the thrown-away draw, the arm and the kind held out');
  assert.ok(Number.isFinite(first.ratio) && Number.isFinite(second.ratio), 'both rounds were paired in the end');
  assert.ok(!first.holdoutDrawn && !second.holdoutDrawn);
  assert.ok(!second.redraws?.length, 'round 2 was not drawn');
});

test('run records keep ids, hashes, counts and costs, never task text, patch, pastes, repo URL or transcripts', async () => {
  const s = await markedRun();
  const out = ranOk(s);
  const files = filesUnder(join(s.dir, '.kit-results'));
  assert.ok(files.some((f) => f.endsWith('acme-fix--anyray.json')), 'the record is kept under <scenarios-dir>/.kit-results/<planHash>/');
  for (const f of files) assert.deepEqual(leaks(readFileSync(f, 'utf8')), [], `${f} carries client content`);
  assert.deepEqual(leaks(JSON.stringify(out)), [], 'run --json carries client content');
  assert.ok(!existsSync(join(s.copy.root, 'results')), 'nothing is written under the kit\'s own results/');

  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.equal(record.planHash, s.lock.planHash);
  assert.deepEqual(record.scenario, s.lock.scenarios.find((x) => x.id === 'acme-fix'), 'the scenario is its id, source and frozen hash, nothing else');
  assert.equal(record.compare, 'anyray');
  assert.equal(record.gatewayVersion, GATEWAY_VERSION, 'read from GET /admin/v1/settings/updates');
  for (const r of countedRounds(record)) {
    assert.ok(r.sessions.a.totals.costUsd > 0 && r.sessions.b.totals.costUsd > 0, `round ${r.round}: both costs stay`);
    assert.equal(r.ratio, r.sessions.b.totals.costUsd / r.sessions.a.totals.costUsd, `round ${r.round}: the ratio is B / A`);
    assert.equal(typeof r.sessions.b.totals.requests, 'number', `round ${r.round}: counts stay`);
    assert.deepEqual(r.quality, { a: true, b: true }, `round ${r.round}: the check outcome stays`);
  }
});

test('a pair still drawn after the last allowed redraw is recorded with its draws and excluded from the verdict as "holdout drawn"', async () => {
  const s = await setup({ holdout: 'all' });
  const child = await run(s, ['--rounds', '1', '--redraw-holdout', '1', '--json']);
  const out = json(child, 'run --json (every session drawn)');
  assert.equal(out.ok, true, `a drawn round is not a failed run: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-600)}`);
  assert.equal(child.status, 0);
  assert.equal(s.gateway.heldSessions().length, 2, 'the first attempt and its one redraw were both drawn');

  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.equal(record.rounds.length, 1);
  const [round] = record.rounds;
  assert.equal(round.round, 1);
  assert.deepEqual(round.holdoutDrawn, { b: [HELD_KIND] }, 'the last draw, recorded');
  assert.deepEqual(round.redraws, [{ b: [HELD_KIND] }], 'the draw thrown away before it');
  assert.ok(!Number.isFinite(round.ratio), 'a drawn pair has no ratio');

  const v = await kitIn(s.copy.root, ['verdict', '--scenarios-dir', s.dir, '--json'], { env: s.env });
  const verdict = json(v, 'verdict --json');
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const scenario = verdict.scenarios?.find((x) => x.id === 'acme-fix');
  assert.deepEqual(scenario?.excluded, [{ round: 1, reasons: ['holdout drawn'] }], 'excluded with that reason, and only that one');
  assert.equal(scenario?.n, 0, 'never scored');
});

test('run refuses a plan whose noise floor was not measured (plan_noise_missing) before invoking Claude or the gateway', async () => {
  const s = await setup({ noise: false });
  const child = await run(s, ['--rounds', '1', '--json']);
  const out = json(child, 'run --json without noise');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'run', code: 'plan_noise_missing' });
  assert.equal(child.status, 3);
  assert.deepEqual(s.claude.versions(), [], 'not even --version');
  assert.deepEqual(s.claude.sessions(), []);
  assert.deepEqual(s.gateway.requests, []);
});

test('run refuses without the kit\'s own key or an admin key, before any session or gateway request', async () => {
  const s = await setup();
  for (const [unset, code] of [['ANYRAY_BENCH_CLIENT_KEY', 'bench_key_missing'], ['ANYRAY_ADMIN_KEY', 'admin_key_missing']]) {
    const env = { ...s.env };
    delete env[unset];
    const child = await run(s, ['--rounds', '1', '--json'], env);
    const out = json(child, `run --json without ${unset}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'run', code }, `without ${unset}`);
    assert.equal(child.status, 2, `without ${unset}`);
    assert.ok(!child.stdout.includes(SHARED_CLIENT_KEY) && !child.stderr.includes(SHARED_CLIENT_KEY), 'no key is printed');
  }
  assert.deepEqual(s.claude.sessions(), [], 'no session ran');
  assert.deepEqual(s.gateway.requests, [], 'no gateway request was made');
});

test('run refuses the bench header knobs, which would change what the frozen plan measures (env_refused)', async () => {
  const s = await setup();
  for (const variable of ['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS']) {
    const child = await run(s, ['--rounds', '1', '--json'], { ...s.env, [variable]: 'x-anyray-tool-defer: off' });
    const out = json(child, `run --json with ${variable}`);
    assert.deepEqual({ ok: out.ok, code: out.code, variable: out.variable }, { ok: false, code: 'env_refused', variable }, variable);
    assert.equal(child.status, 2, variable);
  }
  assert.deepEqual(s.claude.sessions(), [], 'no session ran');
  assert.deepEqual(s.gateway.requests, [], 'no gateway request was made');
});

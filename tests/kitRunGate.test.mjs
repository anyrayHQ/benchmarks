// run_agent.mjs --scenarios-dir (ANY-1485): a client's scenarios run only as the plan they
// froze. The gate runs before anything else, so a refused run never invokes the Claude
// binary at all (a stand-in `claude` records every call). No network, no real session:
// the one run that passes the gate stops at its scenario's repo, a local path that does
// not exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  HEX64, PINS, REF, changeOneByte, fakeClaude, fixScenario, freezeOk, kitEnv, npmRun, onlyJson, runAgent, tempDir,
  twoScenarios, writeScenariosDir,
} from './kitFixtures.mjs';

/** The kit's run, the cheapest shape: direct vs direct, one round, a pinned stand-in Claude. */
const runArgs = (dir, claude, ...more) => ['--scenarios-dir', dir, '--scenario', 'acme-fix', '--compare', 'control', '--claude-bin', claude.bin, ...more];

test('no plan.lock.json: the run refuses with plan_lock_missing and never invokes Claude', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const claude = fakeClaude(t);
  const child = runAgent(t, [...runArgs(dir, claude), '--json']);
  const out = onlyJson(child, 'run_agent --json without a lock');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'run', code: 'plan_lock_missing' });
  assert.equal(child.status, 3);
  assert.deepEqual(claude.invocations(), [], 'Claude was invoked before the plan was checked');
});

for (const [what, file, from, to] of [
  ['the task text', 'scenario.yaml', 'tokenizer test', 'tokenizer tesu'],
  ['the patch', 'bug.patch', "split(' ')", "split('_')"],
  ['the check command', 'scenario.yaml', 'lexer.test.js', 'lexer.tesu.js'],
]) {
  test(`one byte changed in ${what} makes the run refuse with plan_hash_mismatch before any Claude invocation`, (t) => {
    const dir = writeScenariosDir(tempDir(t), twoScenarios());
    const { lock } = freezeOk(t, dir);
    changeOneByte(join(dir, 'acme-fix', file), from, to);
    const claude = fakeClaude(t);
    const child = runAgent(t, [...runArgs(dir, claude), '--json']);
    const out = onlyJson(child, `run_agent --json after ${what} changed`);
    assert.equal(out.code, 'plan_hash_mismatch');
    assert.equal(out.expected, lock.planHash);
    assert.match(out.found ?? '', HEX64);
    assert.notEqual(out.found, out.expected);
    assert.deepEqual(out.changed, ['acme-fix']);
    assert.equal(child.status, 3);
    assert.deepEqual(claude.invocations(), [], 'Claude was invoked (even --version) before the refusal');
  });
}

test('without --json the refusal still exits non-zero and names the expected and the found hash', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const { lock } = freezeOk(t, dir);
  changeOneByte(join(dir, 'acme-fix', 'bug.patch'), "split(' ')", "split('_')");
  const claude = fakeClaude(t);
  const child = runAgent(t, runArgs(dir, claude));
  assert.equal(child.status, 3, `exit ${child.status}: ${child.stderr}`);
  assert.ok(child.stderr.includes(lock.planHash), 'stderr names the frozen (expected) hash');
  const others = (child.stderr.match(/[0-9a-f]{64}/g) ?? []).filter((h) => h !== lock.planHash);
  assert.ok(others.length > 0, 'stderr names the hash the dir has now (found)');
  assert.match(child.stderr, /plan_hash_mismatch/);
  assert.deepEqual(claude.invocations(), []);
});

test('a scenario the frozen plan does not list is refused (plan_scenario_not_frozen)', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  freezeOk(t, dir);
  const claude = fakeClaude(t);
  const args = runArgs(dir, claude, '--json');
  args[args.indexOf('acme-fix')] = 'acme-unknown';
  const child = runAgent(t, args);
  const out = onlyJson(child, 'run_agent --json for an unlisted scenario');
  assert.deepEqual({ code: out.code, scenario: out.scenario }, { code: 'plan_scenario_not_frozen', scenario: 'acme-unknown' });
  assert.equal(child.status, 3);
  assert.deepEqual(claude.invocations(), []);
});

for (const [pin, found, extraArgs, extraEnv] of [
  ['model', 'claude-opus-5-5', [], { ANYRAY_LIVE_MODEL: 'claude-opus-5-5' }],
  ['provider', 'bedrock', ['--provider', 'bedrock'], {}],
  ['gatewayHost', 'other.example.test', ['--compare', 'anyray', '--kinds', 'observation_mask'], { ANYRAY_GATEWAY_URL: 'https://other.example.test' }],
]) {
  test(`a run that would change the frozen ${pin} is refused (plan_pin_mismatch) before Claude is invoked`, (t) => {
    const dir = writeScenariosDir(tempDir(t), twoScenarios());
    freezeOk(t, dir);
    const claude = fakeClaude(t);
    const args = [...runArgs(dir, claude), ...extraArgs, '--json'];
    if (extraArgs.includes('--compare')) args.splice(args.indexOf('--compare'), 2); // the case's own --compare wins
    const child = runAgent(t, args, { env: kitEnv(tempDir(t, 'kit-home-'), extraEnv) });
    const out = onlyJson(child, `run_agent --json with another ${pin}`);
    assert.deepEqual({ code: out.code, pin: out.pin, expected: out.expected, found: out.found }, { code: 'plan_pin_mismatch', pin, expected: PINS[pin], found });
    assert.equal(child.status, 3);
    assert.deepEqual(claude.invocations(), []);
  });
}

test('a Claude Code build other than the frozen one is refused after reading only its version', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  freezeOk(t, dir);
  const claude = fakeClaude(t, '2.1.299');
  const child = runAgent(t, [...runArgs(dir, claude), '--json']);
  const out = onlyJson(child, 'run_agent --json with another Claude Code build');
  assert.deepEqual({ code: out.code, pin: out.pin, expected: out.expected, found: out.found }, { code: 'plan_pin_mismatch', pin: 'clientVersion', expected: PINS.clientVersion, found: '2.1.299' });
  assert.equal(child.status, 3);
  const calls = claude.invocations();
  assert.ok(calls.length > 0, 'the version was read from the pinned binary');
  assert.deepEqual([...new Set(calls)], ['--version'], 'nothing but --version ran');
});

test('a matching plan passes the gate: the run loads the scenario from --scenarios-dir and goes on to its repo', (t) => {
  const parent = tempDir(t);
  const origin = join(parent, 'no-such-origin-zqx4417'); // never created: the clone fails here, offline
  const dir = writeScenariosDir(parent, { 'acme-fix': fixScenario({ repo: { git: origin, ref: REF } }) });
  const { lock } = freezeOk(t, dir);
  const claude = fakeClaude(t);
  const child = runAgent(t, [...runArgs(dir, claude), '--json']);

  // Past the gate: the pinned binary's version was read, and the scenario's repo was reached.
  assert.ok(claude.invocations().length > 0, `the run never got past the plan check (exit ${child.status}): ${child.stderr.slice(0, 400)}`);
  assert.deepEqual([...new Set(claude.invocations())], ['--version'], 'no session ran');
  assert.ok(child.stderr.includes('no-such-origin-zqx4417'), 'the run read acme-fix from --scenarios-dir and tried its repo');
  assert.doesNotMatch(child.stdout + child.stderr, /plan_(lock|hash|pin|scenario)_/);
  // --json: the failure is still one JSON value on stdout; the diagnostics went to stderr.
  const out = onlyJson(child, 'run_agent --json past the gate');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'run', code: 'run_failed' });
  assert.ok(!child.stdout.includes('no-such-origin-zqx4417'), 'stdout carries no diagnostics');
  assert.ok(!child.stdout.includes(lock.nonce) && !child.stderr.includes(lock.nonce), 'the nonce is never printed');
});

test('npm run -s agent: a relative --scenarios-dir resolves from where npm was run, and stdout stays JSON', (t) => {
  const parent = tempDir(t);
  writeScenariosDir(parent, twoScenarios(), 'client-tests');
  const claude = fakeClaude(t);
  const child = npmRun(t, 'agent', [...runArgs('client-tests', claude), '--json'], { cwd: parent, env: kitEnv(tempDir(t, 'kit-home-')) });
  const out = onlyJson(child, 'npm run -s agent -- --json');
  assert.equal(out.code, 'plan_lock_missing');
  assert.equal(typeof out.lockFile, 'string', 'the refusal names the lock it looked for');
  assert.equal(basename(out.lockFile), 'plan.lock.json');
  assert.equal(realpathSync(dirname(out.lockFile)), realpathSync(join(parent, 'client-tests')), 'resolved against INIT_CWD, not the kit root');
  assert.equal(child.status, 3);
  assert.deepEqual(claude.invocations(), []);
});

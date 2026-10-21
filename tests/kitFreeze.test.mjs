// The kit's plan freeze (ANY-1485): `npm run freeze` writes <scenarios-dir>/plan.lock.json,
// an HMAC-SHA256 under a random nonce over every scenario bundle plus the run pins, and
// `verify` (like every later command) refuses a dir that no longer hashes to it. Driven
// only through the CLIs, against scenario dirs built in temp directories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  HEX64, LOCK, PINS, PIN_FLAGS, REF, changeOneByte, docsScenario, fixScenario, freezeOk, kit, kitEnv, lockPath, npmRun,
  onlyJson, readLock, tempDir, twoScenarios, writeScenariosDir,
} from './kitFixtures.mjs';

const verify = (t, dir, opts) => kit(t, ['verify', '--scenarios-dir', dir, '--json'], opts);

/** A scenario with some top-level keys left out (js-yaml refuses to dump an undefined value). */
const without = (scenario, ...keys) => ({ ...scenario, doc: Object.fromEntries(Object.entries(scenario.doc).filter(([k]) => !keys.includes(k))) });

// ---- what the lock holds ----------------------------------------------------------------

test('freeze writes plan.lock.json with the plan hash and scenario ids, and none of the task, patch, paste, check, followups, title or repo URL', (t) => {
  const marker = (what) => `zqx-${what}-marker-7741`;
  const fix = fixScenario({
    title: `Tokenizer fix ${marker('title')}`,
    repo: { git: `https://git.example.test/acme/${marker('repo')}.git`, ref: REF },
    task: `CI is red:\n\n{{ciLog}}\n\nFix ${marker('task')} in the tokenizer.`,
    followups: [`Then ${marker('followup')}.`],
    check: `node --test check/${marker('check')}.test.js`,
  });
  fix.files = { 'bug.patch': `${fix.files['bug.patch']}+// ${marker('patch')}\n`, 'ci-log.txt': `not ok 1 - ${marker('paste')}\n` };
  const dir = writeScenariosDir(tempDir(t), { 'acme-fix': fix, 'acme-docs': docsScenario() });
  const gateway = `https://${PINS.gatewayHost}:8443/${marker('gwpath')}?ref=${marker('gwquery')}`;
  const flags = PIN_FLAGS.map((f, i) => (PIN_FLAGS[i - 1] === '--gateway' ? gateway : f));
  const child = kit(t, ['freeze', '--scenarios-dir', dir, ...flags, '--json']);

  // Freeze ran: a lock with a keyed hash and the scenario ids.
  assert.equal(child.status, 0, `freeze failed: ${child.stderr}`);
  const text = readFileSync(lockPath(dir), 'utf8');
  const lock = JSON.parse(text);
  assert.match(lock.planHash, HEX64);
  assert.match(lock.nonce, HEX64, 'a 32-byte random nonce, hex');
  assert.deepEqual(lock.scenarios.map((s) => s.id), ['acme-docs', 'acme-fix']);
  for (const s of lock.scenarios) assert.match(s.hash, HEX64, s.id);
  assert.deepEqual(lock.pins, { ...PINS, gatewayHost: `${PINS.gatewayHost}:8443` }, 'the gateway is pinned by host only');

  // ...and nothing it hashed.
  for (const what of ['title', 'repo', 'task', 'followup', 'check', 'patch', 'paste', 'gwpath', 'gwquery']) {
    assert.ok(!text.includes(marker(what)), `the lock carries the ${what}`);
    assert.ok(!child.stdout.includes(marker(what)), `freeze --json prints the ${what}`);
  }
  // An allowlist, so a new field is a deliberate change: no room for content or per-file digests.
  assert.deepEqual(Object.keys(lock).sort(), ['algorithm', 'frozenAt', 'nonce', 'pins', 'planHash', 'scenarios', 'version']);
  assert.equal(lock.version, 1);
  assert.equal(lock.algorithm, 'hmac-sha256');
  assert.deepEqual(Object.keys(lock.pins).sort(), ['client', 'clientVersion', 'gatewayHost', 'model', 'provider']);
  for (const s of lock.scenarios) assert.deepEqual(Object.keys(s).sort(), ['hash', 'id', 'source'], s.id);
});

test('source: client and proposed survive into the lock and the freeze answer unchanged', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const { out, lock } = freezeOk(t, dir);
  const sourceOf = (list) => Object.fromEntries(list.map((s) => [s.id, s.source]));
  assert.deepEqual(sourceOf(lock.scenarios), { 'acme-fix': 'client', 'acme-docs': 'proposed' });
  assert.deepEqual(sourceOf(out.scenarios), { 'acme-fix': 'client', 'acme-docs': 'proposed' });
});

for (const [label, source] of [['an unknown source value', 'customer'], ['a source in the wrong case', 'Client'], ['a missing source (never defaulted to client or proposed)', undefined]]) {
  test(`freeze refuses ${label}, naming the scenario and the field, and writes no lock`, (t) => {
    const fix = source === undefined ? without(fixScenario(), 'source') : fixScenario({ source });
    const dir = writeScenariosDir(tempDir(t), { 'acme-fix': fix, 'acme-docs': docsScenario() });
    const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
    const out = onlyJson(child, 'freeze --json');
    assert.equal(out.ok, false);
    assert.equal(out.code, 'scenario_invalid');
    assert.equal(out.scenario, 'acme-fix');
    assert.equal(out.field, 'source');
    assert.equal(child.status, 4);
    assert.ok(!existsSync(lockPath(dir)), 'a refused freeze leaves no lock');
  });
}

test('freeze refuses a dir it cannot freeze with a machine code, and writes no lock', (t) => {
  const cases = [
    ['ref is not a 40-hex commit', { 'acme-fix': fixScenario({ repo: { git: 'https://git.example.test/acme/app.git', ref: 'main' } }) }, 'scenario_invalid', 'repo'],
    ['no task', { 'acme-fix': without(fixScenario(), 'task', 'pastes') }, 'scenario_invalid', 'task'],
    ['two grading modes', { 'acme-fix': fixScenario({ keyFacts: ['split'] }) }, 'scenario_invalid', 'grading'],
    ['a patch file that is not there', { 'acme-fix': { ...fixScenario(), files: { 'ci-log.txt': 'x\n' } } }, 'scenario_invalid', 'patch'],
    ['no scenario at all', {}, 'scenarios_empty', undefined],
  ];
  for (const [label, scenarios, code, field] of cases) {
    const dir = writeScenariosDir(tempDir(t), scenarios);
    const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
    const out = onlyJson(child, `freeze --json (${label})`);
    assert.equal(out.code, code, label);
    if (field) assert.equal(out.field, field, label);
    assert.equal(child.status, 4, label);
    assert.ok(!existsSync(lockPath(dir)), `${label}: no lock`);
  }
  const missing = kit(t, ['freeze', '--scenarios-dir', join(tempDir(t), 'nope'), ...PIN_FLAGS, '--json']);
  assert.equal(onlyJson(missing, 'freeze --json (missing dir)').code, 'scenarios_dir_not_found');
  assert.equal(missing.status, 4);
});

// ---- --json -------------------------------------------------------------------------------

test('freeze --json and verify --json: stdout is one JSON value with the planHash, and the nonce is never printed', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const { out, lock, child } = freezeOk(t, dir);
  assert.equal(out.command, 'freeze');
  assert.equal(out.planHash, lock.planHash);
  assert.deepEqual(out.pins, PINS);
  assert.ok(!child.stdout.includes(lock.nonce) && !child.stderr.includes(lock.nonce), 'freeze printed the nonce');

  const v = verify(t, dir);
  const vOut = onlyJson(v, 'verify --json');
  assert.equal(v.status, 0, v.stderr);
  assert.deepEqual({ ok: vOut.ok, command: vOut.command, planHash: vOut.planHash }, { ok: true, command: 'verify', planHash: lock.planHash });
  assert.ok(!v.stdout.includes(lock.nonce) && !v.stderr.includes(lock.nonce), 'verify printed the nonce');
});

test('a usage error under --json is still one JSON value on stdout, exit 2', (t) => {
  for (const args of [['freeze', ...PIN_FLAGS, '--json'], ['verify', '--json'], ['freeze', '--scenarios-dir', '/x', '--no-such-flag', '--json']]) {
    const child = kit(t, args);
    const out = onlyJson(child, args.join(' '));
    assert.equal(out.ok, false, args.join(' '));
    assert.equal(out.code, 'usage', args.join(' '));
    assert.equal(child.status, 2, args.join(' '));
  }
});

test('npm run -s freeze / verify: JSON only on stdout, and a relative --scenarios-dir resolves from where npm was run', (t) => {
  const parent = tempDir(t);
  writeScenariosDir(parent, twoScenarios(), 'client-tests');
  const env = kitEnv(tempDir(t, 'kit-home-'));
  const f = npmRun(t, 'freeze', ['--scenarios-dir', 'client-tests', ...PIN_FLAGS, '--json'], { cwd: parent, env });
  const fOut = onlyJson(f, 'npm run -s freeze -- --json');
  assert.equal(f.status, 0, f.stderr);
  assert.ok(existsSync(join(parent, 'client-tests', LOCK)), 'the lock lands in <INIT_CWD>/client-tests, not the kit root');
  assert.equal(fOut.planHash, readLock(join(parent, 'client-tests')).planHash);
  const v = npmRun(t, 'verify', ['--scenarios-dir', 'client-tests', '--json'], { cwd: parent, env });
  assert.equal(onlyJson(v, 'npm run -s verify -- --json').planHash, fOut.planHash);
  assert.equal(v.status, 0, v.stderr);
});

// ---- determinism and the nonce --------------------------------------------------------------

/** The same object with every map's keys in reverse order (arrays keep theirs: order there is meaning). */
const reversedKeys = (v) => (Array.isArray(v) ? v.map(reversedKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)])) : v);

test('a frozen plan verifies after the dir moves and its YAML keys are reordered, restyled and commented (same nonce, same planHash)', (t) => {
  const scenarios = twoScenarios();
  const a = writeScenariosDir(tempDir(t), scenarios);
  const { lock } = freezeOk(t, a);
  const reordered = Object.fromEntries(Object.entries(scenarios).map(([id, s]) => [id, {
    ...s,
    yamlText: `# frozen for the pilot; comments are not content\n${yaml.dump(reversedKeys(s.doc), { flowLevel: 1 })}\n# end\n`,
  }]));
  const b = writeScenariosDir(tempDir(t), reordered, 'elsewhere');
  assert.notEqual(readFileSync(join(a, 'acme-fix', 'scenario.yaml'), 'utf8'), readFileSync(join(b, 'acme-fix', 'scenario.yaml'), 'utf8'));
  cpSync(lockPath(a), lockPath(b));
  const v = verify(t, b);
  const out = onlyJson(v, 'verify --json');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.planHash, lock.planHash);
  assert.equal(v.status, 0);
});

test('a dotfile such as .DS_Store in a scenario dir does not break the plan', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const { lock } = freezeOk(t, dir);
  writeFileSync(join(dir, 'acme-fix', '.DS_Store'), 'finder state');
  const v = verify(t, dir);
  assert.equal(onlyJson(v, 'verify --json').planHash, lock.planHash);
  assert.equal(v.status, 0, v.stderr);
});

test('freezing again is a new plan: refused over an existing lock; with --replace a fresh nonce gives a new planHash', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const { lock: first } = freezeOk(t, dir);
  const before = readFileSync(lockPath(dir), 'utf8');

  const again = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, '--json']);
  const refused = onlyJson(again, 'freeze --json over a lock');
  assert.deepEqual({ ok: refused.ok, code: refused.code, planHash: refused.planHash }, { ok: false, code: 'plan_lock_exists', planHash: first.planHash });
  assert.equal(again.status, 3);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), before, 'the existing lock is untouched');

  const { out, lock: second } = freezeOk(t, dir, ['--replace']);
  assert.equal(out.replaces, first.planHash);
  assert.notEqual(second.nonce, first.nonce, 'every freeze draws its own nonce');
  assert.notEqual(second.planHash, first.planHash, 'same scenarios under another nonce hash differently');
  assert.equal(onlyJson(verify(t, dir), 'verify --json').planHash, second.planHash);
});

// ---- verify refuses -------------------------------------------------------------------------

test('verify refuses a one-byte change in any scenario file with plan_hash_mismatch, naming expected, found and the changed scenario', (t) => {
  const cases = [
    ['task text', 'scenario.yaml', 'tokenizer test', 'tokenizer tesu'],
    ['check command', 'scenario.yaml', 'lexer.test.js', 'lexer.tesu.js'],
    ['follow-up', 'scenario.yaml', 'you changed', 'you changes'],
    ['turn cap', 'scenario.yaml', 'maxTurns: 80', 'maxTurns: 81'],
    ['patch bytes', 'bug.patch', "split(' ')", "split('_')"],
    ['paste bytes', 'ci-log.txt', 'splits words', 'splits wordz'],
  ];
  for (const [what, file, from, to] of cases) {
    const dir = writeScenariosDir(tempDir(t), twoScenarios());
    const { lock } = freezeOk(t, dir);
    changeOneByte(join(dir, 'acme-fix', file), from, to);
    const child = verify(t, dir);
    const out = onlyJson(child, `verify --json after a ${what} change`);
    assert.equal(out.code, 'plan_hash_mismatch', what);
    assert.equal(out.expected, lock.planHash, what);
    assert.match(out.found ?? '', HEX64, what);
    assert.notEqual(out.found, out.expected, what);
    assert.deepEqual(out.changed, ['acme-fix'], `${what}: only the scenario that changed is named`);
    assert.equal(child.status, 3, what);
  }
});

test('verify names a scenario added or removed after the freeze, and a new file inside one as a change', (t) => {
  const added = writeScenariosDir(tempDir(t), twoScenarios());
  freezeOk(t, added);
  writeScenariosDir(added, { 'acme-new': fixScenario() }, '.');
  const a = onlyJson(verify(t, added), 'verify --json (added)');
  assert.equal(a.code, 'plan_hash_mismatch');
  assert.deepEqual(a.added, ['acme-new']);

  const removed = writeScenariosDir(tempDir(t), twoScenarios());
  freezeOk(t, removed);
  rmSync(join(removed, 'acme-docs'), { recursive: true });
  const r = onlyJson(verify(t, removed), 'verify --json (removed)');
  assert.equal(r.code, 'plan_hash_mismatch');
  assert.deepEqual(r.removed, ['acme-docs']);

  const extra = writeScenariosDir(tempDir(t), twoScenarios());
  freezeOk(t, extra);
  writeFileSync(join(extra, 'acme-docs', 'NOTES.md'), 'a file the scenario does not reference is still part of it\n');
  const e = onlyJson(verify(t, extra), 'verify --json (new file)');
  assert.equal(e.code, 'plan_hash_mismatch');
  assert.deepEqual(e.changed, ['acme-docs']);
});

test('a hand-edited lock is refused as plan_lock_invalid: relabelling a source, editing a pin, the nonce or the planHash', (t) => {
  const edits = [
    ['source relabelled', (l) => { l.scenarios.find((s) => s.id === 'acme-fix').source = 'proposed'; }],
    ['model pin edited', (l) => { l.pins.model = 'claude-opus-5-5'; }],
    ['nonce edited', (l) => { l.nonce = `${l.nonce.slice(0, -1)}${l.nonce.endsWith('0') ? '1' : '0'}`; }],
    ['planHash edited', (l) => { l.planHash = `${l.planHash.slice(0, -1)}${l.planHash.endsWith('0') ? '1' : '0'}`; }],
  ];
  for (const [what, edit] of edits) {
    const dir = writeScenariosDir(tempDir(t), twoScenarios());
    const { lock } = freezeOk(t, dir);
    edit(lock);
    writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2));
    const child = verify(t, dir);
    const out = onlyJson(child, `verify --json (${what})`);
    assert.deepEqual({ code: out.code, reason: out.reason }, { code: 'plan_lock_invalid', reason: 'self_hash' }, what);
    assert.equal(child.status, 3, what);
  }
});

test('verify refuses a missing lock and an unreadable one with distinct codes', (t) => {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  const missing = verify(t, dir);
  const m = onlyJson(missing, 'verify --json (no lock)');
  assert.equal(m.code, 'plan_lock_missing');
  assert.equal(missing.status, 3);

  writeFileSync(lockPath(dir), '{ not json');
  const broken = verify(t, dir);
  const b = onlyJson(broken, 'verify --json (broken lock)');
  assert.deepEqual({ code: b.code, reason: b.reason }, { code: 'plan_lock_invalid', reason: 'unreadable' });
  assert.equal(broken.status, 3);
});

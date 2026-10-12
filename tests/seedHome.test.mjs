// --seed-home: files placed in every Anyray arm's HOME before anyray-connect configures it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { armsFor, controlArgs, parseArgs, parseSeedHome, requestRecord, slotOptions } from '../run_agent.mjs';
import { armConfig, seedArmHome } from '../lib/agentRun.mjs';

const GW = 'https://gateway.test.invalid';
const KEY = 'ark_synthetic-seed-home';
const ROUTERS = '.anyray/hook-digest-routers.json';
const LEDGER = '.anyray/hook-tee-ledger.json';
// A string only the seed file holds: no record may carry it.
const MARKER = 'synthetic-seed-contents';

const seedFile = (body = JSON.stringify({ labels: [], routers: [{ router: 'test-run', version: 2, at: 1, emits: 5, rereads: 4 }], note: MARKER })) => {
  const file = join(mkdtempSync(join(tmpdir(), 'seed-src-')), 'seed.json');
  writeFileSync(file, body);
  return file;
};
const sha16 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
const gw = (...extra) => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask', ...extra]);

/** A record leaks the seed when it names the source file, its directory, or anything in it. */
const assertNoSource = (record, file) => {
  const json = JSON.stringify(record);
  assert.ok(!json.includes(file), 'the source path never reaches a record');
  assert.ok(!json.includes(dirname(file)), 'nor its directory');
  assert.ok(!json.includes(MARKER), 'nor what the file holds');
};

test('--seed-home takes <relative path>=<absolute file> and keeps a sha256 prefix of the file', () => {
  const file = seedFile();
  assert.deepEqual(parseSeedHome(`${ROUTERS}=${file}`), { path: ROUTERS, file, sha256: sha16(file) });
});

test('--seed-home refuses a path outside the arm HOME, and a file that is not an existing absolute path', () => {
  const file = seedFile();
  for (const path of ['/etc/x.json', '../x.json', '.anyray/../../x.json', './x.json', 'a//b.json', '.', '']) {
    assert.throws(() => parseSeedHome(`${path}=${file}`), /--seed-home takes <relative path in the arm HOME>=<absolute file>/, path);
  }
  assert.throws(() => parseSeedHome(file), /--seed-home takes/, 'no "=": the whole spec is not a path');
  assert.throws(() => parseSeedHome(undefined), /--seed-home takes/);
  assert.throws(() => parseSeedHome('x.json=relative/seed.json'), /x\.json: the file must be an absolute path that exists/);
  assert.throws(() => parseSeedHome('x.json=/nonexistent/synthetic/seed.json'), /must be an absolute path that exists/);
});

test('--seed-home needs an anyray-connect arm: refused with --bare, under --compare control and for an SDK scenario', () => {
  const spec = `${ROUTERS}=${seedFile()}`;
  const refused = /--seed-home needs an anyray-connect arm/;
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway', '--bare', '--seed-home', spec]), refused);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'anyray', '--bare', '--seed-home', spec]), refused);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--seed-home', spec]), refused);
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--kinds', 'observation_mask', '--seed-home', spec]), refused);
  assert.equal(gw('--seed-home', spec).seedHome.length, 1, 'a connect-configured pair takes it');
});

test('--seed-home is repeatable; every Anyray arm gets the same seeds, a direct arm and the control none', () => {
  const [routers, ledger] = [seedFile(), seedFile('{"digestEmits":1}')];
  const a = gw('--seed-home', `${ROUTERS}=${routers}`, '--seed-home', `${LEDGER}=${ledger}`);
  assert.deepEqual(a.seedHome.map((s) => s.path), [ROUTERS, LEDGER]);
  const both = armsFor('gateway');
  assert.deepEqual(slotOptions(a, both, 'a').seedHome, a.seedHome);
  assert.deepEqual(slotOptions(a, both, 'b').seedHome, a.seedHome);

  const one = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--seed-home', `${ROUTERS}=${routers}`]);
  const arms = armsFor('anyray');
  assert.equal(arms.a, 'direct');
  assert.equal('seedHome' in slotOptions(one, arms, 'a'), false, 'the direct arm runs in the real HOME, unseeded');
  assert.deepEqual(slotOptions(one, arms, 'b').seedHome, one.seedHome);

  const control = controlArgs({ ...a, extraHeaders: [] });
  assert.equal('seedHome' in requestRecord(control), false, 'the --with-control run seeds nothing, so records nothing');
  for (const slot of ['a', 'b']) assert.equal('seedHome' in slotOptions(control, armsFor('control'), slot), false);
});

test('the run records each seed as its HOME path and a sha256 prefix, never the source path or the file', () => {
  const file = seedFile();
  const r = requestRecord(gw('--seed-home', `${ROUTERS}=${file}`));
  assert.deepEqual(r.seedHome, [{ path: ROUTERS, sha256: sha16(file) }]);
  assertNoSource(r, file);
  assert.equal('seedHome' in requestRecord(gw()), false, 'no seed: nothing recorded');
});

// ---- the arm HOME ----

const configured = { configured: true, settings: { env: { ANTHROPIC_BASE_URL: GW } }, mcpServers: {}, setup: { env: {} } };
const deps = (configureArm) => ({
  connect: () => ({ gateway: GW, clientKey: KEY }),
  clientKey: () => KEY,
  serviceKey: () => KEY,
  anyrayHooks: () => ({}),
  binExists: () => true,
  bin: '/nonexistent/anyray-connect',
  realClaudeJson: () => ({}), // never this machine's ~/.claude.json
  configureArm,
});
const cfg = () => mkdtempSync(join(tmpdir(), 'seed-cfg-'));
const anyrayArm = (seedHome, configureArm) => armConfig({ arm: 'anyray', gatewayUrl: GW, runTag: { sessionId: 's' }, cfgDir: cfg(), seedHome, deps: deps(configureArm) });

test('each Anyray arm HOME holds the seeded files before anyray-connect configures it, identically, and its setup records path and hash only', () => {
  const file = seedFile();
  const body = readFileSync(file, 'utf8');
  const seeds = [parseSeedHome(`${ROUTERS}=${file}`)];
  const seenByConnect = [];
  const configureArm = ({ home }) => {
    seenByConnect.push(readFileSync(join(home, ROUTERS), 'utf8'));
    return configured;
  };
  const arms = [anyrayArm(seeds, configureArm), anyrayArm(seeds, configureArm)];
  assert.deepEqual(seenByConnect, [body, body], 'in place when connect ran, in both arms');
  assert.notEqual(arms[0].home, arms[1].home);
  for (const a of arms) {
    assert.equal(readFileSync(join(a.home, ROUTERS), 'utf8'), body);
    assert.equal(statSync(join(a.home, ROUTERS)).mode & 0o777, 0o600);
    assert.deepEqual(a.setup.seedHome, [{ path: ROUTERS, sha256: sha16(file) }]);
    assertNoSource(a.setup, file);
  }
  assert.equal('seedHome' in anyrayArm([], () => configured).setup, false, 'no seed: nothing recorded');
});

test('--seed-home refuses an arm anyray-connect could not configure, rather than run it without the seeds', () => {
  const seeds = [parseSeedHome(`${ROUTERS}=${seedFile()}`)];
  assert.throws(() => anyrayArm(seeds, () => ({ configured: false, reason: 'synthetic: no service key' })), /--seed-home needs anyray-connect to configure the arm: synthetic: no service key/);
  assert.equal(anyrayArm([], () => ({ configured: false, reason: 'synthetic' })).setup.configuredBy, 'harness (fallback)', 'unseeded, the fallback still runs');
});

test('seedArmHome refuses a path that would land outside the arm HOME', () => {
  const file = seedFile();
  const home = join(cfg(), 'home');
  mkdirSync(home);
  for (const path of ['../escape.json', '.']) {
    assert.throws(() => seedArmHome(home, [{ path, file, sha256: sha16(file) }]), /escapes the arm HOME/, path);
  }
  assert.equal(existsSync(join(dirname(home), 'escape.json')), false);
});

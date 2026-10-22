// `npm run doctor` (ANY-1516, SPEC section K2): before a client spends anything, one command says
// whether this machine can run their test. Each check is `{ id, ok, code?, fix? }`: node 22.13+,
// git, a clean kit checkout, Claude Code resolved by its real path with its version, the connect
// binary, a test key that is present and not expired, the gateway's /connect/test/context
// reachable (with its latency), one 1-token probe through the gateway on the test key (its
// first-byte latency; gateway_slow past 10 s is a warning, not a failure), an upstream
// credential, and the refused header variables unset. Exit 0 when every required check passes,
// 2 otherwise. The key is never printed. The skill maps each failing code to its fix.
//
// Driven through `npm --prefix <kit copy> run -s doctor` as the skill runs it, with a stand-in
// Claude Code and anyray-connect, against a fake gateway on 127.0.0.1. No network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PINS, kitEnv, tempDir } from './kitFixtures.mjs';
import { json, spawnAsync } from './kitPlanFixtures.mjs';
import { fakeClaude, kitRunCopy, once, sharedTemp } from './kitRunFixtures.mjs';
import { kitScripts } from './kitReleaseFixtures.mjs';
import { TEST_KEY, closedGatewayUrl, fakeConnect, fakeTestGateway, futureIso, keyOf, pastIso, writeTestKitEnv } from './kitTestKeyFixtures.mjs';

/** Every check the spec lists, by the id this contract gives it (CONTRACT.md). */
const CHECK_IDS = ['node', 'git', 'kit_clean', 'claude', 'connect', 'test_key', 'gateway_context', 'gateway_probe', 'upstream_credential', 'header_envs'];
const SECRETS = [TEST_KEY, 'sk-synthetic-placeholder', 'ark_synthetic-123456'];
const SLOW_MS = 10_000;
const MINT_FIX = /anyray-connect test-key/;

const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/**
 * A kit copy (its own clean git checkout), a stand-in Claude Code and anyray-connect first on
 * PATH, a fake test-key gateway, and (unless `file: false`) the test-kit.env that connect writes.
 */
async function setup(root, { gateway: gatewayOpts = {}, file = true, gatewayUrl, expiresAt = futureIso(), mode = 0o600, env: extra = {} } = {}) {
  const copy = kitRunCopy(join(root, 'kit'));
  const home = join(root, 'home');
  const claude = fakeClaude(join(root, 'claude-bin'), { marked: false });
  const connectDir = fakeConnect(join(root, 'connect-bin'), home);
  const gateway = await fakeTestGateway(gatewayOpts);
  gateways.push(gateway);
  if (file) writeTestKitEnv(home, { gateway: gatewayUrl ?? gateway.url, expiresAt, mode });
  const env = kitEnv(home, { PATH: `${connectDir}:${dirname(claude.bin)}:${process.env.PATH}`, ...extra });
  return { root, copy, home, claude, gateway, env };
}

/** `npm --prefix <kit> run -s doctor -- <args>`, from outside the kit (as the skill runs it). */
const doctor = (s, args = ['--json'], env = s.env) =>
  spawnAsync('npm', ['--prefix', s.copy.root, 'run', '-s', 'doctor', '--', ...args], { env, cwd: s.root, timeout: 120_000 });

const noSecrets = (child, what) => {
  for (const secret of SECRETS) assert.ok(!`${child.stdout}${child.stderr}`.includes(secret), `${what} printed a credential`);
};

/** The checks by id, after asserting the answer's shape: `{ ok, command: 'doctor', checks: [{ id, ok, code?, fix? }] }`. */
function checksOf(child, what) {
  const out = json(child, what);
  assert.equal(out.command, 'doctor', `${what}: command`);
  assert.ok(Array.isArray(out.checks) && out.checks.length > 0, `${what}: a checks list: ${JSON.stringify(out).slice(0, 400)}`);
  const byId = {};
  for (const c of out.checks) {
    assert.match(String(c?.id), /^[a-z][a-z0-9_]*$/, `${what}: a check id`);
    assert.ok(!Object.hasOwn(byId, c.id), `${what}: ${c.id} appears once`);
    assert.equal(typeof c.ok, 'boolean', `${what}: ${c.id}.ok is a boolean`);
    if (c.code !== undefined) assert.match(String(c.code), /^[a-z][a-z0-9_]*$/, `${what}: ${c.id}.code is a stable code`);
    if (c.fix !== undefined) assert.ok(typeof c.fix === 'string' && c.fix.trim(), `${what}: ${c.id}.fix is text`);
    if (!c.ok) assert.ok(c.code && c.fix, `${what}: ${c.id} failed without a code and a fix`);
    byId[c.id] = c;
  }
  for (const id of CHECK_IDS) assert.ok(Object.hasOwn(byId, id), `${what}: no "${id}" check (${Object.keys(byId).join(', ')})`);
  assert.equal(out.ok, out.checks.every((c) => c.ok), `${what}: ok is true exactly when every check passes`);
  assert.equal(child.status, out.ok ? 0 : 2, `${what}: exit 0 when every check passes, 2 otherwise`);
  return { out, byId };
}

const failing = (byId) => Object.values(byId).filter((c) => !c.ok).map((c) => `${c.id}:${c.code}`);

test('package.json runs doctor as a kit script', () => {
  assert.equal(kitScripts().doctor, 'node tools/kit.mjs doctor');
});

// A ready machine whose gateway takes 1.2 s to the probe's first byte. Read by the leaf tests below.
const ready = once(async () => {
  const s = await setup(sharedTemp('kit-doctor-'), { gateway: { probeDelayMs: 1200 } });
  const child = await doctor(s);
  return { ...s, child };
});

test('doctor --json on a ready machine: every check passes, exit 0, and no credential is printed', async () => {
  const s = await ready();
  const { out, byId } = checksOf(s.child, 'doctor --json (ready)');
  assert.deepEqual(failing(byId), [], 'no check fails on a ready machine');
  assert.equal(out.ok, true);
  assert.equal(s.child.status, 0);
  noSecrets(s.child, 'doctor --json');
});

test('doctor resolves Claude Code by its real path and reports its version', async () => {
  const s = await ready();
  const { claude } = checksOf(s.child, 'doctor --json (ready)').byId;
  const text = JSON.stringify(claude);
  assert.ok(text.includes(s.claude.realBin), `the claude check names the resolved binary: ${text}`);
  assert.ok(text.includes(PINS.clientVersion), `and its version: ${text}`);
});

test('doctor reads the gateway context with the test key and reports its latency', async () => {
  const s = await ready();
  const { gateway_context: context } = checksOf(s.child, 'doctor --json (ready)').byId;
  assert.ok(Number.isFinite(context.latencyMs) && context.latencyMs >= 0, `gateway_context.latencyMs: ${JSON.stringify(context)}`);
  const reads = s.gateway.testRoute('GET', '/connect/test/context');
  assert.ok(reads.length >= 1, 'GET /connect/test/context');
  for (const r of reads) assert.equal(keyOf(r), TEST_KEY, 'with the test key');
  assert.deepEqual(s.gateway.admin(), [], 'no /admin/* request');
});

test('doctor sends exactly one 1-token probe through the gateway on the test key, tagged as bench traffic, and reports its first-byte latency', async () => {
  const s = await ready();
  const { gateway_probe: probe } = checksOf(s.child, 'doctor --json (ready)').byId;
  const sent = s.gateway.inference();
  assert.equal(sent.length, 1, 'one probe');
  assert.equal(keyOf(sent[0]), TEST_KEY, 'on the test key');
  assert.equal(sent[0].body?.max_tokens, 1, 'a 1-token probe');
  assert.equal(sent[0].metadata?.tool, 'anyray-bench', 'tagged as the kit\'s traffic, like every kit request');
  assert.ok(Number.isFinite(probe.latencyMs), `gateway_probe.latencyMs: ${JSON.stringify(probe)}`);
  assert.ok(probe.latencyMs >= 1100 && probe.latencyMs < SLOW_MS, `the fake gateway held the first byte 1.2 s: ${probe.latencyMs}`);
  assert.equal(probe.ok, true);
  assert.notEqual(probe.code, 'gateway_slow', 'well under the 10 s threshold');
});

test('doctor without --json prints a human summary, exit 0, and no credential', async () => {
  const s = await ready();
  const child = await doctor(s, []);
  assert.equal(child.status, 0, `doctor exit ${child.status}: ${child.stderr.slice(-300)}`);
  assert.ok(child.stdout.trim().length > 0, 'it says something');
  noSecrets(child, 'doctor');
});

test('a probe whose first byte takes longer than 10 s warns gateway_slow with its latency, and a warning does not fail the doctor', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'), { gateway: { probeDelayMs: SLOW_MS + 500 } });
  const child = await doctor(s);
  const { out, byId } = checksOf(child, 'doctor --json (slow gateway)');
  const probe = byId.gateway_probe;
  assert.equal(probe.code, 'gateway_slow', JSON.stringify(probe));
  assert.ok(probe.latencyMs >= SLOW_MS, `the reported first-byte latency: ${probe.latencyMs}`);
  assert.equal(probe.ok, true, 'a slow gateway still works: a warning, not a failure');
  assert.ok(typeof probe.fix === 'string' && probe.fix.trim(), 'the warning carries its fix');
  assert.deepEqual(failing(byId), []);
  assert.equal(out.ok, true);
  assert.equal(child.status, 0);
  noSecrets(child, 'doctor --json (slow gateway)');
});

test('no test key anywhere: test_key fails with test_key_missing and the fix to mint one, exit 2, in both modes', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'), { file: false });
  const env = { ...s.env, ANYRAY_GATEWAY_URL: s.gateway.url };
  const child = await doctor(s, ['--json'], env);
  const { out, byId } = checksOf(child, 'doctor --json (no test key)');
  assert.deepEqual({ ok: byId.test_key.ok, code: byId.test_key.code }, { ok: false, code: 'test_key_missing' });
  assert.match(byId.test_key.fix, MINT_FIX);
  assert.equal(out.ok, false);
  assert.equal(child.status, 2);
  noSecrets(child, 'doctor --json (no test key)');

  const human = await doctor(s, [], env);
  assert.equal(human.status, 2);
  const text = `${human.stdout}${human.stderr}`;
  assert.ok(text.includes('test_key_missing'), 'the human summary names the failing code');
  assert.match(text, MINT_FIX, 'and its fix');
  noSecrets(human, 'doctor (no test key)');
});

test('an expired test key fails test_key with test_key_expired and the fix to mint a new one, exit 2', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'), { expiresAt: pastIso() });
  const child = await doctor(s);
  const { byId } = checksOf(child, 'doctor --json (expired key)');
  assert.deepEqual({ ok: byId.test_key.ok, code: byId.test_key.code }, { ok: false, code: 'test_key_expired' });
  assert.match(byId.test_key.fix, MINT_FIX);
  assert.equal(child.status, 2);
  noSecrets(child, 'doctor --json (expired key)');
});

test('a test-kit.env other users can read fails test_key with test_kit_env_mode, exit 2', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'), { mode: 0o644 });
  const child = await doctor(s);
  const { byId } = checksOf(child, 'doctor --json (test-kit.env 0644)');
  assert.deepEqual({ ok: byId.test_key.ok, code: byId.test_key.code }, { ok: false, code: 'test_kit_env_mode' });
  assert.equal(child.status, 2);
  noSecrets(child, 'doctor --json (test-kit.env 0644)');
});

test('an unreachable gateway fails gateway_context with gateway_unreachable, exit 2', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'), { gatewayUrl: await closedGatewayUrl() });
  const child = await doctor(s);
  const { byId } = checksOf(child, 'doctor --json (unreachable gateway)');
  assert.deepEqual({ ok: byId.gateway_context.ok, code: byId.gateway_context.code }, { ok: false, code: 'gateway_unreachable' });
  assert.equal(byId.gateway_probe.ok, false, 'no probe gets through an unreachable gateway');
  assert.equal(child.status, 2);
  noSecrets(child, 'doctor --json (unreachable gateway)');
});

test('a refused header variable set fails header_envs with env_refused, exit 2', async (t) => {
  for (const variable of ['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS']) {
    const s = await setup(tempDir(t, 'kit-doctor-'), { env: { [variable]: 'x-anyray-tool-defer: off' } });
    const child = await doctor(s);
    const { byId } = checksOf(child, `doctor --json (${variable} set)`);
    assert.deepEqual({ ok: byId.header_envs.ok, code: byId.header_envs.code }, { ok: false, code: 'env_refused' }, variable);
    assert.equal(child.status, 2, variable);
  }
});

test('a kit checkout with local changes fails kit_clean with kit_dirty, exit 2', async (t) => {
  const s = await setup(tempDir(t, 'kit-doctor-'));
  appendFileSync(join(s.copy.root, 'config.yaml'), '# a local edit\n');
  const child = await doctor(s);
  const { byId } = checksOf(child, 'doctor --json (dirty kit)');
  assert.deepEqual({ ok: byId.kit_clean.ok, code: byId.kit_clean.code }, { ok: false, code: 'kit_dirty' });
  assert.equal(child.status, 2);
});

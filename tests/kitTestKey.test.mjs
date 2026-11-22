// The kit on one client-test key (ANY-1516, SPEC section K2): an enrolled developer runs plan,
// run, publish-result and release-check with only ANYRAY_GATEWAY_URL and the test key that
// `anyray-connect test-key` minted, never an admin token. Each command reads what it used to
// read with an admin key from the /connect/test/* routes (SPEC section G), authenticated by the
// test key, and makes no /admin/* request at all. When the environment lacks the credentials
// they come from ~/.anyray/test-kit.env (mode 0600 only); an expired test key is refused by name
// with its fix. With an admin token present the kit keeps today's admin paths: the existing
// kitPlanGate, kitRun, kitPublish and kitReleaseCheck suites pin those.
//
// Driven through the CLI (the real kit, or a kit copy for runs), against a fake gateway on
// 127.0.0.1 that answers /connect/test/* only for the test key. No network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { exclusionReasons } from '../lib/benchVerdict.mjs';
import { kitEnv, readLock, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import { json, kitAsync, planOk, shapedScenarios } from './kitPlanFixtures.mjs';
import {
  PIN_ARGS, assertGatewayBody, fakeClaude, freezeWith, kitIn, kitRunCopy, once, originRepo, poisonClaude, readRecord,
  runScenario, sharedTemp, syntheticPlan, writeDir, writeNoise,
} from './kitRunFixtures.mjs';
import { OTHER_PLAN, storedResult } from './kitReleaseFixtures.mjs';
import {
  CONTEXT_VERSION, PING, REPLICA_RESTARTED, REPLICA_STARTED, TEST_KEY, TEST_PUBLISHED_ID, fakeTestGateway, futureIso, keyOf,
  pastIso, writeTestKitEnv,
} from './kitTestKeyFixtures.mjs';

const BUDGET = ['--budget-usd', '500', '--session-cost-usd', '0.15'];
const CONTEXT = '/connect/test/context';
const SECRETS = [TEST_KEY, 'sk-synthetic-placeholder', 'ark_synthetic-123456'];

const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});
const gatewayFor = async (opts) => {
  const g = await fakeTestGateway(opts);
  gateways.push(g);
  return g;
};

/** ANY-1485's minimal env plus exactly the two variables the client flow needs: no admin token. */
const testKeyEnv = (home, gateway, extra = {}) => kitEnv(home, { ANYRAY_GATEWAY_URL: gateway.url, ANYRAY_BENCH_CLIENT_KEY: TEST_KEY, ...extra });

const noSecrets = (child, what) => {
  for (const s of SECRETS) assert.ok(!`${child.stdout}${child.stderr}`.includes(s), `${what} printed a credential`);
};
const noAdmin = (gateway, what) => assert.deepEqual(gateway.admin().map((r) => `${r.method} ${r.path}`), [], `${what}: an /admin/* request without an admin token`);
/** The reads of `path` the command made, each with the test key; at least one. */
function readsWithTestKey(gateway, method, path, what) {
  const reads = gateway.testRoute(method, path);
  assert.ok(reads.length >= 1, `${what}: no ${method} ${path}`);
  for (const r of reads) assert.equal(keyOf(r), TEST_KEY, `${what}: ${method} ${r.path} is authenticated by the test key`);
  return reads;
}
const plan = (t, dir, env, args = []) => kitAsync(t, ['plan', '--scenarios-dir', dir, ...BUDGET, ...args], { env });

// ---- plan ------------------------------------------------------------------------------------------

test('plan on the test key alone reads GET /connect/test/context, and an all-shadow tenant in the evaluation cohort is planned, not refused: it says how many kinds the test sessions evaluate', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor({ sessionGate: { on: 0, shadow: 4, off: 0 } });
  const env = testKeyEnv(tempDir(t, 'kit-home-'), gateway);

  const child = await plan(t, dir, env, ['--json']);
  const out = planOk(child, 'plan --json on the test key (all shadow, evaluation cohort)');
  assert.deepEqual(out.tenant, { id: 'acme', kinds: { on: 0, shadow: 4, off: 0 }, evaluationCohort: true, kindsEvaluated: 4 },
    'the tenant from the context, its kind counts, and the kinds the test sessions evaluate (on + shadow)');
  readsWithTestKey(gateway, 'GET', CONTEXT, 'plan --json');
  noAdmin(gateway, 'plan --json');
  noSecrets(child, 'plan --json');

  const human = await plan(t, dir, env);
  assert.equal(human.status, 0, `plan (human) exit ${human.status}: ${human.stderr.slice(-300)}`);
  const line = human.stdout.split('\n').find((l) => /\b4\b/.test(l) && /\bkinds?\b/i.test(l) && /\btest sessions?\b/i.test(l));
  assert.ok(line, `the human plan has a line saying 4 kinds are evaluated on the test sessions: ${JSON.stringify(human.stdout.slice(0, 600))}`);
  noAdmin(gateway, 'plan');
  noSecrets(human, 'plan');
});

test('kindsEvaluated counts the kinds on or in shadow, never the ones off', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor({ sessionGate: { on: 1, shadow: 2, off: 3 } });
  const out = planOk(await plan(t, dir, testKeyEnv(tempDir(t, 'kit-home-'), gateway), ['--json']), 'plan --json (1 on, 2 shadow, 3 off)');
  assert.deepEqual(out.tenant, { id: 'acme', kinds: { on: 1, shadow: 2, off: 3 }, evaluationCohort: true, kindsEvaluated: 3 });
});

test('a context that does not put the test sessions in an evaluation cohort keeps the all-shadow refusal: plan_tenant_shadow, exit 3', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor({ sessionGate: { on: 0, shadow: 4, off: 0 }, evaluationCohort: false });
  const child = await plan(t, dir, testKeyEnv(tempDir(t, 'kit-home-'), gateway), ['--json']);
  const out = json(child, 'plan --json (all shadow, no cohort)');
  assert.deepEqual({ ok: out.ok, code: out.code, tenant: out.tenant, kinds: out.kinds }, { ok: false, code: 'plan_tenant_shadow', tenant: 'acme', kinds: { on: 0, shadow: 4, off: 0 } });
  assert.equal(child.status, 3);
  readsWithTestKey(gateway, 'GET', CONTEXT, 'the refusal rests on the context read');
  noAdmin(gateway, 'plan --json (no cohort)');
});

test('a context the plan cannot read is refused, never assumed: plan_tenant_unreadable with the status, for a failing gateway and for a key that is not a test key', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const failing = await gatewayFor({ contextStatus: 503 });
  const a = await plan(t, dir, testKeyEnv(tempDir(t, 'kit-home-'), failing), ['--json']);
  const aOut = json(a, 'plan --json (context 503)');
  assert.deepEqual({ ok: aOut.ok, code: aOut.code, reason: aOut.reason, status: aOut.status }, { ok: false, code: 'plan_tenant_unreadable', reason: 'request_failed', status: 503 });
  assert.equal(a.status, 3);
  readsWithTestKey(failing, 'GET', CONTEXT, 'plan (context 503)');
  noAdmin(failing, 'plan (context 503)');

  const gateway = await gatewayFor();
  const notTestKey = 'ark_synthetic-personal-0002';
  const b = await plan(t, dir, testKeyEnv(tempDir(t, 'kit-home-'), gateway, { ANYRAY_BENCH_CLIENT_KEY: notTestKey }), ['--json']);
  const bOut = json(b, 'plan --json (a personal key, not a test key)');
  assert.deepEqual({ ok: bOut.ok, code: bOut.code, reason: bOut.reason, status: bOut.status }, { ok: false, code: 'plan_tenant_unreadable', reason: 'request_failed', status: 403 });
  assert.equal(b.status, 3);
  assert.ok(gateway.testRoute('GET', CONTEXT).length >= 1, 'the context was asked');
  assert.ok(!`${b.stdout}${b.stderr}`.includes(notTestKey), 'the key is not printed');
  noAdmin(gateway, 'plan (personal key)');
});

// ---- run -------------------------------------------------------------------------------------------

/**
 * A frozen one-scenario plan with noise, a stand-in Claude, a poisoned PATH and a test-key gateway.
 * `sessionGate` / `evaluationCohort` are what the context reports; `kinds` freezes the plan with
 * `--kinds <list>` (the pinned-kinds path).
 */
async function runSetup({ restart = false, viaFile = false, sessionGate, evaluationCohort, kinds } = {}) {
  const root = sharedTemp('kit-testkey-run-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'acme-fix': runScenario(origin) });
  const gateway = await gatewayFor({ restartOnFirstInference: restart, sessionGate, evaluationCohort });
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1, 1.2], anyray: [0.5, 0.6] }, marked: false });
  const home = join(root, 'home');
  const path = { PATH: `${poison.dir}:${process.env.PATH}` };
  let env;
  if (viaFile) {
    writeTestKitEnv(home, { gateway: gateway.url });
    env = kitEnv(home, path);
  } else env = testKeyEnv(home, gateway, path);
  let lock;
  if (kinds) {
    const frozen = json(await kitIn(copy.root, ['freeze', '--scenarios-dir', dir, ...PIN_ARGS(gateway.url), '--kinds', kinds, '--json'], { env }), 'freeze --kinds --json');
    assert.equal(frozen.ok, true, `freeze --kinds must succeed before this test can check anything: ${JSON.stringify(frozen)}`);
    lock = readLock(dir);
  } else lock = await freezeWith(copy.root, dir, gateway.url, env);
  writeNoise(dir);
  return { root, copy, dir, gateway, poison, claude, env, lock };
}
const run = (s, rounds) => kitIn(s.copy.root, ['run', '--scenarios-dir', s.dir, '--claude-bin', s.claude.bin, '--rounds', String(rounds), '--json'], { env: s.env });

// Two rounds on the test key alone; the gateway "restarts" under the first. The context puts the
// test sessions in the evaluation cohort with 2 kinds on, 3 in shadow and 1 off. Read by the leaf
// tests below.
const testKeyRun = once(async () => {
  const s = await runSetup({ restart: true, sessionGate: { on: 2, shadow: 3, off: 1 } });
  const child = await run(s, 2);
  return { ...s, child };
});

function ranOk(s, what) {
  const out = json(s.child, what);
  assert.equal(out.ok, true, `${what} refused or failed: ${s.child.stdout.slice(0, 400)} ${s.child.stderr.slice(-800)}`);
  assert.equal(s.child.status, 0);
  return out;
}
const counted = (record) => record.rounds.filter((r) => Number.isFinite(r.ratio));

test('run with no admin token runs on the test key: the Anyray arm presents it, the context is read with it, and no /admin/* request is made', async () => {
  const s = await testKeyRun();
  const out = ranOk(s, 'run --json on the test key');
  assert.equal(out.planHash, s.lock.planHash);
  const inference = s.gateway.inference();
  assert.ok(inference.length > 0, 'the Anyray arm reached the gateway');
  for (const r of inference) assert.equal(r.apiKey, TEST_KEY, 'every Anyray request carries the test key');
  readsWithTestKey(s.gateway, 'GET', CONTEXT, 'run');
  noAdmin(s.gateway, 'run');
  noSecrets(s.child, 'run --json');
  assert.equal(counted(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray')).length, 2, 'both rounds were paired');
});

test('run records the gateway version GET /connect/test/context reports', async () => {
  const s = await testKeyRun();
  ranOk(s, 'run --json on the test key');
  assert.equal(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray').gatewayVersion, CONTEXT_VERSION);
});

// ANY-1684: a result says how many of the kinds the test evaluated were still in shadow, so the run
// record keeps the context's counts. Only the two counts: never `off`, the tenant or anything else.
test('run records the kinds the test sessions evaluated, from the context\'s session gate, as exactly { on, shadow }', async () => {
  const s = await testKeyRun();
  ranOk(s, 'run --json on the test key');
  readsWithTestKey(s.gateway, 'GET', CONTEXT, 'run');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.deepEqual(record.evaluatedKinds, { on: 2, shadow: 3 }, 'the on and shadow counts, nothing else');
});

test('a context that does not put the test sessions in an evaluation cohort records no evaluated kinds: those sessions applied only what is on', async () => {
  const s = await runSetup({ sessionGate: { on: 2, shadow: 3, off: 1 }, evaluationCohort: false });
  s.child = await run(s, 1);
  ranOk(s, 'run --json, context without the evaluation cohort');
  readsWithTestKey(s.gateway, 'GET', CONTEXT, 'run without the cohort');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.equal(record.gatewayVersion, CONTEXT_VERSION, 'the context was read and the record written');
  assert.equal(counted(record).length, 1, 'the round ran');
  assert.ok(!Object.hasOwn(record, 'evaluatedKinds'), `no evaluatedKinds without the cohort: ${JSON.stringify(record.evaluatedKinds)}`);
});

test('a plan frozen with --kinds records no evaluated kinds: its Anyray arm runs the pinned kinds, not the tenant\'s gate', async () => {
  const s = await runSetup({ sessionGate: { on: 2, shadow: 3, off: 1 }, kinds: 'observation_mask' });
  assert.equal(s.lock.pins.kinds, 'observation_mask', 'the plan pins its kinds');
  s.child = await run(s, 1);
  ranOk(s, 'run --json on a --kinds plan');
  const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
  assert.equal(record.gatewayVersion, CONTEXT_VERSION, 'the context was read and the record written');
  assert.equal(counted(record).length, 1, 'the round ran');
  assert.ok(!Object.hasOwn(record, 'evaluatedKinds'), `no evaluatedKinds on the pinned-kinds path: ${JSON.stringify(record.evaluatedKinds)}`);
});

// Repeat invocations add rounds to one record. Kinds promoted between them must not erase that
// earlier rounds ran with more kinds in shadow: the record keeps the invocation with the most
// shadow kinds (conservative), and a context whose counts are not integers changes nothing.
test('across repeated run invocations the record keeps the evaluated kinds with the most in shadow, and ignores a malformed count', async () => {
  const s = await runSetup({ sessionGate: { on: 1, shadow: 4, off: 0 } });
  const step = async (gate, expected, rounds, what) => {
    s.gateway.state.sessionGate = gate;
    s.child = await run(s, 1);
    ranOk(s, `run --json (${what})`);
    const record = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray');
    assert.equal(record.rounds.length, rounds, `${what}: the invocation added its round`);
    assert.deepEqual(record.evaluatedKinds, expected, what);
  };
  await step({ on: 1, shadow: 4, off: 0 }, { on: 1, shadow: 4 }, 1, 'first invocation: 4 in shadow');
  await step({ on: 0, shadow: '9', off: 0 }, { on: 1, shadow: 4 }, 2, 'a shadow count that is not an integer is not recorded');
  await step({ on: 0, shadow: 5, off: 1 }, { on: 0, shadow: 5 }, 3, 'more kinds in shadow than before: the new counts');
  await step({ on: 4, shadow: 1, off: 0 }, { on: 0, shadow: 5 }, 4, 'kinds promoted since: the earlier, larger shadow count stays');
});

test('each Anyray session\'s keep-warm pings come from GET /connect/test/sessions/:id, keyed by its Claude Code session id, and are added to its cost', async () => {
  const s = await testKeyRun();
  ranOk(s, 'run --json on the test key');
  const prefix = '/connect/test/sessions/';
  const reads = readsWithTestKey(s.gateway, 'GET', new RegExp(`^${prefix}`), 'run');
  const asked = [...new Set(reads.map((r) => decodeURIComponent(r.path.slice(prefix.length))))].sort();
  const sessions = s.claude.sessions().filter((x) => x.kind === 'anyray').map((x) => x.sessionId).sort();
  assert.deepEqual(asked, sessions, 'one summary per Anyray session, by the id Claude Code reported');
  for (const r of counted(readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray'))) {
    const b = r.sessions.b.totals;
    assert.equal(b.gatewayPingCount, PING.requests, `round ${r.round}: the ping count`);
    assert.equal(b.gatewayPingCostUsd, PING.costUsd, `round ${r.round}: the ping cost`);
    assert.ok([0.5, 0.6].includes(b.clientCostUsd), `round ${r.round}: Claude Code's own figure stays as clientCostUsd (${b.clientCostUsd})`);
    assert.ok(Math.abs(b.costUsd - (b.clientCostUsd + PING.costUsd)) < 1e-9, `round ${r.round}: the arm's cost is the client cost plus the pings`);
  }
});

test('a gateway restart is read from the context\'s replicas: the round a replica restarted under is excluded as a gateway restart, the next round is not', async () => {
  const s = await testKeyRun();
  ranOk(s, 'run --json on the test key');
  assert.notEqual(REPLICA_STARTED, REPLICA_RESTARTED);
  const [first, second] = readRecord(s.dir, s.lock.planHash, 'acme-fix', 'anyray').rounds;
  assert.equal(first?.gatewayRestarted, true, 'round 1: the replica start time moved between the reads around it');
  assert.ok(exclusionReasons(first).includes('gateway restart'), 'round 1 is excluded as a gateway restart');
  assert.equal(second?.gatewayRestarted, false, 'round 2: read before and after, unchanged (false, not unknown)');
});

// ---- publish-result and release-check ---------------------------------------------------------------

test('publish-result on the test key posts the report body to POST /connect/test/results and prints only the id the gateway gave', async (t) => {
  const root = tempDir(t, 'kit-testkey-publish-');
  const gateway = await gatewayFor();
  const env = testKeyEnv(join(root, 'home'), gateway);
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env });
  const reported = json(await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env }), 'report --redact --json');

  const child = await kitIn(copy.root, ['publish-result', '--scenarios-dir', dir], { env });
  assert.equal(child.status, 0, `publish failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-400)}`);
  assert.equal(child.stdout, `${TEST_PUBLISHED_ID}\n`, 'stdout is the id the test route gave, and nothing else');
  const posts = gateway.testRoute('POST', '/connect/test/results');
  assert.equal(posts.length, 1, 'one POST');
  assert.equal(keyOf(posts[0]), TEST_KEY);
  assertGatewayBody(posts[0].body, 'the published body');
  assert.deepEqual(posts[0].body, reported, 'exactly what report --json prints');
  noAdmin(gateway, 'publish-result');
  noSecrets(child, 'publish-result');

  const again = await kitIn(copy.root, ['publish-result', '--scenarios-dir', dir, '--json'], { env });
  assert.deepEqual(json(again, 'publish-result --json'), { ok: true, command: 'publish-result', id: TEST_PUBLISHED_ID });
  noAdmin(gateway, 'publish-result --json');
});

test('release-check on the test key: the version from GET /connect/test/context, this plan\'s newest result from GET /connect/test/results?latest=plan', async (t) => {
  const root = tempDir(t, 'kit-testkey-release-');
  const gateway = await gatewayFor();
  const env = testKeyEnv(join(root, 'home'), gateway);
  const dir = writeScenariosDir(root, twoScenarios());
  assert.equal(json(await kitAsync(t, ['freeze', '--scenarios-dir', dir, ...PIN_ARGS(gateway.url), '--json'], { env }), 'freeze --json').ok, true);
  const lock = readLock(dir);
  gateway.state.results = [
    storedResult(lock.planHash, '1.10.509', '2026-10-01T09:00:00.000Z'),
    storedResult(OTHER_PLAN, '1.10.400', '2026-10-23T09:00:00.000Z'),
    storedResult(lock.planHash, CONTEXT_VERSION, '2026-10-20T09:00:00.000Z'),
  ];

  const child = await kitAsync(t, ['release-check', '--scenarios-dir', dir, '--json'], { env });
  assert.deepEqual(json(child, 'release-check --json on the test key'), {
    ok: true, command: 'release-check', planHash: lock.planHash, gatewayVersion: CONTEXT_VERSION,
    published: { gatewayVersion: CONTEXT_VERSION, releaseTag: `v${CONTEXT_VERSION}`, receivedAt: '2026-10-20T09:00:00.000Z' },
    changed: false,
  });
  assert.equal(child.status, 0);
  readsWithTestKey(gateway, 'GET', CONTEXT, 'release-check');
  const [results] = readsWithTestKey(gateway, 'GET', '/connect/test/results', 'release-check');
  assert.equal(results.query.latest, 'plan', 'GET /connect/test/results?latest=plan');
  noAdmin(gateway, 'release-check');
  noSecrets(child, 'release-check');

  const line = await kitAsync(t, ['release-check', '--scenarios-dir', dir], { env });
  assert.equal(line.status, 0);
  assert.equal(line.stdout, 'changed=false\n');
});

test('with no admin token and no test key (environment or ~/.anyray/test-kit.env), plan, publish-result and release-check refuse test_key_missing with the fix, before any request', async (t) => {
  const root = tempDir(t, 'kit-testkey-none-');
  const gateway = await gatewayFor();
  const env = kitEnv(join(root, 'home'), { ANYRAY_GATEWAY_URL: gateway.url });
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env });
  for (const args of [['plan', '--scenarios-dir', dir, ...BUDGET], ['publish-result', '--scenarios-dir', dir], ['release-check', '--scenarios-dir', dir]]) {
    const child = await kitIn(copy.root, [...args, '--json'], { env });
    const out = json(child, `${args[0]} --json with no credential`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: args[0], code: 'test_key_missing' }, args[0]);
    assert.match(String(out.fix ?? ''), /anyray-connect test-key/, `${args[0]}: the fix names the command that mints a test key`);
    assert.equal(child.status, 2, args[0]);
  }
  assert.deepEqual(gateway.requests, [], 'no request without a credential');
});

// ---- ~/.anyray/test-kit.env --------------------------------------------------------------------------

test('when the environment has no gateway or key, plan reads both from ~/.anyray/test-kit.env; when it has them, the environment wins', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor();
  const home = tempDir(t, 'kit-home-');
  writeTestKitEnv(home, { gateway: gateway.url });
  const child = await plan(t, dir, kitEnv(home), ['--json']);
  const out = planOk(child, 'plan --json on test-kit.env alone (no --gateway, no env)');
  assert.equal(out.tenant?.evaluationCohort, true, 'the tenant came from the test context');
  readsWithTestKey(gateway, 'GET', CONTEXT, 'plan on test-kit.env');
  noAdmin(gateway, 'plan on test-kit.env');
  noSecrets(child, 'plan on test-kit.env');

  const fromEnv = await gatewayFor();
  const otherHome = tempDir(t, 'kit-home-');
  writeTestKitEnv(otherHome, { gateway: gateway.url, key: 'ark_svc_synthetic-stale-0003' });
  const before = gateway.requests.length;
  planOk(await plan(t, dir, testKeyEnv(otherHome, fromEnv), ['--json']), 'plan --json with both the env and a test-kit.env');
  readsWithTestKey(fromEnv, 'GET', CONTEXT, 'plan with the env set');
  assert.equal(gateway.requests.length, before, 'the file\'s gateway was not asked');
});

test('run reads the gateway and the test key from ~/.anyray/test-kit.env alone', async () => {
  const s = await runSetup({ viaFile: true });
  const child = await run(s, 1);
  const out = json(child, 'run --json on test-kit.env');
  assert.equal(out.ok, true, `run on test-kit.env refused or failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-800)}`);
  assert.equal(child.status, 0);
  const inference = s.gateway.inference();
  assert.ok(inference.length > 0, 'the Anyray arm reached the file\'s gateway');
  for (const r of inference) assert.equal(r.apiKey, TEST_KEY, 'with the file\'s key');
  readsWithTestKey(s.gateway, 'GET', CONTEXT, 'run on test-kit.env');
  noAdmin(s.gateway, 'run on test-kit.env');
  noSecrets(child, 'run on test-kit.env');
});

test('a test-kit.env that is not mode 0600 is refused (test_kit_env_mode, exit 2) before any request, and never printed', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor();
  for (const mode of [0o644, 0o640]) {
    const home = tempDir(t, 'kit-home-');
    writeTestKitEnv(home, { gateway: gateway.url, mode });
    const child = await plan(t, dir, kitEnv(home), ['--json']);
    const out = json(child, `plan --json, test-kit.env mode ${mode.toString(8)}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'plan', code: 'test_kit_env_mode' }, mode.toString(8));
    assert.equal(child.status, 2, mode.toString(8));
    noSecrets(child, `plan, test-kit.env mode ${mode.toString(8)}`);
  }
  assert.deepEqual(gateway.requests, [], 'the file was refused before its gateway was asked anything');
});

test('an expired test key is refused by name with its fix (run anyray-connect test-key), from the file or from the environment, before any request', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await gatewayFor();
  const fileHome = tempDir(t, 'kit-home-');
  writeTestKitEnv(fileHome, { gateway: gateway.url, expiresAt: pastIso() });
  const envHome = tempDir(t, 'kit-home-');
  for (const [what, env] of [
    ['test-kit.env', kitEnv(fileHome)],
    ['environment', testKeyEnv(envHome, gateway, { ANYRAY_TEST_KEY_EXPIRES_AT: pastIso() })],
  ]) {
    const child = await plan(t, dir, env, ['--json']);
    const out = json(child, `plan --json, expired key in the ${what}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'plan', code: 'test_key_expired' }, what);
    assert.match(String(out.fix ?? ''), /anyray-connect test-key/, `${what}: the fix is to mint a new test key`);
    assert.equal(child.status, 2, what);
    noSecrets(child, `plan, expired key in the ${what}`);
  }
  assert.deepEqual(gateway.requests, [], 'an expired key is never sent');

  // A key that has not expired yet is not refused (the same file with a future expiry).
  const fresh = tempDir(t, 'kit-home-');
  writeTestKitEnv(fresh, { gateway: gateway.url, expiresAt: futureIso() });
  planOk(await plan(t, dir, kitEnv(fresh), ['--json']), 'plan --json with a fresh test key');
});

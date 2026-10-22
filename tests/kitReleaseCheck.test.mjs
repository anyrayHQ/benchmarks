// `npm run release-check` (ANY-1491): the regression template's daily question, "has the gateway
// changed since this plan last published?". It reads the version the gateway runs
// (GET /admin/v1/settings/updates) and the newest published result of THIS plan
// (GET /admin/v1/client-tests?latest=plan), and answers `changed=true|false`, the GitHub Actions
// output line, so the template appends it to $GITHUB_OUTPUT unparsed. Other plans' results never
// count; an unreadable gateway fails the check instead of guessing; a refusal writes nothing to
// stdout. Against a fake gateway on 127.0.0.1 with a plan the real kit froze; no session runs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { changeOneByte, kitEnv, readLock, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import { ADMIN_KEY, json, kitAsync } from './kitPlanFixtures.mjs';
import { GATEWAY_VERSION, PIN_ARGS } from './kitRunFixtures.mjs';
import { OTHER_PLAN, SERVER_MARK, fakeReleaseGateway, kitScripts, storedResult } from './kitReleaseFixtures.mjs';

const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});
const gatewayFor = async (opts) => {
  const g = await fakeReleaseGateway(opts);
  gateways.push(g);
  return g;
};

const OLD = '1.10.509';

/** A plan the real kit froze against `gateway`; the gateway's request log starts empty after it. */
async function frozen(t, gateway) {
  const root = tempDir(t, 'kit-release-');
  const env = kitEnv(join(root, 'home'), { ANYRAY_ADMIN_KEY: ADMIN_KEY });
  const dir = writeScenariosDir(root, twoScenarios());
  const child = await kitAsync(t, ['freeze', '--scenarios-dir', dir, ...PIN_ARGS(gateway.url), '--json'], { env });
  assert.equal(json(child, 'freeze --json').ok, true, `freeze must succeed first: ${child.stderr.slice(-300)}`);
  gateway.requests.length = 0;
  return { root, env, dir, lock: readLock(dir) };
}

const check = (t, s, gateway, args = [], env = s.env) => kitAsync(t, ['release-check', '--scenarios-dir', s.dir, '--gateway', gateway.url, ...args], { env });

/** The two reads, both GETs with the admin key, the results read asking for the newest per plan. */
function assertReads(gateway) {
  assert.deepEqual(gateway.requests.map((r) => `${r.method} ${r.path}`).sort(), ['GET /admin/v1/client-tests', 'GET /admin/v1/settings/updates']);
  assert.equal(gateway.requests.find((r) => r.path === '/admin/v1/client-tests').query.latest, 'plan', 'GET /admin/v1/client-tests?latest=plan');
  for (const r of gateway.requests) assert.equal(r.authorization, `Bearer ${ADMIN_KEY}`, `${r.path} with the admin key`);
}

test('package.json runs it as a kit script', () => {
  assert.equal(kitScripts()['release-check'], 'node tools/kit.mjs release-check');
});

test('unchanged: the newest result of THIS plan carries the version the gateway runs, so the check answers changed=false', async (t) => {
  const gateway = await gatewayFor();
  const s = await frozen(t, gateway);
  gateway.state.results = [
    storedResult(s.lock.planHash, OLD, '2026-10-01T09:00:00.000Z'),
    storedResult(OTHER_PLAN, '1.10.400', '2026-10-23T09:00:00.000Z'),
    storedResult(s.lock.planHash, GATEWAY_VERSION, '2026-10-20T09:00:00.000Z'),
  ];
  const asJson = await check(t, s, gateway, ['--json']);
  assert.deepEqual(json(asJson, 'release-check --json'), {
    ok: true, command: 'release-check', planHash: s.lock.planHash, gatewayVersion: GATEWAY_VERSION,
    published: { gatewayVersion: GATEWAY_VERSION, releaseTag: `v${GATEWAY_VERSION}`, receivedAt: '2026-10-20T09:00:00.000Z' },
    changed: false,
  }, 'the newest of this plan\'s results by receivedAt, not the first in the list, and never another plan\'s');
  assert.equal(asJson.status, 0);
  assertReads(gateway);

  gateway.requests.length = 0;
  const line = await check(t, s, gateway);
  assert.equal(line.status, 0, `a skip is not a failure: ${line.stderr.slice(-300)}`);
  assert.equal(line.stdout, 'changed=false\n', 'exactly the Actions output line');
  assertReads(gateway);
  for (const c of [asJson, line]) assert.ok(!`${c.stdout}${c.stderr}`.includes(ADMIN_KEY), 'the admin key is never printed');
});

test('changed: this plan last published on another version (whatever another plan published on this one)', async (t) => {
  const gateway = await gatewayFor();
  const s = await frozen(t, gateway);
  gateway.state.results = [
    storedResult(s.lock.planHash, OLD, '2026-10-21T09:00:00.000Z'),
    storedResult(s.lock.planHash, GATEWAY_VERSION, '2026-10-02T09:00:00.000Z'),
    storedResult(OTHER_PLAN, GATEWAY_VERSION, '2026-10-22T09:00:00.000Z'),
  ];
  const out = json(await check(t, s, gateway, ['--json']), 'release-check --json');
  assert.deepEqual({ changed: out.changed, published: out.published, gatewayVersion: out.gatewayVersion }, {
    changed: true, gatewayVersion: GATEWAY_VERSION,
    published: { gatewayVersion: OLD, releaseTag: `v${OLD}`, receivedAt: '2026-10-21T09:00:00.000Z' },
  }, 'the newest result of this plan is on 1.10.509, the gateway runs 1.10.515');
  const line = await check(t, s, gateway);
  assert.equal(line.status, 0);
  assert.equal(line.stdout, 'changed=true\n');
});

test('changed: nothing was ever published for this plan (another plan\'s result on this version does not count)', async (t) => {
  const gateway = await gatewayFor();
  const s = await frozen(t, gateway);
  for (const results of [[], [storedResult(OTHER_PLAN, GATEWAY_VERSION, '2026-10-22T09:00:00.000Z')]]) {
    gateway.state.results = results;
    const child = await check(t, s, gateway, ['--json']);
    assert.deepEqual(json(child, 'release-check --json'), {
      ok: true, command: 'release-check', planHash: s.lock.planHash, gatewayVersion: GATEWAY_VERSION, published: null, changed: true,
    }, `${results.length} result(s) of other plans`);
    assert.equal(child.status, 0);
  }
});

// ANY-1516: without an admin key release-check reads the test key's routes (tests/kitTestKey.test.mjs);
// with neither credential it refuses test_key_missing.
test('refused before any request: no admin key and no test key, a gateway other than the frozen one, a scenarios dir changed after the freeze; and nothing on stdout', async (t) => {
  const gateway = await gatewayFor();
  const other = await gatewayFor();
  const s = await frozen(t, gateway);
  const noKey = { ...s.env };
  delete noKey.ANYRAY_ADMIN_KEY;
  const cases = [
    ['no admin key and no test key', (args) => check(t, s, gateway, args, noKey), 'test_key_missing', 2, {}],
    ['another gateway', (args) => check(t, s, other, args), 'plan_pin_mismatch', 3, { pin: 'gatewayHost', expected: s.lock.pins.gatewayHost, found: new URL(other.url).host }],
  ];
  for (const [what, call, code, status, fields] of cases) {
    const human = await call([]);
    assert.equal(human.status, status, `${what}: exit ${human.status}`);
    assert.equal(human.stdout, '', `${what}: a refusal writes nothing that could land in $GITHUB_OUTPUT`);
    assert.ok(human.stderr.split('\n').some((l) => l.startsWith(code)), `${what}: a stderr line starts with ${code}: ${human.stderr.slice(-300)}`);
    const asJson = json(await call(['--json']), `${what} --json`);
    const picked = Object.fromEntries(Object.keys(fields).map((k) => [k, asJson[k]]));
    assert.deepEqual({ ok: asJson.ok, command: asJson.command, code: asJson.code, ...picked }, { ok: false, command: 'release-check', code, ...fields }, what);
  }
  changeOneByte(join(s.dir, 'acme-fix', 'scenario.yaml'), 'tokenizer', 'tokenizes');
  const changed = await check(t, s, gateway, ['--json']);
  const out = json(changed, 'release-check after a change');
  assert.deepEqual({ code: out.code, expected: out.expected, changed: out.changed }, { code: 'plan_hash_mismatch', expected: s.lock.planHash, changed: ['acme-fix'] });
  assert.equal(changed.status, 3);
  assert.deepEqual([...gateway.requests, ...other.requests], [], 'no refusal made a request');
});

test('an unreadable gateway fails the check (gateway_unreadable, exit 1) instead of guessing, and never prints the server\'s answer', async (t) => {
  for (const [opts, read, status] of [[{ versionStatus: 500 }, 'version', 500], [{ resultsStatus: 404 }, 'results', 404]]) {
    const gateway = await gatewayFor(opts);
    const s = await frozen(t, gateway);
    const asJson = await check(t, s, gateway, ['--json']);
    const out = json(asJson, `release-check --json, ${read} unreadable`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code, read: out.read, status: out.status }, { ok: false, command: 'release-check', code: 'gateway_unreadable', read, status });
    assert.equal(asJson.status, 1);
    const human = await check(t, s, gateway);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '', `${read}: no changed= line when the check could not decide`);
    for (const c of [asJson, human]) assert.ok(!`${c.stdout}${c.stderr}`.includes(SERVER_MARK), `${read}: the server's answer is not echoed`);
    assert.ok(gateway.requests.every((r) => r.method === 'GET'), 'only reads');
  }
});

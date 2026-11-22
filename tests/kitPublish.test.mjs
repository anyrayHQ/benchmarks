// `npm run publish-result` (ANY-1487): send the report body to the gateway the plan was frozen
// against, POST /admin/v1/client-tests (ANY-1488), with the admin key from the environment
// (never a flag), and print only the id the server gave it. A body the gateway's schema would
// refuse is never sent. Against a fake gateway on 127.0.0.1; synthetic records, no session runs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { ADMIN_KEY, PUBLISHED_ID, assertGatewayBody, fakeRunGateway, kitIn, syntheticPlan } from './kitRunFixtures.mjs';

const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});
const gatewayFor = async (opts) => {
  const g = await fakeRunGateway(opts);
  gateways.push(g);
  return g;
};

const publishEnv = (root, extra = {}) => kitEnv(join(root, 'home'), { ANYRAY_ADMIN_KEY: ADMIN_KEY, ...extra });
const publish = (copy, dir, gateway, env, args = []) => kitIn(copy.root, ['publish-result', '--scenarios-dir', dir, '--gateway', gateway.url, ...args], { env });
const posts = (gateway) => gateway.requests.filter((r) => r.method === 'POST');

test('publish-result posts the report body to /admin/v1/client-tests with the admin key from the environment, and prints only the server\'s id', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const gateway = await gatewayFor();
  const env = publishEnv(root);
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env });
  const reported = json(await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env }), 'report --redact --json');

  const child = await publish(copy, dir, gateway, env);
  assert.equal(child.status, 0, `publish failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-400)}`);
  assert.equal(child.stdout, `${PUBLISHED_ID}\n`, 'stdout is the server\'s id and nothing else');
  const sent = posts(gateway);
  assert.equal(sent.length, 1, 'one POST');
  assert.equal(sent[0].path, '/admin/v1/client-tests');
  assert.equal(sent[0].authorization, `Bearer ${ADMIN_KEY}`);
  assertGatewayBody(sent[0].body, 'the published body');
  assert.deepEqual(sent[0].body, reported, 'exactly what report --json prints');
  assert.ok(!child.stdout.includes(ADMIN_KEY) && !child.stderr.includes(ADMIN_KEY), 'the key is never printed');

  const again = await publish(copy, dir, gateway, env, ['--json']);
  const out = json(again, 'publish-result --json');
  assert.deepEqual(out, { ok: true, command: 'publish-result', id: PUBLISHED_ID });
});

test('publish-result says where the result shows up, on stderr only, and never in --json', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const gateway = await gatewayFor();
  const env = publishEnv(root);
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env });
  const child = await publish(copy, dir, gateway, env);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, `${PUBLISHED_ID}\n`, 'stdout stays the bare id for programs');
  assert.match(child.stderr, /Published\. It shows under Measurement on the Optimizer page of your console/);
  const asJson = await publish(copy, dir, gateway, env, ['--json']);
  assert.deepEqual(json(asJson, 'publish-result --json'), { ok: true, command: 'publish-result', id: PUBLISHED_ID });
});

test('publish-result refuses to send a body the gateway\'s schema would refuse (report_invalid), and makes no request', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const gateway = await gatewayFor();
  const env = publishEnv(root);
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env, gatewayVersion: null });
  const child = await publish(copy, dir, gateway, env, ['--json']);
  const out = json(child, 'publish-result --json with an invalid body');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'publish-result', code: 'report_invalid' });
  assert.equal(child.status, 1);
  assert.deepEqual(gateway.requests, [], 'nothing was sent');
});

// ANY-1516: without an admin key the kit publishes on the test key (tests/kitTestKey.test.mjs), so
// the refusal for no credential at all is test_key_missing, the client flow's missing key.
test('credentials come from the environment only: no admin key and no test key is test_key_missing, a key flag is usage, and neither sends anything', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const gateway = await gatewayFor();
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env: publishEnv(root) });

  const noKey = await publish(copy, dir, gateway, kitEnv(join(root, 'home')), ['--json']);
  const a = json(noKey, 'publish-result --json without an admin key or a test key');
  assert.deepEqual({ ok: a.ok, code: a.code }, { ok: false, code: 'test_key_missing' });
  assert.equal(noKey.status, 2);

  for (const flag of ['--admin-key', '--token']) {
    const child = await publish(copy, dir, gateway, kitEnv(join(root, 'home')), [flag, ADMIN_KEY, '--json']);
    const out = json(child, `publish-result ${flag}`);
    assert.deepEqual({ ok: out.ok, code: out.code }, { ok: false, code: 'usage' }, flag);
    assert.equal(child.status, 2, flag);
    assert.ok(!child.stdout.includes(ADMIN_KEY) && !child.stderr.includes(ADMIN_KEY), `${flag}: the key is not echoed`);
  }
  assert.deepEqual(gateway.requests, [], 'nothing was sent');
});

test('publish-result refuses a gateway other than the one the plan was frozen against (plan_pin_mismatch)', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const frozenAt = await gatewayFor();
  const other = await gatewayFor();
  const env = publishEnv(root);
  const { copy, dir, lock } = await syntheticPlan(root, { gatewayUrl: frozenAt.url, env });
  const child = await publish(copy, dir, other, env, ['--json']);
  const out = json(child, 'publish-result --json to another gateway');
  assert.deepEqual({ code: out.code, pin: out.pin, expected: out.expected, found: out.found }, { code: 'plan_pin_mismatch', pin: 'gatewayHost', expected: lock.pins.gatewayHost, found: new URL(other.url).host });
  assert.equal(child.status, 3);
  assert.deepEqual(other.requests, [], 'nothing was sent to the other gateway');
  assert.deepEqual(frozenAt.requests, []);
});

test('a refused publish says publish_failed with the HTTP status, and never prints the server\'s answer', async (t) => {
  const root = tempDir(t, 'kit-publish-');
  const gateway = await gatewayFor({ publishStatus: 400 });
  const env = publishEnv(root);
  const { copy, dir } = await syntheticPlan(root, { gatewayUrl: gateway.url, env });
  const child = await publish(copy, dir, gateway, env, ['--json']);
  const out = json(child, 'publish-result --json refused by the gateway');
  assert.deepEqual({ ok: out.ok, code: out.code, status: out.status }, { ok: false, code: 'publish_failed', status: 400 });
  assert.equal(child.status, 1);
  assert.ok(!`${child.stdout}${child.stderr}`.includes('invalid client test result'), 'the server\'s message is not echoed');
  assert.equal(posts(gateway).length, 1, 'it was sent once');
});

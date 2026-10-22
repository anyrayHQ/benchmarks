// Exercise release refusals and decisions without a listening socket. The CLI integration
// tests remain the end-to-end check against HTTP; these cover malformed and missing answers too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { releaseCheck } from '../lib/kitRelease.mjs';
import { clientTestBodySchema } from '../lib/clientTestBody.mjs';
import { freezeOk, kit, kitEnv, onlyJson, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import { ADMIN_KEY } from './kitPlanFixtures.mjs';
import { OTHER_PLAN, TWIN_OF, storedResult } from './kitReleaseFixtures.mjs';

function setup(t) {
  const root = tempDir(t);
  const dir = writeScenariosDir(root, twoScenarios());
  const { lock } = freezeOk(t, dir);
  for (const name of ['ANYRAY_TRACE_TOKEN', 'ANYRAY_TRACE_KEY', 'ANYRAY_ADMIN_KEY']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  process.env.ANYRAY_ADMIN_KEY = ADMIN_KEY;
  return { dir, lock, gateway: 'https://gw.example.test' };
}

test('release-check compares the newest result of this plan with the current version', async (t) => {
  const { dir, lock, gateway } = setup(t);
  const current = '1.10.520';
  const latest = storedResult(lock.planHash, current, '2026-10-20T09:00:00.000Z');
  const results = [
    storedResult(lock.planHash, '1.10.509', '2026-10-01T09:00:00.000Z'), latest,
    storedResult(OTHER_PLAN, '1.10.400', '2026-10-23T09:00:00.000Z'),
  ];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.pathname.endsWith('/updates') ? { version: current } : { results });
  });
  const answer = await releaseCheck(dir, { gateway });
  assert.equal(answer.changed, false);
  assert.deepEqual(answer.published, { gatewayVersion: current, releaseTag: `v${current}`, receivedAt: latest.receivedAt });
  assert.equal(requests[1].url.search, '?latest=plan&limit=200');
  for (const { options } of requests) assert.equal(options.headers.authorization, `Bearer ${ADMIN_KEY}`);
  latest.gatewayVersion = '1.10.519';
  assert.equal((await releaseCheck(dir, { gateway })).changed, true);
  results.splice(0, 2);
  assert.deepEqual((await releaseCheck(dir, { gateway })).published, null);
  assert.equal((await releaseCheck(dir, { gateway })).changed, true);
});

test('release-check refuses malformed, non-2xx and absent answers with a content-free status', async (t) => {
  const { dir, gateway } = setup(t);
  const marker = 'SYNTHETIC_PRIVATE_RESPONSE';
  for (const [read, response, status] of [
    ['version', () => Response.json({ version: 42, detail: marker }), 200],
    ['version', () => Response.json({ version: '' }), 200],
    ['version', () => Response.json({ detail: marker }, { status: 503 }), 503],
    ['version', () => { throw new Error(marker); }, null],
    ['results', () => Response.json({ results: {} }), 200],
  ]) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url) =>
      read === 'results' && url.pathname.endsWith('/updates') ? Response.json({ version: '1.10.520' }) : response());
    await assert.rejects(releaseCheck(dir, { gateway }), (error) => {
      assert.equal(error.code, 'gateway_unreadable');
      assert.equal(error.exitCode, 1);
      assert.deepEqual(error.fields, { read, status });
      assert.ok(!JSON.stringify(error).includes(marker));
      return true;
    });
    fetchMock.mock.restore();
  }
});

test('twins requires a release tag before gateway, credentials or binary checks', (t) => {
  const root = tempDir(t);
  const child = kit(t, ['twins', '--gateway', 'https://gw.example.test', '--json'], { env: kitEnv(join(root, 'home')) });
  assert.equal(child.status, 2);
  assert.equal(onlyJson(child, 'twins without --release').code, 'usage');
});

test('the report schema refuses zero and client twin links while accepting an absent link', () => {
  const { id, receivedAt, ...body } = storedResult('a'.repeat(64), '1.10.520', '2026-10-20T09:00:00.000Z');
  assert.equal(clientTestBodySchema.safeParse(body).success, true);
  const scenario = body.scenarios[0];
  const parses = (source, twinOf) => clientTestBodySchema.safeParse({ ...body, scenarios: [{ ...scenario, source, twinOf }] }).success;
  assert.equal(parses('proposed', TWIN_OF), true);
  assert.equal(parses('proposed', '0'.repeat(64)), false);
  assert.equal(parses('client', TWIN_OF), false);
});

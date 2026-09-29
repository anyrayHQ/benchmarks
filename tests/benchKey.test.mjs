import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBenchKey, benchTenantSetup } from '../lib/benchKey.mjs';
import { describeSetup } from '../lib/agentRun.mjs';

const BENCH = 'ark_svc_bench_fake_0001';
const SHARED = 'ark_svc_shared_fake_0002';

test('the dedicated benchmark key wins, without a warning', () => {
  const warnings = [];
  const r = resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_CLIENT_KEY: SHARED, ANYRAY_BENCH_TENANT: 'bench' }, (m) => warnings.push(m));
  assert.equal(r.key, BENCH);
  assert.equal(r.source, 'ANYRAY_BENCH_CLIENT_KEY');
  assert.equal(r.dedicated, true);
  assert.equal(r.tenant, 'bench');
  assert.deepEqual(warnings, []);
});

test('without it, ANYRAY_CLIENT_KEY is used and a warning names the shared tenant', () => {
  const warnings = [];
  const r = resolveBenchKey({ ANYRAY_CLIENT_KEY: SHARED }, (m) => warnings.push(m));
  assert.equal(r.key, SHARED);
  assert.equal(r.source, 'ANYRAY_CLIENT_KEY');
  assert.equal(r.dedicated, false);
  assert.equal(r.tenant, 'default');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ANYRAY_BENCH_CLIENT_KEY/);
  assert.match(warnings[0], /default/);
  assert.ok(!warnings[0].includes(SHARED), 'the warning never prints a key');
});

test('an empty ANYRAY_BENCH_CLIENT_KEY counts as unset', () => {
  const r = resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: ' ', ANYRAY_CLIENT_KEY: SHARED }, () => {});
  assert.equal(r.source, 'ANYRAY_CLIENT_KEY');
});

test('no key at all: nothing chosen, still warned', () => {
  const warnings = [];
  const r = resolveBenchKey({}, (m) => warnings.push(m));
  assert.equal(r.key, null);
  assert.equal(r.source, null);
  assert.equal(warnings.length, 1);
});

test('a dedicated key without a declared tenant records that the tenant was not declared', () => {
  assert.equal(resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: BENCH }, () => {}).tenant, 'undeclared (set ANYRAY_BENCH_TENANT)');
});

test('an ANYRAY_BENCH_TENANT that is not an id is not recorded verbatim', () => {
  assert.equal(resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_BENCH_TENANT: 'x y\n' }, () => {}).tenant, 'invalid ANYRAY_BENCH_TENANT');
});

test('benchTenantSetup records the tenant and the key variable, never the key', () => {
  const s = benchTenantSetup(resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_BENCH_TENANT: 'bench' }, () => {}));
  assert.deepEqual(s, { tenant: 'bench', keyVar: 'ANYRAY_BENCH_CLIENT_KEY', dedicated: true });
  assert.ok(!JSON.stringify(s).includes(BENCH));
});

test('describeSetup records the tenant on the Anyray arm only, and no key', () => {
  const tenant = benchTenantSetup(resolveBenchKey({ ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_BENCH_TENANT: 'bench' }, () => {}));
  const base = { model: 'm', gatewayUrl: 'https://gw.test.invalid', runTag: 't', maxTurns: 1, enrolled: false, tenant };
  const b = describeSetup({ ...base, arm: 'anyray' });
  assert.deepEqual(b.tenant, tenant);
  assert.match(b.auth, /ANYRAY_BENCH_CLIENT_KEY/);
  assert.ok(!JSON.stringify(b).includes(BENCH));
  assert.equal(describeSetup({ ...base, arm: 'direct' }).tenant, null);
});

// ---- wiring: the live key getters and the recorded setup ----------------------

test('liveKeys: the arm (connect service key and harness header) uses the benchmark key', async () => {
  const { liveKeys } = await import('../lib/agentRun.mjs');
  const k = liveKeys({ ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_CLIENT_KEY: SHARED }, () => ({ clientKey: 'ark_machine' }));
  assert.equal(k.serviceKey(), BENCH);
  assert.equal(k.clientKey(), BENCH);
  const f = liveKeys({ ANYRAY_CLIENT_KEY: SHARED }, () => ({ clientKey: 'ark_machine' }));
  assert.equal(f.serviceKey(), SHARED);
  const none = liveKeys({}, () => ({ clientKey: 'ark_machine' }));
  assert.equal(none.serviceKey(), undefined, 'no env key: connect falls back (needs enrollment)');
  assert.equal(none.clientKey(), 'ark_machine', 'the harness header falls back to the machine profile');
});

test('armSetups records the tenant on the Anyray slot only', async () => {
  const { parseArgs, armSetups } = await import('../run_agent.mjs');
  const tenant = { tenant: 'bench', keyVar: 'ANYRAY_BENCH_CLIENT_KEY', dedicated: true };
  const s = armSetups(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']), { a: 'direct', b: 'anyray' }, { model: 'm', gatewayUrl: 'https://gw.test.invalid' }, { maxTurns: 1 }, { enrolled: false, tenant });
  assert.deepEqual(s.b.tenant, tenant);
  assert.equal(s.a.tenant, null);
});

test('connectPolicy reads with the benchmark key', async () => {
  const { connectPolicy } = await import('../lib/traces.mjs');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['x-anyray-api-key']);
    return { ok: true, json: async () => ({ skills: [] }) };
  };
  await connectPolicy('https://gw.test.invalid', { env: { ANYRAY_BENCH_CLIENT_KEY: BENCH, ANYRAY_CLIENT_KEY: SHARED }, fetchImpl });
  assert.deepEqual(seen, [BENCH]);
});

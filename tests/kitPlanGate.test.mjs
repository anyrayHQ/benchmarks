// The plan's tenant check (ANY-1486): before it plans anything, `plan` reads the tenant's
// session gate through the gateway admin API (GET /admin/v1/optimizer/session-gate, admin key)
// and refuses a tenant whose every gated kind is still in shadow: that tenant applies nothing
// yet, so a paired test would measure pass-through. A gate it cannot read is refused too, never
// assumed. The gateway here is a fake on 127.0.0.1; the admin key is synthetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir, writeScenariosDir } from './kitFixtures.mjs';
import {
  ADMIN_KEY, ALL_SHADOW, APPLYING, fakeGateway, gateRow, json, planEnv, planOk, planRun, shapedScenarios,
} from './kitPlanFixtures.mjs';

const BUDGET = ['--budget-usd', '500', '--session-cost-usd', '0.15'];
const GATE = '/admin/v1/optimizer/session-gate';
const gateReads = (gateway) => gateway.requests.filter((r) => r.path === GATE);
const noKey = (run, what) => assert.ok(!run.stdout.includes(ADMIN_KEY) && !run.stderr.includes(ADMIN_KEY), `${what} printed the admin key`);

test('a tenant whose every gated kind is in shadow is refused: plan_tenant_shadow, exit 3, with the tenant and its kind counts, and no plan', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t, { strategies: ALL_SHADOW });
  const child = await planRun(t, dir, gateway, [...BUDGET, '--json']);
  const out = json(child, 'plan --json (all shadow)');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'plan', code: 'plan_tenant_shadow' });
  assert.equal(out.tenant, 'acme');
  assert.deepEqual(out.kinds, { on: 0, shadow: 4, off: 0 });
  assert.equal(typeof out.message, 'string');
  assert.ok(out.message.length > 0, 'the refusal says why');
  assert.ok(!Object.hasOwn(out, 'scenarios'), 'a refused plan prints no plan');
  assert.equal(child.status, 3);
  noKey(child, 'plan --json (all shadow)');

  // The read the refusal rests on: the session gate, with the admin key as a bearer token.
  const [read] = gateReads(gateway);
  assert.ok(read, 'plan read the session gate');
  assert.equal(read.method, 'GET');
  assert.equal(read.authorization, `Bearer ${ADMIN_KEY}`);

  const human = await planRun(t, dir, gateway, BUDGET);
  assert.equal(human.status, 3, `exit ${human.status}`);
  assert.match(human.stderr, /^plan_tenant_shadow\b/m, 'the human refusal is a stderr line that starts with its code');
  assert.equal(human.stdout.trim(), '', 'and no plan on stdout');
  noKey(human, 'plan (all shadow)');
});

test('one kind on is enough: a tenant that applies something gets its plan, with the kind counts', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t, { strategies: APPLYING });
  const child = await planRun(t, dir, gateway, [...BUDGET, '--json']);
  const out = planOk(child, 'plan --json (applying tenant)');
  assert.deepEqual(out.tenant, { id: 'acme', kinds: { on: 1, shadow: 1, off: 1 } });
  noKey(child, 'plan --json (applying tenant)');
});

test('the refusal reads each kind\'s effective state: a shadow row forced on by an override counts as on', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const strategies = [gateRow('observation_mask', 'shadow', 'force_on'), gateRow('relevance_filter', 'shadow'), gateRow('window_budget', 'shadow')];
  const gateway = await fakeGateway(t, { strategies });
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json (shadow forced on)');
  assert.deepEqual(out.tenant.kinds, { on: 1, shadow: 2, off: 0 });
});

test('a gate with no gated kinds at all (every kind exempt) is not "every kind in shadow"', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t, { strategies: [] });
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json (no gated kinds)');
  assert.deepEqual(out.tenant.kinds, { on: 0, shadow: 0, off: 0 });
});

test('--tenant reaches the gate read as ?tenant=, and without it no tenant is sent', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  planOk(await planRun(t, dir, gateway, [...BUDGET, '--tenant', 'acme-eu', '--json']), 'plan --tenant acme-eu --json');
  planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json');
  const [withTenant, without] = gateReads(gateway);
  assert.deepEqual(withTenant?.query, { tenant: 'acme-eu' });
  assert.deepEqual(without?.query, {});
});

test('a gate the plan cannot read is refused, never assumed: no admin key (and no request), a 403, a body with no strategies', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());

  const unasked = await fakeGateway(t);
  const env = planEnv(t);
  delete env.ANYRAY_ADMIN_KEY;
  const k = await planRun(t, dir, unasked, [...BUDGET, '--json'], { env });
  const kOut = json(k, 'plan --json without an admin key');
  assert.deepEqual({ ok: kOut.ok, code: kOut.code, reason: kOut.reason }, { ok: false, code: 'plan_tenant_unreadable', reason: 'no_admin_key' });
  assert.equal(k.status, 3);
  assert.deepEqual(unasked.requests, [], 'without a key, plan made a request anyway');

  for (const [label, opts, reason] of [
    ['a 403', { status: 403 }, 'request_failed'],
    ['a body with no strategies', { body: { tenant: 'acme' } }, 'bad_response'],
  ]) {
    const gateway = await fakeGateway(t, opts);
    const child = await planRun(t, dir, gateway, [...BUDGET, '--json']);
    const out = json(child, `plan --json (${label})`);
    assert.deepEqual({ ok: out.ok, code: out.code, reason: out.reason }, { ok: false, code: 'plan_tenant_unreadable', reason }, label);
    assert.equal(child.status, 3, label);
    assert.ok(gateReads(gateway).length >= 1, `${label}: the gate was read`);
    noKey(child, `plan --json (${label})`);
  }
});

// Guards that do not need a listening socket, including the client-name attribution fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { redactedRecord } from '../lib/kitResults.mjs';
import { verifyPlan, writeNoise } from '../lib/planLock.mjs';
import { earlyHoldout, kindsObserved } from '../lib/optimizationKinds.mjs';
import { forwardHeaders } from '../lib/resultProxy.mjs';
import { roundTags, runPairWithRedraw } from '../run_agent.mjs';
import { PINS, fakeClaude, freezeOk, kit, kitEnv, lockPath, onlyJson, readLock, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import { MARK, contentRound, leaks } from './kitRunFixtures.mjs';

function plan(t) {
  const dir = writeScenariosDir(tempDir(t), twoScenarios());
  return { dir, lock: freezeOk(t, dir).lock };
}
const measurement = (lock) => ({ sd: 0.3, rounds: 12, byScenario: lock.scenarios.map(({ id }) => ({ id, n: 6, sd: 0.3 })) });

test('kit records discard new and nested content fields while preserving outcomes and costs', (t) => {
  const { lock } = plan(t);
  const r = contentRound(1, 2, 1);
  r.sessions.a.futureContent = MARK.task;
  r.sessions.a.totals.futureContent = MARK.paste;
  r.sessions.a.check.futureContent = MARK.checkCmd;
  r.sessions.a.citations = { total: 4, resolved: 3, exact: 2, bySuffix: 1, ambiguous: 0, unresolved: [MARK.task] };
  r.futureContent = MARK.followup;
  const record = redactedRecord({ compare: 'anyray', rounds: [r], futureContent: MARK.repo }, lock, 'acme-fix', '1.10.515');
  assert.deepEqual(leaks(JSON.stringify(record)), []);
  assert.equal(record.rounds[0].sessions.a.totals.costUsd, 2);
  assert.equal(record.rounds[0].sessions.a.check.passed, true);
  assert.equal(record.rounds[0].quality.b, true);
  assert.deepEqual(record.rounds[0].sessions.a.citations, { total: 4, resolved: 3, exact: 2, bySuffix: 1, ambiguous: 0 });
  assert.deepEqual(record.scenario, lock.scenarios.find((s) => s.id === 'acme-fix'));
});

test('noise signatures reject changed measurements independently of the unchanged plan hash', (t) => {
  const { dir, lock } = plan(t);
  writeNoise(dir, lock, measurement(lock));
  assert.equal(verifyPlan(dir).planHash, lock.planHash);
  const signed = readLock(dir);
  for (const edit of [(l) => { l.noise.sd /= 2; }, (l) => { l.noise.byScenario[0].n++; }]) {
    const changed = structuredClone(signed);
    edit(changed);
    writeFileSync(lockPath(dir), JSON.stringify(changed));
    assert.throws(() => verifyPlan(dir), (e) => e.code === 'plan_lock_invalid' && e.fields.reason === 'noise_hash');
  }
});

test('execution refusals happen before even the version invocation, without needing a gateway', (t) => {
  const { dir, lock } = plan(t);
  const claude = fakeClaude(t);
  const env = kitEnv(tempDir(t), { ANYRAY_GATEWAY_URL: `https://${PINS.gatewayHost}`, ANYRAY_BENCH_CLIENT_KEY: 'synthetic', ANYRAY_ADMIN_KEY: 'synthetic' });
  const run = (extra = {}) => kit(t, ['run', '--scenarios-dir', dir, '--claude-bin', claude.bin, '--rounds', '1', '--json'], { env: { ...env, ...extra } });
  assert.equal(onlyJson(run(), 'missing noise').code, 'plan_noise_missing');
  writeNoise(dir, lock, measurement(lock));
  for (const [extra, code] of [
    [{ ANYRAY_GATEWAY_URL: 'https://other.example.test' }, 'plan_pin_mismatch'],
    [{ ANYRAY_BENCH_EXTRA_HEADERS: 'x-anyray-tool-defer: off' }, 'env_refused'],
    [{ ANYRAY_BENCH_CLIENT_KEY: '' }, 'bench_key_missing'],
    [{ ANYRAY_ADMIN_KEY: '' }, 'admin_key_missing'],
  ]) assert.equal(onlyJson(run(extra), code).code, code);
  assert.deepEqual(claude.invocations(), []);
});

test('client metadata cannot override the bench tool or the attempt session id', () => {
  const headers = forwardHeaders({ host: 'local', 'x-anyray-optimization-kinds': 'client-selected-kind', 'x-anyray-metadata': JSON.stringify({ tool: 'claude-code', sessionId: 'client-session' }) }, { tool: 'client-declared-tool', sessionId: 'attempt-session', intent: 'hash-prefix' }, true);
  assert.equal(headers['x-anyray-optimization-kinds'], undefined);
  assert.equal(headers.host, undefined);
  assert.deepEqual(JSON.parse(headers['x-anyray-metadata']), { tool: 'anyray-bench', sessionId: 'attempt-session', intent: 'hash-prefix' });
});

test('external scenario attribution uses its frozen hash prefix on both arms and redraws use fresh tags', (t) => {
  const { dir, lock } = plan(t);
  const args = { scenariosDir: dir, planLock: lock, scenario: 'acme-fix', compare: 'anyray' };
  const hash = lock.scenarios.find((s) => s.id === args.scenario).hash.slice(0, 16);
  const first = roundTags(args, 1, 1);
  const next = roundTags(args, 1, 1);
  for (const tag of Object.values(first)) {
    assert.equal(tag.intent, hash);
    assert.ok(tag.sessionId.includes(hash));
    assert.ok(!JSON.stringify(tag).includes(args.scenario));
  }
  assert.notEqual(first.b.sessionId, next.b.sessionId);
});

test('tenant defaults observe all feedback kinds and watch any early held kind with zero redraws', async () => {
  const result = { status: 'applied', applied: ['relevance_filter'], preserved: ['code_graph'], skipped: [{ kind: 'observation_mask', guard: 'holdout_whole' }] };
  assert.deepEqual(kindsObserved([result]), ['code_graph', 'observation_mask', 'relevance_filter']);
  assert.deepEqual(earlyHoldout([result], null), ['observation_mask']);
  assert.deepEqual(earlyHoldout([result, result, result, result], null), []);
  let attempts = 0;
  const start = async (redraw) => { attempts++; redraw.report('b')(earlyHoldout([result], null)); return { settled: [] }; };
  const last = await runPairWithRedraw(start, 0, () => {}, true);
  assert.equal(attempts, 1);
  assert.deepEqual(last.holdoutDrawn, { b: ['observation_mask'] });
  assert.deepEqual(last.redraws, []);
  attempts = 0;
  const retried = await runPairWithRedraw(start, 1, () => {}, true);
  assert.equal(attempts, 2);
  assert.deepEqual(retried.holdoutDrawn, { b: ['observation_mask'] });
  assert.deepEqual(retried.redraws, [{ b: ['observation_mask'] }]);
});

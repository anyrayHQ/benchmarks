// `npm run report -- --redact` (ANY-1487): the shareable report of a frozen plan. Scenario ids,
// source, shape ids, ratios, intervals, the verdict words, the predicted bands, and the Claude
// Code and gateway versions; never the task text, follow-ups, pastes, patch, check command, key
// facts, repo URL, answers, tool I/O or diffs, even when a record carries them. `--json` prints
// exactly the body the gateway's POST /admin/v1/client-tests accepts (ANY-1488), checked here
// against a copy of that route's schema. Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { benchVerdict, exclusionReasons } from '../lib/benchVerdict.mjs';
import { rule0, solvedPairVerdict } from '../lib/stats.mjs';
import { PINS, changeOneByte, kitEnv, tempDir } from './kitFixtures.mjs';
import { json, readCatalog } from './kitPlanFixtures.mjs';
import { GATEWAY_VERSION, assertGatewayBody, kitIn, leaks, syntheticPlan } from './kitRunFixtures.mjs';

const report = (copy, dir, env, args) => kitIn(copy.root, ['report', '--scenarios-dir', dir, ...args], { env });

/** The body the report must print, built from the lock, the kit and the libraries on the same rounds. */
function expectedBody(copy, lock, rounds) {
  const ids = lock.scenarios.map((s) => s.id);
  const valid = Object.fromEntries(ids.map((id) => [id, (rounds[id] ?? []).filter((r) => exclusionReasons(r).length === 0)]));
  const scenarios = ids.map((id) => {
    const rs = rounds[id] ?? [];
    const v = benchVerdict(rs);
    const s = rule0(valid[id]);
    const { prediction, shapeId } = lock.predictions.find((p) => p.id === id);
    return {
      shapeId: shapeId ?? 'unknown',
      source: lock.scenarios.find((x) => x.id === id).source,
      predictedBand: prediction.status === 'band' ? { kind: 'band', low: prediction.lo, high: prediction.hi } : { kind: 'none' },
      n: v.n,
      excluded: v.excludedCount,
      winRate: s.winRate,
      median: s.median,
      q3: s.q3,
      max: s.max,
      ci95: v.confidenceInterval95 ? { lower: v.confidenceInterval95.lower, upper: v.confidenceInterval95.upper } : null,
      verdict: v.verdict,
    };
  });
  const pooled = ids.flatMap((id) => rounds[id] ?? []);
  return {
    planHash: lock.planHash,
    kitVersion: copy.version,
    benchmarksCommit: lock.benchmarksCommit,
    gatewayVersion: GATEWAY_VERSION,
    releaseTag: `v${GATEWAY_VERSION}`,
    clientTool: lock.pins.client,
    clientToolVersion: lock.pins.clientVersion,
    model: lock.pins.model,
    provider: lock.pins.provider,
    scenarios,
    totals: {
      n: scenarios.reduce((a, s) => a + s.n, 0),
      excluded: scenarios.reduce((a, s) => a + s.excluded, 0),
      costUsdPerSession: (() => {
        const all = ids.flatMap((id) => valid[id]);
        const mean = (slot) => (all.length ? all.reduce((a, r) => a + r.sessions[slot].totals.costUsd, 0) / all.length : 0);
        return { direct: mean('a'), anyray: mean('b') };
      })(),
    },
    rule0Verdict: pooled.length ? solvedPairVerdict(pooled.filter((r) => !r.gatewayRestarted)).verdict : 'NO DATA',
  };
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

test('report --redact --json is exactly the body the gateway accepts: plan, pins, versions, per-scenario statistics and verdicts', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock, rounds } = await syntheticPlan(root, { env });
  const child = await report(copy, dir, env, ['--redact', '--json']);
  const body = json(child, 'report --redact --json');
  assert.equal(child.status, 0, `report failed: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-400)}`);
  assertGatewayBody(body, 'report --json');

  const want = expectedBody(copy, lock, rounds);
  const { totals, ...rest } = body;
  const { totals: wantTotals, ...wantRest } = want;
  assert.deepEqual(rest, wantRest, 'every field from its source: the lock, the kit, the records through benchVerdict and rule0');
  assert.deepEqual({ n: totals.n, excluded: totals.excluded }, { n: wantTotals.n, excluded: wantTotals.excluded });
  for (const slot of ['direct', 'anyray']) {
    assert.ok(close(totals.costUsdPerSession[slot], wantTotals.costUsdPerSession[slot]), `costUsdPerSession.${slot}: ${totals.costUsdPerSession[slot]} vs ${wantTotals.costUsdPerSession[slot]}`);
  }
  // Pinned on purpose, not only computed: the shapes the catalog gave, the order, the unknown shape.
  assert.deepEqual(body.scenarios.map((s) => s.shapeId), ['t-cc-check-long', 't-docs-few', 'unknown', 't-cc-short'], 'in the lock\'s (id) order; no shape is "unknown"');
  assert.deepEqual(body.scenarios.map((s) => s.verdict), ['pass', 'inconclusive', 'inconclusive', 'fail']);
  assert.equal(body.clientToolVersion, PINS.clientVersion);
});

test('report never carries task text, follow-ups, pastes, patch, check, key facts, repo URL, answers, tool I/O or diffs, even when a record does', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env, marked: true });

  const human = await report(copy, dir, env, ['--redact']);
  assert.equal(human.status, 0, `report failed: ${human.stderr.slice(-400)}`);
  assert.deepEqual(leaks(human.stdout), [], 'the report text carries client content');
  assert.deepEqual(leaks(human.stderr), [], 'the report diagnostics carry client content');
  const asJson = await report(copy, dir, env, ['--redact', '--json']);
  assert.equal(asJson.status, 0, `report --json failed: ${asJson.stdout.slice(0, 400)}`);
  assert.deepEqual(leaks(asJson.stdout), [], 'the body carries client content');

  // ...and it is still the report: ids, shapes, versions, the verdict words.
  for (const s of lock.scenarios) assert.ok(human.stdout.includes(s.id), `the report names ${s.id}`);
  for (const id of ['t-cc-check-long', 't-cc-short', 't-docs-few', 'unknown']) assert.ok(human.stdout.includes(id), `the report names the shape ${id}`);
  assert.ok(human.stdout.includes(GATEWAY_VERSION), 'the gateway version');
  assert.ok(human.stdout.includes(PINS.clientVersion), 'the Claude Code version');
  const body = json(asJson, 'report --redact --json');
  assert.ok(human.stdout.includes(body.rule0Verdict), `the Rule 0 verdict ${body.rule0Verdict}`);
  for (const word of new Set(body.scenarios.map((s) => s.verdict))) {
    assert.ok(human.stdout.split(/[^A-Za-z]+/).some((w) => w.toLowerCase() === word), `the verdict word ${word}`);
  }
  assert.ok(!human.stdout.includes(lock.nonce) && !asJson.stdout.includes(lock.nonce), 'the nonce is never printed');
});

test('report needs --redact: there is no unredacted report of a client plan (usage)', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const redacted = await report(copy, dir, env, ['--redact', '--json']);
  assert.equal(redacted.status, 0, `the same plan reports with --redact: ${redacted.stdout.slice(0, 300)}`);
  for (const args of [['--json'], []]) {
    const child = await report(copy, dir, env, args);
    assert.equal(child.status, 2, `report ${args.join(' ')} without --redact: exit ${child.status}`);
    if (args.includes('--json')) {
      const out = json(child, 'report --json without --redact');
      assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'report', code: 'usage' });
    } else {
      assert.equal(child.stdout, '', 'nothing on stdout');
      assert.match(child.stderr, /^usage/m);
    }
  }
});

test('a body the gateway would refuse is never printed: report_invalid names the path, never a value', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env, gatewayVersion: null }); // the run could not read it
  const child = await report(copy, dir, env, ['--redact', '--json']);
  const out = json(child, 'report --redact --json with no gateway version');
  assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'report', code: 'report_invalid' });
  assert.equal(child.status, 1);
  assert.ok(Array.isArray(out.issues) && out.issues.some((i) => JSON.stringify(i.path) === '["gatewayVersion"]' && typeof i.code === 'string'), JSON.stringify(out.issues));
  for (const i of out.issues) assert.deepEqual(Object.keys(i).sort(), ['code', 'path'], 'an issue is a path and a code');
});

test('report refuses a scenarios dir that changed after the freeze (plan_hash_mismatch)', async (t) => {
  const root = tempDir(t, 'kit-report-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env });
  changeOneByte(join(dir, 'check-long', 'scenario.yaml'), 'failing test', 'failing tesu');
  const child = await report(copy, dir, env, ['--redact', '--json']);
  const out = json(child, 'report --json after a change');
  assert.deepEqual({ code: out.code, expected: out.expected, changed: out.changed }, { code: 'plan_hash_mismatch', expected: lock.planHash, changed: ['check-long'] });
  assert.equal(child.status, 3);
});

test('"unknown" stands for no shape in a report, so the committed catalog never names a shape "unknown"', () => {
  const catalog = readCatalog();
  assert.ok(Array.isArray(catalog?.shapes) && catalog.shapes.length > 0, 'the committed catalog has shapes');
  assert.ok(!catalog.shapes.some((s) => s.id === 'unknown'), 'a catalog shape named "unknown" would read as no shape');
});

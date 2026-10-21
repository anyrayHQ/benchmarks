// `npm run plan` (ANY-1486): before any paid call, the kit classifies each scenario by
// content-free shape features, looks its shape up in predictions.yaml for a predicted BAND of
// paired cost ratios (or `prediction: none`), and says how many pairs that band needs at 80%
// power, what the budget can detect instead, and the most the plan can spend. Driven only
// through the CLI, against scenario dirs in temp directories and a fake gateway on 127.0.0.1.
// Most cases run a COPY of the kit with a test catalog (kitCopy), so the bands are the test's
// own; the real committed catalog is checked for consistency, never for its values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, REF, fixScenario, tempDir, writeScenariosDir } from './kitFixtures.mjs';
import {
  ADMIN_KEY, HEX40, MIN_PUBLIC_ROUNDS, TEST_SHAPES, byId, expectedPrediction, fakeGateway, firstShape, formulaDetectable,
  formulaPairs, gitHead, json, kitAsync, kitCopy, npmRunAsync, planEnv, planOk, planRun, readCatalog, shapeGrid,
  shapeScenario, shapedScenarios,
} from './kitPlanFixtures.mjs';

const BUDGET = ['--budget-usd', '500', '--session-cost-usd', '0.15'];
const shape = (id) => TEST_SHAPES.find((s) => s.id === id);

/** Every budget field follows from the answer's own bands and the formula (contract section 6). */
function assertBudgetMath(out, { budget, cost }) {
  const n = out.scenarios.length;
  assert.equal(out.budgetUsd, budget);
  assert.equal(out.sessionCostUsd, cost);
  assert.ok(Math.abs(out.pairCostUsd - 2 * cost) < 1e-12, `a pair is two sessions: ${out.pairCostUsd}`);
  assert.equal(out.pairsAffordable, Math.floor(budget / n / (2 * cost)), 'the budget is split evenly across the scenarios');
  const detectable = formulaDetectable(out.pairsAffordable);
  if (detectable === null) assert.equal(out.detectableRatio, null, 'fewer than two pairs detect nothing');
  else assert.ok(Math.abs(out.detectableRatio - detectable) < 1e-9, `detectableRatio ${out.detectableRatio} != ${detectable}`);
  let planned = 0;
  const bands = [];
  for (const s of out.scenarios) {
    if (s.prediction?.status === 'band') {
      bands.push(s);
      assert.ok(Math.abs(s.target - (s.prediction.lo + s.prediction.hi) / 2) < 1e-12, `${s.id}: target is the band midpoint`);
      assert.equal(s.pairsNeeded, formulaPairs(s.target), `${s.id}: pairs needed at 80% power for the midpoint`);
      assert.equal(s.resolvable, s.pairsNeeded !== null && out.pairsAffordable >= s.pairsNeeded, `${s.id}: resolvable`);
      assert.equal(s.pairsPlanned, s.pairsNeeded === null ? out.pairsAffordable : Math.min(s.pairsNeeded, out.pairsAffordable), `${s.id}: pairs planned`);
    } else {
      assert.deepEqual({ target: s.target, pairsNeeded: s.pairsNeeded, resolvable: s.resolvable }, { target: null, pairsNeeded: null, resolvable: null }, `${s.id}: no prediction, so nothing to resolve (null, not false)`);
      assert.equal(s.pairsPlanned, out.pairsAffordable, `${s.id}: pairs planned`);
    }
    planned += s.pairsPlanned;
  }
  assert.ok(Math.abs(out.spendCeilingUsd - planned * out.pairCostUsd) < 1e-6, `spendCeilingUsd ${out.spendCeilingUsd} != ${planned} pairs x ${out.pairCostUsd}`);
  assert.ok(out.spendCeilingUsd <= budget + 1e-9, 'the ceiling never exceeds the budget');
  assert.equal(out.resolvable, bands.length > 0 && bands.every((s) => s.resolvable === true), 'the plan resolves only when every band does');
}

// ---- shape features ----------------------------------------------------------------------------

test('plan derives each scenario\'s shape features from scenario.yaml and --client: turn cap, follow-ups, pastes, pauses, MCP tool count, grading', async (t) => {
  const base = { client: 'claude-code', cacheMarkers: 'client', mcp: 'none', requests: 'single', pause: false, outcome: 'check' };
  const cases = {
    'cap-8': [shapeScenario({}, { maxTurns: 8, followups: ['a'], followupDelaySec: 300 }), { requests: 'short', pause: true }],
    'cap-9': [shapeScenario({}, { maxTurns: 9 }), {}],
    'one-followup-299': [shapeScenario({}, { followups: ['a'], followupDelaySec: 299 }), { requests: 'medium' }],
    'two-followups': [shapeScenario({}, { followups: ['a', 'b'] }), { requests: 'long' }],
    'paste-only': [{ ...shapeScenario({}, { pastes: { log: 'log.txt' }, task: 'Fix it:\n\n{{log}}' }), files: { 'log.txt': 'not ok 1\n' } }, { requests: 'long' }],
    'delay-list-second': [shapeScenario({}, { followups: ['a', 'b'], followupDelaySec: [0, 420] }), { requests: 'long', pause: true }],
    'delay-list-unused': [shapeScenario({}, { followups: ['a', 'b'], followupDelaySec: [0, 0, 900] }), { requests: 'long' }],
    'delay-no-followups': [shapeScenario({}, { followupDelaySec: 900 }), {}],
    'mcp-0': [shapeScenario({}, { mcpTools: 0 }), {}],
    'mcp-1': [shapeScenario({}, { mcpTools: 1 }), { mcp: 'some' }],
    'mcp-99': [shapeScenario({}, { mcpTools: 99 }), { mcp: 'some' }],
    'mcp-100': [shapeScenario({}, { mcpTools: 100 }), { mcp: 'many' }],
    docs: [shapeScenario({ outcome: 'citations' }), { outcome: 'citations' }],
    facts: [shapeScenario({ outcome: 'keyFacts' }), { outcome: 'keyFacts' }],
  };
  const dir = writeScenariosDir(tempDir(t), Object.fromEntries(Object.entries(cases).map(([id, [s]]) => [id, s])));
  const gateway = await fakeGateway(t);

  const cc = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json');
  assert.equal(cc.client, 'claude-code', 'claude-code is the default client');
  const ccById = byId(cc.scenarios);
  for (const [id, [, expected]] of Object.entries(cases)) assert.deepEqual(ccById[id]?.features, { ...base, ...expected }, id);

  const codex = planOk(await planRun(t, dir, gateway, [...BUDGET, '--client', 'codex', '--json']), 'plan --client codex --json');
  assert.equal(codex.client, 'codex');
  const codexById = byId(codex.scenarios);
  for (const [id, [, expected]] of Object.entries(cases)) {
    assert.deepEqual(codexById[id]?.features, { ...base, ...expected, client: 'codex', cacheMarkers: 'none' }, `${id} (codex sets no cache markers)`);
  }
});

// ---- matching, bands and the ladder (test catalog) ----------------------------------------------

test('each scenario takes the FIRST catalog shape whose every match key equals its features, with that shape\'s band, and the pairs its midpoint needs (135, 604, 53)', async (t) => {
  const copy = kitCopy(t);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json'], { kitRoot: copy.root }), 'plan --json (test catalog)');
  assert.equal(out.benchmarksCommit, copy.head, 'benchmarksCommit is the kit checkout\'s HEAD');
  assert.deepEqual(out.sd, { value: 0.924, source: 'prior' }, 'the prior sd, labelled prior until noise rounds exist');
  assert.equal(out.alpha, 0.05);
  assert.equal(out.power, 0.8);
  assert.deepEqual(out.scenarios.map((s) => s.id), Object.keys(shapedScenarios()).sort(), 'every scenario, sorted by id');

  const s = byId(out.scenarios);
  const expected = {
    'check-long': ['t-cc-check-long', 0.8, 135],
    'short-task': ['t-cc-short', (0.85 + 0.95) / 2, 604],
    paused: ['t-cc-medium-pause', 0.7, 53],
    'mcp-check-long': ['t-mcp-many', 0.25, 4],
  };
  for (const [id, [shapeId, target, pairs]] of Object.entries(expected)) {
    assert.equal(s[id].shapeId, shapeId, id);
    assert.deepEqual(s[id].prediction, expectedPrediction(shape(shapeId)), `${id}: the band, its expectation and its rounds`);
    assert.ok(Math.abs(s[id].target - target) < 1e-12, `${id}: target ${s[id].target}`);
    assert.equal(s[id].pairsNeeded, pairs, `${id}: pairs needed`);
  }
  assert.equal(s['mcp-check-long'].shapeId, 't-mcp-many', 'the 200-tool seat matches t-mcp-many, listed before t-cc-check-long: first match wins');
  assert.equal(s['short-task'].prediction.expect, 'parity', 'parity is an explicit prediction, with a band');
  assert.equal(s.paused.prediction.rounds, MIN_PUBLIC_ROUNDS, 'eight public rounds are enough for a band');

  assert.equal(s.docs.shapeId, 't-docs-few', 'a known shape...');
  assert.deepEqual(s.docs.prediction, { status: 'none', reason: 'too_few_rounds', rounds: 7 }, '...with fewer than 8 public rounds has no prediction');
  assert.equal(s.facts.shapeId, null, 'no shape matches');
  assert.deepEqual(s.facts.prediction, { status: 'none', reason: 'unknown_shape' });
  for (const id of ['docs', 'facts']) assert.deepEqual([s[id].target, s[id].pairsNeeded], [null, null], id);
});

test('the client decides the shape: under --client codex the same scenarios take the codex shape, a parity band centred on 1 that no number of pairs resolves', async (t) => {
  const copy = kitCopy(t);
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--client', 'codex', '--json'], { kitRoot: copy.root }), 'plan --client codex --json');
  const s = byId(out.scenarios);
  assert.equal(s['mcp-check-long'].shapeId, 't-mcp-many', '{ mcp: many } names no client, and it is listed first');
  for (const id of ['check-long', 'short-task', 'paused', 'docs', 'facts']) {
    assert.equal(s[id].shapeId, 't-codex-parity', id);
    assert.deepEqual(s[id].prediction, { status: 'band', expect: 'parity', lo: 0.9, hi: 1.1, rounds: 8 }, id);
    assert.equal(s[id].target, 1, `${id}: (0.9 + 1.1) / 2`);
    assert.equal(s[id].pairsNeeded, null, `${id}: a ratio of exactly 1 needs no finite number of pairs`);
    assert.equal(s[id].resolvable, false, `${id}: so it is never resolvable (false: there IS a band)`);
  }
  assert.equal(out.resolvable, false);
});

// ---- the budget: what it can detect, the ceiling, resolvable ------------------------------------

test('the budget: pairs affordable per scenario, the effect it can detect, the spend ceiling, and whether it resolves every band', async (t) => {
  const copy = kitCopy(t);
  const all = shapedScenarios();
  const four = { 'check-long': all['check-long'], 'short-task': all['short-task'], docs: all.docs, facts: all.facts };
  const dir = writeScenariosDir(tempDir(t), four);
  const gateway = await fakeGateway(t);
  const plan = async (budget, cost, d = dir) => planOk(
    await planRun(t, d, gateway, ['--budget-usd', String(budget), '--session-cost-usd', String(cost), '--json'], { kitRoot: copy.root }),
    `plan --budget-usd ${budget} --session-cost-usd ${cost}`,
  );

  // $500 at $0.15 a session: 416 pairs per scenario; 135 resolves the 0.8 band, 604 for 0.9 does not.
  const a = await plan(500, 0.15);
  assertBudgetMath(a, { budget: 500, cost: 0.15 });
  assert.equal(a.pairsAffordable, 416);
  assert.deepEqual(Object.fromEntries(a.scenarios.map((s) => [s.id, s.resolvable])), { 'check-long': true, 'short-task': false, docs: null, facts: null });
  assert.equal(a.resolvable, false, 'a budget that cannot resolve a predicted band is reported as such');
  assert.ok(Math.abs(a.spendCeilingUsd - 414.9) < 1e-6, `135 + 3 x 416 pairs at $0.30: ${a.spendCeilingUsd}`);

  // The boundary: exactly 604 pairs resolves the 0.9 band, 603 does not.
  const b = await plan(724.9, 0.15);
  assertBudgetMath(b, { budget: 724.9, cost: 0.15 });
  assert.equal(b.pairsAffordable, 604);
  assert.equal(b.resolvable, true, 'every band resolvable');
  const c = await plan(724.7, 0.15);
  assertBudgetMath(c, { budget: 724.7, cost: 0.15 });
  assert.equal(c.pairsAffordable, 603);
  assert.equal(c.resolvable, false);

  // One pair detects nothing.
  const one = writeScenariosDir(tempDir(t), { 'check-long': all['check-long'] });
  const d = await plan(0.5, 0.15, one);
  assertBudgetMath(d, { budget: 0.5, cost: 0.15 });
  assert.equal(d.pairsAffordable, 1);
  assert.equal(d.detectableRatio, null);

  // No band at all: nothing to resolve, so the plan is not resolvable however large the budget.
  const none = writeScenariosDir(tempDir(t), { docs: all.docs, facts: all.facts });
  const e = await plan(10000, 0.15, none);
  assertBudgetMath(e, { budget: 10000, cost: 0.15 });
  assert.equal(e.resolvable, false);
});

// ---- the real catalog ---------------------------------------------------------------------------

test('an unknown shape is `prediction: none`: in --json (unknown_shape, nothing to resolve) and as the literal text in the human plan', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapeGrid());
  const gateway = await fakeGateway(t);
  const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json (grid, real catalog)');
  const unknown = out.scenarios.filter((s) => s.shapeId === null);
  assert.ok(unknown.length > 0, 'some kit-runnable shape has no catalog entry (the catalog has no catch-all)');
  for (const s of unknown) {
    assert.deepEqual(s.prediction, { status: 'none', reason: 'unknown_shape' }, s.id);
    assert.deepEqual([s.target, s.pairsNeeded, s.resolvable], [null, null, null], s.id);
  }

  const human = await planRun(t, dir, gateway, BUDGET);
  assert.equal(human.status, 0, `plan (human): exit ${human.status}: ${human.stderr.slice(0, 400)}`);
  const id = unknown[0].id;
  const line = human.stdout.split('\n').find((l) => l.includes(id));
  assert.ok(line, `the human plan has a line for ${id}`);
  assert.ok(line.includes('prediction: none'), `the line for ${id} says "prediction: none": ${JSON.stringify(line)}`);
});

test('the committed catalog drives the real kit: each scenario takes the first shape it matches, the 8-round floor decides band or none, and every shape is reachable', async (t) => {
  const catalog = readCatalog();
  const dir = writeScenariosDir(tempDir(t), shapeGrid());
  const gateway = await fakeGateway(t);
  const reached = new Set();
  for (const client of ['claude-code', 'codex']) {
    const out = planOk(await planRun(t, dir, gateway, [...BUDGET, '--client', client, '--json']), `plan --client ${client} --json (grid)`);
    assert.equal(out.scenarios.length, Object.keys(shapeGrid()).length);
    assert.match(out.benchmarksCommit ?? '', HEX40);
    assert.equal(out.benchmarksCommit, gitHead(KIT_ROOT), 'benchmarksCommit is the kit checkout\'s HEAD');
    for (const s of out.scenarios) {
      const expected = firstShape(catalog, s.features);
      assert.equal(s.shapeId, expected?.id ?? null, `${client} ${s.id} ${JSON.stringify(s.features)}`);
      assert.deepEqual(s.prediction, expectedPrediction(expected), `${client} ${s.id}`);
      if (expected) reached.add(expected.id);
    }
  }
  const dead = catalog.shapes.map((s) => s.id).filter((id) => !reached.has(id));
  assert.deepEqual(dead, [], 'shapes no kit scenario can reach (shadowed by an earlier shape, or naming a client the kit does not run)');
});

// ---- content stays out ----------------------------------------------------------------------------

test('plan --json is one JSON value with the shapes, bands, pairs, detectable effect and ceiling, and neither mode prints task text, follow-ups, the check, the title, the repo URL, patch or paste bytes, or the admin key', async (t) => {
  const marker = (what) => `zqx-${what}-marker-8813`;
  const fix = fixScenario({
    title: `Tokenizer fix ${marker('title')}`,
    repo: { git: `https://git.example.test/acme/${marker('repo')}.git`, ref: REF },
    task: `CI is red:\n\n{{ciLog}}\n\nFix ${marker('task')} in the tokenizer.`,
    followups: [`Then ${marker('followup')}.`],
    check: `node --test check/${marker('check')}.test.js`,
  });
  fix.files = { 'bug.patch': `${fix.files['bug.patch']}+// ${marker('patch')}\n`, 'ci-log.txt': `not ok 1 - ${marker('paste')}\n` };
  const dir = writeScenariosDir(tempDir(t), { 'acme-fix': fix });
  const gateway = await fakeGateway(t);

  const child = await planRun(t, dir, gateway, [...BUDGET, '--json']);
  const out = planOk(child, 'plan --json');
  // The path that would print content ran: the scenario was classified and planned.
  const [s] = out.scenarios;
  assert.equal(s.id, 'acme-fix');
  assert.equal(s.source, 'client');
  for (const key of ['features', 'shapeId', 'prediction', 'target', 'pairsNeeded', 'pairsPlanned', 'resolvable']) assert.ok(Object.hasOwn(s, key), `scenario answer carries ${key}`);
  assert.equal(typeof s.prediction.status, 'string');
  for (const key of ['pairsAffordable', 'detectableRatio', 'spendCeilingUsd', 'budgetUsd', 'pairCostUsd', 'resolvable', 'tenant']) assert.ok(Object.hasOwn(out, key), `plan answer carries ${key}`);
  assert.equal(typeof out.spendCeilingUsd, 'number');

  const human = await planRun(t, dir, gateway, BUDGET);
  assert.equal(human.status, 0, `plan (human): ${human.stderr.slice(0, 400)}`);
  assert.ok(human.stdout.includes('acme-fix'), 'the human plan names the scenario');
  for (const [mode, run] of [['--json', child], ['human', human]]) {
    for (const what of ['title', 'repo', 'task', 'followup', 'check', 'patch', 'paste']) {
      assert.ok(!run.stdout.includes(marker(what)) && !run.stderr.includes(marker(what)), `plan (${mode}) printed the ${what}`);
    }
    assert.ok(!run.stdout.includes(ADMIN_KEY) && !run.stderr.includes(ADMIN_KEY), `plan (${mode}) printed the admin key`);
  }
});

test('plan only reads: nothing is written in the scenarios dir (no lock), and its only requests are GETs under /admin/v1/ (no inference call)', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const snapshot = () => Object.fromEntries(readdirSync(dir, { recursive: true }).sort().map((p) => {
    const full = join(dir, p);
    let bytes = null;
    try { bytes = readFileSync(full, 'utf8'); } catch { bytes = 'dir'; }
    return [p, bytes];
  }));
  const before = snapshot();
  const gateway = await fakeGateway(t);
  planOk(await planRun(t, dir, gateway, [...BUDGET, '--json']), 'plan --json');
  assert.ok(!existsSync(join(dir, 'plan.lock.json')), 'plan wrote a lock');
  assert.deepEqual(snapshot(), before, 'plan changed the scenarios dir');
  assert.ok(gateway.requests.length > 0, 'plan read the tenant gate');
  for (const r of gateway.requests) {
    assert.equal(r.method, 'GET', `${r.method} ${r.path}`);
    assert.ok(r.path.startsWith('/admin/v1/'), `plan called ${r.path}`);
  }
});

// ---- refusals before the gateway ------------------------------------------------------------------

test('plan validates the scenarios as freeze does, plus mcpTools, and refuses before it contacts the gateway', async (t) => {
  const gateway = await fakeGateway(t);
  const { source, ...noSource } = shapeScenario().doc;
  assert.equal(source, 'client');
  const cases = [
    ['a missing source', { s: { doc: noSource, files: {} } }, 'scenario_invalid', 'source'],
    ['mcpTools -1', { s: shapeScenario({}, { mcpTools: -1 }) }, 'scenario_invalid', 'mcpTools'],
    ['mcpTools 2.5', { s: shapeScenario({}, { mcpTools: 2.5 }) }, 'scenario_invalid', 'mcpTools'],
    ['mcpTools "200"', { s: shapeScenario({}, { mcpTools: '200' }) }, 'scenario_invalid', 'mcpTools'],
    ['no scenario', {}, 'scenarios_empty', undefined],
  ];
  for (const [label, scenarios, code, field] of cases) {
    const dir = writeScenariosDir(tempDir(t), scenarios);
    const child = await planRun(t, dir, gateway, [...BUDGET, '--json']);
    const out = json(child, `plan --json (${label})`);
    assert.equal(out.ok, false, label);
    assert.equal(out.command, 'plan', label);
    assert.equal(out.code, code, label);
    if (field) assert.deepEqual([out.scenario, out.field], ['s', field], label);
    assert.equal(child.status, 4, label);
  }
  const missing = await planRun(t, join(tempDir(t), 'nope'), gateway, [...BUDGET, '--json']);
  assert.equal(json(missing, 'plan --json (missing dir)').code, 'scenarios_dir_not_found');
  assert.equal(missing.status, 4);
  assert.deepEqual(gateway.requests, [], 'a plan refused on its scenarios made a request');
});

test('plan usage errors: --budget-usd and --session-cost-usd are required positive numbers, --client and --tenant are checked; one JSON value, exit 2, no request', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const gateway = await fakeGateway(t);
  const ok = { '--budget-usd': '50', '--session-cost-usd': '0.15' };
  const argsFor = (flags) => ['plan', '--scenarios-dir', dir, '--gateway', gateway.url, ...Object.entries(flags).flat(), '--json'];
  // The control: these flags make a plan, so each refusal below is about the one flag it changes.
  planOk(await kitAsync(t, argsFor({ ...ok, '--client': 'codex', '--tenant': 'acme-eu' })), 'plan with valid flags');
  const requestsBefore = gateway.requests.length;
  const cases = [
    ['no --budget-usd', { '--session-cost-usd': '0.15' }],
    ['--budget-usd 0', { ...ok, '--budget-usd': '0' }],
    ['--budget-usd -5', { ...ok, '--budget-usd': '-5' }],
    ['--budget-usd abc', { ...ok, '--budget-usd': 'abc' }],
    ['no --session-cost-usd', { '--budget-usd': '50' }],
    ['--session-cost-usd 0', { ...ok, '--session-cost-usd': '0' }],
    ['--client sdk', { ...ok, '--client': 'sdk' }],
    ['--tenant with a slash', { ...ok, '--tenant': 'acme/eu' }],
    ['an unknown flag', { ...ok, '--no-such-flag': 'x' }],
  ];
  for (const [label, flags] of cases) {
    const child = await kitAsync(t, argsFor(flags));
    const out = json(child, label);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'plan', code: 'usage' }, label);
    assert.equal(child.status, 2, label);
  }
  assert.equal(gateway.requests.length, requestsBefore, 'a usage error made a request');
});

test('plan with no gateway configured (no --gateway, no ANYRAY_GATEWAY_URL, none in config.yaml) is pin_missing, exit 2', async (t) => {
  const dir = writeScenariosDir(tempDir(t), shapedScenarios());
  const child = await kitAsync(t, ['plan', '--scenarios-dir', dir, ...BUDGET, '--json']);
  const out = json(child, 'plan --json without a gateway');
  assert.deepEqual({ ok: out.ok, code: out.code, pin: out.pin }, { ok: false, code: 'pin_missing', pin: 'gatewayHost' });
  assert.equal(child.status, 2);
});

test('npm run -s plan: JSON only on stdout, and a relative --scenarios-dir resolves from where npm was run', async (t) => {
  const parent = tempDir(t);
  writeScenariosDir(parent, shapedScenarios(), 'client-tests');
  const gateway = await fakeGateway(t);
  const child = await npmRunAsync(t, 'plan', ['--scenarios-dir', 'client-tests', '--gateway', gateway.url, ...BUDGET, '--json'], { cwd: parent, env: planEnv(t) });
  const out = planOk(child, 'npm run -s plan -- --json');
  assert.deepEqual(out.scenarios.map((s) => s.id), Object.keys(shapedScenarios()).sort());
});

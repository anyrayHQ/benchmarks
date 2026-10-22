// `npm run verdict` (ANY-1487): the frozen plan's run records judged with the repo's own two
// verdicts, word for word: benchVerdict (pass / fail / inconclusive, the paired t interval)
// and Rule 0 (solvedPairVerdict: PASS / FAIL / INCONCLUSIVE / INSUFFICIENT, and NO DATA when
// nothing ran), per scenario and pooled, plus each scenario's actual median against the band
// frozen before the run. Synthetic records under <scenarios-dir>/.kit-results/<planHash>/; no
// session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { benchVerdict, exclusionReasons } from '../lib/benchVerdict.mjs';
import { rule0, solvedPairVerdict } from '../lib/stats.mjs';
import { KIT_ROOT, kitEnv, tempDir } from './kitFixtures.mjs';
import { json, npmRunAsync } from './kitPlanFixtures.mjs';
import { kitIn, syntheticPlan } from './kitRunFixtures.mjs';

// nextStep and tieNote (what to say when a verdict cannot decide) have their own suites,
// kitNextStep.test.mjs and kitFirstRunClarity.test.mjs.
const withoutNext = ({ nextStep: _next, tieNote: _tie, ...rest }) => rest;
const verdict = (copy, dir, env, args = ['--json']) => kitIn(copy.root, ['verdict', '--scenarios-dir', dir, ...args], { env });

/** What the verdict must say for one scenario, computed with the libraries on the same rounds. */
function expected(lock, id, rounds = []) {
  const v = benchVerdict(rounds);
  const valid = rounds.filter((r) => exclusionReasons(r).length === 0);
  const s = rule0(valid);
  const { prediction, shapeId } = lock.predictions.find((p) => p.id === id);
  const band = prediction.status === 'band' ? prediction : null;
  // Every round that ran cleanly is graded, solved or not (a pair only one arm solved counts).
  const graded = rounds.filter((r) => exclusionReasons(r).every((x) => x === 'not solved'));
  const parity = graded.length ? {
    n: graded.length,
    passDirect: graded.filter((r) => r.quality.a).length,
    passAnyray: graded.filter((r) => r.quality.b).length,
    anyrayWorse: graded.filter((r) => r.quality.a && !r.quality.b).length,
    anyrayBetter: graded.filter((r) => !r.quality.a && r.quality.b).length,
  } : undefined;
  return {
    ...(parity ? { parity } : {}),
    id,
    source: lock.scenarios.find((x) => x.id === id).source,
    shapeId,
    prediction,
    verdict: v.verdict,
    rule0: solvedPairVerdict(rounds.filter((r) => !r.gatewayRestarted)).verdict,
    n: v.n,
    totalRounds: rounds.length,
    excluded: v.excluded.map(({ round, reasons }) => ({ round, reasons })),
    stats: { winRate: s.winRate, median: s.median, q3: s.q3, max: s.max },
    ci95: v.confidenceInterval95 ? { lower: v.confidenceInterval95.lower, upper: v.confidenceInterval95.upper } : null,
    vsPrediction: !band || s.median === null ? null : s.median < band.lo ? 'below' : s.median > band.hi ? 'above' : 'inside',
  };
}

test('the verdict words are benchVerdict\'s and Rule 0\'s exactly, per scenario and pooled, with every number from the same rounds', async (t) => {
  const root = tempDir(t, 'kit-verdict-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock, rounds } = await syntheticPlan(root, { env });
  const child = await verdict(copy, dir, env);
  const out = json(child, 'verdict --json');
  assert.equal(out.ok, true, `verdict refused: ${child.stdout.slice(0, 400)} ${child.stderr.slice(-400)}`);
  assert.equal(child.status, 0);
  assert.equal(out.command, 'verdict');
  assert.equal(out.planHash, lock.planHash);

  const ids = lock.scenarios.map((s) => s.id);
  assert.deepEqual(out.scenarios.map((s) => s.id), ids, 'every frozen scenario, in the lock\'s order');
  for (const id of ids) assert.deepEqual(withoutNext(out.scenarios.find((s) => s.id === id)), expected(lock, id, rounds[id]), id);

  const pooled = ids.flatMap((id) => rounds[id] ?? []).filter((r) => !r.gatewayRestarted);
  assert.equal(out.rule0Verdict, solvedPairVerdict(pooled).verdict, 'the pooled Rule 0 verdict over every scenario\'s rounds');

  // The data is built so the words differ: a reader can tell the verdicts apart.
  const words = Object.fromEntries(out.scenarios.map((s) => [s.id, [s.verdict, s.rule0]]));
  assert.deepEqual(words, {
    'check-long': ['pass', 'PASS'],
    docs: ['inconclusive', 'INSUFFICIENT'],
    facts: ['inconclusive', 'INSUFFICIENT'],
    'short-task': ['fail', 'FAIL'],
  });
});

test('predicted vs actual: each scenario\'s median against the band frozen before the run, none where nothing was predicted', async (t) => {
  const root = tempDir(t, 'kit-verdict-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env });
  const out = json(await verdict(copy, dir, env), 'verdict --json');
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  const by = Object.fromEntries(out.scenarios.map((s) => [s.id, s]));
  assert.equal(by['check-long'].vsPrediction, 'below', 'a median of 0.505 against a 0.75-0.85 band saved more than predicted');
  assert.equal(by['short-task'].vsPrediction, 'above', 'a median of 1.29 against a 0.85-0.95 parity band');
  assert.equal(by.facts.vsPrediction, null, 'no shape, no band');
  assert.equal(by.docs.vsPrediction, null, 'a shape with too few public rounds has no band either');
  for (const s of out.scenarios) assert.deepEqual(s.prediction, lock.predictions.find((p) => p.id === s.id).prediction, `${s.id}: the frozen prediction, not the catalog's today`);
  assert.deepEqual(by['check-long'].excluded, [{ round: 9, reasons: ['holdout drawn'] }], 'a pair drawn into a holdout is excluded with that reason alone');
  assert.deepEqual(by['short-task'].excluded, [{ round: 5, reasons: ['not solved'] }]);
});

test('before any paired round there is no Rule 0 verdict: NO DATA, and every scenario is inconclusive', async (t) => {
  const root = tempDir(t, 'kit-verdict-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env, records: false });
  const out = json(await verdict(copy, dir, env), 'verdict --json');
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.rule0Verdict, 'NO DATA');
  for (const s of out.scenarios) assert.deepEqual(withoutNext(s), expected(lock, s.id, []), s.id);
});

test('the run-side commands are npm scripts, and a relative --scenarios-dir resolves from where npm was run', async (t) => {
  const scripts = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).scripts ?? {};
  for (const cmd of ['noise', 'run', 'verdict', 'report', 'publish-result']) assert.equal(scripts[cmd], `node tools/kit.mjs ${cmd}`, `npm run ${cmd}`);

  const root = tempDir(t, 'kit-verdict-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env });
  const child = await npmRunAsync(t, 'verdict', ['--scenarios-dir', relative(root, dir), '--json'], { kitRoot: copy.root, env, cwd: root });
  const out = json(child, 'npm run -s verdict -- --json');
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.equal(out.planHash, lock.planHash, 'INIT_CWD resolved the relative dir, not the kit root');
});

// The human `verdict` and `report --redact` output (ANY-1515): a client reads ratios and confidence
// bounds, not float noise. Both print each scenario's median ratio and CI bounds rounded to at most
// three decimals; `--json` keeps full precision (the verdict and the published body are computed
// from it). Synthetic records under <scenarios-dir>/.kit-results/<planHash>/; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, syntheticPlan } from './kitRunFixtures.mjs';

// A number standing alone (not part of a version such as 1.10.515, a hash or an id).
const NUMBER = /(?<![\w.])\d+(?:\.(\d+))?(?![\w.])/g;
const numbers = (text) => [...text.matchAll(NUMBER)].map((m) => ({ text: m[0], value: Number(m[0]), decimals: m[1]?.length ?? 0 }));
const round3 = (x) => Math.round(x * 1000) / 1000;
const shown = (x) => [round3(x), Number(x.toFixed(3))];
const decimals = (x) => (String(x).split('.')[1] ?? '').length;

/** Lines of `text` that name `id` as a word. */
const linesOf = (text, id) => text.split('\n').filter((l) => l.split(/[^\w-]+/).includes(id));

/** The JSON verdict of the synthetic plan: the full-precision numbers the human text is held to. */
async function fullPrecision(copy, dir, env) {
  const v = json(await kitIn(copy.root, ['verdict', '--scenarios-dir', dir, '--json'], { env }), 'verdict --json');
  assert.equal(v.ok, true, JSON.stringify(v).slice(0, 300));
  const scored = v.scenarios.filter((s) => s.stats.median !== null && s.ci95);
  assert.ok(scored.length >= 2, 'the synthetic plan has scenarios with a median and an interval');
  // The fixture must exercise the rounding, and --json must not round.
  assert.ok(scored.some((s) => decimals(s.ci95.lower) > 3 || decimals(s.ci95.upper) > 3), `an interval bound has more than three decimals in --json: ${JSON.stringify(scored.map((s) => s.ci95))}`);
  return scored;
}

/** Every scored scenario's line shows its median and both CI bounds at three decimals, and no number anywhere has more. */
function assertRounded(text, scored, what) {
  const long = numbers(text).filter((n) => n.decimals > 3);
  assert.deepEqual(long.map((n) => n.text), [], `${what}: numbers with more than three decimals`);
  for (const s of scored) {
    const lines = linesOf(text, s.id);
    assert.ok(lines.length > 0, `${what}: a line names ${s.id}: ${JSON.stringify(text.slice(0, 600))}`);
    const values = lines.flatMap((l) => numbers(l).map((n) => n.value));
    for (const [name, x] of [['median', s.stats.median], ['CI lower', s.ci95.lower], ['CI upper', s.ci95.upper]]) {
      assert.ok(values.some((v) => shown(x).some((r) => Math.abs(v - r) < 1e-9)), `${what}: ${s.id} shows its ${name} ${x} as ${round3(x)}: ${JSON.stringify(lines)}`);
    }
  }
}

test('the human verdict prints each scenario\'s median ratio and CI bounds rounded to three decimals; --json keeps full precision', async (t) => {
  const root = tempDir(t, 'kit-round-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const scored = await fullPrecision(copy, dir, env);
  const human = await kitIn(copy.root, ['verdict', '--scenarios-dir', dir], { env });
  assert.equal(human.status, 0, `verdict failed: ${human.stderr.slice(-400)}`);
  assertRounded(human.stdout, scored, 'verdict');
});

test('the human report prints each scenario\'s median ratio and CI bounds rounded to three decimals; --json keeps full precision', async (t) => {
  const root = tempDir(t, 'kit-round-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const scored = await fullPrecision(copy, dir, env);
  const human = await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact'], { env });
  assert.equal(human.status, 0, `report failed: ${human.stderr.slice(-400)}`);
  assertRounded(human.stdout, scored, 'report');

  const body = json(await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env }), 'report --redact --json');
  const bounds = body.scenarios.filter((s) => s.ci95).flatMap((s) => [s.ci95.lower, s.ci95.upper]);
  assert.ok(bounds.some((x) => decimals(x) > 3), `the published body keeps full precision: ${JSON.stringify(bounds)}`);
});

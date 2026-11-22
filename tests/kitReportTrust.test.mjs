// What a client reads in the human report and `noise` output must carry the numbers that build
// trust: the tail (win rate, Q3, worst pair), dollars per session for both arms, and a plain
// reading of "vs prediction". Numbers are rounded for people; the JSON keeps full precision.
// Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, syntheticPlan } from './kitRunFixtures.mjs';

const report = (copy, dir, env, args) => kitIn(copy.root, ['report', '--scenarios-dir', dir, ...args], { env });

test('the human report shows each scenario\'s tail: win rate, Q3 and the worst pair, in words', async (t) => {
  const root = tempDir(t, 'kit-trust-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const human = (await report(copy, dir, env, ['--redact'])).stdout;
  const body = json(await report(copy, dir, env, ['--redact', '--json']), 'report --json');
  for (const s of body.scenarios.filter((x) => x.n > 0)) {
    const pct = `${Math.round(s.winRate * 100)}%`;
    assert.ok(human.includes(`cheaper in ${pct}`), `${s.shapeId}: win rate ${pct} missing:\n${human}`);
    assert.ok(human.includes(`Q3 ${s.q3.toFixed(3)}`), `${s.shapeId}: Q3 missing`);
    assert.ok(human.includes(`worst pair ${s.max.toFixed(3)}`), `${s.shapeId}: worst pair missing`);
  }
  // A worst pair above 1 says it cost more, not only a number.
  const worstAbove = body.scenarios.find((s) => s.max > 1);
  if (worstAbove) assert.match(human, /worst pair \d\.\d{3} \(\d+(\.\d)?% more\)/);
});

test('the human report shows dollars per session for both arms and the difference', async (t) => {
  const root = tempDir(t, 'kit-trust-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const human = (await report(copy, dir, env, ['--redact'])).stdout;
  const body = json(await report(copy, dir, env, ['--redact', '--json']), 'report --json');
  const { direct, anyray } = body.totals.costUsdPerSession;
  const pct = Math.round(Math.abs(1 - anyray / direct) * 100);
  const word = anyray <= direct ? 'lower' : 'higher';
  assert.ok(human.includes(`Cost per session: direct $${direct.toFixed(2)}, Anyray $${anyray.toFixed(2)} (${pct}% ${word})`), `dollars line missing:\n${human}`);
  assert.doesNotMatch(human, /\d+\.\d{4,}/, 'no raw float');
});

test('"vs prediction" says what it means: saved more, saved less, or inside the band', async (t) => {
  const root = tempDir(t, 'kit-trust-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const human = (await report(copy, dir, env, ['--redact'])).stdout;
  const lines = human.split('\n');
  const checkLong = lines.find((l) => l.startsWith('check-long'));
  const shortTask = lines.find((l) => l.startsWith('short-task'));
  assert.match(checkLong, /saved more than predicted/);
  assert.match(shortTask, /saved less than predicted/);
  assert.doesNotMatch(human, /vs prediction (below|above|inside)\b/, 'the bare below/above words are gone');
  // The machine word stays.
  const verdict = json(await kitIn(copy.root, ['verdict', '--scenarios-dir', dir, '--json'], { env }), 'verdict --json');
  assert.equal(verdict.scenarios.find((s) => s.id === 'check-long').vsPrediction, 'below');
});

test('formatNoise rounds the measured SD, names the plan\'s assumption and what the budget can now detect', async () => {
  const { formatNoise } = await import('../lib/kitResults.mjs');
  const text = formatNoise({
    scenarios: [{ id: 'client-1', pairsNeeded: 1 }, { id: 'proposed-1', pairsNeeded: null }],
    sd: { value: 0.06038389849215534 },
  }, { pairsPlanned: 10 });
  assert.doesNotMatch(text, /\d+\.\d{4,}/, `a raw float: ${text}`);
  assert.match(text, /Measured SD 0\.060/);
  assert.match(text, /the plan assumed 0\.924/);
  assert.match(text, /client-1: 1 pair needed/);
  assert.match(text, /proposed-1: no predicted band to aim at/);
  assert.match(text, /10 pairs can now detect a saving of about \d+%/);
});

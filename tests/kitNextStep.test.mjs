// A verdict that cannot decide says what to do next, in pairs and dollars, from the run's own
// numbers: the mean pair cost it recorded and the noise it measured. A verdict that can decide
// (a pass, or a fail with enough pairs) says nothing more. Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import {
  fakeClaude, fakeRunGateway, freezeWith, kitIn, kitRunCopy, originRepo, poisonClaude, runEnv, runScenario, sharedTemp, syntheticPlan, writeDir,
} from './kitRunFixtures.mjs';

test('nextStep: too few pairs asks for the rest of the minimum, priced at the recorded pair cost', async () => {
  const { nextStep } = await import('../lib/kitResults.mjs');
  const text = nextStep({ verdict: 'inconclusive', rule0: 'INSUFFICIENT', n: 5, median: 0.93, sd: 0.068, pairCostUsd: 0.166 });
  assert.equal(text, 'Run 3 more pairs (about $0.50) to reach the minimum of 8.');
  assert.equal(nextStep({ verdict: 'inconclusive', rule0: 'INSUFFICIENT', n: 7, median: 0.9, sd: 0.1, pairCostUsd: 2 }), 'Run 1 more pair (about $2.00) to reach the minimum of 8.');
});

test('nextStep: enough pairs but a wide interval says how many would resolve the observed median', async () => {
  const { nextStep } = await import('../lib/kitResults.mjs');
  const { pairsNeeded } = await import('../lib/benchVerdict.mjs');
  const more = pairsNeeded(0.93, 0.3) - 10; // 80% power at this SD, less the 10 already run
  assert.ok(more > 60, 'the case is built to be a lot of pairs');
  const text = nextStep({ verdict: 'inconclusive', rule0: 'INCONCLUSIVE', n: 10, median: 0.93, sd: 0.3, pairCostUsd: 0.17 });
  assert.ok(text.startsWith(`About ${more} more pairs (about $${(more * 0.17).toFixed(2)}) would tell a median of 0.930 from no change.`), text);
  // Past 60 more pairs the honest answer is that it will not resolve cheaply.
  assert.match(text, /cost moves too much/i);
  const small = nextStep({ verdict: 'inconclusive', rule0: 'INCONCLUSIVE', n: 10, median: 0.8, sd: 0.26, pairCostUsd: 1 });
  assert.match(small, /^About 1 more pair \(about \$1\.00\)/);
  assert.doesNotMatch(small, /cost moves too much/i);
});

test('nextStep: a verdict that can decide says nothing more', async () => {
  const { nextStep } = await import('../lib/kitResults.mjs');
  assert.equal(nextStep({ verdict: 'pass', rule0: 'PASS', n: 10, median: 0.8, sd: 0.1, pairCostUsd: 1 }), null);
  assert.equal(nextStep({ verdict: 'fail', rule0: 'FAIL', n: 9, median: 1.3, sd: 0.1, pairCostUsd: 1 }), null);
  assert.equal(nextStep({ verdict: 'inconclusive', rule0: 'NO DATA', n: 0, median: null, sd: 0.1, pairCostUsd: null }), null, 'no pairs, no price: nothing to say');
});

test('verdict --json carries nextStep per scenario and the human lines print it', async (t) => {
  const root = tempDir(t, 'kit-next-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir } = await syntheticPlan(root, { env });
  const out = json(await kitIn(copy.root, ['verdict', '--scenarios-dir', dir, '--json'], { env }), 'verdict --json');
  const by = Object.fromEntries(out.scenarios.map((s) => [s.id, s]));
  // facts: two pairs costing $1.90 and $2.10 in total: $2.00 a pair, 6 short of 8.
  assert.equal(by.facts.nextStep, 'Run 6 more pairs (about $12.00) to reach the minimum of 8.');
  assert.equal(by['check-long'].nextStep, null, 'a pass has nothing to add');
  assert.equal(by['short-task'].nextStep, null, 'a fail with a clear interval has nothing to add');
  assert.equal(by.docs.nextStep, null, 'never run');

  const human = (await kitIn(copy.root, ['verdict', '--scenarios-dir', dir], { env })).stdout;
  assert.match(human, /facts: .*\n(\s*Note: .*\n)?\s*Next: Run 6 more pairs \(about \$12\.00\) to reach the minimum of 8\./);
  assert.doesNotMatch(human, /check-long: .*\n\s*Next:/);

  const report = (await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact'], { env })).stdout;
  assert.match(report, /Next: Run 6 more pairs/);
});

test('noise says how long the planned pairs will take, from the pace its own rounds ran at', async () => {
  const { formatNoise, meanRoundMs } = await import('../lib/kitResults.mjs');
  // Both arms run at once, so a round lasts from its start to its end.
  const at = (sec) => new Date(Date.UTC(2026, 9, 22, 12, 0, sec)).toISOString();
  const rounds = [{ startedAt: at(0), endedAt: at(12) }, { startedAt: at(20), endedAt: at(31) }, { startedAt: at(40), endedAt: at(53) }, { startedAt: 'bad', endedAt: at(60) }, {}];
  assert.equal(meanRoundMs(rounds), 12000, 'the mean of the three rounds that have a real start and end');
  assert.equal(meanRoundMs([]), null);
  assert.equal(meanRoundMs([{}]), null);

  const answer = { scenarios: [{ id: 'client-1', pairsNeeded: null }], sd: { value: 0.068 } };
  const text = formatNoise(answer, { pairsPlanned: 17, roundMs: 12000 });
  assert.match(text, /At this pace 17 pairs take about 4 min\./); // 17 x 12 s = 3.4 min
  assert.match(formatNoise(answer, { pairsPlanned: 3, roundMs: 12000 }), /At this pace 3 pairs take under a minute\./);
  assert.doesNotMatch(formatNoise(answer, { pairsPlanned: 17, roundMs: null }), /At this pace/, 'no pace, no claim');
  assert.doesNotMatch(formatNoise(answer, { pairsPlanned: null, roundMs: 12000 }), /At this pace/, 'no plan, no claim');
});

test('noise --json carries the same words the human output prints, so the skill can copy them', async () => {
  const root = sharedTemp('kit-noise-summary-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { 'acme-fix': runScenario(origin) });
  const gateway = await fakeRunGateway();
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1, 1.2, 0.9, 1.1, 0.95, 1.15, 1.02, 1.18, 0.92, 1.08, 0.97, 1.12], anyray: [0.5] } });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  await freezeWith(copy.root, dir, gateway.url, env);
  const child = await kitIn(copy.root, ['noise', '--scenarios-dir', dir, '--claude-bin', claude.bin, '--budget-usd', '40', '--json'], { env });
  const out = json(child, 'noise --json');
  await gateway.close();
  assert.equal(out.ok, true, `noise failed: ${child.stdout.slice(0, 300)} ${child.stderr.slice(-300)}`);
  assert.match(out.summary, /Measured SD \d\.\d{3} \(the plan assumed 0\.924\)/);
  assert.match(out.summary, /At this pace \d+ pairs take (about \d+ min|under a minute)\./);
  assert.doesNotMatch(out.summary, /\d+\.\d{4,}/, 'no raw float');
});

// When the budget stops `noise` or `run`, the human line says so, with what was spent and how many
// rounds ran. It never prints "undefined" (the stop answer has no plan hash). The JSON answer is
// unchanged. Stand-in Claude and gateway; no network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { json, TEST_SHAPES } from './kitPlanFixtures.mjs';
import {
  fakeClaude, fakeRunGateway, freezeWith, kitIn, kitRunCopy, originRepo, pairRound, poisonClaude, runEnv, runScenario, sharedTemp, writeDir, writeNoise, writeRecord,
} from './kitRunFixtures.mjs';

void TEST_SHAPES;
const ID = 'acme-fix';
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/** A frozen plan that has already spent $12 on control rounds, so any budget below that is spent. */
async function spentPlan() {
  const root = sharedTemp('kit-stop-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  const dir = writeDir(root, { [ID]: runScenario(origin) });
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: [1], anyray: [0.5] } });
  const env = runEnv(join(root, 'home'), { gateway, poison });
  const lock = await freezeWith(copy.root, dir, gateway.url, env);
  writeNoise(dir, { sd: 0.3 });
  writeRecord(dir, lock, ID, Array.from({ length: 6 }, (_, i) => pairRound(i + 1, 1, 1)), { compare: 'control' });
  const cli = (command, args) => kitIn(copy.root, [command, '--scenarios-dir', dir, '--claude-bin', claude.bin, ...args], { env });
  return { cli };
}

for (const command of ['run', 'noise']) {
  test(`${command} stopped by the budget says so in words, with spend and rounds, never "undefined"`, async () => {
    const { cli } = await spentPlan();
    const human = await cli(command, ['--budget-usd', '1']);
    assert.equal(human.status, 0, `${command} failed: ${human.stdout.slice(0, 300)} ${human.stderr.slice(-300)}`);
    assert.doesNotMatch(human.stdout, /undefined/, `a leaked undefined: ${human.stdout}`);
    assert.match(human.stdout, new RegExp(`^${command} stopped at the budget: spent \\$12\\.00 of \\$1\\.00 after 0 rounds\\.`, 'm'));

    const asJson = json(await cli(command, ['--budget-usd', '1', '--json']), `${command} --json`);
    assert.equal(asJson.stopped, 'budget_reached');
    assert.equal(asJson.rounds, 0);
  });
}

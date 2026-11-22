// The tail check is printed with every verdict that is not itself the noise (ANY-1656).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailBlockForRun } from '../lib/tailReport.mjs';
import { seededNormals } from '../lib/tailSim.mjs';
import { spawnAsync } from './kitPlanFixtures.mjs';
import { fakeClaude, fakeRunGateway, kitRunCopy, once, originRepo, poisonClaude, runEnv, runScenario, sharedTemp, writeDir } from './kitRunFixtures.mjs';

const round = (i, ratio) => ({ round: i, ratio, quality: { a: true, b: true }, sessions: { a: { totals: { costUsd: 1 } }, b: { totals: { costUsd: ratio } } } });
const rec = (ratios, over = {}) => ({
  scenario: 's', compare: 'gateway', provider: 'anthropic', gateway: 'https://gw.example/', setup: { a: { model: 'm' }, b: { model: 'm' } },
  request: { bare: true }, claudeVersions: { a: { '2.1.300': 1 }, b: { '2.1.300': 1 } }, rounds: ratios.map((r, i) => round(i + 1, r)), ...over,
});
const treated = (ratios) => rec(ratios, { request: { bareA: true } });
const dirWith = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  for (const [f, r] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(r));
  return dir;
};

test('a comparison with no P/P library prints insufficient calibration, never a pass', () => {
  const text = tailBlockForRun(treated([1, 0.9, 1.1]), { dir: dirWith({}) });
  assert.match(text, /Tail check: insufficient calibration/);
});

test('with 19 blocks on disk it decides, and names the files it read', () => {
  const dir = dirWith({ 's--gateway--bare.json': rec(seededNormals(1, 19 * 12).map((z) => Math.exp(z * 0.5))) });
  const text = tailBlockForRun(treated([...Array(11).fill(1), 40]), { dir });
  assert.match(text, /Tail check: excess/);
  assert.match(text, /anchors: s--gateway--bare\.json/);
});

test('the noise runs themselves, and control pairs, print no tail check', () => {
  assert.equal(tailBlockForRun(rec([1, 1.1]), { dir: dirWith({}) }), null);
  assert.equal(tailBlockForRun(treated([1, 1.1]) && { ...treated([1, 1.1]), compare: 'control' }, { dir: dirWith({}) }), null);
  assert.equal(tailBlockForRun(treated([]), { dir: dirWith({}) }), null);
});

test('a direct-vs-Anyray run is read against control pairs, not against pass-through files', () => {
  const direct = rec([...Array(11).fill(1), 40], { compare: 'anyray', request: {} });
  const control = rec(seededNormals(1, 19 * 12).map((z) => Math.exp(z * 0.5)), { compare: 'control', request: {}, gateway: undefined });
  const passThrough = rec(seededNormals(2, 19 * 12).map((z) => Math.exp(z * 0.5)));
  assert.match(tailBlockForRun(direct, { dir: dirWith({ 's--control.json': control }) }), /Tail check: excess/);
  const onlyPP = tailBlockForRun(direct, { dir: dirWith({ 's--gateway--bare.json': passThrough }) });
  assert.match(onlyPP, /insufficient calibration/, 'pass-through pairs are not this pair\'s noise');
});

test('a gateway pair whose A is not pass-through has no matching noise: no block, not a calibration it cannot have', () => {
  const featureAB = rec([1, 1.1], { request: {} });
  assert.equal(tailBlockForRun(featureAB, { dir: dirWith({}) }), null);
});

// ---- through the CLI -------------------------------------------------------------------------
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});
const ran = once(async () => {
  const root = sharedTemp('tail-wiring-');
  const origin = originRepo(root);
  const kit = kitRunCopy(join(root, 'kit'));
  writeDir(kit.root, { 'tail-twin': runScenario(origin) }, 'scenarios');
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const claude = fakeClaude(join(root, 'claude'));
  const env = runEnv(join(root, 'home'), { gateway, poison: poisonClaude(join(root, 'poison')) });
  return spawnAsync(process.execPath, [realpathSync(join(kit.root, 'run_agent.mjs')), '--scenario', 'tail-twin', '--compare', 'anyray', '--bare', '--rounds', '1', '--claude-bin', claude.bin], { env, cwd: kit.root, timeout: 170_000 });
});

test('a real run prints the tail check after its verdict', async () => {
  const child = await ran();
  assert.equal(child.status, 0, `${child.stdout.slice(-500)}${child.stderr.slice(-500)}`);
  assert.match(child.stdout, /Verdict: /);
  assert.match(child.stdout, /Tail check: insufficient calibration/);
});

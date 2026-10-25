// The pooled no-op library is the P/P result files already on disk (ANY-1656): bare gateway pairs
// whose pins match the run being judged. A library with other pins is not exchangeable, so it is skipped by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryFrom, findLibraryFiles, tailForRecord } from '../lib/noiseLibrary.mjs';
import { seededNormals } from '../lib/tailSim.mjs';

const round = (i, ratio, over = {}) => ({ round: i, ratio, quality: { a: true, b: true }, sessions: { a: { totals: { costUsd: 1 } }, b: { totals: { costUsd: ratio } } }, ...over });
const rec = (ratios, over = {}) => ({
  scenario: 's', compare: 'gateway', provider: 'anthropic', gateway: 'https://gw.example/', setup: { a: { model: 'm' }, b: { model: 'm' } },
  request: { bare: true }, claudeVersions: { a: { '2.1.300': ratios.length }, b: { '2.1.300': ratios.length } },
  rounds: ratios.map((r, i) => round(i + 1, r)), ...over,
});
const treated = (ratios, over = {}) => rec(ratios, { compare: 'gateway', request: { bareA: true }, ...over });
const noise = (n, seed = 1) => seededNormals(seed, n).map((z) => Math.exp(z * 0.5));

test('bare gateway pairs with the same pins make the library; their valid rounds are the pairs', () => {
  const r = rec(noise(30));
  r.rounds[3] = round(4, 1.2, { gatewayRestarted: true }); // excluded: not a clean pair
  const lib = libraryFrom([{ file: 'a.json', record: r }], treated([1]));
  assert.equal(lib.ratios.length, 29);
  assert.deepEqual(lib.anchors, [{ file: 'a.json', pairs: 29 }]);
  assert.deepEqual(lib.skipped, []);
});

test('a file is skipped by name when it is not a P/P run or its pins differ', () => {
  const t = treated([1]);
  const files = [
    ['direct.json', rec(noise(5), { compare: 'anyray', request: {} })],
    ['treated.json', treated(noise(5))],
    ['model.json', rec(noise(5), { setup: { a: { model: 'other' }, b: { model: 'other' } } })],
    ['lane.json', rec(noise(5), { request: { bare: true, upstream: 'api-key' } })],
    ['host.json', rec(noise(5), { gateway: 'https://other.example/' })],
    ['version.json', rec(noise(5), { claudeVersions: { a: { '2.1.301': 5 }, b: { '2.1.301': 5 } } })],
    ['scenario.json', rec(noise(5), { scenario: 'other' })],
    ['ok.json', rec(noise(5))],
  ].map(([file, record]) => ({ file, record }));
  const lib = libraryFrom(files, t);
  assert.deepEqual(lib.anchors.map((a) => a.file), ['ok.json']);
  assert.deepEqual(Object.fromEntries(lib.skipped.map((s) => [s.file, s.reason])), {
    'direct.json': 'not a pass-through pair run', 'treated.json': 'not a pass-through pair run', 'model.json': 'different model', 'lane.json': 'different upstream',
    'host.json': 'different gateway', 'version.json': 'different Claude Code version', 'scenario.json': 'different scenario',
  });
});

test('findLibraryFiles lists the bare gateway result files in a results dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(join(dir, 'agent'));
  for (const f of ['s--gateway--bare.json', 's--gateway--bare-api-key.json', 's--gateway--bare-a.json', 's--anyray.json', 's--gateway--feature.json']) writeFileSync(join(dir, 'agent', f), '{}');
  assert.deepEqual(findLibraryFiles(join(dir, 'agent')).map((p) => p.split('/').pop()).sort(), ['s--gateway--bare-api-key.json', 's--gateway--bare.json']);
  assert.deepEqual(findLibraryFiles(join(dir, 'missing')), []);
});

test('tailForRecord runs the check on the treatment record against a library of 19 blocks', () => {
  const t = treated([...Array(11).fill(1), 40]); // one session at 40x
  const lib = [{ file: 'pp.json', record: rec(noise(19 * 12)) }];
  const out = tailForRecord(t, lib);
  assert.equal(out.check.state, 'excess');
  assert.deepEqual(out.anchors, ['pp.json']);
  assert.ok(out.sd > 0.3 && out.sd < 0.7, `sd ${out.sd}`);
});

test('tailForRecord reads a treatment-A pair in its own direction: a costlier B is not the treatment', () => {
  const t = treated([...Array(11).fill(1), 40], { treatment: 'a' });
  const lib = [{ file: 'pp.json', record: rec(noise(19 * 12)) }];
  assert.equal(tailForRecord(t, lib, { treatment: 'a' }).check.state, 'within_noise');
});

test('with no library the answer is insufficient calibration, with the prior SD for the power line', () => {
  const out = tailForRecord(treated([1, 1.1, 0.9]), []);
  assert.equal(out.check.state, 'insufficient_calibration');
  assert.equal(out.sd, 0.924);
  assert.deepEqual(out.anchors, []);
});

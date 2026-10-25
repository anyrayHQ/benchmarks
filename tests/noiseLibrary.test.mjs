// The pooled no-op library is the P/P result files already on disk (ANY-1656): bare gateway pairs
// whose pins match the run being judged. A library with other pins is not exchangeable, so it is skipped by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryFrom, findLibraryFiles, tailForRecord, noiseKindFor } from '../lib/noiseLibrary.mjs';
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

// ---- which no-op fits which pair -------------------------------------------------------------
const control = (ratios, over = {}) => rec(ratios, { compare: 'control', request: {}, gateway: undefined, ...over });
const direct = (ratios, over = {}) => rec(ratios, { compare: 'anyray', request: {}, ...over });

test('the no-op is the pair with the treatment taken out: direct vs Anyray uses control, pass-through vs B uses P/P, any other gateway pair has none', () => {
  assert.equal(noiseKindFor(direct([1])), 'control');
  assert.equal(noiseKindFor(treated([1])), 'pass-through');
  assert.equal(noiseKindFor(rec([1], { request: {} })), null, 'A runs kinds: no pass-through noise matches it');
  assert.equal(noiseKindFor(rec([1])), null, 'a bare pair is itself the noise');
  assert.equal(noiseKindFor(control([1])), null);
});

test('a direct-vs-Anyray run reads control pairs and skips the pass-through files, and the reverse', () => {
  const d = libraryFrom([{ file: 'c.json', record: control(noise(5)) }, { file: 'p.json', record: rec(noise(5)) }], direct([1]));
  assert.deepEqual(d.anchors.map((a) => a.file), ['c.json']);
  assert.deepEqual(d.skipped, [{ file: 'p.json', reason: 'not a control pair run' }]);
  const p = libraryFrom([{ file: 'c.json', record: control(noise(5)) }, { file: 'p.json', record: rec(noise(5)) }], treated([1]));
  assert.deepEqual(p.anchors.map((a) => a.file), ['p.json']);
  assert.deepEqual(p.skipped, [{ file: 'c.json', reason: 'not a pass-through pair run' }]);
});

test('control pairs match on scenario, model, upstream and Claude Code version, not on a gateway they never touched', () => {
  const lib = libraryFrom([
    { file: 'ok.json', record: control(noise(5)) },
    { file: 'ver.json', record: control(noise(5), { claudeVersions: { a: { '9': 5 }, b: { '9': 5 } } }) },
  ], direct([1]));
  assert.deepEqual(lib.anchors.map((a) => a.file), ['ok.json']);
  assert.deepEqual(lib.skipped, [{ file: 'ver.json', reason: 'different Claude Code version' }]);
});

test('findLibraryFiles takes the kind: control files for control, bare files for pass-through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(join(dir, 'agent'));
  for (const f of ['s--control.json', 's--control--x.json', 's--gateway--bare.json', 's--anyray.json']) writeFileSync(join(dir, 'agent', f), '{}');
  const names = (kind) => findLibraryFiles(join(dir, 'agent'), kind).map((p) => p.split('/').pop()).sort();
  assert.deepEqual(names('control'), ['s--control--x.json', 's--control.json']);
  assert.deepEqual(names('pass-through'), ['s--gateway--bare.json']);
});

test('tailForRecord says there is no matching noise for a pair that has none, never a calibration it cannot have', () => {
  assert.equal(tailForRecord(rec([1], { request: {} }), []), null);
});

// The committed shape catalog (ANY-1486): predictions.yaml at the kit root maps content-free
// scenario shapes to a predicted band of paired cost ratios. Bands, never points; parity is an
// explicit prediction; every band is seeded from the README's published results and carries the
// number of public rounds behind it. Read straight from the file: what plan does with it is
// tests/kitPlan.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from './kitFixtures.mjs';
import { FEATURES, SHAPE_ID, readCatalog } from './kitPlanFixtures.mjs';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

test('predictions.yaml parses: version 1 and a non-empty list of shapes', () => {
  const catalog = readCatalog();
  assert.equal(catalog?.version, 1);
  assert.ok(Array.isArray(catalog.shapes) && catalog.shapes.length > 0, 'shapes is a non-empty list');
});

test('every shape has a publishable id, a non-empty match on known features, an expectation, a band with 0 < lo <= hi, a rounds count and a source', () => {
  const { shapes } = readCatalog();
  for (const [i, s] of shapes.entries()) {
    const at = `shapes[${i}] (${s?.id})`;
    assert.match(String(s.id), SHAPE_ID, `${at}: the id is published to the gateway later`);
    assert.ok(s.match && typeof s.match === 'object' && !Array.isArray(s.match) && Object.keys(s.match).length > 0, `${at}: match is a non-empty map (an empty one would match every scenario)`);
    for (const [feature, value] of Object.entries(s.match)) {
      assert.ok(Object.hasOwn(FEATURES, feature), `${at}: ${feature} is not a shape feature`);
      assert.ok(FEATURES[feature].includes(value), `${at}: ${feature} cannot be ${JSON.stringify(value)}`);
    }
    assert.ok(['saving', 'parity'].includes(s.expect), `${at}: expect is saving or parity`);
    assert.ok(finite(s.band?.lo) && finite(s.band?.hi), `${at}: the band has numeric lo and hi`);
    assert.ok(s.band.lo > 0, `${at}: lo > 0`);
    assert.ok(s.band.lo <= s.band.hi, `${at}: lo <= hi`);
    assert.ok(Number.isInteger(s.rounds) && s.rounds >= 0, `${at}: rounds is a count of public rounds`);
    assert.ok(typeof s.source === 'string' && s.source.trim().length > 0, `${at}: the source names where the band came from`);
  }
});

test('shape ids are unique and no two shapes match on the same features', () => {
  const { shapes } = readCatalog();
  const ids = shapes.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
  const matches = shapes.map((s) => JSON.stringify(Object.fromEntries(Object.entries(s.match).sort())));
  assert.equal(new Set(matches).size, matches.length, 'two shapes have the same match: the second can never be chosen');
});

test('every band endpoint is a ratio published in the README "Latest results (2026-10-15)" section', () => {
  const readme = readFileSync(join(KIT_ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Latest results (2026-10-15)');
  assert.ok(start >= 0, 'the README has the 2026-10-15 results section');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const published = [...section.matchAll(/(\d+\.\d+)×/g)].map((m) => Number(m[1]));
  assert.ok(published.length > 10, 'the section publishes its ratios');
  for (const s of readCatalog().shapes) {
    for (const side of ['lo', 'hi']) {
      assert.ok(published.some((x) => Math.abs(x - s.band[side]) < 1e-9), `${s.id}: band.${side} ${s.band[side]} is not a ratio published in the section (${[...new Set(published)].join(', ')})`);
    }
  }
});

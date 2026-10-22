// Shared inputs for the calibration tests (ANY-1492): the calibration document vendor-admin
// publishes (GET /admin/v1/calibration; the shared contract with the monorepo), the catalog
// `calibrate` must produce from it over ANY-1486's test catalog, and the gateway's client-tests
// body schema with the optional `predictedHitRate` the monorepo half adds. Everything is
// synthetic and content-free: shape ids, counts, ratios and 8-hex plan prefixes.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { TEST_SHAPES } from './kitPlanFixtures.mjs';
import { twinBodySchema } from './kitReleaseFixtures.mjs';

/** The kit's floor: a shape under 8 rounds publishes no hit rate (null, never 0). */
export const MIN_CALIBRATION_ROUNDS = 8;

/** One miss as the document lists it: the 8-hex plan prefix, the median, the band it was given, the side. */
export const miss = (plan, median, lo, hi, side) => ({ plan, median, band: { lo, hi }, side });

/**
 * The document's shapes, sorted by shapeId as vendor-admin sorts them:
 *   no-such-shape      names no catalog shape: reported, never added
 *   t-cc-check-long    23 rounds, right in 3 of 4: 0.75, one miss above its band
 *   t-cc-medium-pause  7 rounds: under the floor, so null (it still lists its miss)
 *   t-cc-short         exactly 8 rounds, right in 2 of 5: 0.4, three misses on both sides
 *   t-docs-few         10 rounds, 0.5; its shape has seven PUBLIC rounds, so plans predict no band
 */
export const DOC_SHAPES = [
  { shapeId: 'no-such-shape', rounds: 12, results: 2, hits: 2, hitRate: 1, misses: [] },
  { shapeId: 't-cc-check-long', rounds: 23, results: 4, hits: 3, hitRate: 0.75, misses: [miss('0123abcd', 0.91, 0.75, 0.85, 'above')] },
  { shapeId: 't-cc-medium-pause', rounds: 7, results: 2, hits: 1, hitRate: null, misses: [miss('4567cdef', 0.52, 0.6, 0.8, 'below')] },
  {
    shapeId: 't-cc-short', rounds: 8, results: 5, hits: 2, hitRate: 0.4,
    misses: [miss('1111aaaa', 0.7, 0.85, 0.95, 'below'), miss('2222bbbb', 1.2, 0.85, 0.95, 'above'), miss('3333cccc', 0.5, 0.85, 0.95, 'below')],
  },
  { shapeId: 't-docs-few', rounds: 10, results: 2, hits: 1, hitRate: 0.5, misses: [miss('89abcdef', 0.62, 0.3, 0.5, 'above')] },
];
export const UNKNOWN_SHAPE = 'no-such-shape';

/** A calibration document (deep copies, so a test may mutate it). */
export const calibrationDoc = (shapes = DOC_SHAPES, over = {}) => ({
  version: 1,
  generatedAt: '2026-10-22T00:00:00.000Z',
  minRounds: MIN_CALIBRATION_ROUNDS,
  shapes: structuredClone(shapes),
  ...over,
});

/** The catalog block a document entry becomes: the entry minus its shapeId. */
export const blockOf = ({ shapeId, ...block }) => structuredClone(block);
export const docShape = (id) => DOC_SHAPES.find((s) => s.shapeId === id);

/** ANY-1486's test catalog after `calibrate` with DOC_SHAPES: what plan and report read. */
export const CALIBRATED_SHAPES = TEST_SHAPES.map((s) => (docShape(s.id) ? { ...s, calibration: blockOf(docShape(s.id)) } : { ...s }));
export const CALIBRATED_CATALOG = yaml.dump({ version: 1, shapes: CALIBRATED_SHAPES });

/** A block from an earlier calibration of a shape the new document no longer names. */
export const STALE_BLOCK = { rounds: 9, results: 2, hits: 2, hitRate: 1, misses: [] };
/** The starting catalog of the write test: the test catalog, t-mcp-many carrying a stale block. */
export const STALE_SHAPES = TEST_SHAPES.map((s) => (s.id === 't-mcp-many' ? { ...s, calibration: STALE_BLOCK } : { ...s }));
export const STALE_CATALOG = yaml.dump({ version: 1, shapes: STALE_SHAPES });

/** The calibrated catalog with one shape's block replaced (for the invalid-block cases). */
export const catalogWithBlock = (id, block) => yaml.dump({
  version: 1,
  shapes: CALIBRATED_SHAPES.map((s) => (s.id === id ? { ...s, calibration: block } : s)),
});

/** Twelve misses on one shape (20 results, 8 hits): a truncated list would lose some. */
export const manyMisses = () => Array.from({ length: 12 }, (_, i) => {
  const plan = i.toString(16).padStart(8, '0');
  return i % 2 ? miss(plan, 0.9 + i / 100, 0.75, 0.85, 'above') : miss(plan, 0.6 - i / 100, 0.75, 0.85, 'below');
});

export const writeJson = (file, value) => { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); return file; };
export const catalogText = (root) => readFileSync(join(root, 'predictions.yaml'), 'utf8');
export const readCatalogAt = (root) => yaml.load(catalogText(root));

/** A shape without its calibration block: what calibrate must leave exactly as it was. */
export const withoutBlock = ({ calibration, ...rest }) => rest;

/** Each issue of a refusal is exactly a path and a code, never a value. */
export function assertIssues(out, what) {
  assert.ok(Array.isArray(out.issues) && out.issues.length > 0, `${what}: the refusal lists its issues: ${JSON.stringify(out)}`);
  for (const i of out.issues) {
    assert.deepEqual(Object.keys(i).sort(), ['code', 'path'], `${what}: an issue is a path and a code: ${JSON.stringify(i)}`);
    assert.ok(Array.isArray(i.path) && typeof i.code === 'string', `${what}: ${JSON.stringify(i)}`);
  }
}

// ---- the gateway body, once the monorepo half adds predictedHitRate ------------------------------

// The ONE change ANY-1492 asks of the gateway's clientTestResultSchema on top of ANY-1491's twinOf
// (tests/kitReleaseFixtures.mjs): an optional per-scenario `predictedHitRate`, a number in [0, 1]
// or null (a shape under 8 rounds). Everything else stays strict.
const predictedHitRate = z.number().finite().min(0).max(1).nullable();
const scenarioWithHitRate = twinBodySchema.shape.scenarios.element.extend({ predictedHitRate: predictedHitRate.optional() });
export const hitRateBodySchema = twinBodySchema.extend({ scenarios: z.array(scenarioWithHitRate).min(1).max(50) });

/** Parse with the gateway's schema plus twinOf and predictedHitRate; a failure names paths, never values. */
export function assertHitRateBody(body, what) {
  const r = hitRateBodySchema.safeParse(body);
  assert.ok(r.success, `${what}: the gateway (with predictedHitRate) would refuse this body: ${r.success ? '' : JSON.stringify(r.error.issues.map((i) => ({ path: i.path, code: i.code })))}`);
  return r.data;
}

/** A scenario object without predictedHitRate (to compare with a body from an uncalibrated catalog). */
export const withoutHitRate = ({ predictedHitRate: _, ...rest }) => rest;

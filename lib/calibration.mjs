// Release calibration is a local, content-free import. Validate before touching the catalog.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump as dumpYaml } from 'js-yaml';
import { calibrationDocumentSchema, loadCatalog } from './planner.mjs';
import { PlanError, resolveScenariosDir } from './planLock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const invalid = (issues) => new PlanError('calibration_invalid', { issues }, 'Invalid calibration document');

export function calibrate(from) {
  let document;
  try { document = JSON.parse(readFileSync(resolveScenariosDir(from), 'utf8')); }
  catch { throw invalid([{ path: [], code: 'unreadable_document' }]); }
  const result = calibrationDocumentSchema.safeParse(document);
  if (!result.success) throw invalid(result.error.issues.map(({ path, code }) => ({ path, code })));

  const path = join(ROOT, 'predictions.yaml');
  const original = readFileSync(path, 'utf8');
  const catalog = loadCatalog();
  const entries = new Map(result.data.shapes.map(({ shapeId, ...block }) => [shapeId, block]));
  const ids = new Set(catalog.shapes.map((s) => s.id));
  const updated = [];
  for (const shape of catalog.shapes) {
    delete shape.calibration;
    if (entries.has(shape.id)) {
      shape.calibration = entries.get(shape.id);
      updated.push(shape.id);
    }
  }
  // js-yaml drops comments. Retain the leading provenance (also when it follows version).
  const preamble = original.match(/^(?:(?:[ \t]*(?:#.*)?|version:[^\n]*)\r?\n)*/)[0];
  const provenance = (preamble.match(/^[ \t]*#.*(?:\r?\n|$)/gm) ?? []).join('');
  const text = provenance + dumpYaml(catalog);
  const temporary = join(ROOT, `.predictions-${randomUUID()}.yaml`);
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { ok: true, command: 'calibrate', updated: updated.sort(), unknown: [...entries.keys()].filter((id) => !ids.has(id)).sort() };
}

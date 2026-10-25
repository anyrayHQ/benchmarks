// The pooled no-op library for the tail check (ANY-1656) is the pass-through (P/P) result files
// already on disk: `--compare gateway --bare` runs. They accumulate rounds, so every run tops the
// library up. A file joins only when its pins match the run being judged, because the check assumes
// the no-op pairs and the judged pairs are exchangeable; a file that differs is skipped by name.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exclusionReasons, PRIOR_LOG_RATIO_SD } from './benchVerdict.mjs';
import { orientedRatio } from './stats.mjs';
import { tailCheck } from './tailCheck.mjs';

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? '');
  }
};
const versionsOf = (record) => [...new Set(['a', 'b'].flatMap((s) => Object.keys(record.claudeVersions?.[s] ?? {})))].sort().join(',');

/** What must match for two result files' pairs to be exchangeable. */
const pins = (record) => ({
  scenario: record.scenario?.name ?? record.scenario ?? null,
  model: JSON.stringify([record.setup?.a?.model ?? null, record.setup?.b?.model ?? null, record.bedrock?.model ?? null]),
  upstream: record.request?.upstream ?? 'seat',
  gateway: hostOf(record.gateway),
  version: versionsOf(record),
});
const LABELS = { scenario: 'different scenario', model: 'different model', upstream: 'different upstream', gateway: 'different gateway', version: 'different Claude Code version' };

const isPassThroughPairs = (record) => record.compare === 'gateway' && record.request?.bare === true;

/** The library for `treated`: valid P/P pairs from files whose pins match; the others, with why. */
export function libraryFrom(files, treated) {
  const want = pins(treated);
  const ratios = [];
  const anchors = [];
  const skipped = [];
  for (const { file, record } of files) {
    if (!isPassThroughPairs(record)) {
      skipped.push({ file, reason: 'not a pass-through pair run' });
      continue;
    }
    const have = pins(record);
    const differs = Object.keys(LABELS).find((k) => have[k] !== want[k]);
    if (differs) {
      skipped.push({ file, reason: LABELS[differs] });
      continue;
    }
    const valid = record.rounds.filter((r) => exclusionReasons(r).length === 0).map((r) => r.ratio);
    ratios.push(...valid);
    anchors.push({ file, pairs: valid.length });
  }
  return { ratios, anchors, skipped };
}

/** The P/P result files in a results dir (`<scenario>--gateway--bare[-label].json`; `bare-a` is P vs B). */
export function findLibraryFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => /--gateway--bare(?:-(?!a[-.])[^.]+)?\.json$/.test(f)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const logSd = (ratios) => {
  if (ratios.length < 2) return PRIOR_LOG_RATIO_SD;
  const logs = ratios.map(Math.log);
  const avg = logs.reduce((s, x) => s + x, 0) / logs.length;
  return Math.sqrt(logs.reduce((s, x) => s + (x - avg) ** 2, 0) / (logs.length - 1));
};

/** The tail check for a result record against loaded library files: `{ check, anchors, sd }`. */
export function tailForRecord(record, files, { treatment = 'b', seed = 1 } = {}) {
  const lib = libraryFrom(files, record);
  const ratios = record.rounds.filter((r) => exclusionReasons(r).length === 0).map((r) => orientedRatio(r, treatment));
  return { check: tailCheck({ ratios, library: lib.ratios, seed }), anchors: lib.anchors.map((a) => a.file), skipped: lib.skipped, sd: Number(logSd(lib.ratios).toFixed(3)) };
}

/** Read library files from disk, skipping any that do not parse. */
export const loadLibraryFiles = (paths) =>
  paths.flatMap((file) => {
    try {
      return [{ file: file.split('/').pop(), record: JSON.parse(readFileSync(file, 'utf8')) }];
    } catch {
      return [];
    }
  });

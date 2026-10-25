// The pooled no-op library for the tail check (ANY-1656) is the judged pair with the treatment taken
// out, from result files already on disk: a direct-vs-Anyray run is read against `--compare control`
// pairs (direct vs direct), a pass-through-vs-B run (`--bare-a`) against `--compare gateway --bare`
// pairs (P/P). Any other gateway pair has no matching noise. Files accumulate rounds, so every run
// tops the library up. A file joins only when its pins match the run being judged, because the check
// assumes the no-op pairs and the judged pairs are exchangeable; a file that differs is skipped by name.
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

/** What must match for two result files' pairs to be exchangeable. A control pair never touched a gateway. */
const pins = (record, kind) => ({
  scenario: record.scenario?.name ?? record.scenario ?? null,
  model: JSON.stringify([record.setup?.a?.model ?? null, record.setup?.b?.model ?? null, record.bedrock?.model ?? null]),
  upstream: record.request?.upstream ?? 'seat',
  ...(kind === 'control' ? {} : { gateway: hostOf(record.gateway) }),
  version: versionsOf(record),
});
const LABELS = { scenario: 'different scenario', model: 'different model', upstream: 'different upstream', gateway: 'different gateway', version: 'different Claude Code version' };

/** The no-op the judged record is read against: null when no recorded run is its pair without the treatment. */
export const noiseKindFor = (record) =>
  record.compare === 'anyray' ? 'control' : record.compare === 'gateway' && record.request?.bareA === true ? 'pass-through' : null;

/** What a result file is as noise: direct-vs-direct pairs, both-arms-bare gateway pairs, or neither. */
const noiseKindOf = (record) =>
  record.compare === 'control' ? 'control' : record.compare === 'gateway' && record.request?.bare === true ? 'pass-through' : null;

/** The library for `treated`: valid P/P pairs from files whose pins match; the others, with why. */
export function libraryFrom(files, treated) {
  const kind = noiseKindFor(treated);
  const want = pins(treated, kind);
  const ratios = [];
  const anchors = [];
  const skipped = [];
  for (const { file, record } of files) {
    if (kind === null || noiseKindOf(record) !== kind) {
      skipped.push({ file, reason: `not a ${kind ?? 'matching'} pair run` });
      continue;
    }
    const have = pins(record, kind);
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

const FILES = {
  'pass-through': /--gateway--bare(?:-(?!a[-.])[^.]+)?\.json$/, // `bare-a` is P vs B, not noise
  control: /--control(?:--[^.]+)?\.json$/,
};

/** The result files in a results dir that could be `kind` noise, by name; their records are checked on load. */
export function findLibraryFiles(dir, kind = 'pass-through') {
  try {
    return readdirSync(dir).filter((f) => FILES[kind].test(f)).map((f) => join(dir, f));
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

/** The tail check for a result record against loaded library files: `{ check, anchors, sd }`, or null when no recorded run is its no-op. */
export function tailForRecord(record, files, { treatment = 'b', seed = 1 } = {}) {
  if (noiseKindFor(record) === null) return null;
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

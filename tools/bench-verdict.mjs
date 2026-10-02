#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchVerdict, exclusionReasons, formatVerdictBlock } from '../lib/benchVerdict.mjs';

export function parseArgs(argv) {
  const args = { files: [], allowMixed: false, json: false, minRounds: 8 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-mixed') args.allowMixed = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--min-rounds') {
      const value = argv[++i];
      if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('--min-rounds requires a positive integer');
      args.minRounds = Number(value);
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else args.files.push(arg);
  }
  if (!args.files.length) throw new Error('usage: node tools/bench-verdict.mjs [--json] [--min-rounds N] [--allow-mixed] result.json [result.json ...]');
  return args;
}

const metadata = (record) => ({
  scenario: record.scenario?.name ?? record.scenario ?? null,
  compare: record.compare ?? null,
  model: [record.setup?.a?.model ?? null, record.setup?.b?.model ?? null, record.bedrock?.model ?? null],
  provider: record.provider ?? record.setup?.a?.provider ?? null,
});

export function poolFiles(files, { allowMixed = false } = {}) {
  const sources = files.map((path) => {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(record.rounds)) throw new Error(`${path}: rounds must be an array`);
    return { path, record, metadata: metadata(record) };
  });
  const fields = ['scenario', 'compare', 'model', 'provider'];
  const differences = fields.filter((field) => new Set(sources.map((s) => JSON.stringify(s.metadata[field]))).size > 1);
  if (differences.length && !allowMixed) throw new Error(`refusing to pool files with different ${differences.join(', ')}; use --allow-mixed to override`);
  return {
    sources,
    differences: differences.map((field) => ({ field, values: sources.map((s) => ({ file: basename(s.path), value: s.metadata[field] })) })),
    rounds: sources.flatMap((s) => s.record.rounds.map((round) => ({ file: basename(s.path), round }))),
  };
}

function box(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((r) => String(r[column]).length)));
  const border = (left, join, right) => left + widths.map((w) => '─'.repeat(w + 2)).join(join) + right;
  const line = (row) => '│ ' + row.map((value, i) => String(value).padEnd(widths[i])).join(' │ ') + ' │';
  return [border('┌', '┬', '┐'), line(rows[0]), border('├', '┼', '┤'),
    ...rows.slice(1).map(line), border('└', '┴', '┘')].join('\n');
}

const cost = (value) => Number.isFinite(value) ? value.toFixed(4) : 'n/a';
export function formatTable(pooled, verdict) {
  const rows = [['File', 'Round', 'A cost', 'B cost', 'B/A', 'A solved', 'B solved', 'Status']];
  for (const { file, round } of pooled.rounds) {
    const reasons = exclusionReasons(round);
    rows.push([file, round?.round ?? 'n/a', cost(round?.sessions?.a?.totals?.costUsd), cost(round?.sessions?.b?.totals?.costUsd),
      cost(round?.ratio), round?.quality?.a === true ? 'yes' : 'no', round?.quality?.b === true ? 'yes' : 'no', reasons.length ? reasons.join(', ') : 'valid']);
  }
  const mixed = pooled.differences.length ? `Mixed files (--allow-mixed): ${pooled.differences.map((d) => `${d.field}: ${d.values.map((v) => `${v.file}=${JSON.stringify(v.value)}`).join(', ')}`).join('; ')}\n` : '';
  return `${mixed}${box(rows)}\n${formatVerdictBlock(verdict)}`;
}

export function run(argv, { out = process.stdout, err = process.stderr } = {}) {
  try {
    const args = parseArgs(argv);
    const pooled = poolFiles(args.files, args);
    const verdict = benchVerdict(pooled.rounds.map((x) => x.round), { minRounds: args.minRounds });
    const result = { ...verdict, files: args.files, mixed: pooled.differences };
    out.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatTable(pooled, verdict)}\n`);
    return verdict.verdict === 'pass' ? 0 : verdict.verdict === 'fail' ? 1 : 2;
  } catch (error) {
    err.write(`${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = run(process.argv.slice(2));

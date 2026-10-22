// Client records are built from an allowlist after grading. Never persist session content.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { benchVerdict, exclusionReasons } from './benchVerdict.mjs';
import { rule0, solvedPairVerdict } from './stats.mjs';

const pick = (x, keys) => Object.fromEntries(keys.filter((k) => x?.[k] !== undefined).map((k) => [k, x[k]]));
const countMap = (x) => Object.fromEntries(Object.entries(x ?? {}).filter(([k, v]) => /^[A-Za-z0-9_.:-]{1,128}$/.test(k) && typeof v === 'number'));
const numbers = (x, keys) => Object.fromEntries(keys.filter((k) => typeof x?.[k] === 'number' || x?.[k] === null).map((k) => [k, x[k]]));
export function redactedTotals(t) {
  return {
    ...numbers(t, ['costUsd', 'turns', 'requests', 'subagents', 'toolCalls', 'input', 'output', 'cacheRead', 'cacheWrite', 'wallMs', 'subagentInputShare', 'mainRequests', 'subagentRequests', 'requestsPerSubagent', 'outsideCheckout', 'hookTrimmed', 'retrieveCalls', 'retrieveOk', 'readBatchCalls', 'readBatchOk', 'searchContextCalls', 'searchContextOk', 'cacheBreaks', 'parallelToolTurns', 'compactions', 'answeredAtMs', 'agentsRunningAtEnd', 'reportedFindings', 'clientCostUsd', 'gatewayPingCostUsd', 'gatewayPingCount']),
    ...pick(t, ['timedOutAfterAnswer']),
    ...(t?.hookTrimmedByTool ? { hookTrimmedByTool: countMap(t.hookTrimmedByTool) } : {}),
    ...(t?.peakContext ? { peakContext: countMap(t.peakContext) } : {}),
    ...(t?.start ? { start: numbers(t.start, ['agents', 'read', 'written']) } : {}),
    ...(Array.isArray(t?.models) ? { models: t.models.filter((m) => typeof m === 'string' && /^[\w.:+/-]{1,128}$/.test(m)) } : {}),
  };
}
export function redactedSession(s) {
  const calls = {};
  for (const r of s?.requests ?? []) for (const b of r.blocks ?? []) {
    if (b.type === 'tool_use' && typeof b.name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(b.name)) calls[b.name] = (calls[b.name] ?? 0) + 1;
  }
  return {
    toolCallsByName: s?.toolCallsByName ? countMap(s.toolCallsByName) : calls,
    totals: redactedTotals(s?.totals),
    setup: pick(s?.setup, ['claudeVersion']),
    ...(s?.check ? { check: { passed: s.check.passed === true } } : {}),
    ...(s?.citations ? { citations: numbers(s.citations, ['total', 'resolved', 'exact', 'bySuffix', 'ambiguous']) } : {}),
    ...(s?.answeredViaFile ? { answeredViaFile: true } : {}),
    ...(Array.isArray(s?.kindsObserved) ? { kindsObserved: s.kindsObserved } : {}),
  };
}
export const kitResultsDir = (dir, planHash) => join(dir, '.kit-results', planHash);
export function prepareKitResults(dir, planHash) {
  const out = kitResultsDir(dir, planHash);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(dir, '.kit-results', '.gitignore'), '*\n');
  return out;
}
export function redactedRecord(record, lock, id, gatewayVersion) {
  const rounds = record.rounds.map((r) => ({
    ...pick(r, ['round', 'ratio', 'error', 'failure', 'quality', 'holdoutDrawn', 'redraws', 'gatewayRestarted', 'hookLeak', 'startedAt', 'endedAt', 'kindsObserved']),
    ...(r.runTag ? { runTag: pick(r.runTag, ['tool', 'intent', 'sessionId']) } : {}),
    // Only the presence matters for exclusion; paths must not travel with results.
    ...(r.sharedOutsideWrites?.length ? { sharedOutsideWrites: Array(r.sharedOutsideWrites.length).fill(true) } : {}),
    ...(r.sessions ? { sessions: Object.fromEntries(['a', 'b'].map((slot) => [slot, redactedSession(r.sessions[slot])])) } : {}),
  }));
  return {
    planHash: lock.planHash,
    scenario: pick(lock.scenarios.find((s) => s.id === id), ['id', 'source', 'hash']),
    compare: record.compare,
    claudeVersion: lock.pins.clientVersion,
    ...(record.compare !== 'control' ? { gatewayVersion: gatewayVersion ?? null, kindsObserved: [...new Set(rounds.flatMap((r) => r.kindsObserved ?? []))].sort() } : {}),
    rounds,
    stats: rule0(rounds.filter((r) => exclusionReasons(r).length === 0)),
    rule0Verdict: solvedPairVerdict(rounds.filter((r) => !r.gatewayRestarted)),
    verdict: benchVerdict(rounds),
  };
}
export function readKitRecords(dir, lock, compare = 'anyray') {
  return lock.scenarios.map(({ id }) => {
    const file = join(kitResultsDir(dir, lock.planHash), `${id}--${compare}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  });
}

/** All recorded session costs count, including excluded rounds and earlier commands. */
export function kitSpend(dir, lock) {
  const rounds = ['control', 'anyray'].flatMap((compare) => readKitRecords(dir, lock, compare).flatMap((r) => r?.rounds ?? []));
  const costs = rounds.map(roundCost);
  const spentUsd = costs.reduce((sum, cost) => sum + cost, 0);
  return { spentUsd, rounds: rounds.length, maxRoundUsd: costs.reduce((max, cost) => Math.max(max, cost), 0), meanRoundUsd: costs.length ? spentUsd / costs.length : null };
}

export function roundCost(round) {
  return ['a', 'b'].reduce((sum, slot) => {
    const cost = round?.sessions?.[slot]?.totals?.costUsd;
    return sum + (Number.isFinite(cost) && cost >= 0 ? cost : 0);
  }, 0);
}

export const humanRatio = (value) => Number.isFinite(value) ? value.toFixed(3) : 'n/a';
export const humanInterval = (ci) => ci ? `${humanRatio(ci.lower)}-${humanRatio(ci.upper)}` : 'n/a';
export function formatKitVerdict(answer) {
  return answer.scenarios.map((s) => `${s.id}: ${s.verdict}; median ${humanRatio(s.stats.median)}; CI ${humanInterval(s.ci95)}; Rule 0 ${s.rule0}`).join('\n') + `\nPooled Rule 0: ${answer.rule0Verdict}\n`;
}
export function kitVerdict(lock, records) {
  const scenarios = lock.scenarios.map(({ id, source }, i) => {
    const rounds = records[i]?.rounds ?? [];
    const v = benchVerdict(rounds);
    const s = rule0(rounds.filter((r) => exclusionReasons(r).length === 0));
    const { shapeId, prediction } = lock.predictions[i];
    return {
      id, source, shapeId, prediction, verdict: v.verdict,
      rule0: solvedPairVerdict(rounds.filter((r) => !r.gatewayRestarted)).verdict,
      n: v.n, totalRounds: rounds.length,
      excluded: v.excluded.map(({ round, reasons }) => ({ round, reasons })),
      stats: pick(s, ['winRate', 'median', 'q3', 'max']),
      ci95: v.confidenceInterval95 ? pick(v.confidenceInterval95, ['lower', 'upper']) : null,
      vsPrediction: prediction.status !== 'band' || s.median === null ? null : s.median < prediction.lo ? 'below' : s.median > prediction.hi ? 'above' : 'inside',
    };
  });
  const pooled = records.flatMap((r) => r?.rounds ?? []);
  return { ok: true, command: 'verdict', planHash: lock.planHash,
    rule0Verdict: pooled.length ? solvedPairVerdict(pooled.filter((r) => !r.gatewayRestarted)).verdict : 'NO DATA', scenarios };
}

/** The legacy HTML page's redacted input, built independently of its full-record mode. */
export function redactedPageRecord(r) {
  const stats = (s) => ({ ...numbers(s, ['n', 'wins', 'solvedA', 'solvedB', 'winRate', 'median', 'q3', 'max']),
    ...(['PASS', 'FAIL', 'INCONCLUSIVE', 'INSUFFICIENT', 'NO DATA', 'pass', 'fail', 'inconclusive'].includes(s?.verdict) ? { verdict: s.verdict } : {}) });
  return {
    scenario: pick(r.scenario, ['name', 'source']), compare: r.compare, label: r.label,
    arms: pick(r.arms, ['a', 'b']), stats: stats(r.stats),
    ...(r.rule0Verdict ? { rule0Verdict: stats(r.rule0Verdict) } : {}),
    ...(r.verdict ? { verdict: stats(r.verdict) } : {}),
    rounds: (r.rounds ?? []).map((x) => ({
      ...pick(x, ['round', 'ratio']), quality: pick(x.quality, ['a', 'b']),
      ...(x.sessions ? { sessions: Object.fromEntries(['a', 'b'].map((slot) => [slot, {
        totals: redactedTotals(x.sessions[slot]?.totals), setup: pick(x.sessions[slot]?.setup, ['claudeVersion']),
      }])) } : {}),
    })),
  };
}

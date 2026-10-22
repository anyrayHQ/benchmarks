// Kept in step with gateway/src/services/clientTests.ts (ANY-1488, 4457e55c8),
// plus ANY-1491's optional twinOf field (requires the gateway schema update).
// Construct only aggregate fields; validate before either printing or sending them.
import { z } from 'zod';
import { exclusionReasons } from './benchVerdict.mjs';
import { kitVerdict } from './kitResults.mjs';
import { PlanError } from './planLock.mjs';

const identity = z.string().min(1).regex(/^[A-Za-z0-9][\w.:-]{0,63}$/);
const version = z.string().min(1).regex(/^[0-9A-Za-z][\w.+-]{0,63}$/);
const ratio = z.number().finite().gt(0).max(1000);
const predictedBand = z.union([
  z.object({ kind: z.literal('band'), low: ratio, high: ratio }).strict().refine((b) => b.low <= b.high),
  z.object({ kind: z.literal('none') }).strict(),
]);
const interval = z.object({ lower: ratio, upper: ratio }).strict().refine((ci) => ci.lower <= ci.upper);
const scenario = z.object({
  shapeId: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.enum(['client', 'proposed']), predictedBand,
  twinOf: z.string().regex(/^[0-9a-f]{64}$/).refine((h) => !/^0{64}$/.test(h)).optional(),
  n: z.number().int().min(0).max(10000), excluded: z.number().int().min(0).max(10000),
  winRate: z.number().finite().min(0).max(1).nullable(),
  median: ratio.nullable(), q3: ratio.nullable(), max: ratio.nullable(), ci95: interval.nullable(),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
}).strict().refine((s) => s.twinOf === undefined || s.source === 'proposed', { path: ['twinOf'] });
export const clientTestBodySchema = z.object({
  planHash: z.string().min(1).regex(/^[0-9a-f]{64}$/), kitVersion: version,
  benchmarksCommit: z.string().min(1).regex(/^[0-9a-f]{40}$/), gatewayVersion: version,
  releaseTag: identity, clientTool: identity, clientToolVersion: version,
  model: z.string().min(1).regex(/^[A-Za-z0-9][\w.:+/-]{0,127}$/).refine((m) => !m.includes('//')),
  provider: identity, scenarios: z.array(scenario).min(1).max(50),
  totals: z.object({
    n: z.number().int().min(0).max(100000), excluded: z.number().int().min(0).max(100000),
    costUsdPerSession: z.object({ direct: z.number().finite().min(0).max(1e6), anyray: z.number().finite().min(0).max(1e6) }).strict(),
  }).strict(),
  rule0Verdict: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'INSUFFICIENT', 'NO DATA']),
}).strict();

export function clientTestBody(lock, records, kitVersion, { scenarios: frozenScenarios = [], releaseTag } = {}) {
  const verdict = kitVerdict(lock, records);
  const versions = new Set(records.filter(Boolean).map((r) => r.gatewayVersion));
  const gatewayVersion = versions.size === 1 ? [...versions][0] : null;
  const scenarios = verdict.scenarios.map((s) => {
    const twinOf = frozenScenarios.find(({ id }) => id === s.id)?.scenario.twinOf;
    return {
      shapeId: s.shapeId ?? 'unknown', source: s.source,
      ...(twinOf === undefined ? {} : { twinOf }),
      predictedBand: s.prediction.status === 'band' ? { kind: 'band', low: s.prediction.lo, high: s.prediction.hi } : { kind: 'none' },
      n: s.n, excluded: s.excluded.length, ...s.stats, ci95: s.ci95, verdict: s.verdict,
    };
  });
  const valid = records.flatMap((r) => r?.rounds ?? []).filter((r) => exclusionReasons(r).length === 0);
  const mean = (slot) => valid.length ? valid.reduce((sum, r) => sum + r.sessions[slot].totals.costUsd, 0) / valid.length : 0;
  const body = {
    planHash: lock.planHash, kitVersion, benchmarksCommit: lock.benchmarksCommit,
    gatewayVersion, releaseTag: releaseTag ?? `v${gatewayVersion}`, clientTool: lock.pins.client,
    clientToolVersion: lock.pins.clientVersion, model: lock.pins.model, provider: lock.pins.provider,
    scenarios, totals: { n: scenarios.reduce((sum, s) => sum + s.n, 0), excluded: scenarios.reduce((sum, s) => sum + s.excluded, 0), costUsdPerSession: { direct: mean('a'), anyray: mean('b') } },
    rule0Verdict: verdict.rule0Verdict,
  };
  const result = clientTestBodySchema.safeParse(body);
  if (!result.success) throw new PlanError('report_invalid', { issues: result.error.issues.map(({ path, code }) => ({ path, code })) }, 'Result does not match the gateway schema');
  return result.data;
}

export function formatKitReport(verdict, body) {
  return [`Plan ${verdict.planHash}`, `Claude Code ${body.clientToolVersion}; gateway ${body.gatewayVersion}`, ...verdict.scenarios.map((s) =>
    `${s.id} (${s.source}, ${s.shapeId ?? 'unknown'}): ${s.prediction.status === 'band' ? `prediction: ${s.prediction.lo}-${s.prediction.hi}` : 'prediction: none'}; n ${s.n}; median ${s.stats.median ?? 'n/a'}; CI ${s.ci95 ? `${s.ci95.lower}-${s.ci95.upper}` : 'n/a'}; ${s.verdict}; Rule 0 ${s.rule0}; vs prediction ${s.vsPrediction ?? 'n/a'}`), `Pooled Rule 0: ${verdict.rule0Verdict}`, ''].join('\n');
}

// Kept in step with gateway/src/services/clientTests.ts (ANY-1488, 4457e55c8),
// plus ANY-1491's optional twinOf field (requires the gateway schema update).
// ANY-1492 adds the optional predictedHitRate from the current catalog.
// Construct only aggregate fields; validate before either printing or sending them.
import { z } from 'zod';
import { exclusionReasons } from './benchVerdict.mjs';
import { kitVerdict, humanRatio, humanInterval, humanTail, humanCost, humanVsPrediction } from './kitResults.mjs';
import { PlanError } from './planLock.mjs';
import { loadCatalog, predictedHitRate } from './planner.mjs';

const identity = z.string().min(1).regex(/^[A-Za-z0-9][\w.:-]{0,63}$/);
const version = z.string().min(1).regex(/^[0-9A-Za-z][\w.+-]{0,63}$/);
const ratio = z.number().finite().gt(0).max(1000);
const predictedBand = z.union([
  z.object({ kind: z.literal('band'), low: ratio, high: ratio }).strict().refine((b) => b.low <= b.high),
  z.object({ kind: z.literal('none') }).strict(),
]);
const interval = z.object({ lower: ratio, upper: ratio }).strict().refine((ci) => ci.lower <= ci.upper);
const pairCount = z.number().int().min(0).max(10000);
// Paired check outcomes; the counts must reconcile, as the gateway requires.
const parity = z.object({
  n: pairCount, passDirect: pairCount, passAnyray: pairCount, anyrayWorse: pairCount, anyrayBetter: pairCount,
}).strict().refine((p) => p.passDirect <= p.n && p.passAnyray <= p.n && p.anyrayWorse + p.anyrayBetter <= p.n
  && p.passAnyray === p.passDirect - p.anyrayWorse + p.anyrayBetter);
const scenario = z.object({
  shapeId: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.enum(['client', 'proposed']), predictedBand,
  predictedHitRate: z.number().finite().min(0).max(1).nullable().optional(),
  twinOf: z.string().regex(/^[0-9a-f]{64}$/).refine((h) => !/^0{64}$/.test(h)).optional(),
  n: z.number().int().min(0).max(10000), excluded: z.number().int().min(0).max(10000),
  winRate: z.number().finite().min(0).max(1).nullable(),
  median: ratio.nullable(), q3: ratio.nullable(), max: ratio.nullable(), ci95: interval.nullable(),
  verdict: z.enum(['pass', 'fail', 'inconclusive']),
  parity: parity.optional(),
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
  const catalog = loadCatalog();
  const scenarios = verdict.scenarios.map((s) => {
    const twinOf = frozenScenarios.find(({ id }) => id === s.id)?.scenario.twinOf;
    const shape = catalog.shapes.find((shape) => shape.id === s.shapeId);
    return {
      shapeId: s.shapeId ?? 'unknown', source: s.source,
      ...(twinOf === undefined ? {} : { twinOf }),
      ...(s.parity ? { parity: s.parity } : {}),
      ...(shape?.calibration ? { predictedHitRate: predictedHitRate(shape, s.prediction) } : {}),
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

const qualityClause = (p) => (p
  ? `; Anyray passed ${p.passAnyray} of ${p.n}, direct ${p.passDirect} of ${p.n}${p.anyrayWorse ? `; ${p.anyrayWorse} ${p.anyrayWorse === 1 ? 'pair' : 'pairs'} passed only direct` : ''}`
  : '');

export function formatKitReport(verdict, body) {
  return [`Plan ${verdict.planHash}`, `Claude Code ${body.clientToolVersion}; gateway ${body.gatewayVersion}`, ...verdict.scenarios.map((s) =>
    `${s.id} (${s.source}, ${s.shapeId ?? 'unknown'}): ${s.prediction.status === 'band' ? `prediction: ${humanRatio(s.prediction.lo)}-${humanRatio(s.prediction.hi)}` : 'prediction: none'}; n ${s.n}; median ${humanRatio(s.stats.median)}; CI ${humanInterval(s.ci95)}; ${s.verdict}; Rule 0 ${s.rule0}${qualityClause(s.parity)}${humanTail(s) ? `; ${humanTail(s)}` : ''}; vs prediction: ${humanVsPrediction(s.vsPrediction)}`), `Pooled Rule 0: ${verdict.rule0Verdict}`, ...(humanCost(body.totals.costUsdPerSession) ? [humanCost(body.totals.costUsdPerSession)] : []), ''].join('\n');
}

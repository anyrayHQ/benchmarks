// Per-strategy quality checks for strategies that don't fit answer-vs-answer judging.
// ctx: { baseline, optimized, metric, judged } where baseline/optimized are
// GatewayClient.execute results and judged (tool_safety) is a judgeAnswers result.

const CHECKS = {
  // semantic_cache: correctness is an exact hit serving the identical response.
  cache_hit: (ctx) => ({
    verdict: ctx.optimized?.decisions?.cacheHit ? 'PASS' : 'FAIL',
    detail: { cacheHit: !!ctx.optimized?.decisions?.cacheHit },
  }),
  // cache_optimizer: lossless — the answer must be byte-identical to baseline.
  identical: (ctx) => {
    const same = ctx.baseline?.answer === ctx.optimized?.answer;
    return { verdict: same ? 'PASS' : 'FAIL', detail: { identical: same } };
  },
  // param_tuning: the clamped output must not be cut mid-answer.
  truncation: (ctx) => ({
    verdict: ctx.optimized?.finishReason === 'length' ? 'FAIL' : 'PASS',
    detail: { finishReason: ctx.optimized?.finishReason ?? null },
  }),
  // tool_pruning: answer judge plus "no needed tool was pruned" (judge preserved).
  tool_safety: (ctx) => ({
    verdict: ctx.judged?.preserved ? 'PASS' : 'FAIL',
    detail: { score: ctx.judged?.score, missingFacts: ctx.judged?.missingFacts ?? [] },
  }),
  // context_quality: read-only signal, not a transform.
  readonly: (ctx) => ({ verdict: 'N/A', detail: ctx.metric ?? {} }),
};

export function runCheck(kind, ctx) {
  const fn = CHECKS[kind];
  if (!fn) throw new Error(`unknown check kind: ${kind}`);
  return fn(ctx);
}

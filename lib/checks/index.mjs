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
  // tool_pruning/tool_schema_compression: the optimized turn must call the same
  // tool(s) as baseline — proves needed tools survived (robust to preamble phrasing,
  // which gets terser as tools are pruned; the tool CALL is the real invariant).
  tool_calls: (ctx) => {
    const calls = (r) =>
      [
        ...new Set(
          (r?.raw?.choices?.[0]?.message?.tool_calls ?? [])
            .map((t) => t.function?.name)
            .filter(Boolean)
        ),
      ].sort();
    const base = calls(ctx.baseline);
    const opt = calls(ctx.optimized);
    // Non-empty baseline (so a no-tool answer can't vacuously pass) and every tool
    // the baseline called is still called after optimization.
    const ok = base.length > 0 && base.every((n) => opt.includes(n));
    return { verdict: ok ? 'PASS' : 'FAIL', detail: { baselineToolCalls: base, optimizedToolCalls: opt } };
  },
  // context_quality: read-only signal, not a transform.
  readonly: (ctx) => ({ verdict: 'N/A', detail: ctx.metric ?? {} }),
};

export function runCheck(kind, ctx) {
  const fn = CHECKS[kind];
  if (!fn) throw new Error(`unknown check kind: ${kind}`);
  return fn(ctx);
}

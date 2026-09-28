// What the gateway had turned on, and what each strategy actually did — derived from
// the org optimizer config and the per-request optimizer decisions (lib/traces.mjs).
// Kept free of Node APIs so report_agent.mjs can inline it into the page.

export const BENCH_TOOL = 'anyray-bench';

/** A rule applies to benchmark traffic when its `when` is empty or matches tool=anyray-bench. */
function ruleAppliesToBench(rule) {
  const w = rule.when;
  if (!w || Object.keys(w).length === 0) return true;
  if (w.endpoints || w.models || w.users || w.teams) return false; // not decidable here; skip
  const tool = w.metadata?.tool;
  if (!tool) return false;
  return tool.some((v) => v === '*' || v === BENCH_TOOL || (v.endsWith('*') && BENCH_TOOL.startsWith(v.slice(0, -1))));
}

/**
 * Effective strategy set for benchmark requests: org enabled flags, then matching
 * override rules in order (`disable` always wins). Returns null when the config is
 * not visible (no admin key).
 */
export function effectiveStrategies(opt) {
  if (!opt?.strategies) return null;
  const state = new Map(opt.strategies.map((s) => [s.kind, { kind: s.kind, on: !!s.enabled, source: s.enabled ? 'org default' : 'off' }]));
  const disabled = new Set();
  for (const rule of opt.overrides?.rules ?? []) {
    if (!ruleAppliesToBench(rule)) continue;
    for (const k of rule.enable ?? []) {
      const cur = state.get(k) ?? { kind: k };
      state.set(k, { ...cur, on: true, source: cur.on ? cur.source : `rule: ${rule.label ?? 'unnamed'}` });
    }
    for (const k of rule.disable ?? []) disabled.add(k);
  }
  for (const k of disabled) state.set(k, { ...(state.get(k) ?? { kind: k }), on: false, source: 'disabled by rule' });
  return [...state.values()].filter((s) => s.kind !== 'audited_holdout');
}

/** One decision → a state the report can show. */
export function decisionState(d) {
  if ((d.estimatedTokensSaved ?? 0) > 0) return 'saved';
  const m = d.metric?.name ?? '';
  if (m === 'guard_suppressed') return 'guard';
  if (m || d.after?.reason || d.summary) return 'stood down';
  return 'no change';
}

/**
 * Per-strategy outcome across a set of traces: how many requests it acted on, how
 * many it saved on, tokens saved, guard holds, and the stand-down reasons it gave.
 */
export function strategyOutcomes(traces) {
  const out = new Map();
  for (const t of traces ?? []) {
    for (const d of t.decisions ?? []) {
      const o = out.get(d.kind) ?? { kind: d.kind, requests: 0, saved: 0, tokens: 0, usd: 0, guard: 0, reasons: new Set() };
      o.requests++;
      const st = decisionState(d);
      if (st === 'saved') {
        o.saved++;
        o.tokens += d.estimatedTokensSaved ?? 0;
        o.usd += d.estimatedSavingsUsd ?? 0;
      } else if (st === 'guard') o.guard++;
      else if (st === 'stood down') o.reasons.add(d.metric?.name ?? d.after?.reason ?? d.summary);
      out.set(d.kind, o);
    }
  }
  return [...out.values()]
    .map((o) => ({ ...o, reasons: [...o.reasons].filter(Boolean).slice(0, 4) }))
    .sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);
}

/**
 * Enabled vs outcome, one row per strategy: on-but-never-seen, on-and-saved,
 * on-but-held-back, and anything that ran without being listed as on.
 */
export function strategyTable(opt, traces) {
  const eff = effectiveStrategies(opt);
  const outcomes = new Map(strategyOutcomes(traces).map((o) => [o.kind, o]));
  const kinds = new Set([...(eff ?? []).map((s) => s.kind), ...outcomes.keys()]);
  return [...kinds].map((kind) => {
    const e = eff?.find((s) => s.kind === kind);
    const o = outcomes.get(kind);
    let verdict;
    if (o?.saved) verdict = 'worked';
    else if (o?.guard) verdict = 'held by guard';
    else if (o?.requests) verdict = 'stood down';
    else if (e?.on) verdict = 'on, never fired';
    else verdict = 'off';
    return { kind, on: e ? e.on : null, source: e?.source ?? (o ? 'not in config' : null), outcome: o ?? null, verdict };
  }).sort((a, b) => (b.outcome?.tokens ?? 0) - (a.outcome?.tokens ?? 0) || (b.on === true) - (a.on === true) || a.kind.localeCompare(b.kind));
}

// Read a pause-scenario round from its result file: what each arm cost, and what the
// gateway did at each COLD turn, the first request after an idle gap long enough for the
// provider's prompt cache to have expired.
//
// On such a turn the gateway may attest the expiry to its optimizer, which then prices an
// edit of the (already lost) cached prefix differently. Per cold turn this reports whether
// the attestation shows on the trace, which strategies removed how many tokens (the
// optimizer's own estimates), whether a strategy counted the write it avoided
// (`cold_write_saving_usd`), and what the provider then wrote and read.
//
// Everything comes from the result file run_agent.mjs wrote (totals, per-request traces),
// so it needs no gateway access.

const DEFAULT_GAP_SEC = 1800;

/** Half the scenario's shortest pause: a gap longer than that between two requests is a pause. */
export function coldGapSec(scenario) {
  const d = scenario?.followupDelaySec;
  const pauses = (Array.isArray(d) ? d : [d]).filter((x) => typeof x === 'number' && x > 0);
  return pauses.length ? Math.min(...pauses) / 2 : DEFAULT_GAP_SEC;
}

// `<kind> mint admission estimate`: the kind whose mint gate reported the metric.
const metricKind = (d) => String(d.summary ?? '').split(' ')[0] || d.kind;
const metricsNamed = (decisions, name) => decisions.filter((d) => d?.metric?.name === name);
const MEASURES = new Set(['mint_economics', 'content_census', 'cache_lint', 'first_appearance_shadow']);
// Suppression-ledger rows that report a measurement or the attestation, not a strategy standing down.
const NOT_A_STAND_DOWN = new Set(['first_appearance_shadow', 'prompt_cache_expiry']);

function coldTurn(trace, idleMs) {
  const decisions = trace.decisions ?? [];
  const removed = {};
  for (const d of decisions) {
    if (!d || MEASURES.has(d.kind) || !(d.estimatedTokensSaved > 0)) continue;
    removed[d.kind] = (removed[d.kind] ?? 0) + d.estimatedTokensSaved;
  }
  return {
    at: trace.timestamp,
    idleMin: Math.round(idleMs / 60000),
    // The attestation is only visible where a mint gate priced something under it.
    attested: [...new Set(metricsNamed(decisions, 'cache_expired').map(metricKind))].sort(),
    // A gap that read expired but was not attested, and why.
    refused: (trace.suppressed ?? []).filter((s) => s?.kind === 'prompt_cache_expiry').map((s) => s.reason),
    // Strategies a gate stood down on this request (a holdout, the regret guard, a cooloff).
    stoodDown: (trace.suppressed ?? []).filter((s) => s?.kind && !NOT_A_STAND_DOWN.has(s.kind)).map((s) => `${s.kind}:${s.reason}`).sort(),
    creditUsd: Object.fromEntries(metricsNamed(decisions, 'cold_write_saving_usd').map((d) => [metricKind(d), d.metric.value])),
    removed,
    removedTokens: Object.values(removed).reduce((a, b) => a + b, 0),
    cacheWriteTokens: trace.cacheWriteTokens ?? null,
    cacheReadTokens: trace.cacheReadTokens ?? null,
    declines: trace.declines ?? null,
  };
}

/** The main-thread requests that follow a gap longer than `gapSec`. */
export function coldTurnsOf(traces, gapSec) {
  const main = traces.filter((t) => t.subagent !== true).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const out = [];
  for (let i = 1; i < main.length; i++) {
    const idleMs = Date.parse(main[i].timestamp) - Date.parse(main[i - 1].timestamp);
    if (idleMs > gapSec * 1000) out.push(coldTurn(main[i], idleMs));
  }
  return out;
}

const costOf = (totals, solved) => ({
  costUsd: totals?.costUsd ?? null,
  clientCostUsd: totals?.clientCostUsd ?? null,
  pings: totals?.gatewayPingCount ?? null,
  pingCostUsd: totals?.gatewayPingCostUsd ?? null,
  turns: totals?.turns ?? null,
  requests: totals?.requests ?? null,
  cacheBreaks: totals?.cacheBreaks ?? null,
  retrieveCalls: totals?.retrieveCalls ?? null,
  retrieveOk: totals?.retrieveOk ?? null,
  solved: solved ?? null,
});

/**
 * `{ gapSec, rounds: [{ round, ratio, heldOut, arms: { a, b }, problems }] }`. An arm is
 * `{ cost, coldTurns }` (`coldTurns` null when its traces are not in the file). `problems`
 * lists what makes the round unreadable as a comparison of the two arms.
 */
export function coldTurnReport(record) {
  const gapSec = coldGapSec(record.scenario);
  const treated = record.request?.experimentB ?? null; // arm B's tag, when the treatment is a rule keyed on it
  const rounds = (record.rounds ?? []).map((r) => {
    if (r.error) return { round: r.round, error: r.error };
    const problems = [];
    if (r.gatewayRestarted) problems.push('the gateway restarted during the round');
    if (r.heldOut?.differs) {
      const list = (k) => (k?.length ? k.join(', ') : 'none');
      problems.push(`the session gate held out different kinds: A ${list(r.heldOut.a)}, B ${list(r.heldOut.b)}`);
    }
    if (r.experimentRule && r.experimentRule.stable === false) problems.push("arm B's rule changed during the round");
    const arms = {};
    for (const slot of ['a', 'b']) {
      if (!r.sessions?.[slot]) continue;
      const S = slot.toUpperCase();
      const source = slot === 'a' ? r.tracesA : r.traces;
      let coldTurns = null;
      if (source?.unavailable) problems.push(`${S}: traces unavailable (${source.unavailable})`);
      else if (Array.isArray(source?.traces)) {
        coldTurns = coldTurnsOf(source.traces, gapSec);
        coldTurns.forEach((c, i) => {
          if (!c.attested.length) problems.push(`${S}: cold turn ${i + 1} was not attested (${c.refused.join(', ') || 'no mint gate priced under it, or the gateway did not attest'})`);
        });
        if (slot === 'b' && treated && coldTurns.some((c) => c.attested.length) && !coldTurns.some((c) => Object.keys(c.creditUsd).length)) {
          problems.push('B: no cold turn shows the credit (cold_write_saving_usd)');
        }
      }
      arms[slot] = { cost: costOf(r.sessions[slot].totals, r.quality?.[slot]), coldTurns };
    }
    // A tenant-wide guard can open or close between the two arms' cold turns: the arms then
    // ran different strategies at that turn.
    const [ca, cb] = [arms.a?.coldTurns, arms.b?.coldTurns];
    if (ca && cb) {
      for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
        const [x, y] = [ca[i]?.stoodDown ?? [], cb[i]?.stoodDown ?? []];
        if (x.join() !== y.join()) problems.push(`cold turn ${i + 1}: different kinds stood down (A ${x.join(', ') || 'none'}; B ${y.join(', ') || 'none'})`);
      }
    }
    return { round: r.round, ratio: r.ratio ?? null, heldOut: r.heldOut ?? null, arms, problems };
  });
  return { gapSec, treated, rounds };
}

const usd = (v, d = 3) => (v == null ? 'n/a' : `$${v.toFixed(d)}`);
const kindList = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');

/** The report as text: one block per round, one line per arm, one per cold turn. */
export function formatColdTurnReport(report) {
  const out = [`cold turn = a main-thread request more than ${Math.round(report.gapSec / 60)} min after the one before it`];
  for (const r of report.rounds) {
    if (r.error) {
      out.push(`\nround ${r.round}: failed (${r.error})`);
      continue;
    }
    out.push(`\nround ${r.round}: ratio B/A ${r.ratio == null ? 'n/a' : r.ratio.toFixed(3)}`);
    if (r.problems.length) out.push(`  DISCARD or re-check this round:\n${r.problems.map((p) => `    - ${p}`).join('\n')}`);
    for (const [slot, arm] of Object.entries(r.arms)) {
      const c = arm.cost;
      const held = r.heldOut?.[slot];
      out.push(
        `  ${slot.toUpperCase()}: ${usd(c.costUsd)} (client ${usd(c.clientCostUsd)} + ${c.pings ?? 'n/a'} pings ${usd(c.pingCostUsd)}) · ${c.turns} turns · ${c.requests} requests · ` +
          `${c.cacheBreaks} cache breaks · ${c.retrieveCalls} retrievals (${c.retrieveOk} ok) · ${c.solved ? 'solved' : 'NOT solved'}` +
          (held ? ` · held out: ${held.length ? held.join(', ') : 'none'}` : '')
      );
      if (!arm.coldTurns) {
        out.push('    cold turns: n/a (no traces for this arm in the file)');
        continue;
      }
      if (!arm.coldTurns.length) out.push('    cold turns: none');
      arm.coldTurns.forEach((t, i) => {
        const declined = Object.entries(t.declines ?? {}).flatMap(([k, why]) => Object.keys(why).map((w) => `${k}:${w}`));
        out.push(
          `    cold turn ${i + 1} (idle ${t.idleMin} min): ` +
            (t.attested.length ? `attested ${t.attested.join(', ')}` : `NOT attested${t.refused.length ? ` (${t.refused.join(', ')})` : ''}`) +
            ` · removed ${t.removedTokens} tok${t.removedTokens ? ` (${kindList(t.removed)})` : ''}` +
            ` · ${Object.keys(t.creditUsd).length ? `credit ${Object.entries(t.creditUsd).map(([k, v]) => `${usd(v, 4)} (${k})`).join(', ')}` : 'no credit'}` +
            ` · wrote ${t.cacheWriteTokens ?? 'n/a'} / read ${t.cacheReadTokens ?? 'n/a'}` +
            (t.stoodDown.length ? ` · stood down ${t.stoodDown.join(', ')}` : '') +
            (declined.length ? ` · declined ${declined.join(', ')}` : '')
        );
      });
    }
  }
  return out.join('\n');
}

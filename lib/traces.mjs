// Read what Anyray did to a session, from the gateway's own records — the same data
// the console's request modal shows (optimizer pipeline, per-strategy savings, cost).
//
// The trace API is admin-only: it needs an `aak_…` admin API key with traces:read
// (and optimizer:read for the enabled-strategy config), in ANYRAY_TRACE_KEY. Prompt
// bodies (/content) additionally need traces:content, which API keys never get, so
// the forwarded prompt is only shown when ANYRAY_TRACE_TOKEN (an admin token/session)
// is set. Without any key, the report says so instead of guessing.
//
// Requests are correlated by the sessionId we put in x-anyray-metadata.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBenchKey } from './benchKey.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`${res.status} ${url.replace(/\?.*/, '')}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Client-side policy (hooks digest on/off, org MCP) — readable with the client key. */
export async function connectPolicy(gatewayUrl, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    const key = resolveBenchKey(env, () => {}).key || JSON.parse(readFileSync(join(homedir(), '.anyray', 'connect.json'), 'utf8')).clientKey;
    const res = await fetchImpl(`${gatewayUrl}/connect/policy`, { headers: { 'x-anyray-api-key': key } });
    if (!res.ok) return { error: `connect/policy ${res.status}` };
    const { skills, ...rest } = await res.json();
    return { ...rest, skills: (skills ?? []).map((s) => `${s.name ?? s.id} ${s.version ?? ''}`.trim()) };
  } catch (e) {
    return { error: e.message };
  }
}

/** Org optimizer config: which strategies are on, with params. Needs optimizer:read. */
export async function optimizerConfig(gatewayUrl, env = process.env) {
  const token = env.ANYRAY_TRACE_TOKEN || env.ANYRAY_TRACE_KEY || env.ANYRAY_ADMIN_KEY;
  if (!token) return { unavailable: 'set ANYRAY_ADMIN_KEY (aak_ key with optimizer:read)' };
  try {
    const j = await getJSON(`${gatewayUrl}/admin/v1/optimizer`, token);
    return { strategies: j.config?.strategies ?? [], overrides: j.config?.overrides ?? null };
  } catch (e) {
    return { unavailable: e.message };
  }
}

/** One trace as the result file keeps it: usage, what the optimizer decided, what it withheld and why. */
export function traceRecord(row, detail) {
  const opt = (detail.observations ?? []).find((o) =>
    [o.name, o.type].some((s) => (s || '').toLowerCase().includes('optimizer'))
  );
  const m = detail.metadata ?? row.metadata ?? {};
  return {
    id: row.id,
    timestamp: row.timestamp,
    endpoint: m.endpoint,
    subagent: m.subagent ?? null,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheWriteTokens: m.cacheWriteTokens,
    estimatedTokensSaved: m.estimatedTokensSaved,
    costUsd: m.costUsd,
    baselineCostUsd: m.baselineCostUsd,
    savingsUsd: m.savingsUsd ?? m.grossSavingsUsd,
    optimizationStatus: m.optimizationStatus,
    optimizationKinds: m.optimizationKinds,
    decisions: Array.isArray(opt?.output?.decisions) ? opt.output.decisions : [],
    // Kinds a gate stood down on this request (a holdout, a cooloff, a refused cache-expiry
    // attestation) and why each strategy that ran declined: ids and counts, never content.
    suppressed: Array.isArray(m.optimizationSuppressed) ? m.optimizationSuppressed : null,
    declines: m.strategyDeclines && typeof m.strategyDeclines === 'object' ? m.strategyDeclines : null,
    input: detail.contentRedacted ? null : detail.input,
    contentRedacted: !!detail.contentRedacted,
  };
}

/**
 * All traces for one sessionId, with the optimizer decisions for each. Traces land
 * asynchronously, so poll until the count stops growing (or `waitMs` passes).
 */
export async function sessionTraces(gatewayUrl, sessionId, { env = process.env, waitMs = 90000 } = {}) {
  const token = env.ANYRAY_TRACE_TOKEN || env.ANYRAY_TRACE_KEY || env.ANYRAY_ADMIN_KEY;
  if (!token) return { unavailable: 'set ANYRAY_ADMIN_KEY (aak_ key with traces:read) to see the optimizer pipeline' };
  let rows = [];
  const deadline = Date.now() + waitMs;
  try {
    for (let last = -1; Date.now() < deadline; ) {
      const page = await getJSON(`${gatewayUrl}/admin/v1/traces?limit=100&sessionId=${encodeURIComponent(sessionId)}`, token);
      rows = page.data ?? page.items ?? page.rows ?? [];
      if (rows.length && rows.length === last) break;
      last = rows.length;
      await sleep(10000);
    }
    const traces = [];
    for (const row of rows) {
      let detail;
      try {
        detail = await getJSON(`${gatewayUrl}/admin/v1/traces/${row.id}/content`, token);
      } catch (e) {
        if (e.status !== 403 && e.status !== 401) throw e;
        detail = { ...(await getJSON(`${gatewayUrl}/admin/v1/traces/${row.id}`, token)), contentRedacted: true };
      }
      traces.push(traceRecord(row, detail));
    }
    return { traces: traces.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))) };
  } catch (e) {
    return { unavailable: e.message };
  }
}

const adminToken = (env) => env.ANYRAY_TRACE_TOKEN || env.ANYRAY_TRACE_KEY || env.ANYRAY_ADMIN_KEY;

/**
 * What the gateway itself spent on one Claude Code session: its keep-warm pings are
 * real billed calls the client never sees, so Claude Code's total_cost_usd leaves them
 * out. Keyed by Claude Code's own session id (the x-claude-code-session-id header),
 * subagents included. Spend rows land asynchronously, so re-read until the counts stop
 * moving, bounded by `waitMs`. An older gateway (no such endpoint) or a key without
 * spend:read comes back `{ unavailable }`.
 */
export async function sessionGatewaySpend(
  gatewayUrl,
  clientSessionId,
  { env = process.env, fetchImpl = fetch, sleep: wait = sleep, clock = Date.now, waitMs = 30000, intervalMs = 5000 } = {}
) {
  const token = adminToken(env);
  if (!token) return { unavailable: 'set ANYRAY_ADMIN_KEY (admin API key with spend:read) to count gateway pings' };
  if (!clientSessionId) return { unavailable: 'no Claude Code session id in the init event' };
  const url = `${gatewayUrl}/admin/v1/spend/sessions/${encodeURIComponent(clientSessionId)}?includeSubagents=true`;
  const deadline = clock() + waitMs;
  let last = null;
  try {
    for (;;) {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return { unavailable: `GET /admin/v1/spend/sessions ${res.status}` };
      const body = await res.json();
      const pings = (body.byRequestKind ?? []).find((k) => k.requestKind === 'cache_warm') ?? { requests: 0, costUsd: 0 };
      const read = { pingCount: pings.requests, pingCostUsd: pings.costUsd, requests: body.total?.requests ?? 0, sessions: body.sessions };
      const settled = last && read.requests > 0 && read.requests === last.requests && read.pingCount === last.pingCount;
      last = read;
      if (settled) return { ...read, settled: true };
      if (clock() + intervalMs > deadline) return { ...read, settled: false };
      await wait(intervalMs);
    }
  } catch (e) {
    return { unavailable: e.message };
  }
}

/**
 * The gateway arm's cost with its pings in: `costUsd` becomes client cost + ping cost
 * (what the ratio compares), `clientCostUsd` keeps Claude Code's own figure. An
 * unavailable read records null and leaves the cost as it was.
 */
export function addGatewayPings(totals, spend) {
  const clientCostUsd = totals.costUsd;
  if (!spend || spend.unavailable) return { ...totals, clientCostUsd, gatewayPingCount: null, gatewayPingCostUsd: null };
  return {
    ...totals,
    clientCostUsd,
    gatewayPingCount: spend.pingCount,
    gatewayPingCostUsd: spend.pingCostUsd,
    costUsd: clientCostUsd == null ? null : clientCostUsd + spend.pingCostUsd,
  };
}

/**
 * Each gateway replica's start time, from the admin health report (reportedAt − uptime),
 * so a round can tell whether the gateway restarted under it. Stale replicas (no longer
 * reporting) are left out. Null when unreadable.
 */
export function replicaStarts(health) {
  const replicas = (Array.isArray(health?.replicas) ? health.replicas : []).filter((r) => (r.freshness ?? 'fresh') === 'fresh');
  if (!replicas.length) return null;
  return Object.fromEntries(replicas.map((r) => [r.replicaId, new Date(Date.parse(r.reportedAt) - r.uptimeSec * 1000).toISOString()]));
}

/** True when a replica is new or started again between two readings (null if either is unknown). */
export function restartedDuring(before, after, toleranceMs = 60_000) {
  if (!before || !after) return null;
  return Object.entries(after).some(([id, started]) => !(id in before) || Math.abs(Date.parse(started) - Date.parse(before[id])) > toleranceMs);
}

/** The gateway's replica start times now, or null. Needs an admin key. */
export async function gatewayReplicaStarts(gatewayUrl, env = process.env, { fetchImpl = fetch } = {}) {
  const token = adminToken(env);
  if (!gatewayUrl || !token) return null;
  try {
    const res = await fetchImpl(new URL('/admin/v1/settings/health', gatewayUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? replicaStarts(await res.json()) : null;
  } catch {
    return null;
  }
}

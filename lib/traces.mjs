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
      const opt = (detail.observations ?? []).find((o) =>
        [o.name, o.type].some((s) => (s || '').toLowerCase().includes('optimizer'))
      );
      const m = detail.metadata ?? row.metadata ?? {};
      traces.push({
        id: row.id,
        timestamp: row.timestamp,
        endpoint: m.endpoint,
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
        input: detail.contentRedacted ? null : detail.input,
        contentRedacted: !!detail.contentRedacted,
      });
    }
    return { traces: traces.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))) };
  } catch (e) {
    return { unavailable: e.message };
  }
}

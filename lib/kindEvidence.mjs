// What one optimization kind did in one session, read from the gateway's trace METADATA
// (ANY-1154): which requests it decided on, how many blocks it folded fresh and how many
// tokens that saved, how much it replayed, why it declined, and whether the session gate
// held it out. Only the metadata list (`GET /admin/v1/traces?sessionId=`) and the
// metadata-only detail (`GET /admin/v1/traces/:id`) are read, never the `/content` path,
// and the fold keeps counts and enum tokens only: no summary text, no before/after seam.

const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const HOLDOUT_REASONS = new Set(['session_gate_holdout', 'holdout_kind', 'holdout_whole']);
const count = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);
const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n;
};

/**
 * One kind's evidence over a session's trace rows. `decisionsById` maps a trace id to its
 * optimizer decisions (from the detail read); a row whose metadata names the kind but has
 * no decision list read leaves the token and block counts UNKNOWN (null), never zero.
 * A replay decision (`pinsReplayed`) re-sends settled folds; anything else is a fresh fold.
 */
export const foldKindEvidence = (rows, decisionsById, kind) => {
  const e = {
    requests: 0,
    requestsWithKind: 0,
    freshFolds: 0,
    blocksFactored: 0,
    freshTokens: 0,
    replays: 0,
    pinsReplayed: 0,
    replayTokens: 0,
    tokensSaved: 0,
    suppressed: {},
    declines: {},
    holdout: false,
    detailUnread: 0,
  };
  for (const r of Array.isArray(rows) ? rows : []) {
    e.requests++;
    const m = r?.metadata ?? {};
    for (const s of Array.isArray(m.optimizationSuppressed) ? m.optimizationSuppressed : []) {
      if (s?.kind === kind && typeof s.reason === 'string' && TOKEN.test(s.reason)) bump(e.suppressed, s.reason);
    }
    const declined = m.strategyDeclines?.[kind];
    if (declined && typeof declined === 'object') {
      for (const [reason, n] of Object.entries(declined)) if (TOKEN.test(reason) && Number.isInteger(n) && n > 0) bump(e.declines, reason, n);
    }
    if (!(Array.isArray(m.optimizationKinds) && m.optimizationKinds.includes(kind))) continue;
    e.requestsWithKind++;
    const decisions = decisionsById?.[r.id];
    if (!Array.isArray(decisions)) {
      e.detailUnread++;
      continue;
    }
    for (const d of decisions) {
      if (d?.kind !== kind) continue;
      const tokens = count(d.estimatedTokensSaved);
      if (count(d.pinsReplayed) > 0) {
        e.replays++;
        e.pinsReplayed += d.pinsReplayed;
        e.replayTokens += tokens;
      } else {
        e.freshFolds++;
        e.blocksFactored += count(d.after?.blocksFactored);
        e.freshTokens += tokens;
      }
      e.tokensSaved += tokens;
    }
  }
  e.holdout = Object.keys(e.suppressed).some((r) => HOLDOUT_REASONS.has(r));
  if (e.detailUnread > 0) for (const k of ['freshFolds', 'blocksFactored', 'freshTokens', 'replays', 'pinsReplayed', 'replayTokens', 'tokensSaved']) e[k] = null;
  return e;
};

/** The decisions of one metadata-only trace detail, reduced to the fields the fold reads. */
const decisionsOf = (detail) =>
  (detail?.observations ?? [])
    .filter((o) => o?.name === 'optimizer' && Array.isArray(o.output?.decisions))
    .flatMap((o) => o.output.decisions)
    .map((d) => ({
      kind: typeof d?.kind === 'string' ? d.kind : null,
      estimatedTokensSaved: d?.estimatedTokensSaved,
      ...(Number.isFinite(d?.pinsReplayed) && { pinsReplayed: d.pinsReplayed }),
      ...(Number.isFinite(d?.after?.blocksFactored) && { after: { blocksFactored: d.after.blocksFactored } }),
    }));

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every watched kind's evidence for one session, by the sessionId the arm sent in
 * x-anyray-metadata. Traces land asynchronously, so the metadata list is re-read until
 * `settleReads` consecutive reads agree on the row count (bounded by `maxReads`). The
 * admin token rides a header and is never printed. Never throws: a read that fails is
 * `{ unavailable }`, which a report must show as unknown, not as zero.
 */
export const readSessionKindEvidence = async (
  gatewayUrl,
  adminToken,
  sessionId,
  kinds,
  { fetchImpl = fetch, sleep = sleepMs, intervalMs = 10_000, settleReads = 2, maxReads = 6, pageLimit = 100 } = {}
) => {
  if (!adminToken) return { unavailable: 'no admin token' };
  const headers = { authorization: `Bearer ${adminToken}` };
  const getJson = async (path) => {
    const res = await fetchImpl(new URL(path, gatewayUrl), { headers });
    if (!res.ok) throw Object.assign(new Error(`GET ${path.replace(/\?.*/, '')} ${res.status}`), { status: res.status });
    return res.json();
  };
  const listAll = async () => {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ sessionId, limit: String(pageLimit), ...(cursor && { cursor }) });
      const body = await getJson(`/admin/v1/traces?${q}`);
      rows.push(...(Array.isArray(body?.data) ? body.data : []));
      cursor = typeof body?.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
      if (!cursor) break;
    }
    // A row the list shows twice across pages is one request.
    return [...new Map(rows.filter((r) => r?.sessionId === undefined || r.sessionId === sessionId).map((r) => [r.id, r])).values()];
  };
  try {
    let rows = await listAll();
    let agreeing = 1;
    for (let n = 1; n < maxReads && agreeing < settleReads; n++) {
      await sleep(intervalMs);
      const next = await listAll();
      agreeing = next.length === rows.length && next.length > 0 ? agreeing + 1 : 1;
      rows = next;
    }
    const wanted = rows.filter((r) => Array.isArray(r?.metadata?.optimizationKinds) && kinds.some((k) => r.metadata.optimizationKinds.includes(k)));
    const decisionsById = {};
    for (const r of wanted) {
      try {
        decisionsById[r.id] = decisionsOf(await getJson(`/admin/v1/traces/${encodeURIComponent(r.id)}`));
      } catch {
        // Left unread: the fold reports this row's tokens as unknown.
      }
    }
    return {
      requests: rows.length,
      settled: agreeing >= settleReads,
      kinds: Object.fromEntries(kinds.map((k) => [k, foldKindEvidence(rows, decisionsById, k)])),
    };
  } catch (e) {
    return { unavailable: String(e?.message ?? e?.name ?? 'error').slice(0, 120) };
  }
};

// Per-request strategy selection, so a benchmark says which optimizations it measures
// instead of inheriting whatever the gateway's tenant has on by default.
//
// Gateway contract: `x-anyray-optimization-kinds: k1,k2` runs exactly those kinds
// (default-off ones too) unless an admin rule disables them. Each inference response
// then carries `x-anyray-optimization-result`: JSON with status, applied kinds, skipped
// kinds with a fixed reason, and preserved session kinds. No header = unconfirmed.

export const KINDS_HEADER = 'x-anyray-optimization-kinds';
export const RESULT_HEADER = 'x-anyray-optimization-result';

const KIND = /^[a-z][a-z0-9_]{0,63}$/;

/** `--kinds a,b` → ['a','b']: trimmed, deduped, catalogue-shaped ids only. */
export function parseKinds(spec) {
  const kinds = [...new Set(String(spec ?? '').split(',').map((k) => k.trim()).filter(Boolean))];
  if (!kinds.length) throw new Error('--kinds expects a comma-separated list of optimization kinds, e.g. observation_mask,code_graph');
  const bad = kinds.filter((k) => !KIND.test(k));
  if (bad.length) throw new Error(`--kinds: not an optimization kind: ${bad.map((k) => JSON.stringify(k)).join(', ')}`);
  return kinds;
}

/** ANTHROPIC_CUSTOM_HEADERS (newline-separated) with the kinds header set, everything else kept. */
export function withKindsHeader(headers, kinds) {
  const lines = String(headers ?? '').split('\n').filter(Boolean);
  if (!kinds?.length) return lines.join('\n');
  const rest = lines.filter((h) => !h.toLowerCase().startsWith(`${KINDS_HEADER}:`));
  return [...rest, `${KINDS_HEADER}: ${kinds.join(',')}`].join('\n');
}

const ids = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string' && KIND.test(k)) : null);

/** One response's feedback header → { status, applied, skipped, preserved } or unconfirmed. */
export function parseOptimizationResult(raw) {
  if (raw === undefined || raw === null || raw === '') return { status: 'unconfirmed', why: 'missing' };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { status: 'unconfirmed', why: 'invalid' };
  }
  const applied = ids(j?.applied);
  if (!j || typeof j !== 'object' || typeof j.status !== 'string' || !applied || !Array.isArray(j.skipped)) {
    return { status: 'unconfirmed', why: 'invalid' };
  }
  return {
    status: KIND.test(j.status) ? j.status : 'unknown',
    applied,
    skipped: j.skipped
      .filter((s) => typeof s?.kind === 'string' && KIND.test(s.kind) && typeof s.reason === 'string' && KIND.test(s.reason))
      .map(({ kind, reason }) => ({ kind, reason })),
    preserved: ids(j.preserved) ?? [],
  };
}

const bump = (o, k) => {
  o[k] = (o[k] ?? 0) + 1;
};

/** Per requested kind across a session's responses: applied, skipped by reason, unconfirmed. */
export function tallyKinds(results, kinds) {
  const byKind = Object.fromEntries(kinds.map((k) => [k, { applied: 0, skipped: {}, unconfirmed: 0 }]));
  const t = { requests: results.length, unconfirmed: 0, byKind, otherApplied: {}, preserved: {} };
  for (const r of results) {
    if (r.status === 'unconfirmed') {
      t.unconfirmed++;
      for (const k of kinds) byKind[k].unconfirmed++;
      continue;
    }
    for (const k of kinds) {
      const skip = r.skipped.find((s) => s.kind === k);
      if (r.applied.includes(k)) byKind[k].applied++;
      else if (skip) bump(byKind[k].skipped, skip.reason);
      else byKind[k].unconfirmed++;
    }
    for (const k of r.applied) if (!kinds.includes(k)) bump(t.otherApplied, k);
    for (const k of r.preserved) bump(t.preserved, k);
  }
  return t;
}

/** Human summary: one line per requested kind. */
export function formatKindTally(t) {
  const lines = [`optimization feedback: ${t.requests} request(s), ${t.unconfirmed} without feedback`];
  for (const [k, c] of Object.entries(t.byKind)) {
    const n = Object.values(c.skipped).reduce((a, b) => a + b, 0);
    const why = n ? ` (${Object.entries(c.skipped).map(([r, x]) => `${r} ${x}`).join(', ')})` : '';
    lines.push(`    ${k}: applied ${c.applied} · skipped ${n}${why} · unconfirmed ${c.unconfirmed}`);
  }
  const other = Object.entries(t.otherApplied);
  if (other.length) lines.push(`    also applied: ${other.map(([k, x]) => `${k} ${x}`).join(', ')}`);
  const kept = Object.entries(t.preserved);
  if (kept.length) lines.push(`    preserved: ${kept.map(([k, x]) => `${k} ${x}`).join(', ')}`);
  return lines.join('\n');
}

// Which Anyray client key the Anyray arm uses, and which tenant that puts its traffic in.
//
// The gateway keys tenant-wide optimizer state (regret-guard verdicts, session cooloffs,
// holdouts) by the request's tenant, and the tenant comes from the client key. On a
// shared key every experiment lands in the same tenant (`default`), so one experiment's
// regrets can switch a strategy off for the next. ANYRAY_BENCH_CLIENT_KEY is a key
// dedicated to benchmark traffic; ANYRAY_BENCH_TENANT names its tenant for the record
// (the gateway does not report a key's tenant to the client).

const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const set = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `{ key, source, dedicated, tenant }`; warns (never with the key) when falling back. */
export function resolveBenchKey(env = process.env, warn = console.warn) {
  const bench = set(env.ANYRAY_BENCH_CLIENT_KEY);
  const declared = set(env.ANYRAY_BENCH_TENANT);
  const tenantName = declared === null ? null : TENANT_ID.test(declared) ? declared : 'invalid ANYRAY_BENCH_TENANT';
  if (bench) {
    return { key: bench, source: 'ANYRAY_BENCH_CLIENT_KEY', dedicated: true, tenant: tenantName ?? 'undeclared (set ANYRAY_BENCH_TENANT)' };
  }
  const shared = set(env.ANYRAY_CLIENT_KEY);
  warn(
    'ANYRAY_BENCH_CLIENT_KEY is not set: the Anyray arm ' +
      (shared ? 'uses ANYRAY_CLIENT_KEY' : 'has no client key in the environment') +
      ", so its traffic shares the gateway's default tenant (regret-guard verdicts, cooloffs and holdouts) with every other experiment."
  );
  return { key: shared, source: shared ? 'ANYRAY_CLIENT_KEY' : null, dedicated: false, tenant: 'default' };
}

/** What the result records about the arm's tenant: never the key itself. */
export const benchTenantSetup = ({ tenant, source, dedicated }) => ({ tenant, keyVar: source, dedicated });

// --provider bedrock: both arms bill AWS Bedrock instead of a Claude subscription.
//   direct   Claude Code's own Bedrock client (CLAUDE_CODE_USE_BEDROCK=1), signed with an
//            AWS profile on this machine.
//   anyray   Claude Code connected by `anyray-connect --org`: the gateway key
//            authenticates, and the gateway's routing sends the request to Bedrock with
//            the credentials it holds. Nothing on the client names a provider.
// The gateway rewrites Claude Code's model id to a Bedrock one; the direct arm must call
// that same id, so one tiny request through the gateway reads it back first.
//
// Claude Code also makes side calls on a small/fast model (WebFetch's page summarizer
// among them). Toward the Anthropic API, which is what the gateway arm looks like to it,
// it picks its current Haiku for them. On Bedrock it runs them on the MAIN model unless
// ANTHROPIC_DEFAULT_HAIKU_MODEL names one (that var also sets its `haiku` alias), so the
// direct arm would pay Sonnet for calls the gateway arm makes on Haiku: a difference the
// client could set itself, never a gateway saving. The direct arm gets Bedrock Haiku 5.5.

const set = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The direct arm's AWS profile and region, and optional pinned Bedrock ids (main and small/fast model). */
export function bedrockOptions(env = process.env) {
  return {
    profile: set(env.ANYRAY_BEDROCK_PROFILE) ?? set(env.AWS_PROFILE) ?? 'default',
    region: set(env.ANYRAY_BEDROCK_REGION) ?? 'us-east-1',
    model: set(env.ANYRAY_BEDROCK_MODEL),
    smallModel: set(env.ANYRAY_BEDROCK_SMALL_MODEL),
  };
}

/** The Claude Code env var that sets its small/fast model (and its `haiku` alias). */
export const SMALL_MODEL_ENV = 'ANTHROPIC_DEFAULT_HAIKU_MODEL';
/** Claude Code reads this one first when set; recorded, never set by the harness. */
const LEGACY_SMALL_MODEL_ENV = 'ANTHROPIC_SMALL_FAST_MODEL';

/**
 * The direct arm's small/fast model: ANYRAY_BEDROCK_SMALL_MODEL, else Haiku 5.5 in the
 * same cross-region inference profile as the main model (`us.anthropic.claude-sonnet-5`
 * → `us.anthropic.claude-haiku-5-5`; `us` when the main id names none).
 */
export function bedrockSmallModel(model, pinned = null) {
  if (pinned) return { smallModel: pinned, smallModelSource: 'ANYRAY_BEDROCK_SMALL_MODEL' };
  const geo = /^([a-z]+)\.anthropic\./.exec(model ?? '')?.[1] ?? 'us';
  return { smallModel: `${geo}.anthropic.claude-haiku-5-5`, smallModelSource: `default: Haiku 5.5 in the main model's "${geo}" inference profile` };
}

/** Process env that puts a Claude Code session on Bedrock directly, small/fast model included. */
export const bedrockDirectEnv = ({ profile, region, smallModel = null }) => ({
  CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: profile, AWS_REGION: region,
  ...(smallModel ? { [SMALL_MODEL_ENV]: smallModel } : {}),
});

/** The small/fast model an env names for Claude Code (the var it reads first wins), or null. */
export function smallModelInEnv(env = {}) {
  for (const key of [LEGACY_SMALL_MODEL_ENV, SMALL_MODEL_ENV]) if (set(env[key])) return { model: env[key].trim(), env: key };
  return null;
}

/**
 * One 1-token request the way the org lane sends it (gateway key as bearer, no provider
 * header). Returns the provider that served it and the model id it was served as.
 */
export async function probeGatewayRoute({ gatewayUrl, clientKey, model, fetchImpl = fetch }) {
  if (!clientKey) throw new Error('--provider bedrock needs ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY for the Anyray arm');
  const res = await fetchImpl(new URL('/v1/messages', gatewayUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${clientKey}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-anyray-metadata': JSON.stringify({ tool: 'anyray-bench', intent: 'route-probe' }) },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gateway route probe: HTTP ${res.status} ${text.slice(0, 200).replace(/\b(ark|aak)[-_][\w-]+/g, '<redacted>')}`);
  let served = null;
  try {
    served = JSON.parse(text).model ?? null;
  } catch {}
  return { provider: res.headers.get('x-anyray-provider'), model: served };
}

/**
 * Throws unless the gateway served the probe from Bedrock; returns the Bedrock model id.
 * A gateway on Bedrock's native InvokeModel lane answers with the client's own model id,
 * not the Bedrock one: `pinned` (ANYRAY_BEDROCK_MODEL) then names the direct arm's id.
 */
export function assertBedrockRoute(route, { pinned = null } = {}) {
  if (route.provider !== 'bedrock') throw new Error(`--provider bedrock: the gateway routed the org lane to "${route.provider ?? 'unknown'}", not bedrock`);
  if (/(^|\.)anthropic\./.test(route.model ?? '')) return route.model;
  if (pinned) return null;
  throw new Error(`--provider bedrock: the gateway served model "${route.model}", not a Bedrock Anthropic id; set ANYRAY_BEDROCK_MODEL to the id the direct arm should call`);
}

/** `us.anthropic.claude-sonnet-5` / `anthropic.claude-haiku-4-5-20251001-v1:0` → the canonical id. */
export const canonicalModel = (model) => String(model ?? '').replace(/^(?:[a-z]+\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '');

const family = (model) => /^claude-([a-z]+)-/.exec(canonicalModel(model))?.[1] ?? null;

/**
 * Model families both arms used, but on different models (`result.modelUsage` keys, e.g.
 * Haiku 4.5 on one arm and Haiku 5.5 on the other): { haiku: { a: [...], b: [...] } }.
 * A family only one arm used is not a mismatch: the other arm made no such call.
 */
export function modelMismatch(a = [], b = []) {
  const byFamily = (models) => {
    const out = {};
    for (const m of models) if (family(m)) (out[family(m)] ??= new Set()).add(canonicalModel(m));
    return out;
  };
  const [fa, fb] = [byFamily(a), byFamily(b)];
  const out = {};
  for (const f of Object.keys(fa)) {
    if (!fb[f]) continue;
    const [x, y] = [[...fa[f]].sort(), [...fb[f]].sort()];
    if (x.join() !== y.join()) out[f] = { a: x, b: y };
  }
  return out;
}

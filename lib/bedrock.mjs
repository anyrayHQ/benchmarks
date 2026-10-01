// --provider bedrock: both arms bill AWS Bedrock instead of a Claude subscription.
//   direct   Claude Code's own Bedrock client (CLAUDE_CODE_USE_BEDROCK=1), signed with an
//            AWS profile on this machine.
//   anyray   Claude Code connected by `anyray-connect --org`: the gateway key
//            authenticates, and the gateway's routing sends the request to Bedrock with
//            the credentials it holds. Nothing on the client names a provider.
// The gateway rewrites Claude Code's model id to a Bedrock one; the direct arm must call
// that same id, so one tiny request through the gateway reads it back first.

const set = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The direct arm's AWS profile and region, and an optional pinned Bedrock model id. */
export function bedrockOptions(env = process.env) {
  return {
    profile: set(env.ANYRAY_BEDROCK_PROFILE) ?? set(env.AWS_PROFILE) ?? 'default',
    region: set(env.ANYRAY_BEDROCK_REGION) ?? 'us-east-1',
    model: set(env.ANYRAY_BEDROCK_MODEL),
  };
}

/** Process env that puts a Claude Code session on Bedrock directly. */
export const bedrockDirectEnv = ({ profile, region }) => ({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: profile, AWS_REGION: region });

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

// Execute a request against the live Anyray gateway (:8787) — chat-completions by
// default, or Anthropic-native `/v1/messages` when the workload's endpoint says so
// (needed for `thinking` and `context_management`, which the chat route doesn't carry).
// `optimize:'off'` bypasses the hook (a baseline, or an already-transformed request);
// `optimize:'on'` runs the full deployed pipeline. Returns the answer, the raw provider
// body (so a response can be seeded into the semantic cache), and the real provider
// `usage` (savings are the actual billed prompt-token delta, not chars/4).

import { authHeaders, withClaudeIdentity, withClaudeIdentitySystem } from './auth.mjs';
import { fetchRetry } from './http.mjs';

export function parseCompletion(body) {
  const choice = body?.choices?.[0] ?? {};
  const content = choice.message?.content ?? '';
  const answer = Array.isArray(content)
    ? content.map((b) => b.text ?? '').join('')
    : String(content);
  return { answer, usage: body?.usage ?? {}, finishReason: choice.finish_reason ?? null };
}

// Anthropic messages response -> the same normalized shape parseCompletion returns.
// output_tokens includes thinking tokens, which is exactly the output-side basis.
export function parseMessages(body) {
  const answer = (body?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const u = body?.usage ?? {};
  return {
    answer,
    usage: { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null },
    finishReason: body?.stop_reason ?? null,
  };
}

export class GatewayClient {
  constructor({ url, auth, endpoint = '/v1/chat/completions', timeoutMs = 30000, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.auth = auth;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async execute(request, { optimize = 'off', model, metadata, endpoint } = {}) {
    const path = endpoint || this.endpoint;
    const native = path.includes('/messages');
    const headers = {
      'content-type': 'application/json',
      ...authHeaders(this.auth),
      'x-anyray-optimize': optimize,
    };
    if (metadata) headers['x-anyray-metadata'] = JSON.stringify(metadata);
    // Claude identity rides in `messages` on the chat route, in top-level `system`
    // on the native route (a system-role message is invalid there).
    const payload = native
      ? { ...request, ...(model && { model }), system: withClaudeIdentitySystem(request.system, this.auth) }
      : { ...request, ...(model && { model }), messages: withClaudeIdentity(request.messages, this.auth) };
    const started = Date.now();
    const res = await fetchRetry(
      this.fetch,
      `${this.url}${path}`,
      () => ({ method: 'POST', headers, body: JSON.stringify(payload) }),
      { timeoutMs: this.timeoutMs }
    );
    if (!res.ok) {
      const text = (await res.text?.().catch(() => '')) ?? '';
      throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    const parsed = native ? parseMessages(body) : parseCompletion(body);
    let decisions = null;
    const hdr = res.headers?.get?.('x-anyray-optimization');
    if (hdr) {
      try {
        decisions = JSON.parse(hdr);
      } catch {
        decisions = null;
      }
    }
    return { ...parsed, raw: body, decisions, latencyMs: Date.now() - started };
  }
}

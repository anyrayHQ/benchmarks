// Execute a chat-completions request against the live Anyray gateway (:8787).
// `optimize:'off'` bypasses the hook (a baseline, or an already-transformed request);
// `optimize:'on'` runs the full deployed pipeline. Returns the answer, the raw provider
// body (so a response can be seeded into the semantic cache), and the real provider
// `usage` (savings are the actual billed prompt-token delta, not chars/4).

import { authHeaders, withClaudeIdentity } from './auth.mjs';
import { fetchRetry } from './http.mjs';

export function parseCompletion(body) {
  const choice = body?.choices?.[0] ?? {};
  const content = choice.message?.content ?? '';
  const answer = Array.isArray(content)
    ? content.map((b) => b.text ?? '').join('')
    : String(content);
  return { answer, usage: body?.usage ?? {}, finishReason: choice.finish_reason ?? null };
}

export class GatewayClient {
  constructor({ url, auth, endpoint = '/v1/chat/completions', timeoutMs = 30000, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, '');
    this.auth = auth;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async execute(request, { optimize = 'off', model, metadata } = {}) {
    const headers = {
      'content-type': 'application/json',
      ...authHeaders(this.auth),
      'x-anyray-optimize': optimize,
    };
    if (metadata) headers['x-anyray-metadata'] = JSON.stringify(metadata);
    const messages = withClaudeIdentity(request.messages, this.auth);
    const payload = { ...request, ...(model && { model }), messages };
    const started = Date.now();
    const res = await fetchRetry(
      this.fetch,
      `${this.url}${this.endpoint}`,
      () => ({ method: 'POST', headers, body: JSON.stringify(payload) }),
      { timeoutMs: this.timeoutMs }
    );
    if (!res.ok) {
      const text = (await res.text?.().catch(() => '')) ?? '';
      throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    const parsed = parseCompletion(body);
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

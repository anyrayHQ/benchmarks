// Send one request down one path and normalize what comes back.
//
//   side 'direct'   the provider itself: upstream credential only, no Anyray headers.
//                   Always Anthropic-native /v1/messages (see lib/toAnthropic.mjs).
//   side 'gateway'  an Anyray gateway, as a customer calls it: the payload's own wire
//                   format and the client key, with NO x-anyray-* control headers, so
//                   the gateway does whatever its deployment does by default.
//
// Both return the answer text (tool calls rendered inline, so a tool-calling turn is
// comparable), a normalized usage block that splits cached from uncached input, and
// wall-clock latency.

import { authHeaders, isOAuth, withClaudeIdentity } from './auth.mjs';
import { fetchRetry } from './http.mjs';
import { chatToMessages, withIdentityBlock } from './toAnthropic.mjs';

const toolCall = (name, input) =>
  `[tool_call ${name} ${typeof input === 'string' ? input : JSON.stringify(input ?? {})}]`;

/**
 * Normalized usage. `input` is the total prompt size however it was billed;
 * `cacheRead` / `cacheWrite` are the parts of it billed at cache rates (null when the
 * wire format does not say).
 */
export function parseCompletion(body) {
  const choice = body?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = msg.content ?? '';
  const text = Array.isArray(content) ? content.map((b) => b.text ?? '').join('') : String(content);
  const calls = (msg.tool_calls ?? []).map((tc) => toolCall(tc.function?.name, tc.function?.arguments));
  const u = body?.usage ?? {};
  return {
    answer: [text, ...calls].filter(Boolean).join('\n'),
    usage: {
      input: u.prompt_tokens ?? null,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? null,
      cacheWrite: u.cache_creation_input_tokens ?? null,
      output: u.completion_tokens ?? null,
    },
    finishReason: choice.finish_reason ?? null,
  };
}

// Anthropic's input_tokens excludes cached tokens; fold them back so `input` is the
// whole prompt on both wire formats. output_tokens includes thinking tokens.
export function parseMessages(body) {
  const blocks = body?.content ?? [];
  const answer = blocks
    .map((b) => (b?.type === 'text' ? b.text ?? '' : b?.type === 'tool_use' ? toolCall(b.name, b.input) : ''))
    .filter(Boolean)
    .join('\n');
  const u = body?.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    answer,
    usage: {
      input: u.input_tokens == null ? null : u.input_tokens + cacheRead + cacheWrite,
      cacheRead,
      cacheWrite,
      output: u.output_tokens ?? null,
    },
    finishReason: body?.stop_reason ?? null,
  };
}

export class Client {
  constructor({ side, url, auth, timeoutMs = 300000, fetchImpl = fetch }) {
    if (side !== 'direct' && side !== 'gateway') throw new Error(`unknown side ${side}`);
    if (!url) {
      throw new Error(side === 'gateway' ? 'no gateway URL: set ANYRAY_GATEWAY_URL' : 'no direct URL');
    }
    this.side = side;
    this.url = url.replace(/\/$/, '');
    this.auth = auth;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  /** Build {url, headers, payload, native} without sending — exported for tests. */
  prepare(request, { endpoint = '/v1/chat/completions', model } = {}) {
    const req = { ...request, ...(model && { model }) };
    const native = endpoint.includes('/messages');
    if (this.side === 'direct') {
      const oauth = this.auth?.provider === 'anthropic' && isOAuth(this.auth?.upstreamToken);
      const body = native ? req : chatToMessages(req, { identity: oauth });
      return {
        url: `${this.url}/v1/messages`,
        headers: { 'content-type': 'application/json', ...authHeaders(this.auth, { direct: true }) },
        payload: oauth && native ? withIdentityBlock(body) : body,
        native: true,
      };
    }
    // Claude identity rides in `messages` on the chat route, and as its own leading
    // `system` block on the native route: glued into one system string, subscription
    // OAuth is rejected upstream (surfaced as a misleading 429).
    const oauth = this.auth?.mode === 'passthrough' && this.auth?.provider === 'anthropic' && isOAuth(this.auth?.upstreamToken);
    return {
      url: `${this.url}${endpoint}`,
      headers: { 'content-type': 'application/json', ...authHeaders(this.auth) },
      payload: native
        ? oauth ? withIdentityBlock(req) : req
        : { ...req, messages: withClaudeIdentity(req.messages, this.auth) },
      native,
    };
  }

  async execute(request, opts = {}) {
    const { url, headers, payload, native } = this.prepare(request, opts);
    const started = Date.now();
    const res = await fetchRetry(
      this.fetch,
      url,
      () => ({ method: 'POST', headers, body: JSON.stringify(payload) }),
      { timeoutMs: this.timeoutMs }
    );
    if (!res.ok) {
      const text = (await res.text?.().catch(() => '')) ?? '';
      throw new Error(`${this.side} ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = await res.json();
    const parsed = native ? parseMessages(body) : parseCompletion(body);
    return { ...parsed, latencyMs: Date.now() - started };
  }
}

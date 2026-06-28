// Whole-request token accounting (the default, content-free measurement basis).
//
// We measure the SIZE of the chat request the optimizer returns, not the model's
// answer — the saving Anyray books is on the INPUT it forwards to the provider.
// Size is the character length of every message body plus the tools array, and
// the token figure is chars / chars_per_token (default 4, matching the
// optimizer's own estimate). This is an estimate, not a provider bill — see
// RESULTS.md for how it compares to real prompt_tokens.

/** Flatten a request's message contents to a single string (string or block-array). */
export function textOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  return messages
    .map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    )
    .join('\n');
}

/** Whole-request character size: message text + any tools/functions schema. */
export function sizeOf(request) {
  const body = textOf(request);
  const tools = request?.tools ? JSON.stringify(request.tools) : '';
  return body.length + tools.length;
}

/** Character count -> estimated tokens at the configured basis. */
export function estTokens(chars, charsPerToken = 4) {
  return Math.round(chars / charsPerToken);
}

/** Percent saved from before/after (0 when before is 0). */
export function savedPct(before, after) {
  return before > 0 ? Math.round((1 - after / before) * 100) : 0;
}

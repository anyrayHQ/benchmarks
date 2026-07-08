// Whole-request token accounting (the default, content-free measurement basis).
//
// We measure the SIZE of the chat request the optimizer returns, not the model's
// answer — the saving Anyray books is on the INPUT it forwards to the provider.
// Size is the character length of every message body plus the tools array, and
// the token figure is chars / chars_per_token (default 4, matching the
// optimizer's own estimate). This is an estimate, not a provider bill — see
// RESULTS.md for how it compares to real prompt_tokens.

// Block-aware so a key fact containing quotes matches VERBATIM in Anthropic
// payloads (JSON.stringify would escape it and break the substring check).
const blockText = (block) => {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'tool_result') return contentText(block.content);
  return JSON.stringify(block);
};

const contentText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).join('\n');
  return JSON.stringify(content ?? '');
};

/** Flatten a request's message contents (and Anthropic top-level system) to one string. */
export function textOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = typeof request?.system === 'string' ? [request.system] : [];
  return [...system, ...messages.map((m) => contentText(m.content))].join('\n');
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

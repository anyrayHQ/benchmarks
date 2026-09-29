// Convert an OpenAI chat-completions request into an Anthropic-native /v1/messages
// request. Used only for blackbox mode's direct-to-provider baseline: Anthropic's own
// chat-compat route flattens every system message into one string, which a Claude
// subscription OAuth token rejects (the Claude Code identity must be its own leading
// system block). Going native keeps the identity as a separate block, and is also the
// shape the gateway itself sends upstream, so the baseline is the same request Anyray
// would have forwarded, minus Anyray.

import { CLAUDE_CODE_SYSTEM } from './auth.mjs';

const text = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : c == null ? '' : String(c);

function contentBlocks(c) {
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' || !b?.type ? { type: 'text', text: b.text ?? '' } : b));
  const t = text(c);
  return t ? [{ type: 'text', text: t }] : [];
}

function parseArgs(a) {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a || '{}');
  } catch {
    return { _raw: String(a) };
  }
}

/** Append blocks to the last message when it has the same role (Anthropic wants alternation). */
function push(out, role, blocks) {
  if (!blocks.length) return;
  const last = out.at(-1);
  if (last?.role === role) last.content.push(...blocks);
  else out.push({ role, content: [...blocks] });
}

/**
 * @param req     chat-completions body ({model, max_tokens, messages, tools?, ...})
 * @param opts.identity  prepend the Claude Code identity as its own system block
 */
export function chatToMessages(req, { identity = false } = {}) {
  const system = [];
  if (identity) system.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
  const messages = [];
  for (const m of req.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      const t = text(m.content);
      if (t && !(identity && t.startsWith('You are Claude Code'))) system.push({ type: 'text', text: t });
    } else if (m.role === 'tool') {
      push(messages, 'user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = contentBlocks(m.content);
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
      }
      push(messages, 'assistant', blocks);
    } else {
      push(messages, 'user', contentBlocks(m.content));
    }
  }
  const out = { model: req.model, max_tokens: req.max_tokens ?? 4096, messages };
  if (system.length) out.system = system;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.stop) out.stop_sequences = [].concat(req.stop);
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => {
      const f = t.function ?? t;
      return { name: f.name, description: f.description, input_schema: f.parameters ?? f.input_schema ?? { type: 'object' } };
    });
  }
  return out;
}

/** Native request: make sure the identity is its own leading system block. */
export function withIdentityBlock(req) {
  const s = req.system;
  const rest = typeof s === 'string' ? (s ? [{ type: 'text', text: s }] : []) : Array.isArray(s) ? s : [];
  if (rest[0]?.text?.startsWith('You are Claude Code')) return req;
  return { ...req, system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }, ...rest] };
}

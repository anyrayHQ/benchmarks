// Answer-vs-answer quality judge. The DIRECT answer (provider, no Anyray) is the
// reference; the judge rules whether the GATEWAY answer preserves its correctness and
// completeness on the task, using the workload's key facts as the rubric. The judge
// itself is always called direct, so Anyray is never in the scoring path.
// Synthetic payloads only — never point this at real traffic.

import { authHeaders, isOAuth } from './auth.mjs';
import { fetchRetry } from './http.mjs';
import { chatToMessages } from './toAnthropic.mjs';

/**
 * First balanced JSON object in a string (ignores braces inside strings).
 * Returns the raw substring (callers JSON.parse).
 */
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in judge reply');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('unterminated JSON object in judge reply');
}

export function buildJudgeMessages({ question, keyFacts, directAnswer, gatewayAnswer }) {
  const facts = (keyFacts || []).map((f) => `- ${f}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You compare two assistant answers to the same request. The REFERENCE answer came ' +
        'from sending the request straight to the model provider; the CANDIDATE answer came ' +
        'from sending the identical request through an intermediary gateway. Decide whether ' +
        "the candidate preserves the reference's correctness and completeness for the task. " +
        'A shorter or reworded answer is fine if it still answers correctly and reflects the ' +
        'key facts. Reply with ONLY a JSON object: ' +
        '{"preserved":boolean,"score":0-100,"missingFacts":[string],"rationale":string}.',
    },
    {
      role: 'user',
      content:
        `TASK:\n${question}\n\nKEY FACTS the answer should reflect:\n${facts || '- (none)'}\n\n` +
        `REFERENCE ANSWER:\n${directAnswer}\n\nCANDIDATE ANSWER:\n${gatewayAnswer}`,
    },
  ];
}

/** Coarse label from a judge result. */
export function qualityLabel(judged) {
  if (judged.preserved && judged.score >= 90) return 'PASS';
  if (judged.score >= 75) return 'MARGINAL';
  return 'FAIL';
}

export async function judgeAnswers({ judge, question, keyFacts, directAnswer, gatewayAnswer, fetchImpl = fetch }) {
  const body = chatToMessages(
    {
      model: judge.model,
      max_tokens: 600,
      messages: buildJudgeMessages({ question, keyFacts, directAnswer, gatewayAnswer }),
    },
    { identity: judge.auth?.provider === 'anthropic' && isOAuth(judge.auth?.upstreamToken) }
  );
  const headers = { 'content-type': 'application/json', ...authHeaders(judge.auth, { direct: true }) };
  // temperature is omitted: the newest judge models (e.g. opus-4-8) reject it as
  // deprecated, and they are effectively deterministic for this rubric task.
  const call = async () => {
    const res = await fetchRetry(
      fetchImpl,
      judge.url,
      () => ({ method: 'POST', headers, body: JSON.stringify(body) }),
      { timeoutMs: 60000 }
    );
    if (!res.ok) throw new Error(`judge ${res.status}`);
    const reply = await res.json();
    const text = (reply?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    return JSON.parse(extractJsonObject(text));
  };
  let parsed;
  try {
    parsed = await call();
  } catch {
    parsed = await call(); // one retry on parse error (HTTP retries handled in fetchRetry)
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  return {
    preserved: !!parsed.preserved,
    score,
    missingFacts: Array.isArray(parsed.missingFacts) ? parsed.missingFacts : [],
    rationale: String(parsed.rationale || ''),
    by: judge.model,
  };
}

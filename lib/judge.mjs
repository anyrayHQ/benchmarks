// Answer-vs-answer quality judge. The baseline answer (from the full context) is the
// reference; the judge rules whether the optimized answer (from the token-reduced
// context) preserves its correctness/completeness on the task, using the workload's
// key facts as the rubric. Synthetic payloads only — never point this at real traffic.

import { authHeaders, withClaudeIdentity } from './auth.mjs';
import { fetchRetry } from './http.mjs';

/**
 * First balanced JSON object in a string (ignores braces inside strings).
 * Returns the raw substring (callers JSON.parse) — same contract as run_quality.mjs.
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

export function buildJudgeMessages({ question, keyFacts, baselineAnswer, optimizedAnswer }) {
  const facts = (keyFacts || []).map((f) => `- ${f}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You compare two assistant answers to the same task. The BASELINE answer was ' +
        'produced from the full context; the OPTIMIZED answer from a token-reduced ' +
        'context. Decide whether the optimized answer preserves the baseline\'s ' +
        'correctness and completeness for the task. A shorter or reworded answer is ' +
        'fine if it still answers correctly and reflects the key facts. Reply with ONLY ' +
        'a JSON object: {"preserved":boolean,"score":0-100,"missingFacts":[string],"rationale":string}.',
    },
    {
      role: 'user',
      content:
        `TASK:\n${question}\n\nKEY FACTS the answer should reflect:\n${facts || '- (none)'}\n\n` +
        `BASELINE ANSWER:\n${baselineAnswer}\n\nOPTIMIZED ANSWER:\n${optimizedAnswer}`,
    },
  ];
}

export async function judgeAnswers({
  judge,
  question,
  keyFacts,
  baselineAnswer,
  optimizedAnswer,
  fetchImpl = fetch,
}) {
  const messages = withClaudeIdentity(
    buildJudgeMessages({ question, keyFacts, baselineAnswer, optimizedAnswer }),
    judge.auth
  );
  const headers = {
    'content-type': 'application/json',
    ...authHeaders(judge.auth),
    'x-anyray-optimize': 'off',
  };
  // temperature is omitted: the newest judge models (e.g. opus-4-8) reject it as
  // deprecated, and they are effectively deterministic for this rubric task.
  const call = async () => {
    const res = await fetchRetry(
      fetchImpl,
      judge.url,
      () => ({
        method: 'POST',
        headers,
        body: JSON.stringify({ model: judge.model, max_tokens: 600, messages }),
      }),
      { timeoutMs: 60000 }
    );
    if (!res.ok) throw new Error(`judge ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? '';
    return JSON.parse(extractJsonObject(typeof text === 'string' ? text : JSON.stringify(text)));
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

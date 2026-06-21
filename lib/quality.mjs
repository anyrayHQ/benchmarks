// Key-fact survival — the quality side of the benchmark.
//
// Token reduction is only worth anything if the answer survives. For each
// workload we define the answer-bearing "key facts" (short verbatim markers that
// carry the answer); quality is the fraction of them that survive in the request
// the optimizer returns. Two scorers:
//
//   deterministic  — substring survival (no model): is each marker still present?
//   judge          — an LLM rules whether each fact is still *answerable* from the
//                    kept context (semantic, catches mangling a substring can't).
//
// Both pair with the token saving so the tradeoff reads at a glance, the way a
// compression quality benchmark does.

import { textOf } from './tokens.mjs';

/** Full searchable text of a request: message bodies + tools/functions schema. */
export function fullText(request) {
  const tools = request?.tools ? '\n' + JSON.stringify(request.tools) : '';
  return textOf(request) + tools;
}

/** PASS >= 90% of key facts survive; MARGINAL 75-89%; FAIL below. */
export function verdictFor(coverage) {
  if (coverage >= 0.9) return 'PASS';
  if (coverage >= 0.75) return 'MARGINAL';
  return 'FAIL';
}

/**
 * Deterministic key-fact survival: which markers are still present (verbatim)
 * in the optimized request. Returns { present, missing, coverage, verdict }.
 */
export function keyFactSurvival(optimizedRequest, keyFacts = []) {
  const hay = fullText(optimizedRequest);
  const present = [];
  const missing = [];
  for (const fact of keyFacts) {
    (hay.includes(fact) ? present : missing).push(fact);
  }
  const coverage = keyFacts.length ? present.length / keyFacts.length : 1;
  return { present, missing, coverage, verdict: verdictFor(coverage) };
}

/** Build the judge prompt for the LLM (--judge) pass over one workload. */
export function judgePrompt(question, optimizedContext, keyFacts) {
  return [
    {
      role: 'system',
      content:
        'You are an evaluation judge. You are given a QUESTION, a CONTEXT that was ' +
        'trimmed by an optimizer, and a list of KEY FACTS needed to answer the ' +
        'question. For each key fact, decide whether it is still present or ' +
        'derivable from the CONTEXT (true) or not (false). Judge meaning, not exact ' +
        'wording. Respond with ONLY JSON: {"covered":[bool,...],"coverage":0-100,' +
        '"note":"one short line"} where covered[i] corresponds to keyFacts[i].',
    },
    {
      role: 'user',
      content:
        `QUESTION:\n${question}\n\nKEY FACTS (in order):\n` +
        keyFacts.map((f, i) => `${i + 1}. ${f}`).join('\n') +
        `\n\nCONTEXT:\n${optimizedContext}`,
    },
  ];
}

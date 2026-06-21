# Quality benchmark — does the answer survive?

Token reduction is only worth anything if the model can still answer. This is the
quality side of the [savings benchmark](RESULTS.md): for each workload we define
the **answer-bearing key facts** (the specific lines, identifiers, codes, and
paths a correct answer must rest on — all verbatim from the payload), then measure
how many survive the optimizer's trim.

## Overview

| | Workloads | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| **Key-fact survival** (substring, strict) | 19 | 16 | 0 | 3 |
| **LLM judge** (Claude Opus 4.8, semantic) | 19 | 16 | 1 | 2 |

**16 of 19 workloads preserve the answer in full.** The three that don't are *all*
the same case — the lexical `relevance_filter` meeting its known limit — and the
benchmark surfaces them rather than hiding them (see [Why three aren't
green](#why-three-arent-green)). Verdict bands: **PASS** ≥ 90% of key facts
survive · **MARGINAL** ≥ 75% · **FAIL** below.

## Per workload

`saved` is the token reduction (from [RESULTS.md](RESULTS.md)); `key-facts` is the
strict substring survival; `judge` is the semantic coverage + verdict.

| Workload | Strategy | Saved | Key-facts | Judge |
|---|---|--:|--:|--|
| `1-access-log` | `relevance_filter` | 93% | 100% | 100% ✅ PASS |
| `2-sre-incident` | `relevance_filter` | 98% | 0% | 20% ❌ FAIL |
| `4-json-array` | `context_compression` | 78% | 100% | 100% ✅ PASS |
| `5-code-search` | `relevance_filter` | 71% | 67% | 67% ❌ FAIL |
| `6-git-diff` | `relevance_filter` | 71% | 50% | 80% ⚠️ MARGINAL |
| `7-codebase-explore` | `code_skeleton` | 30% | 100% | 100% ✅ PASS |
| `15-multifile-graph` | `code_graph` | 33% | 100% | 100% ✅ PASS |
| `17-python-multifile` | `code_graph` | 36% | 100% | 100% ✅ PASS |
| `11-mcp-tools` | `tool_pruning` | 65% | 100% | 100% ✅ PASS |
| `12-rag-overfetch` | `relevance_filter` | 69% | 100% | 100% ✅ PASS |
| `13-prompt-boilerplate` | `prompt_compression` | 84% | 100% | 100% ✅ PASS |
| `3-github-triage` | `relevance_filter` | 85% | 100% | 100% ✅ PASS |
| `8-long-session` | `window_budget` | 72% | 100% | 100% ✅ PASS |
| `16-test-run` | `command_digest` | 77% | 100%¹ | 100% ✅ PASS |
| `18-session-recall` | `relevance_filter` | 86% | 100% | 100% ✅ PASS |
| `19-decision-recall` | `relevance_filter` | 74% | 100% | 100% ✅ PASS |
| `20-research-brief` | `relevance_filter` | 85% | 100% | 100% ✅ PASS |
| `21-content-memory` | `relevance_filter` | 81% | 100% | 100% ✅ PASS |
| `22-ops-open-loops` | `relevance_filter` | 79% | 100% | 100% ✅ PASS |

¹ `command_digest` **rewrites** the output (it digests, it doesn't just elide), so
the raw-form markers needed a reformatted shape; all three failing tests + their
root causes are present. For every other strategy the kept text is verbatim, so
substring survival is exact.

## How it's measured

- **Key-fact survival (deterministic).** Each key fact is a verbatim substring of
  the payload; we check whether it still appears in the request the optimizer
  returns. No model, fully reproducible. A *strict* floor: a paraphrased or
  reformatted survivor counts as a miss.
- **LLM judge (semantic).** A model reads the kept context and rules whether each
  key fact is still *answerable* — catching survival the substring test is too
  blunt for (e.g. a rewriting strategy, or an answer derivable from neighboring
  lines). Committed numbers were judged by Claude Opus 4.8; reproduce against any
  OpenAI-compatible endpoint with `node run_quality.mjs --all --judge`
  (`ANYRAY_JUDGE_URL` / `ANYRAY_JUDGE_KEY` / `ANYRAY_JUDGE_MODEL`).

The answer-bearing markers live in [`keyfacts.json`](keyfacts.json).

## Why three aren't green

All three weak spots are `relevance_filter` — the **lexical** (BM25) strategy —
and the cause is the same: when the answer-bearing lines don't share vocabulary
with the question, lexical ranking scores them low and elides them.

- **`2-sre-incident` (FAIL).** The question asks why p99 *spiked*; the root cause
  is a *db connection pool saturating* (`max_conns=20 in_use=20`). Those lines
  share almost no words with the question, so they rank out — while the normal
  request lines that *do* contain "checkout"/"p99" survive. The answer is lost.
- **`5-code-search` (FAIL).** The constant `RETRY_MAX = 5` survives, but the line
  carrying its defining file path (`src/lib/http/retryPolicy.ts`) ranks lower than
  the many *usage* lines and is elided — you get the value, not the location.
- **`6-git-diff` (MARGINAL).** The file `src/auth/middleware.ts` and the removed
  `- user.role === "admin"` line survive, so the weakening *is* derivable; the
  surrounding hunk detail is elided.

**It is not an aggressiveness problem.** Backing the budget off does not fix it —
`2-sre` stays at 0% key-fact survival even at `keepChars=4000` (95% saved, vs 98%
at the headline knob), because the root-cause lines are *ranked* out, not
*budgeted* out. The honest fix is a **semantic / embedding relevance filter** for
vocabulary-mismatch workloads — on the [roadmap](RESULTS.md#roadmap). Until then,
these are exactly the workloads to watch when a strategy is purely lexical.

The strategies that **keep structure rather than rank lines** — `code_skeleton`,
`code_graph`, `tool_pruning`, `window_budget`, `context_compression`,
`command_digest` — preserve the answer at 100% across the board.

## Reproduce

```bash
node run_quality.mjs --all            # deterministic key-fact survival
node run_quality.mjs --all --judge    # + LLM judge (needs ANYRAY_JUDGE_* )
```

Results are written to `<suite>/results/quality.json`.

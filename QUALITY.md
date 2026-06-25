# Quality benchmark — does the answer survive?

Token reduction is only worth anything if the model can still answer. This is the
quality side of the [savings benchmark](RESULTS.md): for each workload we define
the **answer-bearing key facts** (the specific lines, identifiers, codes, and
paths a correct answer must rest on — all verbatim from the payload), then measure
how many survive the optimizer's trim.

**In one line:** *saved* = how much smaller the request got; *key-facts* = how much of
the answer survived that trim. **PASS** = ≥ 90% of the answer's facts survive,
**MARGINAL** = ≥ 75%, **FAIL** = below — so a FAIL means the optimizer cut too much of
the answer on that workload, not that anything errored.

## Overview

Two committed signals sit beside each saving. **Strict substring survival** is the
reproducible-by-anyone floor — no model required. The **Claude Opus 4.8 judge** is a
committed semantic overlay: it reads the same kept context and rules whether each key
fact is still *answerable*, catching what the substring test is too blunt for in both
directions — a miss that's really fine, and a verbatim "survivor" that doesn't carry
the answer.

| | Workloads | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| **Key-fact survival** (substring, strict — committed) | 22 | 20 | 0 | 2 |
| **LLM judge** (semantic, Claude Opus 4.8 — committed) | 22 | 19 | 2 | 1 |

On the strict floor **20 of 22 preserve the answer in full**; the two that don't
(`5-code-search`, `6-git-diff`) are both the lexical `relevance_filter` meeting its
known limit. The Opus-4.8 judge then moves two rows — it clears `6-git-diff` to
MARGINAL (the weakened check is still locatable) and drops `8-long-session` to
MARGINAL (its key facts are the pinned prompt, so substring survival overstated the
answer) — netting **19 PASS · 2 MARGINAL · 1 FAIL**. The benchmark surfaces these
rather than hiding them (see [Why two aren't green](#why-two-arent-green)). Verdict
bands: **PASS** ≥ 90% of key facts survive · **MARGINAL** ≥ 75% · **FAIL** below.

## Per workload

`saved` is the token reduction (from [RESULTS.md](RESULTS.md)); `key-facts` is the
strict substring survival; `judge` is the committed Claude Opus 4.8 semantic verdict
(each row records the model in its `by` field).

| Workload | Strategy | Saved | Key-facts (strict) | Judge (Opus 4.8) |
|---|---|--:|--:|--:|
| `1-access-log` | `relevance_filter` | 92% | 100% ✅ | 100% ✅ |
| `2-sre-incident` | `relevance_filter` | 84% | 100% ✅ | 100% ✅ |
| `4-json-array` | `context_compression` | 78% | 100% ✅ | 100% ✅ |
| `29-orders-json` | `context_compression` | 42% | 100% ✅ | 100% ✅ |
| `30-metrics-json` | `context_compression` | 42% | 100% ✅ | 100% ✅ |
| `5-code-search` | `relevance_filter` | 68% | 67% ❌ | 67% ❌ |
| `6-git-diff` | `relevance_filter` | 68% | 50% ❌ | 80% ⚠️ |
| `7-codebase-explore` | `code_skeleton` | 28% | 100% ✅ | 100% ✅ |
| `15-multifile-graph` | `code_graph` | 32% | 100% ✅ | 100% ✅ |
| `17-python-multifile` | `code_graph` | 33% | 100% ✅ | 100% ✅ |
| `27-read-service-ts` | `code_skeleton` | 76% | 100% ✅ | 100% ✅ |
| `28-read-module-py` | `code_skeleton` | 82% | 100% ✅ | 100% ✅ |
| `11-mcp-tools` | `tool_pruning` | 65% | 100% ✅ | 100% ✅ |
| `12-rag-overfetch` | `relevance_filter` | 67% | 100% ✅ | 100% ✅ |
| `13-prompt-boilerplate` | `prompt_compression` | 84% | 100% ✅ | 100% ✅ |
| `23-mcp-schema` | `tool_schema_compression` | 7% | 100% ✅ | 100% ✅ |
| `3-github-triage` | `relevance_filter` | 84% | 100% ✅ | 100% ✅ |
| `8-long-session` | `window_budget` | 72% | 100% ✅ | 80% ⚠️ |
| `16-test-run` | `command_digest` | 77% | 100%¹ ✅ | 100% ✅ |
| `24-agent-toolcalls` | `window_budget` | 25% | 100% ✅ | 100% ✅ |
| `31-long-toolsession` | `window_budget` | 27% | 100% ✅ | 100% ✅ |
| `18-session-recall` | `relevance_filter` | 85% | 100% ✅ | 100% ✅ |

¹ `command_digest` **rewrites** the output (it digests, it doesn't just elide), so
`16-test-run`'s key facts are written in the digest's reformatted shape — its 100%
therefore confirms the digest **round-trips** the failing tests + root causes, not
that raw-log strings survive verbatim. `keyfacts.json` flags this with a `_note`.
For every elide-only strategy the kept text is verbatim, so substring survival is
exact.

## How it's measured

- **Key-fact survival (deterministic, committed).** Each key fact is a verbatim
  substring of the payload; we check whether it still appears in the request the
  optimizer returns. No model, fully reproducible. A *strict* floor: a paraphrased
  or reformatted survivor counts as a miss.
- **LLM judge (semantic, committed).** A model reads the kept context and rules
  whether each key fact is still *answerable* — catching what the substring test is
  too blunt for in both directions: an answer derivable from neighboring lines that
  the strict floor scores a miss, and a verbatim "survivor" that doesn't actually
  carry the answer. The committed verdicts are Claude Opus 4.8's (recorded per row in
  the `by` field). Regenerate them against any OpenAI-compatible model with
  `node run_quality.mjs --all --judge` (`ANYRAY_JUDGE_URL` / `ANYRAY_JUDGE_KEY` /
  `ANYRAY_JUDGE_MODEL`), or offline with `--dump` (writes `judge-inputs.json` for an
  external judge to score, then merge the verdicts back). Reproducing the judge needs
  a model; reproducing the strict floor does not.

The answer-bearing markers live in [`keyfacts.json`](keyfacts.json).

## Why two aren't green

Both weak spots are `relevance_filter` — the **lexical** (BM25) strategy — and the
cause is the same: when the answer-bearing lines don't share vocabulary with the
question, lexical ranking scores them low and elides them.

- **`5-code-search` (FAIL, both signals).** The constant `RETRY_MAX = 5` survives,
  but the line carrying its defining file path (`src/lib/http/retryPolicy.ts`) ranks
  lower than the many *usage* lines and is elided — you get the value, not the
  location. The Opus-4.8 judge agrees (67% FAIL): the precise location is genuinely
  gone.
- **`6-git-diff` (strict FAIL → judge MARGINAL).** Only half the key facts survive
  verbatim, but the file `src/auth/middleware.ts` and the removed admin-check line do
  survive, so the weakening *is* locatable — which is why the committed Opus-4.8
  judge rates it MARGINAL (80%) rather than FAIL.

**It is not an aggressiveness problem.** Both stay below the bar **even at the
production knob** (`keepChars=32000`, far more generous than the benchmark's): the
answer-bearing lines are *ranked* out, not *budgeted* out. (A third case,
`2-sre-incident`, used to FAIL here — but that was a rigged `keepChars=1000` knob;
at a fair budget it preserves the answer, so it's no longer a failure.) The honest
fix is a **semantic / embedding relevance filter** for vocabulary-mismatch
workloads — on the [roadmap](RESULTS.md#roadmap). Until then, these are exactly the
workloads to watch when a strategy is purely lexical.

The strategies that **keep structure rather than rank lines** — `code_skeleton`,
`code_graph`, `tool_pruning`, `tool_schema_compression`, `window_budget`,
`context_compression`, `command_digest` — preserve the answer at 100% on the strict
floor across the board. The one semantic caveat the committed judge raises is
`8-long-session` (`window_budget`): it survives substring at 100%, but its key facts
are the pinned system prompt + question while the per-subsystem findings were cropped
to retrieval, so Opus 4.8 rates it **MARGINAL (80%)** — the overlay catching a
"survivor" that doesn't fully carry the answer.

## Reproduce

```bash
node run_quality.mjs --all            # strict key-fact survival (committed, no model)
# Semantic judge — committed verdicts are Claude Opus 4.8's; regenerate against any
# OpenAI-compatible endpoint, crediting the model in each row's `by` field:
ANYRAY_JUDGE_URL=… ANYRAY_JUDGE_KEY=… ANYRAY_JUDGE_MODEL=claude-opus-4-8 \
  node run_quality.mjs --all --judge
# …or offline: dump the judge inputs for an external model, then merge verdicts back:
node run_quality.mjs --all --dump     # writes <suite>/results/judge-inputs.json
```

Results are written to `<suite>/results/quality.json`. The strict run is resume-safe
(re-running skips already-scored workloads); a later `--judge` run fills in the
`judge` column on top without redoing the deterministic pass.

Results are content-free in spirit but synthetic throughout: every key fact and
payload here is invented, never real user data.

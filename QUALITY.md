# Quality benchmark — does the answer survive?

Token reduction is only worth anything if the model can still answer. This is the
quality side of the [savings benchmark](RESULTS.md): for each workload we define
the **answer-bearing key facts** (the specific lines, identifiers, codes, and
paths a correct answer must rest on — all verbatim from the payload), then measure
how many survive the optimizer's trim.

## Overview

The committed, reproducible-by-anyone signal is **strict substring survival** — no
model required. An optional **LLM judge** (`--judge`) adds a semantic check on
demand; it is not part of the committed numbers (it needs a model endpoint).

| | Workloads | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| **Key-fact survival** (substring, strict — committed) | 22 | 20 | 0 | 2 |

**20 of 22 workloads preserve the answer in full.** The two that don't are *both*
the same case — the lexical `relevance_filter` meeting its known limit — and the
benchmark surfaces them rather than hiding them (see [Why two aren't
green](#why-two-arent-green)). Verdict bands: **PASS** ≥ 90% of key facts
survive · **MARGINAL** ≥ 75% · **FAIL** below.

## Per workload

`saved` is the token reduction (from [RESULTS.md](RESULTS.md)); `key-facts` is the
strict substring survival. Run with `--judge` to add a semantic `judge` column
(model recorded per row in its `by` field).

| Workload | Strategy | Saved | Key-facts | Verdict |
|---|---|--:|--:|--|
| `1-access-log` | `relevance_filter` | 92% | 100% | ✅ PASS |
| `2-sre-incident` | `relevance_filter` | 84% | 100% | ✅ PASS |
| `4-json-array` | `context_compression` | 78% | 100% | ✅ PASS |
| `29-orders-json` | `context_compression` | 42% | 100% | ✅ PASS |
| `30-metrics-json` | `context_compression` | 42% | 100% | ✅ PASS |
| `5-code-search` | `relevance_filter` | 68% | 67% | ❌ FAIL |
| `6-git-diff` | `relevance_filter` | 68% | 50% | ❌ FAIL |
| `7-codebase-explore` | `code_skeleton` | 28% | 100% | ✅ PASS |
| `15-multifile-graph` | `code_graph` | 32% | 100% | ✅ PASS |
| `17-python-multifile` | `code_graph` | 33% | 100% | ✅ PASS |
| `27-read-service-ts` | `code_skeleton` | 76% | 100% | ✅ PASS |
| `28-read-module-py` | `code_skeleton` | 82% | 100% | ✅ PASS |
| `11-mcp-tools` | `tool_pruning` | 65% | 100% | ✅ PASS |
| `12-rag-overfetch` | `relevance_filter` | 67% | 100% | ✅ PASS |
| `13-prompt-boilerplate` | `prompt_compression` | 84% | 100% | ✅ PASS |
| `23-mcp-schema` | `tool_schema_compression` | 7% | 100% | ✅ PASS |
| `3-github-triage` | `relevance_filter` | 84% | 100% | ✅ PASS |
| `8-long-session` | `window_budget` | 72% | 100% | ✅ PASS |
| `16-test-run` | `command_digest` | 77% | 100%¹ | ✅ PASS |
| `24-agent-toolcalls` | `window_budget` | 25% | 100% | ✅ PASS |
| `31-long-toolsession` | `window_budget` | 27% | 100% | ✅ PASS |
| `18-session-recall` | `relevance_filter` | 85% | 100% | ✅ PASS |

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
- **LLM judge (semantic, optional overlay).** A model reads the kept context and
  rules whether each key fact is still *answerable* — catching survival the
  substring test is too blunt for (e.g. an answer derivable from neighboring
  lines). It is **not committed** (it needs a model endpoint). Run it on demand:
  `node run_quality.mjs --all --judge` with `ANYRAY_JUDGE_URL` / `ANYRAY_JUDGE_KEY`
  / `ANYRAY_JUDGE_MODEL` set. Each judged row records the model in a `by` field, so
  the verdict is self-attributing and reproducible.

The answer-bearing markers live in [`keyfacts.json`](keyfacts.json).

## Why two aren't green

Both weak spots are `relevance_filter` — the **lexical** (BM25) strategy — and the
cause is the same: when the answer-bearing lines don't share vocabulary with the
question, lexical ranking scores them low and elides them.

- **`5-code-search` (FAIL).** The constant `RETRY_MAX = 5` survives, but the line
  carrying its defining file path (`src/lib/http/retryPolicy.ts`) ranks lower than
  the many *usage* lines and is elided — you get the value, not the location.
- **`6-git-diff` (FAIL).** Strictly, only half the key facts survive verbatim. The
  file `src/auth/middleware.ts` and the removed admin-check lines do survive, so the
  weakening *is* derivable — which is why the optional semantic judge tends to rate
  this one higher than the strict substring floor.

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
`context_compression`, `command_digest` — preserve the answer at 100% across the
board.

## Reproduce

```bash
node run_quality.mjs --all            # deterministic key-fact survival (committed)
# Optional semantic judge — set the model you want credited in quality.json:
ANYRAY_JUDGE_URL=… ANYRAY_JUDGE_KEY=… ANYRAY_JUDGE_MODEL=claude-opus-4-8 \
  node run_quality.mjs --all --judge
```

Results are written to `<suite>/results/quality.json`. The deterministic run is
resume-safe (re-running skips already-scored workloads); a later `--judge` run
fills in the `judge` column on top without redoing the deterministic pass.

Results are content-free in spirit but synthetic throughout: every key fact and
payload here is invented, never real user data.

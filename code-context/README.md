# Code context

A coding agent reads source files, search hits, or a diff back into the window.
The code-aware strategies keep the navigable skeleton — or, for a multi-file
trace, only the bodies on the reference path the question touches — and elide the
rest, every elided body retrievable on demand.

**Why it's common:** coding agents (Claude Code, Cursor, …) read whole files back
into the window when the question only needs signatures and call sites — research
pegs roughly **70% of a coding agent's tokens as irrelevant file reads**.

## Workloads

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| Code search (100 hits) — "where is the retry policy configured?" | `relevance_filter` | `keepChars=8000, roles=user` | 4,275 | 1,925 | **55%** |
| Git diff — "any risky change in this PR?" | `context_compression` | `roles=user` | 5,669 | 3,160 | **44%** |
| Codebase exploration — "explain the architecture & where retries live" | `code_graph` | `minChars=200, minBodyLines=2, roles=user` | 4,679 | 3,833 | **18%** |
| Multi-file trace — "how does Checkout.submitOrder capture payment?" | `code_graph` | `minChars=200, minBodyLines=2` | 2,092 | 1,446 | **31%** |
| Multi-file trace (Python) — same, in an indentation language | `code_graph` | `minChars=200, minBodyLines=2` | 1,787 | 1,191 | **33%** |
| Read a large TS service file (tool result) — keep the on-path bodies | `code_graph` | `minChars=200, minBodyLines=2` | 2,649 | 890 | **66%** |
| Read a Python module (tool result) — keep the on-path bodies | `code_graph` | `minChars=200, minBodyLines=2` | 2,218 | 654 | **71%** |

## How it works

- **`code_graph`** keeps a source file's navigable outline — imports and every
  declaration's signature line — and, across files, only the bodies on the path the
  question needs: it builds a reference graph, seeds the working set from the live
  question, and keeps the on-path bodies (`submitOrder → capturePayment → sendCharge`
  plus the collaborators they touch), eliding off-path files **and** off-path
  functions inside a kept file. It reads block extent from braces for C-family code
  and from indentation for Python, so it never interprets the code and passes through
  anything it can't balance.
- **`relevance_filter`** handles search hits — the same lexical
  keep-the-relevant-lines pass as the logs suite.
- **`context_compression`** handles diffs — it keeps every hunk structurally rather
  than ranking lines, so no answer-bearing change is dropped.

The code-aware strategies are conservative by design (they keep signatures and
structure), so the percentages are lower than the logs suite — but the saving is
**lossless to navigation**: the agent still sees every symbol, and can retrieve
any collapsed body (`/v1/retrieve`).

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Produced by
[`./run.sh`](run.sh); see [`results/`](results/).

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
| Code search (100 hits) — "where is the retry policy configured?" | `relevance_filter` | `keepChars=1500, roles=user` | 3,132 | 999 | **68%** |
| Git diff — "any risky change in this PR?" | `relevance_filter` | `keepChars=2000, roles=user` | 3,473 | 1,107 | **68%** |
| Codebase exploration — "explain the architecture & where retries live" | `code_skeleton` | `minBodyLines=3, roles=user` | 4,679 | 3,372 | **28%** |
| Multi-file trace — "how does Checkout.submitOrder capture payment?" | `code_graph` | `minChars=200, minBodyLines=2` | 2,092 | 1,420 | **32%** |
| Multi-file trace (Python) — same, in an indentation language | `code_graph` | `minChars=200, minBodyLines=2` | 1,787 | 1,191 | **33%** |
| Read a large TS service file (tool result) — keep the call structure | `code_skeleton` | `minBodyLines=4` | 2,649 | 642 | **76%** |
| Read a Python module (tool result) — keep the call structure | `code_skeleton` | `minBodyLines=4` | 2,218 | 407 | **82%** |

## How it works

- **`code_skeleton`** keeps the navigable outline of a source file — imports,
  every declaration's signature line and its closing brace — and collapses the
  statement bodies between them into a content-free marker. The structure scan is
  brace-based for C-family code and indentation-based for Python; it never
  interprets the code and passes through anything it can't balance.
- **`code_graph`** is the graph-aware cousin: it builds a reference graph over the
  files in the request, seeds the working set from the live question, and keeps
  only the bodies on that path (`submitOrder → capturePayment → sendCharge` plus
  the collaborators they touch), eliding off-path files **and** off-path functions
  inside a kept file. The Python row proves it reads block extent from
  indentation, not just braces.
- **`relevance_filter`** handles search hits and diffs — the same lexical
  keep-the-relevant-lines pass as the logs suite.

The code-aware strategies are conservative by design (they keep signatures and
structure), so the percentages are lower than the logs suite — but the saving is
**lossless to navigation**: the agent still sees every symbol, and can retrieve
any collapsed body (`/v1/retrieve`).

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Produced by
[`./run.sh`](run.sh); see [`results/`](results/).

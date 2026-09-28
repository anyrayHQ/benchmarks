# Code context

**Why it's common:** coding agents (Claude Code, Cursor, …) read whole files back
into the window when the question only needs signatures and call sites — research
pegs roughly **70% of a coding agent's tokens as irrelevant file reads**.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| Code search (100 hits) — "where is the retry policy configured?" | [`5-code-search.json`](payloads/5-code-search.json) |
| Git diff — "any risky change in this PR?" | [`6-git-diff.json`](payloads/6-git-diff.json) |
| Codebase exploration — "explain the architecture & where retries live" | [`7-codebase-explore.json`](payloads/7-codebase-explore.json) |
| Multi-file trace — "how does Checkout.submitOrder capture payment?" | [`15-multifile-graph.json`](payloads/15-multifile-graph.json) |
| Multi-file trace (Python) — "how does Checkout.submit_order capture payment?" | [`17-python-multifile.json`](payloads/17-python-multifile.json) |
| Read a large TS service file (tool result) — keep the on-path bodies | [`27-read-service-ts.json`](payloads/27-read-service-ts.json) |
| Read a Python module (tool result) — keep the on-path bodies | [`28-read-module-py.json`](payloads/28-read-module-py.json) |

Run just this suite: `./code-context/run.sh` (flags such as `--workload <id>` pass through).

# Guardrails

**Why these are common:** redundant / near-duplicate requests are **40–60%** of
enterprise LLM traffic (**18%** exact duplicates, **~47%** semantically similar) —
the cache case.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see [the replay suite](../docs/bench.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| Repeated identical request — 2nd call served from cache | [`9-repeat-request.json`](payloads/9-repeat-request.json) |
| Claude prompt-cache prefix — stabilize the system+tools prefix for reuse | [`25-claude-cache-prefix.json`](payloads/25-claude-cache-prefix.json) |
| Content census — nine shape classes through a read-only pass | [`41-mixed-content-census.json`](payloads/41-mixed-content-census.json) |
| Prefix churn — the client rewrites its own cached prefix between two turns | [`44-prefix-churn.json`](payloads/44-prefix-churn.json) |

Run just this suite: `./guardrails/run.sh` (flags such as `--workload <id>` pass through).

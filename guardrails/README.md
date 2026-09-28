# Guardrails

**Why these are common:** redundant / near-duplicate requests are **40–60%** of
enterprise LLM traffic (**18%** exact duplicates, **~47%** semantically similar) —
the cache case; and uncapped output ceilings let a one-line task reserve 100k
output tokens — the `param_tuning` case.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| Repeated identical request — 2nd call served from cache | [`9-repeat-request.json`](payloads/9-repeat-request.json) |
| Runaway max_tokens — 100k output ceiling on a one-line task | [`14-runaway-max-tokens.json`](payloads/14-runaway-max-tokens.json) |
| Claude prompt-cache prefix — stabilize the system+tools prefix for reuse | [`25-claude-cache-prefix.json`](payloads/25-claude-cache-prefix.json) |
| Context health score — flag a bloated, over-fetched context | [`26-context-quality.json`](payloads/26-context-quality.json) |
| Provider context trim — Anthropic clear_tool_uses annotation, content untouched | [`38-anthropic-context-trim.json`](payloads/38-anthropic-context-trim.json) |
| Reasoning downshift — routine tool-resume turn on a reasoning model | [`39-reasoning-downshift.json`](payloads/39-reasoning-downshift.json) |
| Output shaping — concise-output advisory appended on a resume turn | [`40-output-shaping.json`](payloads/40-output-shaping.json) |
| Content census — nine shape classes through a read-only pass | [`41-mixed-content-census.json`](payloads/41-mixed-content-census.json) |
| Prefix churn — the client rewrites its own cached prefix between two turns | [`44-prefix-churn.json`](payloads/44-prefix-churn.json) |

Run just this suite: `./guardrails/run.sh` (flags such as `--workload <id>` pass through).

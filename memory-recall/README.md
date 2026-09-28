# Cross-session memory recall

**Why it's common:** assistants and agents increasingly carry long-term memory —
past sessions, decisions, research notes, a back catalogue, a week of activity —
and recall a large slice of it to answer a narrow question. The whole store is
billed unless it's filtered to what the question actually touches.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| Cross-session catch-up — "catch me up on this branch" | [`18-session-recall.json`](payloads/18-session-recall.json) |
| Stale trajectory — mask old bulky observations, keep errors and fresh turns | [`36-stale-observations.json`](payloads/36-stale-observations.json) |
| Durable externalization — a 100 KB manifest becomes a retrieval handle | [`37-durable-blob.json`](payloads/37-durable-blob.json) |

Run just this suite: `./memory-recall/run.sh` (flags such as `--workload <id>` pass through).

# Logs & structured data

**Why it's common:** pasting a whole log or data export and asking one question is
the single most common thing engineers do with an assistant — and it bills the
entire file every turn. Incident exports and API dumps are huge and almost
entirely off-topic to the question being asked.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| Access log (500 requests) — "find the failing requests" | [`1-access-log.json`](payloads/1-access-log.json) |
| SRE incident — "why did checkout p99 spike at 10:05?" | [`2-sre-incident.json`](payloads/2-sre-incident.json) |
| Synonym-gap logs — "find the resource-exhaustion event" (OOM/cgroup) | [`33-synonym-gap-logs.json`](payloads/33-synonym-gap-logs.json) |
| JSON array (500 items) — "which orders failed and why?" | [`4-json-array.json`](payloads/4-json-array.json) |
| Orders dump (tool result) — "which orders failed and why?" | [`29-orders-json.json`](payloads/29-orders-json.json) |
| Metrics series (tool result) — "find the latency spike" | [`30-metrics-json.json`](payloads/30-metrics-json.json) |

Run just this suite: `./logs-and-data/run.sh` (flags such as `--workload <id>` pass through).

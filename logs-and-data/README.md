# Logs & structured data

A large log or data blob pasted into a single turn, with a narrow question about
it. The lexical relevance filter locks onto the lines that answer the question;
the JSON crusher minifies and array-caps oversized tool data.

**Why it's common:** pasting a whole log or data export and asking one question is
the single most common thing engineers do with an assistant — and it bills the
entire file every turn. Incident exports and API dumps are huge and almost
entirely off-topic to the question being asked.

## Workloads

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| Access log (500 requests) — "find the failing requests" | `relevance_filter` | `keepChars=3000, roles=user` | 26,153 | 1,078 | **96%** |
| SRE incident — "why did checkout p99 spike at 10:05?" | `relevance_filter` | `keepChars=12000, roles=user` | 26,385 | 4,326 | **84%** |
| Synonym-gap logs — "find the resource-exhaustion event" (OOM/cgroup) | `relevance_filter` | `keepChars=3000, roles=user, semanticRerank=true, semanticWeight=0.7` | 2,963 | 1,185 | **60%** |
| JSON array (500 items) — "which orders failed and why?" | `context_compression` | `roles=user` | 74,460 | 16,013 | **78%** |
| Orders dump (tool result) — "which orders failed and why?" | `context_compression` | `(defaults)` | 17,940 | 10,436 | **42%** |
| Metrics series (tool result) — "find the latency spike" | `context_compression` | `(defaults)` | 12,091 | 7,047 | **42%** |

## How it works

- **`relevance_filter`** scores each line of the blob against the live question
  (BM25, lexical — no model call) and keeps the top lines within `keepChars`. The
  prompt names the failure (an HTTP 500, a p99 spike), so the rare error lines
  rank to the top while the boilerplate every line shares is ignored by IDF. The
  elided lines are stashed for retrieval (`/v1/retrieve`).
- **`context_compression`** routes a tool/data message to a structure-aware
  compressor. On a large embedded array (row 4) it caps to `maxArrayItems`
  (default 50) and stashes the remainder for retrieval; on already-structured JSON
  tool results (rows 29–30) it minifies in place. The committed `decisions` field
  shows which path each row took.

## Measurement

Whole-request size (message text + tools) before vs after, tokens at `chars / 4`.
The blobs ride in a single `user` message, so the strategies are pointed at that
role (`roles=user`). Numbers are produced by [`./run.sh`](run.sh) against a live
optimizer and written to [`results/`](results/).

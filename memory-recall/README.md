# Cross-session memory recall

The "remember this for me" workloads. You've accumulated a large pile of history —
past sessions, decisions, research notes, a published back catalogue, a week of
activity — and you ask a narrow question of it. The recalled store rides back as a
**tool message** (a `memory.search` result), and the lexical filter ranks the
whole store against the live question, keeping the few records that answer it.

**Why it's common:** assistants and agents increasingly carry long-term memory —
past sessions, decisions, research notes, a back catalogue, a week of activity —
and recall a large slice of it to answer a narrow question. The whole store is
billed unless it's filtered to what the question actually touches.

## Workloads

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| Cross-session catch-up — "catch me up on this branch" | `relevance_filter` | `keepChars=2500` | 5,936 | 896 | **85%** |
> Kept as a **single representative**. This "recall a big store" shape is handled by
> `relevance_filter` and is rare in coding-agent traffic, so the suite was slimmed
> from five near-identical workloads to one (see the README's traffic-weighting note).

### New workloads (first run 2026-07-08, optimizer v0.3.41)

These are **not** more of the slimmed shape. They cover the "trajectory diet"
strategies (RFC 0004) where old context is *stashed behind a retrieval handle*
rather than filtered — recall as a `/v1/retrieve` round-trip, which is this
suite's actual subject. Both ran with the durable CCR tier available, so nothing
self-gated to a no-op.

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| Stale trajectory — mask old bulky observations, keep errors and fresh turns | `observation_mask` | (defaults) | 6,722 | 1,115 | **83%** |
| Durable externalization — a 100 KB manifest becomes a retrieval handle | `output_externalize` | needs the durable CCR tier | 24,581 | 24,581 | **0%** |
## How it works

It's the same mechanic — a big store + a narrow question →
**`relevance_filter`** (BM25, lexical, no model call) keeps the on-topic records
and elides the rest (each stashed for retrieval). Two things make it reliable
here:

- **The store rides as a tool message**, so the filter runs with its default
  roles (`tool`/`function`) — no `roles=user` rule, no risk of mangling the user's
  prose.
- **BM25's IDF ignores the boilerplate** every record shares (`branch=`, `status=`,
  `shipped`/`merged`) and locks onto the rare discriminator — a branch name, a
  decision topic, the words `blocked`/`waiting`/`open`.

The two pending workloads use a different mechanic — **stash, don't filter**:

- **`observation_mask`** replaces tool observations older than `keepRecentTurns`
  assistant turns with a one-hop retrieval marker (the original stashed via CCR).
  Observations the provider flagged failed are hard-kept — the only flag the
  strategy honors is `is_error: true` on an Anthropic `tool_result`, so the
  payload is Claude-shaped and the log slice with the bind failure carries it,
  staying inline while the bulky helm/describe/pods dumps mask — the root-cause
  facts survive deterministically without any retrieval.
- **`output_externalize`** goes further: a 100 KB manifest read is replaced
  wholesale by a compact, content-free handle and stashed in the **durable** tier
  (survives restarts, retrievable cross-replica). It self-gates on
  `ANYRAY_CONTENT_KEY` + a non-`off` content mode + the spend DB, and no-ops
  without them — see `VALIDATION.md` before reading its row as a zero.

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Produced by
[`./run.sh`](run.sh); see [`results/`](results/). These are framed by persona
rather than strategy, but mechanically they're the row Anyray does best: a large
block selected against a sharp question.

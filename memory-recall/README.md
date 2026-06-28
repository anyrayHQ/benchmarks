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
| Cross-session catch-up — "catch me up on this branch" | `relevance_filter` | `keepChars=2500` | 5,895 | 867 | **85%** |

> Kept as a **single representative**. This "recall a big store" shape is handled by
> `relevance_filter` and is rare in coding-agent traffic, so the suite was slimmed
> from five near-identical workloads to one (see the README's traffic-weighting note).

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

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Produced by
[`./run.sh`](run.sh); see [`results/`](results/). These are framed by persona
rather than strategy, but mechanically they're the row Anyray does best: a large
block selected against a sharp question.

# Guardrails (special accounting)

Five workloads whose saving is **not** whole-request character reduction, so each
is reported on its own basis rather than rolled into the headline percentage. The
committed results carry what the harness can measure plus the optimizer's own
decision string; this README explains what each number means.

**Why these are common:** redundant / near-duplicate requests are **40–60%** of
enterprise LLM traffic (**18%** exact duplicates, **~47%** semantically similar) —
the cache case; pasted screenshots are billed as expensive vision tokens — the OCR
case; and uncapped output ceilings let a one-line task reserve 100k output tokens —
the `param_tuning` case.

## Workloads

| Workload | Strategy | Knob | Basis | Result |
|---|---|---|---|---|
| Repeated identical request — 2nd call served from cache | `semantic_cache` | (defaults) | call avoided | 2nd call served from cache |
| Pasted screenshot — "what is this error and how do I fix it?" | `vision_ocr` | `imageTokenEstimate=1000` | vision tokens | image → OCR text |
| Runaway `max_tokens` — 100k ceiling on a one-line task | `param_tuning` | `maxTokensCap=4096` | output ceiling | `max_tokens` 100,000 → 4,096 |
| Claude prompt-cache prefix — stabilize the system+tools prefix | `cache_optimizer` | `minPrefixChars=4096` | cached-read reuse | tools sorted + `cache_control` injected (tools, system) |
| Context health — flag a bloated, over-fetched context | `context_quality` | `bloatedToolChars=1500` | health score (read-only) | 69/100 (6 bloated, 2 duplicate) |

## Why these are special

- **`semantic_cache` — the saving is a *call*, not a trim.** The benefit is that
  the *second* identical request is served from cache, avoiding the provider call
  entirely (its whole input and output). The harness seeds the cache, then probes
  an identical repeat call, so the committed `optimized.json` row records that warm
  **HIT** — `savedPct: 100`, `tier: cache`: the whole request avoided, not a
  character trim. (The seed is written directly; the optimizer's own provider→cache
  write-back path is not exercised here.) The win is realized across repeated
  traffic, not on a cold first call.

- **`vision_ocr` — the saving is in vision tokens, not characters.** The strategy
  runs a local OCR pass on a text-bearing screenshot and swaps the image for the
  extracted text, so a text-only model can answer and the expensive image tokens
  go away. The harness measures the request payload by characters: the 54,354-char
  request (almost entirely the base64 image) shrinks to ~790 chars of text. The *meaningful* basis
  is the provider's **vision-token** cost — roughly `imageTokenEstimate` (~1,000)
  → ~146 text tokens, about **85%** — which is what the live trace on the Anyray
  demo stack recorded.

- **`param_tuning` — the saving is the output *ceiling*, not the input.** It
  clamps a runaway `max_tokens` (100,000 → 4,096), capping worst-case output spend
  and keeping providers that pre-reserve output quota from rejecting the request.
  The input is untouched (0% input reduction by design); the committed row records
  the `max_tokens_before`/`max_tokens_after` clamp. The bill only inflates when the
  model actually rambles — the cap removes that tail risk.

- **`cache_optimizer` — the saving is downstream *cached reads*, not a smaller
  input.** On `claude-*` traffic it sorts the tool block (a byte-identical prefix
  every turn) and injects `cache_control` breakpoints at the end of the tools and
  system blocks, so the static prefix bills at the cached-read discount on the
  *next* turn. It never drops content — it reorders and annotates — so the request
  size barely moves here; the win is in the provider's cache, not in `chars`. The
  Anthropic breakpoint path is gated on model + a large-enough prefix, so this
  workload pins `minPrefixChars` to Sonnet's ~4096-char floor to fire it.

- **`context_quality` — a read-only *diagnostic*, not a transform.** It scores the
  request's context health (window fill, bloated and duplicate tool outputs) and
  emits a 0–100 score on the decision's `metric` field; the request is returned
  unchanged (0% saved by design). The workload feeds it a deliberately over-fetched
  context (two docs fetched twice) and it scores **69/100**, flagging the bloat.

## Measurement

Produced by [`./run.sh`](run.sh) against a live optimizer, same as the other
suites. The difference is the *basis*: read the `decisions`, `tier`, and
`max_tokens_*` fields in [`results/optimized.json`](results/), not the
`savedPct`.

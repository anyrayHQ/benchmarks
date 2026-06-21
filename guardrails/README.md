# Guardrails (special accounting)

Three workloads whose saving is **not** whole-request character reduction, so each
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

## Why these are special

- **`semantic_cache` — the saving is a *call*, not a trim.** The benefit is that
  the *second* identical request is served from cache, avoiding the provider call
  entirely (its whole input and output). A single cold run through the optimizer
  is a cache miss with no character change, so `optimized.json` honestly shows 0%
  for this one-shot measurement. The win shows up across repeated traffic, not in
  one request.

- **`vision_ocr` — the saving is in vision tokens, not characters.** The strategy
  runs a local OCR pass on a text-bearing screenshot and swaps the image for the
  extracted text, so a text-only model can answer and the expensive image tokens
  go away. The harness measures the request payload by characters: the base64
  image (54,354 chars) is replaced by ~780 chars of text. The *meaningful* basis
  is the provider's **vision-token** cost — roughly `imageTokenEstimate` (~1,000)
  → ~146 text tokens, about **85%** — which is what the live trace on the Anyray
  demo stack recorded.

- **`param_tuning` — the saving is the output *ceiling*, not the input.** It
  clamps a runaway `max_tokens` (100,000 → 4,096), capping worst-case output spend
  and keeping providers that pre-reserve output quota from rejecting the request.
  The input is untouched (0% input reduction by design); the committed row records
  the `max_tokens_before`/`max_tokens_after` clamp. The bill only inflates when the
  model actually rambles — the cap removes that tail risk.

## Measurement

Produced by [`./run.sh`](run.sh) against a live optimizer, same as the other
suites. The difference is the *basis*: read the `decisions`, `tier`, and
`max_tokens_*` fields in [`results/optimized.json`](results/), not the
`savedPct`.

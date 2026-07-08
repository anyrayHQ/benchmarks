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

### New workloads (first run 2026-07-08, optimizer v0.3.41)

Four more strategies whose value is invisible to request-byte accounting — two
save on the *output/provider* side, two must prove they change *nothing*.

| Workload | Strategy | Knob | Basis | Result |
|---|---|---|---|---|
| Provider context trim — Anthropic `clear_tool_uses` annotation | `provider_context_trim` | `triggerTokens=4000`, `/v1/messages` | provider-clearable input | **4,994 of 5,289 input tok (94%)** of stale tool results marked for server-side clearing; message bytes untouched, 100% key-fact survival |
| Reasoning downshift — routine tool-resume turn on a reasoning model | `reasoning_budget` | (defaults, session metadata) | thinking-token budget | capped **24,576 → 8,192 (−67%)** on the resume turn; content untouched, 100% key-fact survival |
| Output shaping — concise-output advisory on a resume turn | `output_shaping` | (defaults) | output tokens | **−24% live** (265 → 201, judge-PASS answer parity, `results/live-basis.json`) for +7% request bytes |
| Content census — nine shape classes through a read-only pass | `content_census` | (defaults) | census counters (read-only) | request byte-identical; 9 fresh tool outputs censused (json_array 35%, base64 15%, source_code ×2 13%, …) |

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

- **`provider_context_trim` — the provider does the clearing, Anyray only labels.**
  On metered bare-`claude-*` traffic past `triggerTokens` it injects Anthropic's
  native `context_management` `clear_tool_uses` edit; Anthropic then clears aged
  tool results before billing. The gateway never reads or rewrites message bytes —
  which is exactly what the workload asserts: key facts from the *earliest* tool
  rounds must survive at **100%**. Anything less is a do-no-harm violation, not a
  quality trade. Fires only on the `/v1/messages` endpoint (the workload carries
  an `endpoint` override).

- **`reasoning_budget` — the saving is thinking tokens on the *next* response.**
  On a routine tool-resume turn (≥2 assistant turns, ends on a clean tool result,
  no new user question) it downshifts reasoning effort — here the Anthropic lane
  caps a client-wide `thinking.budget_tokens` of 24576 to the default 8192 on a
  `claude-opus-4-8` request. Message bytes are untouched; the saving is the
  thinking the model no longer burns re-deriving context it already has. Needs a
  session key in the optimize metadata (the workload sets one).

- **`output_shaping` — a nudge, not a transform.** On the same routine-resume
  shape it appends one sentinel-guarded advisory steering the model away from
  re-printing unchanged files. The `[anyray:output-guidance]` key fact asserts the
  advisory actually fired (it is absent from the raw payload); the remaining key
  facts assert nothing else moved. Reports $0 estimated savings by design — the
  win is measured downstream via the regression guard.

- **`content_census` — sizing the *next* strategy, changing nothing.** It
  classifies fresh tool outputs — only segments after the last assistant turn;
  re-sent history is excluded — into shape classes (JSON array/object, unified
  diff, grep output, build/test log, source code by family, HTML, base64, prose)
  and emits counters that size what a future strategy could address. The workload
  lands one of each shape class in a single parallel read round so all nine are
  fresh at once; the pass must be byte-identical.

## Measurement

Produced by [`./run.sh`](run.sh) against a live optimizer, same as the other
suites. The difference is the *basis*: read the `decisions`, `tier`, and
`max_tokens_*` fields in [`results/optimized.json`](results/), not the
`savedPct`.

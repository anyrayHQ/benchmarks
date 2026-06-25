# Anyray Optimizer Benchmarks

[Anyray](https://anyray.ai) cuts the **input tokens** your LLM requests carry — and
this repo proves it, reproducibly, on the workloads developers and coding agents
actually produce day-to-day, with the answer kept intact.

> **Headline: 72% fewer input tokens across 22 real-world workloads (290k → 82k),
> answer preserved in 20 of 22 — every number reproducible against a running optimizer.**

Each workload is a wasteful thing real devs and agents do every day — pasting a
whole log and asking one question, an agent re-reading entire files, MCP tool-schema
bloat, RAG over-fetching, resending the full session every turn. These aren't inputs
cherry-picked to flatter an algorithm: the mix is **weighted to real measured
traffic** (see [Why these workloads](#why-these-workloads)). Anyray fixes them **on
the request path, without touching the app**.

Every number is produced by running the **real optimizer** (the before-request
hook that sits on the gateway's hot path) over these workloads and measuring the
request it returns. Nothing is hand-typed: `./run.sh` writes the JSON in each
suite's `results/`, and the headline below is the sum of those files.

## Headline

Whole-request token reduction, measured by running each workload's hero strategy
through a live optimizer (accounting basis — see [Methodology](#methodology)):

| Suite | Workloads | Before (tok) | After (tok) | **Saved** |
|---|--:|--:|--:|--:|
| [`logs-and-data/`](logs-and-data/) | 5 | 157,029 | 39,859 | **75%** |
| [`code-context/`](code-context/) | 7 | 20,030 | 9,138 | **54%** |
| [`tools-and-rag/`](tools-and-rag/) | 4 | 14,565 | 4,877 | **67%** |
| [`agent-ops/`](agent-ops/) | 5 | 92,970 | 27,050 | **71%** |
| [`memory-recall/`](memory-recall/) | 1 | 5,895 | 867 | **85%** |
| **Total** | **22** | **290,489** | **81,791** | **72%** |
| [`guardrails/`](guardrails/) | 5 | *special accounting* | | *see suite* |

The mix is **weighted to real measured traffic** — `context_compression` and
`code_skeleton`, which fire on ~90% / ~71% of production calls, carry the suite. Token
counts use a `chars / 4` estimate, so read the **percentage** as the headline (see
[Methodology](#methodology)). Full per-workload and per-strategy breakdowns, plus a
real-provider cross-check, are in [RESULTS.md](RESULTS.md).

## Quality — does the answer survive?

Savings are only worth it if the model can still answer. For every workload we
define the **answer-bearing key facts** and check how many survive — two committed
signals, side by side:

| | Workloads | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| Key-fact survival (strict substring, model-free) | 22 | 20 | 0 | 2 |
| Semantic judge (Claude Opus 4.8) | 22 | 19 | 2 | 1 |

**The answer survives on 20 of 22 by the strict measure, and a Claude Opus 4.8 judge
confirms 19 PASS / 2 MARGINAL / 1 FAIL.** The few that aren't perfect are one known
limit of the lexical filter — reported openly, not hidden, with every judge verdict
shown in **[QUALITY.md](QUALITY.md)**.

## Why these workloads

These aren't synthetic stress tests picked to make an optimizer look good. Every
one is a token-waste pattern that the 2025–2026 AI-cost literature consistently
ranks as among the most common — and most expensive — things developers and
coding agents do. **79% of enterprises overran their AI budgets last year**, and
the same culprits show up every time. We benchmark Anyray on exactly those.

| Waste pattern — what devs / agents actually do | What the cost research reports | Suite |
|---|---|---|
| Paste a whole log or data dump and ask one question | the single most common thing engineers do with an assistant — the file is billed in full, every turn | `logs-and-data` |
| Agents re-read entire files when the question needs signatures, not bodies | **~70%** of a coding agent's tokens are irrelevant file reads | `code-context` |
| MCP tool-schema bloat rides along every call | **55k+ tokens** of tool definitions before the first message | `tools-and-rag` |
| RAG over-retrieval | **3–5×** more chunks fetched than the answer uses | `tools-and-rag` |
| The same instruction block re-pasted per item | repeated boilerplate billed once per item | `tools-and-rag` |
| Agents resend the whole history every turn (context re-accumulation) | the **#1** researched waste pattern — agents use **4–15×** chat tokens; a 50-turn coding session bills ~**25:1** input:output | `agent-ops` |
| Command / test output read back verbatim | runner output is mostly passing lines + banners | `agent-ops` |
| Recall a large store (sessions, decisions, notes) for a narrow question | recall-heavy assistant + agent usage | `memory-recall` |
| Redundant / near-duplicate requests | **40–60%** of enterprise LLM traffic is repetitive (**18%** exact duplicates, **~47%** semantically similar) | `guardrails` (cache) |
| Pasted screenshots billed as vision tokens | text-bearing images cost far more than their extracted text | `guardrails` (OCR) |
| Runaway output ceilings / over-generation | uncapped `max_tokens` inflates worst-case spend | `guardrails` (param) |

*(Figures are the patterns the 2025–2026 industry cost research surfaces
repeatedly; they motivate the workload selection, they are not themselves Anyray
measurements. Anyray's measurements are the [headline](#headline) and
[RESULTS.md](RESULTS.md).)*

Waste patterns we **don't** yet have a strategy for — named so the scope is honest:
model overkill (routing trivial calls to cheaper models), retry storms /
duplicate-call debouncing, and provider prompt-cache shaping.

## Benchmarks

Each suite is a directory of payloads plus the strategy that targets that waste
pattern. The "hero strategy" is the one Anyray reaches for first on that shape of
request.

| Suite | Workloads | Hero strategies | What it measures |
|---|---|---|---|
| [`logs-and-data/`](logs-and-data/) | 5 | `context_compression`, `relevance_filter` | A log/data/JSON blob (often a tool result) + a narrow question → minify, array-cap, keep the lines that answer it |
| [`code-context/`](code-context/) | 7 | `code_skeleton`, `code_graph`, `relevance_filter` | Source/diff/search read back (file reads via tool results) → keep the navigable skeleton, elide bodies |
| [`tools-and-rag/`](tools-and-rag/) | 4 | `tool_pruning`, `tool_schema_compression`, `relevance_filter`, `prompt_compression` | Tool-schema bloat, verbose schema prose, over-fetched chunks, re-pasted boilerplate |
| [`agent-ops/`](agent-ops/) | 5 | `window_budget`, `relevance_filter`, `command_digest` | Triage dumps, long tool-call sessions that overflow the window, verbatim test output |
| [`memory-recall/`](memory-recall/) | 1 | `relevance_filter` | A large recalled store + a "remember this for me" question |
| [`guardrails/`](guardrails/) | 5 | `semantic_cache`, `vision_ocr`, `param_tuning`, `cache_optimizer`, `context_quality` | Repeated calls, pasted screenshots, runaway ceilings, Claude cache-prefix, context health |

The optimizer is **reversible**: every elided span is stashed behind a
content-free retrieval handle (CCR `POST /v1/retrieve`), so the model can pull
back anything it turns out to need. Most strategies re-rank and elide rather than
paraphrase — so the saving comes from dropping what the live question doesn't
touch, not from lossy rewriting; a few (`command_digest`, `tool_schema_compression`)
rewrite deterministically and idempotently. See [Does it preserve the
answer?](#does-it-preserve-the-answer)

## Methodology

The harness turns each workload into two configs — the Anyray analog of a
compression benchmark's `control` vs `model--aggressiveness`:

- **`control`** — the raw request, optimizer bypassed. Establishes the baseline token count.
- **`optimized`** — the suite's hero strategy, pinned at a single knob, run by a live optimizer.

For each workload the harness:

1. `PUT /admin/optimizer/settings` to pin exactly one strategy at one knob (so the
   saving is attributable to a named strategy, not the whole pipeline).
2. `POST /v1/optimize` with the payload, and reads back the transformed request.
3. Measures **whole-request size**: the character length of every message body
   plus the tools schema, before and after.

The token figure is `chars / 4` (the basis the optimizer itself uses; set in
`config.yaml`). The **savings percentage is the reliable signal** — it's confirmed
against a real BPE tokenizer (`tiktoken`) and the optimizer's own calibrated
estimator; the absolute counts are a conservative estimate (~1.2–1.8× below real
provider tokens on dense logs/JSON). A real-provider cross-check is in
[RESULTS.md](RESULTS.md); a built-in `--live-bill` mode is on the
[roadmap](RESULTS.md#roadmap).

**Content-free, by construction.** The harness records only sizes and the
optimizer's own one-line decision strings — never message bodies. That mirrors
Anyray's core invariant: prompt/response *content* is never logged. Every payload
in this repo is **synthetic**.

## Prerequisites

- Node.js 20+
- A reachable Anyray optimizer (the before-request hook). The Anyray stack brings
  one up in-network on `:8088` — `docker compose up` from the
  [Anyray install repo](https://github.com/anyrayHQ/install). Any reachable
  instance works.
- The optimizer's admin token (`ANYRAY_ADMIN_TOKEN`) — the same key that gates the
  Anyray console. The harness uses it to pin one strategy per workload.

## Setup

```bash
cp .env.example .env
# Edit .env: ANYRAY_OPTIMIZER_URL and ANYRAY_ADMIN_TOKEN
```

`./run.sh` installs dependencies (`js-yaml`) and loads `.env` on first run.

## Configuration

All settings live in [`config.yaml`](config.yaml):

- **`shared`** — optimizer URL, admin-token env var (and an optional
  optimizer-token env var for hardened optimizers that gate `/v1/optimize`), the
  chars-per-token accounting basis, request timeout.
- **`benchmarks`** — one entry per suite; each lists its workloads, and each
  workload names its `strategy` and `params` (the knob). To benchmark a strategy
  at a different aggressiveness, change its `params` and re-run.

## Running a benchmark

```bash
cd memory-recall && ./run.sh          # one suite
./run.sh --all                        # every suite
```

### Options

```bash
./run.sh --suite code-context                      # one suite by name
./run.sh --suite code-context --workload 15-multifile-graph   # one workload
./run.sh --all --limit 2                           # first 2 workloads per suite (smoke test)
```

### Resume support

Interrupted? Re-run the same command. Workloads already present in
`results/optimized.json` are skipped.

## Results

Each suite writes `results/control.json` and `results/optimized.json` — an array
over the suite's workloads, re-saved per item (so a run resumes cleanly). Each
`optimized` row carries the strategy, knob, before/after chars and tokens, percent
saved, and the optimizer's decision strings. These files are **committed** — they
are the real, reproducible scores. The aggregate is [RESULTS.md](RESULTS.md).

## Does it preserve the answer?

Yes — measured, not asserted. The [**quality benchmark**](QUALITY.md) defines the
answer-bearing key facts for each workload and checks how many survive: **20 of 22
by strict substring**, and a **Claude Opus 4.8 judge** (committed alongside) confirms
**19 PASS / 2 MARGINAL / 1 FAIL**. Anyray's strategies are also reversible — every
elided span is retrievable on demand (`POST /v1/retrieve`) — so even a partial trim
is recoverable.

Run it with `node run_quality.mjs --all` (strict survival) and `--judge` for the
semantic pass.

## What this does and doesn't measure

- **Does:** input-token reduction per workload, per strategy, reproducibly, on a
  content-free basis — **and** answer-quality (key-fact survival) per workload.
- **Doesn't (yet):** latency added by the hook (the optimizer fails open past
  `ANYRAY_OPTIMIZER_TIMEOUT_MS`); output-token cost (except the `param_tuning`
  guardrail, which clamps the output ceiling). See [RESULTS.md](RESULTS.md#roadmap).

---

Built on the Anyray optimizer. Learn more at [anyray.ai](https://anyray.ai) ·
[docs](https://docs.anyray.ai).

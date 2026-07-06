# Live quality + savings validation

The `run_benchmark.mjs` / `run_quality.mjs` harness measures **how much** the optimizer
trims and whether key facts **survive in the trimmed request**. `run_live.mjs` answers the
harder question: when a real model actually answers, does the saving **hold up without
degrading the answer** — and which strategies are WORKING, need TUNE-ing, or need REWORK?

It runs against the **actually running** stack (gateway `:8787`, optimizer admin `:8088`)
and judges **the model's answer**, not just the kept context.

## What it measures

For each workload, two requests go through the live gateway:

- **baseline** — the original request with the hook **off** (`x-anyray-optimize: off`).
- **optimized** — either the optimizer-transformed request with the hook off
  (`per-strategy` / `sweep`), or the original with the hook **on** (`pipeline`, full
  deployed config).

From the two provider responses it records:

- **Real saved %** — the actual billed `usage.prompt_tokens` delta (not a `chars/4`
  estimate).
- **Quality** — per the workload's `qualityCheck` (below).

## Quality checks (per strategy)

| `qualityCheck` | Strategies | Test |
|---|---|---|
| `answer_judge` (default) | relevance_filter, context_compression, code_graph, command_digest, window_budget, prompt_compression, tool_schema_compression, vision_ocr | An LLM judge (Opus) rules whether the optimized answer preserves the **baseline answer's** correctness/completeness on the task, using `keyfacts.json` as the rubric. PASS ≥ 90 & preserved · MARGINAL ≥ 75 · else FAIL. |
| `tool_safety` | tool_pruning | `answer_judge` **and** no pruned tool was actually needed. |
| `cache_hit` | semantic_cache | The 2nd identical request is served from cache (exact hit). |
| `identical` | cache_optimizer | Lossless — the answer is byte-identical to baseline. |
| `truncation` | param_tuning | The clamped output is not cut mid-answer (`finish_reason`). |
| `readonly` | context_quality, content_census | Read-only signal — reports the health metric / shape counters, not an answer. |

The 2026-07-06 coverage expansion adds strategies whose checks lean on
`keyfacts.json` in two inverted ways worth knowing when reading `quality.json`:

- **Do-no-harm workloads** (38 `provider_context_trim`, 39 `reasoning_budget`,
  40 `output_shaping`): the strategy must not touch message bytes, so anything
  below **100%** deterministic key-fact survival is a failure of the strategy's
  contract, not a savings/quality trade.
- **Fired-assertion keyfact** (40): the `[anyray:output-guidance]` fact is absent
  from the raw payload and only appears if the advisory was appended — a 0% on
  that single fact means the strategy never fired, not that content was lost.

## Environment prerequisites

Two workloads exercise strategies that self-gate on deployment features; without
them they no-op (an honest 0% row, not a failure):

- **37-durable-blob (`output_externalize`)** needs the durable CCR tier:
  `ANYRAY_CONTENT_KEY` set, content mode not `off`, and the spend DB reachable.
- **42-semantic-rerank-rag (`relevance_filter` + `semanticRerank`)** needs the
  optimizer's local embedder (MiniLM) available; without it the filter falls back
  to lexical-only ranking and the lexical-trap doc wins.

## Per-workload `endpoint` / `metadata` overrides

Workload entries in `config.yaml` may set `endpoint` (e.g. `/v1/messages` for
38 — `provider_context_trim` only fires on Anthropic's messages endpoint with a
bare `claude-*` model) and `metadata` (e.g. a `sessionId` for 39 —
`reasoning_budget` keys its per-session downshift state off it). Both are passed
through by `run_benchmark.mjs` / `run_quality.mjs` on the `/v1/optimize` call and
default to the shared endpoint / `{}` when absent.

## Verdicts

`lib/verdict.mjs` rolls each strategy's workloads into one verdict
(thresholds in `config.yaml` → `verdict`):

- **WORKING** — median real saved ≥ `minSavedPct` and no quality FAIL.
- **TUNE** — a quality FAIL/MARGINAL exists, but a **sweep** knob recovers PASS at decent
  savings → the recommended knob is shown.
- **REWORK / REPLACE** — a FAIL no sweep knob recovers, or negligible savings everywhere.
- **N/A** — read-only strategies (context_quality).

## Authentication

The harness reaches the gateway the same way your coding tools do. `lib/auth.mjs` resolves:

- **Client key** (`ark_…`) — from `~/.anyray/connect.json` (or `ANYRAY_CLIENT_KEY`), sent as `x-anyray-api-key`.
- **Upstream credential** — in the default **passthrough** mode, the Claude subscription
  OAuth token is read fresh from the macOS keychain (`Claude Code-credentials`) each run and
  sent as `Authorization: Bearer …` (never persisted). Override with `ANYRAY_UPSTREAM_TOKEN`
  (e.g. an `sk-ant-…` API key) or set `ANYRAY_AUTH_MODE=managed` if the gateway has a
  server-side credential.

> The subscription is shared with your interactive Claude Code session, so a large run
> contends for the same rate limit (expect `429`s — the harness backs off and retries, and
> is resume-aware). Run big sweeps when the session is idle.

## Running it

```bash
cp .env.example .env    # ANYRAY_ADMIN_TOKEN + ANYRAY_OPTIMIZER_URL; auth auto-resolves (see above)

# Safe first: validates the stack as configured, mutates no optimizer config.
./run.sh --pipeline --all

# Per-strategy attribution (pins one strategy at a time; config is snapshotted + restored).
./run.sh --live --all

# Tune a strategy's knob (savings <-> quality curve).
./run.sh --sweep --strategy relevance_filter --all

# Regenerate the scorecard, then read it.
npm run verdicts && cat VERDICTS.md

# Everything (pipeline + per-strategy + verdicts):
npm run validate
```

Runs are **resume-aware** (a workload already in the result file is skipped) so a run can
be re-entered after an interruption. Results land in `<suite>/results/{live,pipeline,
sweep-<strategy>}.json`, with attribution in `results/run-meta.json`; `VERDICTS.md` is the
headline scorecard.

## Safety & privacy

- **`per-strategy` and `sweep` temporarily pin the optimizer to one strategy** via
  `PUT /admin/optimizer/settings`. The prior config is **snapshotted and restored** (even
  on crash). `pipeline` mode changes nothing — prefer it on a stack serving other traffic.
- Both the answers and the judge consume the deployment's model quota.
- **Synthetic payloads only.** Never point this harness at real traffic; it never reads
  prompt content from the spend store and does not enable plaintext content mode.

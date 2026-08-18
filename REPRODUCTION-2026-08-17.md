# Reproduction of the published headline — findings (ANY-114)

Run date **2026-08-17**. Optimizer built from `anyrayHQ/monorepo` at `cd8c045e`
(`optimizer` 0.3.124, defaults revision 9). Benchmarks repo from `711b4df`.

## Result

The published **77%** could not be reproduced, and is not the right number. Once
the harness and fixture bugs below are fixed, the same 29 workloads measure
**87.1%** — the optimizer is *better* than published, not worse.

| | workloads | before | after | saved | quality |
|---|---:|---:|---:|---:|---|
| Committed `RESULTS.md` (generated 2026-07-01) | 29 | 338,562 | 77,098 | 77.2% | 32/32 PASS |
| Same fixtures on a current optimizer | 29 | 338,562 | 80,712 | 76.2% | — |
| **After the three repo fixes on this branch** | **29** | **338,958** | **43,712** | **87.1%** | **31/32 PASS** |

The 76.2% middle row is *not* a reproduction even though it lands a point away
from 77.2%. The composition moved underneath it: 8 workloads dropped to exactly
**0%** (−7.0 points) while 8 unrelated ones improved by about as much. Netting to
one point is arithmetic luck.

Four things were wrong: three in this repo, all fixed on this branch, and one in
the product, filed here for a decision rather than fixed.

---

## Fix 1 — the harness's own strategy pin was silently reverted

`lib/optimizerClient.mjs`.

A `PUT /admin/optimizer/settings` that omits `defaultsRevision` is read as
revision 0, so the optimizer replays its entire `DEFAULTS_MIGRATIONS` ledger over
the submitted config before persisting it (`optimizer/src/config.ts`,
`saveConfig` → `migratePersistedDefaults`). Ledger entries force specific kinds
off — revisions 1/2/6 `window_budget`, revision 5 `tool_pruning` — so pinning
exactly those kinds was reverted to `enabled: false`:

```
PUT {"strategies":[{"kind":"window_budget","enabled":true,"params":{"maxTokens":8000}}]}
 -> {"kind":"window_budget","enabled":false,"params":{"maxTokens":8000}}

PUT {"defaultsRevision":9,"strategies":[{"kind":"window_budget","enabled":true,…}]}
 -> {"kind":"window_budget","enabled":true,"params":{"maxTokens":8000}}
```

Recovered 4 workloads: `8-long-session` 0→95%, `11-mcp-tools` 0→70%,
`31-long-toolsession` 0→46%, `24-agent-toolcalls` 0→38%.

Worth noting for `RESULTS.md`: this means the headline includes two strategies
that are **off by shipped default**, for reasons the ledger documents at length
(`window_budget` crops whole messages against a user-controlled ceiling;
`tool_pruning` measured 34 fires and zero prunes on dogfood). Pinning them is
legitimate for per-strategy attribution, but the published table should say so.

## Fix 2 — eight fixtures measured 0% because their payload was the live turn

`tools/recut-single-turn-fixtures.mjs` + the 8 payloads.

`isFreshToolSegment` (`optimizer/src/strategies/freshInput.ts`) makes every
strategy skip tool output sitting after the last assistant message — output the
model has not read yet. Trimming it would destroy the current turn's input, so
the guard is correct. It shipped in **#536 / `8e6718c9`, 2026-07-02**.

The committed results were generated **2026-07-01** (`7ba9a94`) — *one day
earlier*. Eight fixtures are shaped:

```
user(ask to read) -> assistant(tool_call) -> tool(the entire measured payload)
```

so the whole payload sits in the protected zone forever, and each row silently
reported 0% on every build since. Nothing re-measured them.

The fix is in the fixtures, not the optimizer. Re-cut to the same conversation
one turn later — the read is a completed prior step, the live turn is the user's
question, carried forward **verbatim** so `keyfacts.json` still describes exactly
what the request needs:

```
user(ask) -> assistant(tool_call) -> tool(big) -> assistant(ack) -> user(the original question)
```

That is the shape a coding agent actually sends on the turn where trimming
history pays off. Results:

| workload | strategy | committed | before fix | after fix |
|---|---|---:|---:|---:|
| `memory-recall/18-session-recall` | relevance_filter | 85% | 0% | 85% |
| `code-context/28-read-module-py` | code_graph | 71% | 0% | 70% |
| `tools-and-rag/32-vocab-mismatch-rag` | relevance_filter | 71% | 0% | 69% |
| `code-context/27-read-service-ts` | code_graph | 66% | 0% | 66% |
| `logs-and-data/29-orders-json` | context_compression | 42% | 0% | 88% |
| `logs-and-data/30-metrics-json` | context_compression | 42% | 0% | 93% ⚠ |
| `code-context/17-python-multifile` | code_graph | 33% | 0% | 33% |
| `code-context/15-multifile-graph` | code_graph | 31% | 0% | 31% |

Six land within ~2pp of their published value, which is the cross-check that the
re-cut measures the same thing the original intended. The tool ships `--check`
so CI can fail if a single-turn fixture reappears.

## Fix 3 — scores depended on suite order (embedding model not loaded)

`lib/optimizerClient.mjs` (`warmEmbedder`) + `run_benchmark.mjs`.

A `semanticRerank` workload that ran before the optimizer's local embedding model
was resident silently fell back to lexical ranking — precisely what the
vocabulary-gap fixtures exist to defeat. `33-synonym-gap-logs` measured
**94% saved / 50% key-facts FAIL** as the first row of a cold run and
**61% / 100% PASS** re-run against the same warm optimizer. A 33-point swing on
identical input, with no error on either path, so which number you got depended on
suite order.

`run_benchmark` now loads the model before the first measurement. Two non-obvious
things about writing that warm-up, both of which cost a run:

- **Synthetic filler does not work.** `relevance_filter` skips embeddings when
  lexical ranking is already confident (`lexConfidentHits`, default 6) and no-ops
  entirely when nothing is worth dropping, so hand-rolled content is served by
  BM25 and never touches the model. The warm-up replays a real `semanticRerank`
  workload from `config.yaml` instead.
- **The warm-up request must carry the retrieve tool.** Without it the optimizer
  suppresses the strategy as `no_retrieve` *before* any embedding happens, so the
  probe reports "not warm" forever and no amount of polling helps. I first read
  this as a slow lazy load and added a retry loop; the retry was treating a
  suppression as latency.

Advisory, never fatal: prints a pointer to `npm run fetch-model` if the model
cannot be confirmed, and restores the pre-warm-up config either way.

## Finding 4 — a real product regression: `context_compression` drops the answer

**Not fixed here — this is a product bug and wants its own ticket.**

`logs-and-data/30-metrics-json` is the one quality FAIL, and it is the most
important thing in this run. It loses **both** its key facts (`4200`, `512`).

### What the fixture is

A 480-point hourly metrics series, and the question is "find the single spike:
which timestamp has p99 over 4000 and how many errors at that point?" The answer
lives at **index 305 of 480**:

```json
{"t":"2026-06-25T17:00:00Z","p50":44,"p99":4200,"errors":512}
```

Every other point has p99 between 80 and 99. The spike is the entire answer.

### What went wrong

**`1758cc46` ("fix optimizer token savings pipeline", #1118, 2026-07-17) lowered
`context_compression`'s default `maxArrayItems` from 500 to 50.**

`crushValue` keeps the **first** N items and elides the tail
(`contextCompression.ts`: `v.slice(0, p.maxArrayItems)`), then appends one
summary object. So the model receives points 0–49, all unremarkable, followed by:

```json
{"__anyray_elided__":430,"of":480,"retrieve":"ctx_1lp09cuiimh68_1184"}
```

Verified by sweeping the knob on today's build. The old default reproduces the
committed byte count exactly:

| `maxArrayItems` | result | key facts |
|---:|---|---:|
| 50 (today's default) | `48244->3045` | **0% FAIL** |
| 200 | `48244->11795` | **0% FAIL** |
| **500 (the July default)** | **`48244->28068`** | **100% PASS** |
| 1000 / 5000 | `48244->28068` | 100% PASS |

`48244->28068` is character-identical to the committed decision, which confirms
the July run used 500 and that nothing else about this row moved.

### Why this is worse than "truncation"

The bytes are recoverable — the elision is reversible and carries a `retrieve`
handle, and 430 of 480 points are stashed. The hazard is that **the model has no
way to know it needs them.** Compare:

- `code_graph` elides function *bodies* but keeps every *signature*. The model
  sees `async capture(amount: number, ctx: TxnContext)` and knows a body exists
  to fetch. Elision is visible at the point of use.
- A truncated array of metrics is **statistically indistinguishable** from a
  complete one. Points 0–49 look like a healthy service. Nothing in the kept
  slice hints that the maximum lies outside it. `__anyray_elided__: 430` says
  *how many* rows are gone but nothing about *what* was in them.

So for any extremum query — max, min, outlier, "the one that failed", "when did
it spike" — the model can answer fluently and confidently from the visible 50 and
be flatly wrong, with no signal that a retrieval was needed. That is the failure
mode that matters: not lost data, but a **wrong answer that looks right**.

It is also the shape this strategy will see most in production: `29-orders-json`
(the sibling fixture, "which orders failed") passes only because its failures
happen to fall inside the first 50 rows. That is luck, not correctness.

### Blast radius: the pipeline position does NOT limit this

Worth stating plainly, because it is the intuitive assumption and it is wrong.
`context_compression` runs *after* the specialists (`RUNS_AFTER` in
`constraints.ts`), which sounds like it only ever gets leftovers. Running last is
not protection — it means the strategy receives everything no other strategy
wanted, and for plain structured data that is *everything*.

Verified three ways on this build:

1. **The full shipped default pipeline drops the answer.** No pinning, no
   `enabledKinds` — just the 14 strategies enabled in `DEFAULT_CONFIG`.
   `context_compression` is the only strategy that fires on `30-metrics-json`,
   and the key facts read `0% FAIL`.
2. **No specialist claims the data.** Asked alone, `command_digest`, `code_graph`,
   `relevance_filter`, `context_dedupe`, and `observation_mask` *all* decline — a
   JSON metrics dump is not a command transcript, not code, not a duplicate, not
   a stale observation. `RUNS_AFTER` governs sequence, not whether.
3. **Minimal repro on synthetic data**, no fixture involved: one tool message
   returning `{"metric":…,"points":[…]}`, one assistant ack, the user's question.
   - **51 items is enough** — the array only has to exceed 50, and ~8 KB triggers it.
   - **Hard cutoff at index 50**: needle at 49 survives, needle at 50 does not.
   - **Model-dependent**: fires on `claude-sonnet-4-6` and
     `openai.gpt-oss-120b-1:0`; does *not* fire on `gpt-4o`, where `gpt-*` is an
     implicit-cache model and the cache guard suppresses it.

That last point is the only thing narrowing exposure, and it is incidental rather
than designed: OpenAI-hosted traffic is shielded, Anthropic traffic and
open-weights models on Bedrock/Groq are not.

So the condition is: a tool returned a JSON array of >50 items, the output is in
history, the model is not `gpt-*`, and the answer lives past item 50. Log
queries, metrics series, DB result sets, search hits, and CI output all match.

### Suggested direction (not implemented — needs a decision)

I did not change the default. Reverting 50→500 fleet-wide moves everyone's
savings numbers and is Dean's call, not mine. Options, roughly in order of how
much I'd trust them:

1. **Sample rather than truncate.** For a long array of uniform records, keep the
   first N/2 and last N/2, or keep N spread evenly across the array. Preserves
   the shape of the series and makes an extremum far likelier to survive, at the
   same token cost.
2. **Keep numeric extremes.** When array elements are objects with numeric
   fields, always retain the row holding each field's min and max. Cheap, and
   targets exactly the query class that breaks.
3. **Raise the default back and take the savings loss**, treating 50 as too
   aggressive for a default. Simplest, least clever, immediately correct.

Options 1 and 2 keep #1118's savings win; option 3 abandons it. Either way, the
regression test is `30-metrics-json` — it is now a committed FAIL, so whichever
fix lands will flip it green.

`maxArrayItems` is not documented on any `docs/docs/` page, so no docs update
rides along.

---

## Reproduction notes — three things that cost savings silently

None of these error. Each just returns a lower number, so a customer following
"Run it yourself" gets a bad result and no clue why. Each cost me a full run to
find. Item 2 is now fixed in the harness (fix 3 above); items 1 and 3 are
environment/usage notes that belong in the docs.

1. **The optimizer needs a durable stash**, or `output_externalize` no-ops and
   `observation_mask` degrades. `durableStashAvailable()`
   (`optimizer/src/strategies/contextRetrieval.ts`) requires all three of
   `ANYRAY_SPEND_DB_URL`, `ANYRAY_CONTENT_KEY`, and a content mode that is not
   `off`. A bare `node dist/index.js` has none, and `memory-recall/37-durable-blob`
   reads 0% instead of 99%. Confirm with `GET /health` →
   `"configStore":"shared"` (`"per-pod"` means no durable tier).
2. **The optimizer needs its embedding model fetched**: `npm run fetch-model` in
   `optimizer/`. Without it every `semanticRerank: true` workload silently falls
   back to lexical ranking, which is precisely what those fixtures exist to
   defeat. `42-semantic-rerank-rag` scored MARGINAL and `33-synonym-gap-logs`
   FAILed until I fetched it.
3. **`./run.sh --all` resumes**, skipping any workload already in
   `<suite>/results/optimized.json` (and `run_quality.mjs` likewise from
   `quality.json`). On a fresh clone it re-measures **nothing** and prints
   `already done — skipping` 29 times, which reads as success. Delete the
   `control.json` / `optimized.json` / `quality.json` triples first. Worth a
   `--force` flag.

Item 2 no longer skews a run — fix 3 above loads the model first — but the model
still has to be *present*, so `npm run fetch-model` remains a prerequisite.

For scale, the headline reads: **44.3%** with none of this addressed, **51.4%**
with the durable stash, **76.2%** with fix 1, **87.1%** with fixes 2 and 3 as
well. That last figure is now reproducible from a cold optimizer in a single
`./run.sh --all`, which it was not before.

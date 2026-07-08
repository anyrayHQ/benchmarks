# Strategy research — state of the art vs. Anyray's strategies

*Researched 2026-07-08 via web search (Exa) over papers and open-source repos.
Star counts are as-seen on that date. Criteria per the research goal: prefer
**peer-reviewed / research-backed** techniques and **open-source projects with
large adoption** (stars), then compare each against the optimizer strategies
this repo benchmarks and recommend improvements or additions.*

The optimizer strategies live in the Anyray optimizer (the before-request hook);
this repo measures them. This document is the comparison and the roadmap it
implies: what to tune in existing strategies, and which new strategies earn a
place (each with the workload suite that would prove it).

---

## TL;DR

| Verdict | Strategies |
|---|---|
| **Already state-of-practice** — keep, minor tuning | `relevance_filter` (+semantic rerank), `window_budget`, `command_digest`, `tool_pruning`, `cache_optimizer`, `param_tuning` |
| **Improve** — a concrete, research-backed upgrade exists | `code_graph` (graph *ranking* à la Aider repo-map), `context_compression` (tabular re-serialization à la TOON), `semantic_cache` (similarity matching à la GPTCache), `tool_schema_compression` (typed-signature rendering), `window_budget` (restorable eviction) |
| **Add** — proven gap we don't cover | `context_pruning` (Provence/RECOMP-style extractive pruning), `observation_masking` (rolling tool-result clearing), `session_compaction` (summarize-then-continue), `memory_extraction` (Mem0/Letta-style store) |
| **Watch, don't build** | ML prompt compression (LLMLingua-2) — strongest research line, but needs a GPU-backed encoder on the hot path; revisit if latency budget allows |

---

## 1. What the research and high-star OSS actually do

### 1.1 Prompt compression (research line: LLMLingua)

- **LLMLingua / LongLLMLingua / LLMLingua-2** — [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua),
  **~6.4k stars**; EMNLP 2023 / ACL 2024 / ACL Findings 2024.
  - LLMLingua: budget controller + iterative token-level compression using a
    small LM's perplexity; up to **20x** compression on GSM8K/BBH with minimal
    quality loss.
  - LongLLMLingua: **question-aware** coarse-to-fine compression + document
    reordering + subsequence recovery; **+21.4% accuracy at ~4x fewer tokens**
    on NaturalQuestions, ~94% cost reduction on LooGLE, 1.4–2.6x latency wins.
  - LLMLingua-2 (task-agnostic): reframes compression as **token
    classification** with a small encoder (distilled from GPT-4 annotations);
    2–5x compression, **3–6x faster** than LLMLingua-1 — built for exactly the
    "hook on the request path" position Anyray occupies.
  - Take: the strongest research family in this space. The blocker is
    operational, not scientific: a transformer encoder pass per request on the
    gateway hot path. LLMLingua-2's encoder is small enough that this is
    plausible as an *opt-in* strategy where latency tolerates it.

### 1.2 RAG context pruning (research line: RECOMP → Provence)

- **RECOMP** (ICLR 2024): extractive + abstractive compressors for retrieved
  docs; keeps ~**5–10% of tokens** on NQ/TriviaQA/HotpotQA with under ~10%
  relative quality drop; ~2x faster end-to-end.
- **Provence** (Naver, ICLR 2025): sentence-level pruning as **sequence
  labeling, unified with the reranker** (one DeBERTa pass does both), dynamic
  pruning ratio (drops zero to all sentences per chunk), **negligible-to-zero
  QA drop and sometimes improved answers** (noise removal). Model open-sourced
  (`naver/provence-reranker-debertav3-v1`).
- Take: this is `relevance_filter`'s research-grade sibling — ours ranks and
  trims at chunk/line level with BM25 (+ optional semantic rerank); Provence
  prunes *inside* kept chunks at sentence level with a learned, dynamic ratio.
  The two compose: filter chunks lexically first (cheap), prune sentences
  second (model-based).

### 1.3 Semantic caching (OSS line: GPTCache)

- **GPTCache** — [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache),
  **~8.1k stars**, MIT; NLP-OSS 2023 paper. Embedding → vector store →
  **similarity evaluator** (cross-encoder scoring beats raw cosine), tunable
  threshold, LRU/FIFO eviction. Known failure mode: false-positive hits on
  *similar-but-different* queries — the evaluator + threshold exist to control
  precision, and cache entries must be scoped per model/params.
- Take: our `semantic_cache` workload (`9-repeat-request`) only proves the
  *identical-request* case. GPTCache's design is the reference for the harder
  and much more valuable near-duplicate case.

### 1.4 Agent context engineering (industry line: Anthropic, Manus; research: observation masking)

- **Anthropic, "Effective context engineering for AI agents"** (2025) and the
  Claude platform context-editing API: three primitives — **compaction**
  (summarize the conversation near the limit, keep recent tool results
  verbatim), **tool-result clearing** (replace old `tool_result` blocks with a
  re-fetchable placeholder — this repo's `/v1/retrieve` elision marker is the
  same idea), and **structured note-taking / agentic memory**. Sub-agents as
  context isolation: explore with tens of thousands of tokens, return a 1–2k
  summary.
- **Manus, "Context Engineering for AI Agents"** (2025): **KV-cache hit rate
  is the #1 production metric** (~10x price gap between cached and uncached
  input tokens on Claude); keep the prompt prefix stable and append-only,
  serialize deterministically, **mask tools instead of removing them**
  (dynamic tool removal invalidates the KV cache), make any context drop
  **restorable** (keep the URL/path, drop the content), use the filesystem as
  external memory.
- **"The Complexity Trap"** (arXiv:2508.21433): on SWE-agent tasks, **simple
  observation masking (keep the last N tool observations, mask older ones)
  matches or beats LLM summarization** at a fraction of the cost; a hybrid
  (mask first, summarize rarely) cut cost a further ~7–11% while *improving*
  solve rate. Strong evidence that the cheap mechanism is the right default.
- Take: directly validates two things we already do (`cache_optimizer`'s
  stable prefix; restorable elision markers) and names our two biggest gaps
  (observation masking, compaction) — see §3.

### 1.5 Code context (OSS line: Aider repo-map)

- **Aider** — [Aider-AI/aider](https://github.com/Aider-AI/aider), **~42k
  stars**. Its repo map parses the repo with **tree-sitter**, builds a graph of
  files/symbols linked by definition-reference edges, runs **personalized
  PageRank** (personalization biased toward files in the current chat /
  mentioned identifiers), and **binary-searches** the set of top-ranked
  definitions to fit a hard token budget (default ~1k tokens).
- Take: our `code_graph` already keeps on-path bodies and skeletons — same
  family. What Aider adds that we lack: (1) a **global rank** so that under a
  budget the *most-referenced* symbols survive rather than a file-order
  prefix, and (2) **fit-to-budget** semantics (`maxTokens`) instead of only
  local knobs (`minBodyLines`).

### 1.6 Tool selection & schema cost (research line: RAG-MCP and successors)

- **RAG-MCP** (arXiv:2505.03275): retrieve tools from an indexed registry
  instead of stuffing all schemas; **>50% prompt-token cut** (2133 → 1084)
  and accuracy **18.2% → 43.1%** on their MCP stress test.
- **MCP-Zero** (arXiv:2506.01056, [xfey/MCP-Zero](https://github.com/xfey/MCP-Zero)):
  *agent-initiated* tool discovery — start with no schemas, let the model
  request capabilities; up to **98% token reduction** on APIBank while keeping
  accuracy.
- Semantic tool discovery / tool-attention work (2025–26): top-K≈3 tool
  retrieval gets ~**97% hit rate, ~95–99% tool-token reduction**; lazy schema
  loading (name-only until used) is the common trick. This is exactly the
  deferred-tool / ToolSearch pattern production agent harnesses now ship.
- Take: `tool_pruning` (drop unused schemas) is the static version of this.
  The research consensus adds two upgrades: rank tools by **query relevance**
  (not just presence/absence), and keep unsent schemas **discoverable**
  (mask, don't delete — also the Manus KV-cache advice).

### 1.7 Cross-session memory (OSS line: Mem0, Letta, Zep)

- **Mem0** — [mem0ai/mem0](https://github.com/mem0ai/mem0), **~60k stars**;
  paper reports **+26% accuracy over OpenAI's memory on LOCOMO, 91% lower p95
  latency, >90% token savings vs. full-context replay**. Two-phase
  extraction/update pipeline (ADD/UPDATE/DELETE/NOOP per fact), optional graph
  variant.
- **Letta (MemGPT)** — [letta-ai/letta](https://github.com/letta-ai/letta),
  **~24k stars**: OS-style memory hierarchy (in-context core memory + recall +
  archival, with paging); their filesystem-memory agent beats Mem0 on LoCoMo
  (74.0 vs 68.5) — simple external stores remain competitive.
- **Zep / Graphiti** (~18k stars): temporal knowledge graph; on LongMemEval,
  **+18.5% accuracy at ~2% of the baseline tokens** and ~90% lower latency.
- Take: our `memory-recall` suite treats the recalled store as *given* and
  filters it with BM25 (`relevance_filter`). The research frontier is what
  produces that store (extraction, dedup, temporal updates). That's an
  optimizer feature beyond request-shaping — see `memory_extraction` in §3.

### 1.8 Token-efficient serialization (OSS line: TOON)

- **TOON** — [toon-format/toon](https://github.com/toon-format/toon) (spec
  v1.0, MIT; multiple implementations): a token-oriented serialization for
  LLM input. Vendor benchmarks: ~**40% fewer tokens than pretty JSON** with
  equal-or-better retrieval accuracy; **~60% fewer on uniform/tabular arrays**
  (its sweet spot — CSV-like row folding with an explicit schema header and
  array lengths). Independent benchmarks agree on the savings but show
  **accuracy regressions on deeply nested / non-uniform data**, where JSON
  stays better.
- Take: our `context_compression` (JSON minify + array caps) is lossy where
  TOON is lossless. For uniform arrays — exactly our `4-json-array`,
  `29-orders-json`, `30-metrics-json` workloads — tabular re-serialization
  saves ~40–60% *before* any capping, and capping can then be less aggressive.

---

## 2. Side-by-side: our strategies vs. the field

| Anyray strategy (knob) | Closest research / OSS | Gap assessment |
|---|---|---|
| `relevance_filter` (keepChars, semanticRerank) | BM25 + rerank is standard IR; Provence/RECOMP (ICLR 24/25) go sentence-level | **Solid.** Add sentence-level pruning inside kept chunks as a second pass (new `context_pruning`, §3) |
| `context_compression` (maxArrayItems) | TOON (~40–60% lossless on tabular) | **Improve:** re-serialize uniform arrays to tabular before capping; cap becomes the fallback, not the headline |
| `code_graph` (minBodyLines) | Aider repo-map (~42k★): PageRank + binary-search to token budget | **Improve:** add reference-count ranking and a `maxTokens` fit-to-budget knob |
| `window_budget` (maxTokens) | "Complexity Trap" (2508.21433); Anthropic tool-result clearing | **Improve:** evict tool-results before user/assistant turns; leave a restorable `/v1/retrieve` placeholder (we already have the marker mechanism) |
| `prompt_compression` (minChars, dedup) | LLMLingua-2 (ACL 24, ~6.4k★) is the learned version | **Keep** as the cheap deterministic tier; LLMLingua-2 is the opt-in ML tier if ever needed |
| `tool_pruning` (keepUnnamed) | RAG-MCP / MCP-Zero (50–98% tool-token cuts) | **Improve:** relevance-ranked top-K with name-only stubs for the rest (mask, don't delete) |
| `tool_schema_compression` | OpenAI/Anthropic internally render schemas as typed signatures (TS-style), not JSON Schema | **Improve:** render pruned-survivor schemas as compact typed signatures, not just whitespace/boilerplate stripping |
| `command_digest` (maxFailures) | Same idea as CI log folding; no stronger published variant found | **Keep.** |
| `semantic_cache` | GPTCache (~8.1k★): embedding + evaluator + threshold | **Improve:** similarity matching with a conservative threshold + cross-encoder verify; scope by model/params |
| `vision_ocr` | Standard practice | **Keep.** |
| `param_tuning` (maxTokensCap) | Standard guardrail | **Keep.** |
| `cache_optimizer` (minPrefixChars) | Manus: KV-cache hit rate as #1 metric; append-only prefix discipline | **Validated.** Extend measurement: report cache-hit *rate* across a session, not just prefix stability |
| `context_quality` (diagnostic) | — | **Keep** as diagnostic. |
| *(none)* | Observation masking (2508.21433) | **Add** `observation_masking`, §3 |
| *(none)* | Anthropic compaction API; Claude Code compaction | **Add** `session_compaction`, §3 |
| *(none)* | Provence / RECOMP | **Add** `context_pruning`, §3 |
| *(none)* | Mem0 (60k★) / Letta (24k★) / Zep | **Add** `memory_extraction` (longer-term), §3 |

---

## 3. Recommendations

Ordered by (evidence strength × fit with the gateway-hook position × expected
token impact on real coding-agent traffic).

### 3.1 Add `observation_masking` — highest confidence, cheapest win

Keep the last **N** tool observations verbatim; replace older ones with a
one-line restorable placeholder (`[elided — retrievable via /v1/retrieve]`).
Evidence: arXiv:2508.21433 shows this **matches LLM summarization on SWE-agent
solve rate at far lower cost**; Anthropic ships the same primitive as
tool-result clearing. It composes with `window_budget` (mask first, trim
second) and, unlike turn-trimming, preserves the assistant's own reasoning
turns. Proposed knobs: `keepLastObservations` (default 10), `minCharsToMask`.
Benchmark: extend `agent-ops` (`24-agent-toolcalls`, `31-long-toolsession`
already have the right shape — add a masking variant and compare against
`window_budget` head-to-head).

### 3.2 Improve `context_compression` — tabular re-serialization for uniform arrays

Detect arrays of same-shaped objects and re-serialize as header + rows
(TOON-style / CSV-style) instead of only minify + cap. **Lossless ~40–60%**
on the exact workloads this suite runs (`4-json-array`, `29-orders-json`,
`30-metrics-json`), and it stacks with array capping. Guardrail from the
independent benchmarks: apply **only** to uniform, flat arrays — nested or
ragged data stays JSON (accuracy regresses there). Knob: `tabularMinRows`
(default ~20).

### 3.3 Improve `code_graph` — rank + fit-to-budget (Aider repo-map)

Add symbol-reference ranking (references-in count is a sufficient first cut;
personalized PageRank as the full version, biased by identifiers in the user's
question) and a `maxTokens` knob that binary-searches how many ranked bodies
survive. Evidence: Aider (~42k★) has run this in production for two years; it
is the accepted answer for "compact code context under a budget". Benchmark:
`7-codebase-explore` and the multi-file traces already measure this; add a
low-budget variant to show graceful degradation.

### 3.4 Improve `tool_pruning` — ranked top-K with discoverable stubs

Rank tool schemas by relevance to the conversation, send full schemas for
top-K (K≈3–5 per RAG-MCP-line results), and **name-only stubs** for the rest
so the model can still request them (mask, don't delete — keeps behavior safe
*and* the prefix stable for KV-cache). Evidence: RAG-MCP (+25pp accuracy at
−50% tokens), MCP-Zero (−98% tokens). Then point `tool_schema_compression` at
the survivors and render them as **typed signatures** rather than JSON Schema
prose. Benchmark: `11-mcp-tools` / `23-mcp-schema` cover this; add a workload
where the *needed* tool is not in top-K to prove the stub-recovery path
(qualityCheck: `tool_safety`).

### 3.5 Add `context_pruning` — sentence-level second pass for RAG

After `relevance_filter` keeps the right chunks, prune non-answering
*sentences inside* them. Provence (ICLR 2025) shows dynamic sentence pruning
with ~zero QA drop; model is open (`naver/provence-reranker-debertav3-v1`,
DeBERTa-size — the one ML component here small enough to sit on the hook, and
it doubles as the semantic reranker we already invoke for `semanticRerank`).
Benchmark: `12-rag-overfetch` and `32-vocab-mismatch-rag` extended with a
combined filter+prune config.

### 3.6 Add `session_compaction` — the summarize tier above `window_budget`

When a session exceeds the budget even after masking, summarize the oldest
span into a structured digest (decisions, open threads, file paths) and keep
recent turns verbatim — Anthropic's compaction, Claude Code's `/compact`.
Use sparingly per the Complexity-Trap result (hybrid beats always-summarize):
fire only when `observation_masking` + `window_budget` can't reach the budget.
Note: this adds an LLM call to the hot path — it must be async/amortized, and
that operational cost is why it ranks below masking despite bigger savings.
Benchmark: `8-long-session` at a budget below what trimming alone can meet
while keeping the answer facts.

### 3.7 Improve `semantic_cache` — near-duplicate matching (GPTCache design)

Embed request → vector lookup → **cross-encoder verify** → serve on
high-confidence match only; scope keys by model + params; LRU eviction.
Evidence: GPTCache (~8.1k★). The false-positive risk is real, so the verify
stage and a conservative default threshold are part of the spec, and the
`cache_hit` qualityCheck must gain near-miss cases that assert *misses*
(serving a stale answer to a different question is a FAIL, not a saving).
Benchmark: extend `9-repeat-request` with paraphrased-repeat and
similar-but-different variants.

### 3.8 Longer-term: `memory_extraction`

What produces the `memory-recall` store today is out of scope for a request
hook; Mem0 (60k★) / Letta (24k★) / Zep show extraction-based stores answering
recall questions at **<10% of full-replay tokens**. If Anyray grows a
post-response hook, fact extraction + dedup into the store is the
highest-leverage cross-session feature. Benchmark: `memory-recall` suite grows
paired write/read workloads.

### Explicitly not recommended now

- **LLMLingua-family ML compression on the hot path** — best-published
  compression ratios, but a per-request encoder pass conflicts with the
  hook's latency budget; the deterministic strategies above capture most of
  the win on this repo's traffic mix. Revisit as an opt-in tier (LLMLingua-2
  is 3–6x faster than v1 and designed for exactly this).
- **Replacing BM25 with pure embedding retrieval in `relevance_filter`** —
  the two vocab-mismatch workloads (33, 32) already show hybrid
  lexical+semantic wins; pure-semantic loses the exact-match cases (IDs,
  error codes) that dominate log workloads.

---

## Sources

| Topic | Source | Type / adoption |
|---|---|---|
| Prompt compression | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) — LLMLingua (EMNLP 23), LongLLMLingua (ACL 24), LLMLingua-2 (ACL Findings 24) | Research + OSS, ~6.4k★ |
| RAG pruning | RECOMP (ICLR 24, arXiv:2310.04408); Provence (ICLR 25, arXiv:2501.16214), model on HF | Research, models open |
| Semantic cache | [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) (NLP-OSS 23) | OSS, ~8.1k★ |
| Context engineering | Anthropic *Effective context engineering for AI agents*; Claude context-editing API (compaction, tool-result clearing); Manus *Context Engineering for AI Agents* | Industry practice |
| Observation masking | *The Complexity Trap* (arXiv:2508.21433) | Research |
| Code context | [Aider-AI/aider](https://github.com/Aider-AI/aider) repo-map (tree-sitter + PageRank + budget fit) | OSS, ~42k★ |
| Tool selection | RAG-MCP (arXiv:2505.03275); [xfey/MCP-Zero](https://github.com/xfey/MCP-Zero) (arXiv:2506.01056); semantic tool-discovery line | Research + OSS |
| Memory | [mem0ai/mem0](https://github.com/mem0ai/mem0) ~60k★; [letta-ai/letta](https://github.com/letta-ai/letta) ~24k★; Zep/Graphiti temporal KG | OSS + papers |
| Serialization | [toon-format/toon](https://github.com/toon-format/toon) spec v1.0 + independent benchmarks | OSS |

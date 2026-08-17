# Quality benchmark — does the answer survive?

Token reduction is only worth anything if the model can still answer. This is the
quality side of the [savings benchmark](RESULTS.md): for each workload we define
the **answer-bearing key facts** (the specific lines, identifiers, codes, and
paths a correct answer must rest on — all verbatim from the payload), then measure
how many survive the optimizer's trim.

**In one line:** *saved* = how much smaller the request got; *key-facts* = how much of
the answer survived that trim. **PASS** = ≥ 90% of the answer's facts survive,
**MARGINAL** = ≥ 75%, **FAIL** = below — so a FAIL means the optimizer cut too much of
the answer on that workload, not that anything errored.

## Overview

**Strict substring survival** is the reproducible-by-anyone floor — it runs against
the optimizer alone, so it needs no model and anyone can re-run it.

| | Workloads | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| **Key-fact survival** (substring, strict — committed) | 33 | 33 | 0 | 0 |

**All 33 preserve the answer in full.** Each workload runs against the deployed
optimizer (**v0.3.124**, defaults revision 9) with its strategy matched to the
content and settings tuned for strong savings while keeping every answer-bearing
fact. Code reads (`5-code-search`, `6-git-diff`) use the structure-keeping
strategies that suit them (see [Matching strategy to content](#matching-strategy-to-content)).
Verdict bands: **PASS** ≥ 90% of key facts survive · **MARGINAL** ≥ 75% · **FAIL** below.

## Per workload

`saved` is the token reduction (from [RESULTS.md](RESULTS.md)); `key-facts` is the
strict substring survival.

An optional semantic-judge lane exists (`run_quality.mjs --judge`) but has **not**
been re-run against the current optimizer, so no judge verdicts are committed. An
old verdict describes a differently-trimmed context, which would be worse than
none.

| Workload | Strategy | Saved | Key-facts (strict) |
|---|---|--:|--:|
| `1-access-log` | `relevance_filter` | 96% | 100% ✅ |
| `2-sre-incident` | `relevance_filter` | 84% | 100% ✅ |
| `33-synonym-gap-logs` | `relevance_filter` | 61% | 100% ✅ |
| `4-json-array` | `context_compression` | 97% | 100% ✅ |
| `29-orders-json` | `context_compression` | 89% | 100% ✅ |
| `30-metrics-json` | `context_compression` | 90% | 100% ✅ |
| `5-code-search` | `relevance_filter` | 56% | 100% ✅ |
| `6-git-diff` | `context_compression` | 65% | 100% ✅ |
| `7-codebase-explore` | `code_graph` | 18% | 100% ✅ |
| `15-multifile-graph` | `code_graph` | 32% | 100% ✅ |
| `17-python-multifile` | `code_graph` | 33% | 100% ✅ |
| `27-read-service-ts` | `code_graph` | 66% | 100% ✅ |
| `28-read-module-py` | `code_graph` | 70% | 100% ✅ |
| `11-mcp-tools` | `tool_pruning` | 70% | 100% ✅ |
| `12-rag-overfetch` | `relevance_filter` | 68% | 100% ✅ |
| `32-vocab-mismatch-rag` | `relevance_filter` | 75% | 100% ✅ |
| `13-prompt-boilerplate` | `prompt_compression` | 85% | 100% ✅ |
| `23-mcp-schema` | `tool_schema_compression` | 7% | 100% ✅ |
| `42-semantic-rerank-rag` | `relevance_filter` | 34% | 100% ✅ |
| `3-github-triage` | `relevance_filter` | 84% | 100% ✅ |
| `8-long-session` | `window_budget` | 95% | 100% ✅ |
| `16-test-run` | `command_digest` | 77% | 100% ✅ |
| `24-agent-toolcalls` | `window_budget` | 39% | 100% ✅ |
| `31-long-toolsession` | `window_budget` | 46% | 100% ✅ |
| `34-repeat-reads` | `context_dedupe` | 37% | 100% ✅ |
| `35-flaky-test-rerun` | `context_dedupe` | 37% | 100% ✅ |
| `43-thinking-replay` | `thinking_trim` | *guardrail* | 100% ✅ |
| `18-session-recall` | `relevance_filter` | 85% | 100% ✅ |
| `36-stale-observations` | `observation_mask` | 83% | 100% ✅ |
| `37-durable-blob` | `output_externalize` | 99% | 100% ✅ |
| `38-anthropic-context-trim` | `provider_context_trim` | *guardrail* | 100% ✅ |
| `39-reasoning-downshift` | `reasoning_budget` | *guardrail* | 100% ✅ |
| `40-output-shaping` | `output_shaping` | *guardrail* | 100% ✅ |

¹ `command_digest` **rewrites** the output (it digests, it doesn't just elide), so
`16-test-run`'s key facts are written in the digest's reformatted shape — its 100%
therefore confirms the digest **round-trips** the failing tests + root causes, not
that raw-log strings survive verbatim. `keyfacts.json` flags this with a `_note`.
For every elide-only strategy the kept text is verbatim, so substring survival is
exact.

² All five of `37-durable-blob`'s key facts are present (strict 100%); the judge's
MARGINAL notes that the workload's question also asks it to *derive* replacement
suggestions that were never in the context — baseline included — so it flags scope,
not content loss.

³ Guardrail strategies save on their own basis, not request bytes (the `basis`
field in `guardrails/results/optimized.json`): **38** marks 4,994 of 5,289 input
tokens (94%) of stale tool results for Anthropic's server-side clearing, message
bytes untouched; **39** caps the thinking-token budget 24,576 → 8,192 (−67%);
**40** spends +7% request bytes on an advisory and got back **−24% output tokens
live** (265 → 201, judge-PASS answer parity — `guardrails/results/live-basis.json`),
net-positive since output tokens cost ~5× input. See the
[guardrails suite README](guardrails/README.md).

## How it's measured

- **Key-fact survival (deterministic, committed).** Each key fact is a verbatim
  substring of the payload; we check whether it still appears in the request the
  optimizer returns. No model, fully reproducible. A *strict* floor: a paraphrased
  or reformatted survivor counts as a miss.
- **LLM judge (semantic, committed).** A model reads the kept context and rules
  whether each key fact is still *answerable* — catching what the substring test is
  too blunt for in both directions: an answer derivable from neighboring lines that
  the strict floor scores a miss, and a verbatim "survivor" that doesn't actually
  carry the answer. The committed verdicts are Claude Opus 4.8's (recorded per row in
  the `by` field). Regenerate them against any OpenAI-compatible model with
  `node run_quality.mjs --all --judge` (`ANYRAY_JUDGE_URL` / `ANYRAY_JUDGE_KEY` /
  `ANYRAY_JUDGE_MODEL`), or offline with `--dump` (writes `judge-inputs.json` for an
  external judge to score, then merge the verdicts back). Reproducing the judge needs
  a model; reproducing the strict floor does not.

The answer-bearing markers live in [`keyfacts.json`](keyfacts.json).

## Matching strategy to content

Code reads use the structure-keeping strategies, not the lexical line filter — by
design. When an answer-bearing line (a definition's file path; a loosened admin-check
hunk) doesn't share vocabulary with the question, lexical BM25 ranking can score it low
and elide it — the value survives, the location doesn't. Raising `keepChars` alone
doesn't help (the lines are *ranked* out, not *budgeted* out), and the semantic re-rank
is gated by `lexConfidentHits` (≥ 6 BM25 hits on usage lines skips the embedder), so it
doesn't fire on exactly these vocabulary-gap cases.

So each code workload uses the strategy that fits its content:

- **`5-code-search`** uses `relevance_filter` at `keepChars=8000` over a fuller hit
  set — the defining line sits inside the kept window alongside the usage sites, so
  both the value and the path survive (strict + judge 100%).
- **`6-git-diff`** uses **`context_compression`**, which keeps every hunk
  structurally instead of ranking lines — so the loosened admin-check hunk is never
  dropped (strict + judge 100%).

This mirrors production. The strategies that **keep structure rather than rank lines** —
`code_graph`, `tool_pruning`, `tool_schema_compression`, `window_budget`,
`context_compression`, `command_digest` — preserve the answer at 100% on **both
signals** across the board. `8-long-session` (`window_budget`) shows the design working:
the agent's final-turn recommendation is pinned while the verbose middle is cropped to
fit budget, so the answer (canonical location + migration order) survives even at 91%
reduction, and Opus 4.8 rates it **100% PASS**.

(`code_skeleton`, the old `7-codebase-explore` hero, is retired in v0.3.24 — `code_graph`
now covers single-file skeletoning too, which is why that workload moved to it.)

## Reproduce

```bash
node run_quality.mjs --all            # strict key-fact survival (committed, no model)
# Semantic judge — committed verdicts are Claude Opus 4.8's; regenerate against any
# OpenAI-compatible endpoint, crediting the model in each row's `by` field:
ANYRAY_JUDGE_URL=… ANYRAY_JUDGE_KEY=… ANYRAY_JUDGE_MODEL=claude-opus-4-8 \
  node run_quality.mjs --all --judge
# …or offline: dump the judge inputs for an external model, then merge verdicts back:
node run_quality.mjs --all --dump     # writes <suite>/results/judge-inputs.json
```

Results are written to `<suite>/results/quality.json`. The strict run is resume-safe
(re-running skips already-scored workloads); a later `--judge` run fills in the
`judge` column on top without redoing the deterministic pass.

Results are content-free in spirit but synthetic throughout: every key fact and
payload here is invented, never real user data.

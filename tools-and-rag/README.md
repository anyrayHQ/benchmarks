# Tools & retrieval

Bloat that rides alongside the prompt: dozens of tool schemas the model won't
call, RAG chunks fetched far past what's relevant, the same instruction block
re-pasted once per item. Prune the unused tools, drop the off-topic chunks, dedup
the boilerplate.

**Why it's common:** MCP tool-schema bloat can be **55k+ tokens** of tool
definitions riding along before the first message, RAG pipelines over-fetch
**3–5×** the chunks the answer uses, and templated batch jobs re-paste the same
instruction block once per item — all billed every call.

## Workloads

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| MCP tool bloat — 41 tool schemas ride along, 2 are needed | `tool_pruning` | `keepUnnamed=true` | 5,614 | 2,076 | **63%** |
| RAG over-retrieval — top-20 chunks stuffed, 2 hold the answer | `relevance_filter` | `keepChars=1200, roles=user` | 1,498 | 487 | **67%** |
| Vocab-mismatch RAG (20 chunks) — "what revokes their credential?" | `relevance_filter` | `keepChars=1500, roles=tool\|function\|user, semanticRerank=true, semanticWeight=0.7` | 2,216 | 643 | **71%** |
| Templated boilerplate — the same instructions re-pasted 40x | `prompt_compression` | `minChars=400` | 5,841 | 914 | **84%** |
| MCP tool schemas — 41 verbose schemas, compress the prose not the set | `tool_schema_compression` | `collapseWhitespace=true, stripBoilerplate=true` | 1,612 | 1,504 | **7%** |

## How it works

- **`tool_pruning`** drops tool schemas the request doesn't reference. The prompt
  names two Jira tools, so the other schemas are pruned; `keepUnnamed=true` keeps
  any tool the heuristic can't positively match (it never prunes first-use or
  `mcp__` tools), trading a little saving for safety.
- **`relevance_filter`** keeps the retrieved chunks that actually match the
  question and elides the over-fetched remainder (reversibly).
- **`prompt_compression`** detects a block repeated across the prompt and dedups
  it to a single copy — the 40 re-pasted instruction blocks collapse to one.
- **`tool_schema_compression`** rewrites only the free-text `description` fields of
  the tool schemas — collapsing whitespace and stripping boilerplate lead-ins —
  while leaving names, types, and required fields byte-for-byte intact. Unlike
  `tool_pruning` it keeps every tool, so it is cache-safe and keeps saving on the
  re-sent tool block of warm / subscription traffic.

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Tool schemas count
toward the size (they're part of the request the provider bills). Produced by
[`./run.sh`](run.sh); see [`results/`](results/).

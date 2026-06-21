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
| MCP tool bloat — 41 tool schemas ride along, 2 are needed | `tool_pruning` | `keepUnnamed=true` | 5,614 | 1,972 | **65%** |
| RAG over-retrieval — top-20 chunks stuffed, 2 hold the answer | `relevance_filter` | `keepChars=1200, roles=user` | 1,498 | 468 | **69%** |
| Templated boilerplate — the same instructions re-pasted 40× | `prompt_compression` | `minChars=400` | 5,841 | 914 | **84%** |

## How it works

- **`tool_pruning`** drops tool schemas the request doesn't reference. The prompt
  names two Jira tools, so the other schemas are pruned; `keepUnnamed=true` keeps
  any tool the heuristic can't positively match (it never prunes first-use or
  `mcp__` tools), trading a little saving for safety.
- **`relevance_filter`** keeps the retrieved chunks that actually match the
  question and elides the over-fetched remainder (reversibly).
- **`prompt_compression`** detects a block repeated across the prompt and dedups
  it to a single copy — the 40 re-pasted instruction blocks collapse to one.

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. Tool schemas count
toward the size (they're part of the request the provider bills). Produced by
[`./run.sh`](run.sh); see [`results/`](results/).

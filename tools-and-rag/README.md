# Tools & retrieval

**Why it's common:** MCP tool-schema bloat can be **55k+ tokens** of tool
definitions riding along before the first message, RAG pipelines over-fetch
**3–5×** the chunks the answer uses, and templated batch jobs re-paste the same
instruction block once per item — all billed every call.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| MCP tool bloat — 41 tool schemas ride along, 2 are needed | [`11-mcp-tools.json`](payloads/11-mcp-tools.json) |
| RAG over-retrieval — top-20 chunks stuffed, 2 hold the answer | [`12-rag-overfetch.json`](payloads/12-rag-overfetch.json) |
| Vocab-mismatch RAG (20 chunks) — "what revokes their credential?" | [`32-vocab-mismatch-rag.json`](payloads/32-vocab-mismatch-rag.json) |
| Templated boilerplate — the same instructions re-pasted 40x | [`13-prompt-boilerplate.json`](payloads/13-prompt-boilerplate.json) |
| MCP tool schemas — 41 verbose schemas, compress the prose not the set | [`23-mcp-schema.json`](payloads/23-mcp-schema.json) |
| Cost-cutting synonyms RAG (14 docs) — "lower the cloud bill" vs "infrastructure spend" | [`42-semantic-rerank-rag.json`](payloads/42-semantic-rerank-rag.json) |

Run just this suite: `./tools-and-rag/run.sh` (flags such as `--workload <id>` pass through).

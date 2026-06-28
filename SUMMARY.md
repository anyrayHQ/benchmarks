# Anyray optimizer — results summary

Across 22 synthetic agent/coding workloads, the Anyray optimizer cut input tokens by **72% overall** (median 72% per workload) while preserving the answer-bearing key facts in **91%** of cases (86% confirmed by an LLM judge).

## Token savings by workload type

| Workload type | Workloads | Median input-token reduction |
|---|---:|---:|
| Logs & structured data | 5 | 78% |
| Code context | 7 | 68% |
| Tools & retrieval | 4 | 65% |
| Agent operations | 5 | 72% |
| Cross-session memory recall | 1 | 85% |
| **All** | **22** | **72% overall** |

## Quality preservation

Quality is measured as **answer-bearing key-fact survival** — for each workload we define the short markers that carry the answer, then check they survive the optimizer’s trim (verbatim substring, plus an LLM judge for meaning).

- **20/22** workloads preserve their key facts (deterministic).
- **19/22** confirmed by the LLM judge.


_(5 guardrail workloads — semantic cache, screenshot OCR, runaway-output caps — use special accounting rather than whole-request token reduction and are reported separately.)_

_Synthetic data only (privacy-preserving). Numbers are reproducible: `npm run bench` then `npm run quality`, then `npm run summary`. See `VALIDATION.md` for methodology._

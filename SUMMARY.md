# Anyray optimizer — results summary

Across 24 synthetic agent/coding workloads, the Anyray optimizer cut input tokens by **76% overall** (median 65% per workload) while preserving the answer-bearing key facts in **100%** of cases (100% confirmed by an LLM judge).

## Token savings by workload type

| Workload type | Workloads | Median input-token reduction |
|---|---:|---:|
| Logs & structured data | 6 | 69% |
| Code context | 7 | 44% |
| Tools & retrieval | 5 | 67% |
| Agent operations | 5 | 77% |
| Cross-session memory recall | 1 | 85% |
| **All** | **24** | **76% overall** |

## Quality preservation

Quality is measured as **answer-bearing key-fact survival** — for each workload we define the short markers that carry the answer, then check they survive the optimizer’s trim (verbatim substring, plus an LLM judge for meaning).

- **24/24** workloads preserve their key facts (deterministic).
- **24/24** confirmed by the LLM judge.


_(5 guardrail workloads — semantic cache, screenshot OCR, runaway-output caps — use special accounting rather than whole-request token reduction and are reported separately.)_

_Synthetic data only (privacy-preserving). Numbers are reproducible: `npm run bench:all` then `npm run quality:all`, then `npm run summary`. See `VALIDATION.md` for methodology._

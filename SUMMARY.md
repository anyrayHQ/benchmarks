# Anyray optimizer — results summary

Across 29 synthetic agent/coding workloads, the Anyray optimizer cut input tokens by **87% overall** (median 70% per workload) while preserving the answer-bearing key facts in **100%** of cases (0% confirmed by an LLM judge).

## Token savings by workload type

| Workload type | Workloads | Median input-token reduction |
|---|---:|---:|
| Logs & structured data | 6 | 90% |
| Code context | 7 | 56% |
| Tools & retrieval | 6 | 69% |
| Agent operations | 7 | 46% |
| Cross-session memory recall | 3 | 85% |
| **All** | **29** | **87% overall** |

## Quality preservation

Quality is measured as **answer-bearing key-fact survival** — for each workload we define the short markers that carry the answer, then check they survive the optimizer’s trim (verbatim substring, plus an LLM judge for meaning).

- **33/33** workloads preserve their key facts (deterministic).
- **0/0** confirmed by the LLM judge.


_(11 guardrail workloads — semantic cache, screenshot OCR, runaway-output caps — use special accounting rather than whole-request token reduction and are reported separately.)_

_Synthetic data only (privacy-preserving). Numbers are reproducible: `npm run bench:all` then `npm run quality:all`, then `npm run summary`. See `VALIDATION.md` for methodology._

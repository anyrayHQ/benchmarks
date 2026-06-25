# Agent operations

The long-running agent's everyday waste: a triage dump it has to scan, a session
that grows past the context window, a test run read back verbatim. Filter to the
relevant rows, fit the conversation to a token budget, and digest the command
output down to its failures.

**Why it's common:** agentic context re-accumulation — agents resending the whole
history every turn — is the **#1** waste pattern in the cost research; agents use
**4–15×** the tokens of a chat, and a 50-turn coding session bills around **25:1**
input:output. The session only grows, so the bill compounds.

## Workloads

| Workload | Strategy | Knob | Before (tok) | After (tok) | Saved |
|---|---|---|--:|--:|--:|
| GitHub triage — "which open issues are P0 auth bugs?" | `relevance_filter` | `keepChars=2000, roles=user` | 5,583 | 902 | **84%** |
| Long agent session — keep a 60-message session inside the window | `window_budget` | `maxTokens=24000` | 81,915 | 22,886 | **72%** |
| Test-suite output — "which tests failed and why?" | `command_digest` | `maxFailures=10, contextLines=12, roles=user` | 1,515 | 351 | **77%** |
| Agentic tool-call session — fit a multi-step investigation in budget | `window_budget` | `maxTokens=700` | 781 | 587 | **25%** |
| Long tool-call session — fit a 10-file investigation in budget | `window_budget` | `maxTokens=2500` | 3,176 | 2,324 | **27%** |

## How it works

- **`relevance_filter`** keeps the issues matching the triage query (the P0 auth
  bugs) and elides the rest.
- **`window_budget`** caps the total conversation at `maxTokens` by cropping the
  oldest middle turns while pinning the system prompt and the most recent turns —
  a reversible fit-to-window, so the cropped turns are retrievable rather than
  lost. Two shapes are covered: a 60-turn prose session, and an **agentic
  tool-call session** (assistant `tool_calls` + linked `tool` results) where the
  answer sits in the pinned final turn and the early investigation is cropped.
- **`command_digest`** recognizes a test-runner's output shape (pytest/jest/…)
  from the text alone and keeps the failure blocks (signature + traceback, capped
  at `maxFailures`) plus the count summary, dropping the passing lines and the
  session banner. It fires the same for an autonomous agent that just ran the
  suite — no question needed. Here it keeps 3 failing blocks out of an 80-test run
  (6,060 → 1,402 chars).

## Measurement

Whole-request size before vs after, tokens at `chars / 4`. `window_budget`
reports against its own token budget; the small difference from the `chars / 4`
headline is the budgeter's internal estimate. Produced by [`./run.sh`](run.sh);
see [`results/`](results/).

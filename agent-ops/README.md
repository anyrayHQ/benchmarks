# Agent operations

**Why it's common:** agentic context re-accumulation — agents resending the whole
history every turn — is the **#1** waste pattern in the cost research; agents use
**4–15×** the tokens of a chat, and a 50-turn coding session bills around **25:1**
input:output. The session only grows, so the bill compounds.

Each workload is sent twice — straight to the provider and through the Anyray gateway — and compared on billed tokens, cost and answer quality. This is the replay suite, a secondary check; see the [README](../README.md#the-replay-suite-secondary).

| Workload | Payload |
|---|---|
| GitHub triage — "which open issues are P0 auth bugs?" | [`3-github-triage.json`](payloads/3-github-triage.json) |
| Long agent session — keep a 60-message session inside the window | [`8-long-session.json`](payloads/8-long-session.json) |
| Test-suite output — "which tests failed and why?" | [`16-test-run.json`](payloads/16-test-run.json) |
| Agentic tool-call session — fit a multi-step investigation in budget | [`24-agent-toolcalls.json`](payloads/24-agent-toolcalls.json) |
| Long tool-call session — fit a 10-file investigation in budget | [`31-long-toolsession.json`](payloads/31-long-toolsession.json) |
| Repeated reads — the agent re-reads a file and re-runs git status | [`34-repeat-reads.json`](payloads/34-repeat-reads.json) |
| Flaky-suite re-run — near-duplicate pytest output collapses to a delta | [`35-flaky-test-rerun.json`](payloads/35-flaky-test-rerun.json) |
| Replayed reasoning — a resumed agent turn re-sends six signed thinking blocks *(not run: replays thinking blocks with synthetic signatures, which a real provider rejects (400 Invalid signature))* | [`43-thinking-replay.json`](payloads/43-thinking-replay.json) |

Run just this suite: `./agent-ops/run.sh` (flags such as `--workload <id>` pass through).

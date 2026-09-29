# Anyray Benchmarks

[![ci](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml/badge.svg)](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-3c873a)](package.json)

Does putting Anyray on a real agent's request path make the session cheaper, without
making the result worse? This repo answers that the way a customer's bill would, against
Anyray's Rule 0: **a session must never cost more because of us.**

## The agent benchmark

Each **round** runs the same task on a real open-source repo in two arms **at the same
time**, each a full Claude Code session on its own fresh checkout:

| Arm | How it reaches the model |
|---|---|
| **A · direct** | Claude Code straight to Anthropic. No gateway, hooks or MCP. |
| **B · through Anyray** | The same Claude Code session via an Anyray gateway, sending only the client key. When this machine's `anyray-connect` is enrolled on that gateway, its hooks and MCP server are attached too. |

Nothing is scripted. The model picks every step, with all of Claude Code's default
tools, subagents included. Both arms get the same model, task, turn cap and upstream
credential, and neither loads your own Claude Code settings.

Per round it records:

- **Cost:** Claude Code's billed total, with cache reads and writes, main agent and subagents.
- **Turns, model requests, subagents** and their share of cost.
- **Solved or not.** A bug-fix task must pass its test command in the session's checkout afterwards. A question must contain every key fact. An audit's `path:line` citations must resolve to real lines.
- **Every model request:** cache read / write / uncached input, each tool call and its output.
- **The gateway's own record,** when an admin key is set: which strategies were on for the run, and what each one did on each request (saved, stood down, held by the guard).

Across rounds it gives the **Rule 0 verdict** (`lib/stats.mjs`):
- **Win rate:** Anyray must be cheaper in clearly more rounds than the 53% noise floor (the bar is 63%).
- **Q3 ratio below 1:** Anyray must still be cheaper at the third quartile, so no more than a quarter of rounds may cost more.
- **Quality parity:** Anyray must solve as many rounds as direct.

A **control** comparison (`--compare control`) runs direct against direct to show how
far two identical setups drift apart. A result inside that band proves nothing.

### Scenarios

| Scenario | Repo | Task | Graded by |
|---|---|---|---|
| `cobra-flag-groups` | spf13/cobra (pinned) | Fix a planted bug in mutually exclusive flags | `go test ./...` passes |
| `cobra-dispatch` | spf13/cobra (pinned) | Explain how a command line is dispatched | Key facts in the answer |
| `gin-doc-audit` | gin-gonic/gin (pinned) | Audit 2,700 lines of docs against 24k lines of Go | Path:line citations resolve |
| `gin-test-triage` | gin-gonic/gin (pinned) | Fix two hidden regressions from ~80 KB of verbose test output | `go test ./...` passes |
| `gin-long-session` | gin-gonic/gin (pinned) | Six user turns in one session: triage, fix, re-test, two code walkthroughs, recap | `go test ./...` passes |

Each is `scenarios/<name>/scenario.yaml` (plus a patch for bug-fix tasks). Every session
is capped at `timeoutMin` (6 minutes by default) and `maxTurns`. A scenario with
`followups:` runs as one multi-turn session: each follow-up is sent as a new user turn
when the previous answer is done. `hidePatch: true` re-imports the patched checkout as a
single commit, so the planted bug can't be found with `git diff` or `git log`.

### Running it

Requirements: Node.js 20+, the `claude` CLI signed in to a Claude subscription (the
upstream credential for both arms), `git`, and Go for the cobra/gin checks.

```bash
cp .env.example .env     # ANYRAY_GATEWAY_URL, ANYRAY_CLIENT_KEY, ANYRAY_ADMIN_KEY

npm run agent -- --scenario cobra-flag-groups                       # 1 round, ~1 min
npm run agent -- --scenario cobra-flag-groups --rounds 6 --compare control
npm run agent -- --scenario cobra-flag-groups --rounds 6
npm run agent:report     # → results/agent/report.html
```

Rounds accumulate in `results/agent/<scenario>--<compare>.json`, so re-running adds
rounds. `--label <name>` keeps a run in its own file (e.g. a single-strategy run). `results/` is local only, because transcripts hold tool output. Share the
report instead.

### Turning strategies on for benchmark traffic only

```bash
npm run bench-rule -- show           # what the gateway has on and off
npm run bench-rule -- enable [kind…] # default: every strategy that is off
npm run bench-rule -- only <kind…>   # just these on, every other strategy off
                                     # either takes --params '{"<kind>":{…}}'
npm run bench-rule -- per-experiment <kind…>  # one rule per kind, selected per session
npm run bench-rule -- remove
```

`per-experiment` adds one rule per strategy. A rule matches `tool == "anyray-bench"` and
`experiment == <kind>`, turns that strategy on and every other one off. Pick the strategy
for a run with `npm run agent -- --scenario <name> --strategy <kind>`: the Anyray arm
sends `experiment=<kind>` in `x-anyray-metadata`, and each round records whether any
other strategy acted (`isolation.ok`). `remove` deletes every rule this tool added.

This adds one override rule to the gateway's optimizer config. The rule matches
`metadata.tool == "anyray-bench"`, which only this harness sends, so other traffic on
the gateway keeps its config. The config as it was before the change is saved to
`results/optimizer-config.before.json`. Gateways listed in `config.yaml`
`run.blocked_gateways` are refused by both the runner and this tool.

## The replay suite (secondary)

`run.mjs` sends 38 fixed payloads (`<suite>/payloads/*.json`) once directly and once
through the gateway, and compares the billed tokens, cost and a judge's view of the two
answers. It is a quick way to check that a gateway change does something on a known
request shape. It is **not** evidence of savings:
- **Payload design:** each payload was built around a pattern the optimizer targets.
- **No caching:** nothing is ever served from cache, so every trimmed token counts at full price.
- **Single requests:** there are no turns, subagents or cache writes to pay for.

```bash
npm run replay -- --suite code-context --workload 27-read-service-ts
node show.mjs code-context/27-read-service-ts    # one workload, printed in full
npm run replay:report                              # → RESULTS.md (local)
```

## On your own traffic

The scenarios here are ours, not yours. [`anyrayHQ/simulator`](https://github.com/anyrayHQ/simulator)
points at your own gateway with a client key, sends each of your own captured prompts
twice (once with `x-anyray-optimize: off`, once the ordinary way) and reports the
input-token delta from your provider's `usage` field, plus whether the facts you marked
as required survive. Its results stay with you and are never committed anywhere.

## Layout

```
run_agent.mjs         paired agent rounds → results/agent/*.json
report_agent.mjs      → results/agent/report.html
scenarios/            one directory per task: scenario.yaml (+ patch)
tools/bench-rule.mjs  strategies on/off for benchmark traffic only
lib/agentRun.mjs      checkout, headless Claude Code per arm, transcript parsing
lib/stats.mjs         Rule 0 verdict
lib/strategies.mjs    strategies on vs what each did, from gateway traces
lib/traces.mjs        gateway admin API: optimizer config, per-request traces
lib/cost.mjs          price usage, incl. cache reads and 5-minute/1-hour writes
config.yaml           model, pricing, blocked gateways, replay workload list
run.mjs · report.mjs · show.mjs · lib/client.mjs · lib/judge.mjs · lib/toAnthropic.mjs
                      the replay suite
```

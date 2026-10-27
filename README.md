# Anyray Benchmarks

[![ci](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml/badge.svg)](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-3c873a)](package.json)

Does putting Anyray on a real agent's request path make the session cheaper, without
making the result worse? Test it on the work you were going to test anyway: Claude Code
runs your task direct and through your gateway, pair after pair, and judges the pairs
against Anyray's Rule 0: **a session must never cost more because of us.**

## Contents

- [Test it on your own work](#test-it-on-your-own-work)
  - [Before you start](#before-you-start)
  - [1. Install the plugin](#1-install-the-plugin)
  - [2. Tell Claude your test](#2-tell-claude-your-test)
  - [3. Review the plan](#3-review-the-plan)
  - [4. Freeze it](#4-freeze-it)
  - [5. Say Start](#5-say-start)
  - [6. Noise first, then paired runs](#6-noise-first-then-paired-runs)
  - [7. Read the verdict](#7-read-the-verdict)
  - [8. Publish, if you want to](#8-publish-if-you-want-to)
  - [9. Rerun it on every release](#9-rerun-it-on-every-release)
- [Results](#results)
- [Kit commands](#kit-commands)
- [Our bench](#our-bench)
- [On your own traffic](#on-your-own-traffic)
- [Docs](#docs)
- [Layout](#layout)

## Test it on your own work

Bring the test you planned to run before trusting us with your traffic. The
`anyray-test` skill records it, shows what your budget can prove, and runs it in Claude
Code. Nothing that spends money starts until you say **Start**.

`Define → Plan → Freeze → Start → Noise rounds → Paired runs → Verdict → Report → Publish → Every release`

### Before you start

- Claude Code, signed in, and Anyray Connect installed.
- Node.js 22.13+, npm and git, plus whatever your test's check command needs.

That is all. The skill gets your test key from Connect and checks this machine before it
plans, so there is no key to copy and no setup command to run first. If a check fails, it
names the failed code and its fix.

To run the checks by hand, see [Doctor](docs/kit-internals.md#doctor). An Anyray-hosted
multi-tenant (fleet) gateway cannot mint the self-serve test key; see
[Multi-tenant gateways](docs/kit-internals.md#multi-tenant-gateways).

### 1. Install the plugin

In Claude Code:

```text
/plugin marketplace add anyrayHQ/benchmarks
/plugin install anyray-test@anyray-benchmarks
```

On first use the skill checks out this kit at its pinned release.

### 2. Tell Claude your test

From the root of your repository, ask Claude to measure Anyray on your test and include
the test itself:

```text
Measure Anyray on this test: the lint step is red. Run go vet ./... and fix every finding without changing behavior.
```

Claude saves your words unchanged as `source: client` in
`anyray-test/client-1/scenario.yaml`, pins the commit and how to grade the result, and
may propose two or three scenarios of its own as `source: proposed`. Your test is never
reworded or dropped. Scenario files stay on your machine.

### 3. Review the plan

Claude asks for your budget, then shows the plan. For example, with a $30 budget:

```text
client-1: prediction: none; pairs planned: after noise
Pairs: set after the noise rounds measure your session cost
Noise alone is 12 sessions (6 rounds of two direct sessions): the budget must cover them before any pair runs.
Spend ceiling: $30.00
```

The spend ceiling is the most the test can spend, noise rounds included. The noise rounds
measure what one session costs, so the pair count comes after them. A predicted
range appears once our public results cover your task's shape with at least eight rounds;
until then the plan says `prediction: none`.

### 4. Freeze it

Approve the plan and Claude freezes it: one plan hash over every scenario file, the pins
(model, provider, Claude Code version, gateway) and the predictions. Any later change is
a new plan, so neither side can adjust the test after seeing a result.

### 5. Say Start

Claude shows the ceiling again and waits. Only an explicit **Start** for this frozen plan
begins paid work. "Go ahead", silence, or approving the freeze does not count.

### 6. Noise first, then paired runs

First Claude runs your task direct twice per round, six rounds, to measure how much its
cost moves on its own. Then each paired round runs it once direct and once through your
gateway, on your tenant's defaults. A round the gateway draws into its holdout is redrawn
or excluded. A losing pair is never retried.
When the noise rounds finish, Claude reports the measured spread against the plan's
assumption, what the planned pairs can now detect, and how long they will take at the
pace your own rounds ran.

### 7. Read the verdict

For example (synthetic numbers):

```text
client-1 (client, unknown): prediction: none; n 10; median 0.814; CI 0.667-0.920; pass; Rule 0 PASS; Anyray passed 10 of 10, direct 10 of 10; cheaper in 80% of pairs; Q3 0.918; worst pair 1.045 (4.5% more); vs prediction: n/a
Pooled Rule 0: PASS
Cost per session: direct $1.30, Anyray $0.96 (26% lower)
```

How to read it:

- **`median`, `CI`, `pass`:** the paired cost verdict. `pass` needs at least 8 pairs and a
  95% interval that stays below 1.
- **`Rule 0 PASS`:** Anyray wins clearly more pairs than noise alone would, and the third
  quartile (`Q3`) still saves. It judges the tail, not the average, so the line shows `Q3`
  and the worst pair beside the median. See [Reading the verdict](docs/bench.md#reading-the-verdict).
- **`Anyray passed 10 of 10, direct 10 of 10`:** your own check, run on both arms. A
  cheaper run that fails it is never a win.
- **`Kinds:`** (when shown): how many kinds the test evaluated were still in shadow on
  your tenant. Your live traffic gets them only after they are promoted.
- **`Next:`** (when the verdict cannot decide yet): for example
  `Next: Run 6 more pairs (about $12.00) to reach the minimum of 8.`, priced at your own
  pair cost. Running them is a new paid run with its own Start.
- **`Note:`** (when the interval includes 1): there is no clear difference from direct.
  Rule 0 judges the tail, so it can read FAIL on a tie; the Rule 0 word is never softened.

Claude copies the verdict word for word and writes `anyray-test/report.html`: an offline
page with no content from your task. It shows the headline, every scenario's tail, savings
by session length and every pair with its checks. Paste a plan, verdict or report back to
Claude later to pick up where you left off.

### 8. Publish, if you want to

Publishing sends only hashes, counts and statistics to your gateway: no task,
repository, transcript or tool output. The Measurement card in your console then shows
the result, for example:

```text
Your test (plan 2d13843, 20 pairs): 0.75x, Cost check: Passed; Anyray passed 20 of 20, direct 20 of 20.
```

### 9. Rerun it on every release

Copy [the regression workflow](kit/workflows/anyray-regression.yml) into your private
scenarios repository as `.github/workflows/anyray-regression.yml`, and commit the
scenarios and `plan.lock.json` after measuring noise. Set `ANYRAY_GATEWAY_URL`,
`ANYRAY_ADMIN_KEY`, `ANYRAY_BENCH_CLIENT_KEY` and `ANYRAY_UPSTREAM_TOKEN`. A daily
`release-check` reruns the same test only when your gateway moved to a new release. The
admin-key scopes, runner options and public [twins/](twins/) are in
[docs/kit-internals.md](docs/kit-internals.md#rerun-on-every-release).

## Results

Latest run, 2026-10-15: 16 scenarios across three kinds of agent client on Claude
Sonnet 5, one paired round each. Over 15 counted pairs the direct sessions cost
**$12.47** and the same sessions through Anyray **$5.65 (0.45×)**; Anyray was cheaper in
13 of them. The full table, where the difference comes from, and earlier runs are in
[docs/results.md](docs/results.md).

## Kit commands

The skill runs these for you. To drive the kit yourself, run them from this checkout, in
this order. Every command takes `--json`, and all but `doctor` take `--scenarios-dir <dir>`. What each one
checks, records and refuses is in [docs/kit-internals.md](docs/kit-internals.md).

| Command | What it does |
|---|---|
| `npm run -s doctor` | Checks this machine and the test key |
| `npm run -s plan -- --budget-usd N --gateway <url>` | Shows what the budget can prove. No model calls, no files. |
| `npm run -s freeze -- --model … --provider … --client … --client-version … --gateway <url>` | Locks the plan hash over scenarios, pins and predictions |
| `npm run -s verify` | Checks the files still match the frozen plan |
| `npm run -s noise -- --claude-bin <abs> --rounds 6 --budget-usd N` | Direct-vs-direct rounds that measure your noise floor |
| `npm run -s run -- --claude-bin <abs> --budget-usd N --redraw-holdout 2` | Paired rounds, direct vs Anyray, inside the budget |
| `npm run -s verdict` | Rule 0, the paired cost verdict and the tail check |
| `npm run -s report -- --redact` | Local report and `report.html`, with no task content |
| `npm run -s publish-result` | Sends the redacted body to your gateway |
| `npm run -s release-check` | Says whether the gateway version changed since the last published result |

- Pass the same `--budget-usd` to `noise` and `run`. The guard counts every recorded
  session, noise and failed rounds included, and stops before the budget is passed.
- One failed round lets a run continue; two in a row stop it (`run_failed`).
- Records stay in `<scenarios-dir>/.kit-results/<planHash>/`: hashes, counts, costs and
  outcomes only, never tasks, transcripts or tool output.

## Our bench

The results come from our own paired bench on public scenarios: the same task run by the
same agent straight to the provider and through an Anyray gateway, pair after pair, with
Rule 0 and a paired cost verdict over the pairs. It needs a gateway you control. Start at
[docs/bench.md](docs/bench.md); other clients and providers are in
[docs/lanes.md](docs/lanes.md).

## On your own traffic

The scenarios here are ours, not yours. [`anyrayHQ/simulator`](https://github.com/anyrayHQ/simulator)
sends each of your own captured prompts to your gateway twice (once with
`x-anyray-optimize: off`) and reports the input-token delta and whether the facts you
marked as required survive. Its results stay with you.

## Docs

| Doc | What it holds |
|---|---|
| [docs/results.md](docs/results.md) | The latest run in full, and earlier runs |
| [docs/bench.md](docs/bench.md) | Running our bench: setup, rounds, verdict, comparison modes, scenarios, run options, replay suite |
| [docs/lanes.md](docs/lanes.md) | The bench on an Anthropic API key, AWS Bedrock, per-token agents, Codex and an Agent SDK app |
| [docs/kit-internals.md](docs/kit-internals.md) | What each kit command checks, records and refuses |
| [docs/harness-internals.md](docs/harness-internals.md) | What each harness check does and records |

## Layout

```
run_agent.mjs         paired agent rounds → results/agent/*.json
run_sdk_app.mjs       Agent SDK app lanes (sdk-app-scanner, sdk-app-code-scan) → results/agent/*.json
tools/compare-sdk-app.mjs  per-pair ratios for an Agent SDK app result file
tools/probe-sdk-code-scan.mjs  offline check of arm D's Connect MCP mount
report_agent.mjs      → results/agent/report.html
scenarios/            one directory per task: scenario.yaml (+ patch)
tools/bench-rule.mjs  strategies on/off for benchmark traffic only; params for one experiment tag
tools/cold-turns.mjs  a pause-scenario round, read back per cold turn
lib/agentRun.mjs      checkout, headless Claude Code per arm, transcript parsing
lib/stats.mjs         Rule 0 verdict
lib/benchVerdict.mjs  paired cost confidence interval and verdict
tools/bench-verdict.mjs  recalculate verdict from result files
lib/strategies.mjs    strategies on vs what each did, from gateway traces
lib/traces.mjs        gateway admin API: optimizer config, per-request traces
lib/cost.mjs          price usage, incl. cache reads and 5-minute/1-hour writes
config.yaml           model, pricing, blocked gateways, replay workload list
run.mjs · report.mjs · show.mjs · lib/client.mjs · lib/judge.mjs · lib/toAnthropic.mjs
                      the replay suite
docs/results.md            the latest run in full, and earlier runs
docs/bench.md              running our bench: setup, rounds, verdict, modes, scenarios, run options, replay
docs/lanes.md              the bench on an API key, Bedrock, per-token agents, Codex, an Agent SDK app
docs/kit-internals.md      what each kit command checks, records and refuses
docs/harness-internals.md  what each harness check does and records
```

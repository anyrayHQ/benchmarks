# Anyray Benchmarks

[![ci](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml/badge.svg)](https://github.com/anyrayHQ/benchmarks/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-3c873a)](package.json)

Does putting Anyray on a real agent's request path make the session cheaper, without
making the result worse? Test it on the work you were going to test anyway: Claude Code
runs your task direct and through your gateway, pair after pair, and judges the pairs
against Anyray's Rule 0: **a session must never cost more because of us.**

**Contents:** [Test it on your own work](#test-it-on-your-own-work) ·
[Latest results](#latest-results-2026-10-15) · [Kit commands](#kit-commands) ·
[Running our bench](#running-our-bench) · [Gateway setup](#gateway-setup) ·
[How a round works](#how-a-round-works) ·
[Reading the verdict](#reading-the-verdict) · [Comparison modes](#comparison-modes) ·
[Scenarios](#scenarios) · [Other lanes](#other-lanes) · [Run options](#run-options) ·
[Replay suite](#the-replay-suite-secondary) ·
[On your own traffic](#on-your-own-traffic) · [Layout](#layout)

More detail: [docs/kit-internals.md](docs/kit-internals.md) (what each kit command checks
and records), [docs/harness-internals.md](docs/harness-internals.md) (what each harness
check does) and [docs/results-history.md](docs/results-history.md) (earlier runs).

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
  and the worst pair beside the median. See [Reading the verdict](#reading-the-verdict).
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

Commit the frozen plan to a private repository and add
[the regression workflow](kit/workflows/anyray-regression.yml). It reruns the same test
whenever your gateway moves to a new release. Setup is under
[Rerun on every release](#rerun-on-every-release).

### Multi-tenant gateways

A gateway in Anyray-hosted multi-tenant (fleet) mode cannot mint the self-serve test key.
On such a gateway, set your normal key as `ANYRAY_BENCH_CLIENT_KEY` and a tenant-bound
admin key as `ANYRAY_ADMIN_KEY`, and pin the kinds to evaluate when you freeze:

```bash
npm run freeze -- --scenarios-dir ./anyray-test --kinds auto ...
```

- `auto` reads the kinds that are on for your tenant and pins them in the plan hash, so
  the test measures what you would get. They go to the Anyray arm only, as
  `x-anyray-optimization-kinds`.
- A tenant with no kind on is refused (`plan_kinds_empty`).
- `--kinds code_graph,observation_mask` names kinds yourself; the test then measures that
  list, not your tenant's.
- Without `--kinds` nothing changes.

### Checking this machine yourself

The skill runs these for you. Run them by hand to debug a failure.

```bash
anyray-connect test-key --json
npm run -s doctor -- --json
```

- Connect saves a key that lasts seven days in `~/.anyray/test-kit.env` (mode 0600).
  Rerun the test-key command when it expires.
- `ANYRAY_GATEWAY_URL` and `ANYRAY_BENCH_CLIENT_KEY` override the file's gateway and key.
  Keep keys out of chat and scenario files.
- Doctor checks Node, git, a clean kit checkout, Claude Code, Connect, the test key,
  gateway context, a 1-token probe, the upstream credential and header settings. It never
  prints a key.
- Exit 0 means ready; exit 2 means fix the named check and retry. A probe over ten seconds
  is a `gateway_slow` warning.

## Latest results (2026-10-15)

16 scenarios across three kinds of agent client, each a paired run: the same agent and
task straight to Amazon Bedrock, and through a development build of the Anyray gateway
with its nine default strategies, on Claude Sonnet 5 (Claude Code 2.1.296 on both arms).
One round per scenario, with a re-run when a pair was not usable. A round counts only
when both arms solved the task and neither wrote outside its checkout.

Over 15 counted pairs the direct sessions cost **$12.47** and the same sessions through
Anyray **$5.65 (0.45×)**. Anyray was cheaper in 13 of them; the median scenario ran 0.52×.

| Scenario | Client | Direct | Anyray | Ratio |
|---|---|---|---|---|
| `cobra-flag-groups`, 200-tool MCP seat | Claude Code | $0.187 | $0.039 | 0.21× |
| `pyrepo-pillar-docs` | Claude Code | $2.192 | $0.532 | 0.24× |
| `cobra-dispatch`, 200-tool MCP seat | Claude Code | $0.300 | $0.076 | 0.25× |
| `sdk-docs` | SDK tool loop | $1.546 | $0.418 | 0.27× |
| `framework-docs` | Agent-framework graph agent | $1.244 | $0.436 | 0.35× |
| `pyrepo-docs` | Claude Code | $2.235 | $0.789 | 0.35× |
| `gin-test-triage` | Claude Code | $0.418 | $0.150 | 0.36× |
| `pyrepo-state-docs` | Claude Code | $1.647 | $0.853 | 0.52× |
| `gin-long-session` | Claude Code | $0.874 | $0.553 | 0.63× |
| `cobra-pause` | Claude Code | $0.278 | $0.210 | 0.76× |
| `cobra-dispatch` | Claude Code | $0.092 | $0.071 | 0.78× |
| `pyrepo-loader` | Claude Code | $0.224 | $0.180 | 0.80× |
| `cobra-flag-groups` | Claude Code | $0.050 | $0.047 | 0.96× |
| `gin-doc-audit` | Claude Code | $1.092 | $1.147 | 1.05× |
| `cobra-web-flags` | Claude Code | $0.091 | $0.146 | 1.60× |
| `pyrepo-long-session` | Claude Code | not counted | | |

The previous run (2026-10-11: 18 scenarios, three rounds each, 52 counted rounds) came in
at 0.48×. One round per scenario is a spot check: a single scenario's ratio moves by 0.2
or more between runs on the agent's path alone (`pyrepo-docs` 0.55× then, 0.35× now;
`cobra-web-flags` 1.01× then, 1.60× now).

**Where the difference comes from**

- **Clients that send no cache markers** (`sdk-docs`, `framework-docs`): the gateway
  adds cache breakpoints, so most of each request's input becomes a cache read.
- **A seat with many MCP tools:** tool deferral keeps the tool schemas out of every
  request (about 135k tokens on the 200-tool seat, about 7k on a plain seat).
- **Doc and code-trace tasks** (`pyrepo-*-docs`): the Anyray arm's main agent reads the
  code itself with ranged batch reads, in 33 to 39 requests. The direct arms made 97 to
  130, most of them in the 3 to 5 subagents they fanned the trace out to.
- **Long test output** (`gin-test-triage`, `gin-long-session`): failures are grepped
  instead of read whole, and long command output is folded.

**Where it is close or lost**

- **Short tasks** of 4 to 8 requests (`cobra-flag-groups`, `cobra-dispatch`,
  `pyrepo-loader`): the saving is a few percent, smaller than the noise of one round.
- `gin-doc-audit` (1.05×): the counted direct arm skipped subagents and cost $1.09,
  against its $1.82 median in the 2026-10-11 run.
- `cobra-web-flags` (1.60×): tool search ran an extra model step to load the deferred
  WebFetch tool, about 9k uncached input tokens. Only one of 82 earlier Anyray sessions
  of this scenario paid more than 1k uncached input.

**Notes**

- `repeat_factor` is new in the default set since 2026-10-11. It replaces a long block
  repeated across tool results with a pointer to its first copy. An on/off pair found it
  lossless and under 1% of session cost here.
- `pyrepo-long-session` has no counted pair: in both rounds the direct arm wrote a scratch
  file to `/tmp`, outside its checkout, which the harness excludes on purpose.
- Both arms solved every round. `cobra-3pause` and `cobra-walkaway` were not in this run.
- The [paired verdict](#reading-the-verdict) needs at least 8 valid rounds per scenario;
  this run is a one-round check against the last multi-round one.

Earlier runs, such as the Agent SDK app arm comparison, are in
[docs/results-history.md](docs/results-history.md).

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

### Rerun on every release

Copy [kit/workflows/anyray-regression.yml](kit/workflows/anyray-regression.yml) into your
private scenarios repository as `.github/workflows/anyray-regression.yml`, and commit the
scenarios and `plan.lock.json` after measuring noise. Set `ANYRAY_GATEWAY_URL`,
`ANYRAY_ADMIN_KEY`, `ANYRAY_BENCH_CLIENT_KEY` and `ANYRAY_UPSTREAM_TOKEN`. A daily
`release-check` starts paid rounds only when the gateway version changed. The admin-key
scopes, runner options and public [twins/](twins/) are in
[docs/kit-internals.md](docs/kit-internals.md#rerun-on-every-release).

---

The rest of this README is for running our own bench on public scenarios.

## Running our bench

Our own paired bench on public scenarios, the one behind [Latest results](#latest-results-2026-10-15).

Requirements: Node.js 22.13+, the `claude` CLI signed in to a Claude subscription (the
upstream credential for both arms), `git`, and Go for the cobra and gin checks.

```bash
cp .env.example .env     # set ANYRAY_GATEWAY_URL; keys are optional overrides

npm run agent -- --scenario cobra-flag-groups --kinds observation_mask,code_graph   # 1 round, ~1 min
npm run agent -- --scenario cobra-flag-groups --rounds 6 --compare control
npm run agent -- --scenario cobra-flag-groups --rounds 6 --kinds observation_mask,code_graph
npm run agent:report     # → results/agent/report.html
```

- Rounds accumulate in `results/agent/<scenario>--<compare>.json`, so a re-run adds
  rounds. `--label <name>` keeps a run in its own file.
- `results/` is local only, because transcripts hold tool output. Share the report instead.
- `--parallel N` runs up to N rounds at once (default 2, max 4). Each round is two
  sessions on the one subscription, hence the low cap. Each round is saved as it finishes,
  so an interrupted run keeps them.
- `npm test` uses stubs and makes no model requests.

## Gateway setup

### Use a dedicated tenant

> [!IMPORTANT]
> The gateway keeps regret-guard verdicts, cooloffs and holdouts per tenant, and the
> tenant comes from the client key. Set `ANYRAY_BENCH_CLIENT_KEY` to a key whose tenant
> only benchmarks use, and `ANYRAY_BENCH_TENANT` to its id. Without it the run warns and
> uses the shared `default` tenant. A separate tenant needs a multi-tenant gateway
> (`ANYRAY_MULTI_TENANT=true`).

### Turn strategies on for benchmark traffic only

```bash
npm run bench-rule -- show           # what is on and off, and what the regret guard suppresses now
npm run bench-rule -- enable [kind…] # default: every strategy that is off
npm run bench-rule -- only <kind…>   # just these on, every other strategy off
                                     # either takes --params '{"<kind>":{…}}'
npm run bench-rule -- per-experiment <kind…>  # one rule per kind, picked with --strategy <kind>
npm run bench-rule -- remove                  # removes what enable, only and per-experiment added
npm run bench-rule -- params <experiment> --params '{"<kind>":{…}}'  # params for one experiment tag
npm run bench-rule -- remove-params <experiment>                    # removes exactly that rule
```

- Every rule matches `metadata.tool == "anyray-bench"`, which only this harness sends, so
  other traffic keeps its config.
- The config before the change is saved to `results/optimizer-config.before.json`.
- `params` writes are revision-checked: a concurrent edit is retried, never overwritten.
  Param names are checked against the deployed optimizer, since a misspelt one does nothing.
- Gateways in `config.yaml` `run.blocked_gateways` are refused (the kit refuses them at plan
  and freeze with `plan_gateway_blocked`). Benchmark config changes never touch our hosted
  gateway, gateway.anyray.ai; benchmark traffic may run there.

### Pick a Claude Code integration level

```bash
ANYRAY_CONNECT_BIN=/absolute/path/to/anyray-connect npm run agent -- \
  --scenario cobra-flag-groups --kinds observation_mask --integration-level gateway_hooks
npm run bench-level -- show
npm run bench-level -- set gateway
npm run bench-level -- clear
```

`--integration-level gateway|gateway_hooks|gateway_hooks_mcp` sets the level on the
benchmark key for the run and restores it afterwards, even on Ctrl-C. `--read-trim` needs
`gateway_hooks_mcp`. For a service key pass `--agent <id>`; for a user seat `--user <id>`.

### Connect checks and pinned builds

Every round checks that `anyray-connect` set up the Anyray arm correctly: what it wrote
before the session, and what the session loaded. A failed required check fails the round
instead of measuring a half-connected client.

`ANYRAY_CONNECT_BIN=<abs path>` (every Anyray arm) and `--connect-bin-b <abs path>` (B
only) pin the Connect build an arm runs. The harness makes sure an installed Connect
desktop app cannot take over, and fails the round if a different build ran. Details:
[docs/harness-internals.md](docs/harness-internals.md#connect-checks).

## How a round works

Each **round** runs the same task on a real open-source repo in two arms **at the same
time**, each a full Claude Code session on its own fresh checkout:

| Arm | How it reaches the model |
|---|---|
| **A · direct** | Claude Code straight to Anthropic. No gateway, hooks or MCP. |
| **B · through Anyray** | The same Claude Code session via an Anyray gateway, sending only the client key. When this machine's `anyray-connect` is enrolled on that gateway, its hooks and MCP server are attached too. |

Nothing is scripted. The model picks every step, with all of Claude Code's default tools,
subagents included. Both arms get the same model, task, turn cap and upstream credential,
and neither loads your own Claude Code settings.

Each round records:

- **Cost:** Claude Code's billed total, cache reads and writes included, main agent and
  subagents. Gateway keep-warm pings (billed, but not in Claude Code's total) are added
  when an admin key with `spend:read` is set.
- **Solved or not:** a bug fix must pass its test command, a question must contain every
  key fact, and an audit's `path:line` citations must resolve to real lines.
- **Work:** turns, model requests, subagents, each tool call, and cache read / write /
  uncached input per request.
- **The gateway's record** (with an admin key): which strategies were on, and what each did
  on each request.
- **Booked vs measured savings** (`--compare anyray`): what the gateway claims it saved
  against what the pair really cost. A round where Anyray cost more but the gateway still
  booked a saving prints a warning.
- **Fairness flags:** a gateway restart during the round, a session that worked outside its
  checkout, a file both arms wrote outside their checkouts, or mixed Claude Code versions.
  Each prints a warning.

### Which strategies the Anyray arm runs

`--compare anyray` and `gateway` need `--kinds <k1,k2>` (or `--strategy <kind>`). The
Anyray arm sends them as `x-anyray-optimization-kinds`, so the gateway runs exactly those
strategies, off-by-default ones included, unless an admin rule disables one. A run never
inherits the tenant's defaults, which drift.

A local pass-through proxy reads `x-anyray-optimization-result` on each response. Each
round prints, per kind, how many requests applied it, skipped it (with the reason) or gave
no feedback.

## Reading the verdict

Each result file has two verdicts.

**Rule 0** (`lib/stats.mjs`), across solved pairs:

| Bar | Pass when |
|---|---|
| Win rate | Anyray is cheaper in at least 63% of rounds (the noise floor is 53%) |
| Q3 ratio | Below 1, so no more than a quarter of rounds cost more |
| Quality parity | Anyray solves as many rounds as direct |

**Paired cost verdict** (`verdict`): the geometric mean of B/A with a 95% interval.
`pass` needs at least 8 valid rounds and an upper bound below 1. `fail` means the lower
bound is above 1. Anything else is `inconclusive`, with the number of rounds still needed.

Only **solved pairs** count: rounds where both arms solved the task. A cheap failure is
never a win. Rounds only one arm solved are listed as quality events. Rounds with a
crash, a timeout without cost, a gateway restart, or work outside the checkout are
excluded and listed, and so are rounds in which both arms wrote the same file outside
their checkouts (`shared file`). Fewer than 3 solved pairs gives `INSUFFICIENT`.

Under `--kinds-b`, both arms send the kinds they differ by in
`x-anyray-optimization-shadow-kinds`. The gateway runs them on a copy of each request
and reports whether they would have saved tokens, without changing what it sends. Rule 0
then scores only **on-shape pairs**, where the kinds would act in both arms' sessions.
In the other pairs the treatment had nothing to act on, so both arms sent the same bytes
and the ratio is session noise. The printout lists those rounds as off-shape. If an arm
got no shadow answer (an older gateway, or a kind that stores content for retrieval and
can't run in shadow), every solved pair is scored and the printout says why.

Recalculate from existing files, with no model traffic:

```bash
node tools/bench-verdict.mjs results/agent/cobra-flag-groups--control*.json
node tools/bench-verdict.mjs --json --min-rounds 12 results/agent/example.json
```

It refuses to pool files with a different scenario, compare mode, model or provider
(`--allow-mixed` overrides). Exit codes: 0 pass, 1 fail, 2 inconclusive.

### The tail check

The win-rate, Q3 and mean gates say nothing about one very expensive session. The tail
check does: it fails a run when its worst pair is worse than the worst pair in each of 19
blocks of no-op pairs (direct vs direct, or pass-through vs pass-through), recorded
earlier for the same scenario. With too few no-op pairs it prints
`insufficient calibration` and never passes. It is a weak check and says so. The math,
the no-op sources and how to top them up are in
[docs/harness-internals.md](docs/harness-internals.md#tail-check).

## Comparison modes

| Mode | A | B | Use it to |
|---|---|---|---|
| `--compare anyray` (default) | direct | through Anyray | ask the end-to-end question |
| `--compare control` | direct | direct | see how far two identical setups drift. A result inside that band proves nothing. |
| `--compare gateway` | through Anyray | through Anyray + treatment | isolate one feature. Both arms carry everything else the gateway brings. |
| `--compare gateway --bare` | pass-through | pass-through | P vs P: the noise floor of the gateway path itself. No `--kinds` needed. |
| `--compare gateway --bare-a` | pass-through | through Anyray | P vs B: does Anyray's default beat pass-through? B runs `--kinds`, or the tenant's stored defaults on a frozen plan. |

- `--with-control` runs a control next to the main comparison and prints its median and
  range as the noise band.
- **Header treatment:** `ANYRAY_BENCH_EXTRA_HEADERS` goes to B only under `gateway`.
- **Rule treatment:** `--experiment-b <name>` tags B's `x-anyray-metadata`, and
  `bench-rule params` adds a rule keyed on that tag. Each round records whether the rule
  stayed the same; drop a round with `stable: false`.
- **Strategy treatment:** `--kinds-b`, `--read-trim-b` and `--hook-posture-b` change B
  only (see [Run options](#run-options)).

```bash
ANYRAY_BENCH_EXTRA_HEADERS='x-example-feature: on' \
  npm run agent -- --scenario cobra-flag-groups --rounds 6 --compare gateway --strategy thinking_trim --label feature-ab

npm run bench-rule -- params my-exp-b --params '{"observation_mask":{"mintPaybackTurns":2}}'
npm run agent -- --scenario pyrepo-long-session --compare gateway \
  --kinds relevance_filter,code_graph,observation_mask --experiment-b my-exp-b --label my-exp
npm run bench-rule -- remove-params my-exp-b
```

A gateway may hold one strategy out of a session as its own control, drawn per session.
A round whose arms got different holdouts compared two strategy sets and prints a
warning. `--redraw-holdout N` restarts such a pair with fresh sessions, up to N times.
Name every kind the gateway may hold out in `--kinds`.

## Scenarios

| Scenario | Repo | Task | Graded by |
|---|---|---|---|
| `cobra-flag-groups` | spf13/cobra (pinned) | Fix a planted bug in mutually exclusive flags | `go test ./...` passes |
| `cobra-dispatch` | spf13/cobra (pinned) | Explain how a command line is dispatched | Key facts in the answer |
| `gin-doc-audit` | gin-gonic/gin (pinned) | Audit 2,700 lines of docs against 24k lines of Go | Path:line citations resolve |
| `gin-test-triage` | gin-gonic/gin (pinned) | Fix two hidden regressions from ~80 KB of verbose test output | `go test ./...` passes |
| `gin-long-session` | gin-gonic/gin (pinned) | Six user turns in one session: triage, fix, re-test, two code walkthroughs, recap | `go test ./...` passes |
| `gin-ci-paste` | gin-gonic/gin (pinned) | Five user turns; the same ~17 KB CI test log is pasted into four of them | `go test ./...` passes |
| `cobra-pause` | spf13/cobra (pinned) | Two questions with a 6-minute pause between them | Key facts in the answer |
| `cobra-3pause` | spf13/cobra (pinned) | Four questions with pauses of 6, 15 and 40 minutes | Key facts in the answer |
| `cobra-walkaway` | spf13/cobra (pinned) | One question, then the user never returns; ping cost read after the gateway's idle window | Key facts in the answer |
| `pyrepo-docs` | a large Python codebase (pinned) | Developer docs: how a command reaches a minion and runs a module | Path:line citations resolve |
| `pyrepo-pillar-docs` | a large Python codebase (pinned) | Developer docs: how grains and pillar data reach a minion | Path:line citations resolve |
| `pyrepo-state-docs` | a large Python codebase (pinned) | Developer docs: how `state.apply` turns SLS files into executed states | Path:line citations resolve |
| `pyrepo-loader` | a large Python codebase (pinned) | Explain how an execution module is found and loaded | Key facts in the answer |
| `pyrepo-long-session` | a large Python codebase (pinned) | Five user turns of code walkthroughs over one large Python codebase | Path:line citations resolve |
| `pyrepo-long-session-cold` | a large Python codebase (pinned) | The same five turns with three 62-minute pauses, so three turns start with the prompt cache expired (about 4 hours a round) | Path:line citations resolve |
| `pyrepo-long-session-pause` | a large Python codebase (pinned) | The same five turns with three 7-minute pauses, for arms on 5-minute cache entries (API key, Bedrock): three cold turns in about an hour | Path:line citations resolve |
| `sdk-docs` | a large Python codebase (pinned) | SDK tool loop without client cache markers, direct Bedrock vs gateway | Path:line citations resolve |
| `framework-docs` | a large Python codebase (pinned) | The `pyrepo-docs` task run by an agent-framework graph agent, direct Bedrock vs gateway | Path:line citations resolve |
| `hono-dispatch` | honojs/hono (pinned) | Explain how a request reaches its route handler and middleware (TypeScript) | Key facts in the answer |
| `vite-transform` | vitejs/vite (pinned) | Explain how the dev server resolves, loads and transforms a module request (TypeScript) | Key facts in the answer |
| `vite-docs` | vitejs/vite (pinned) | Developer docs: dev server startup, module transform, HMR (TypeScript) | Path:line citations resolve |
| `commander-fix` | tj/commander.js (pinned) | Fix a planted bug in list options (JavaScript, runs without `npm install`) | `node --test bench-check/list-options.test.js` passes |

Each scenario is `scenarios/<name>/scenario.yaml`, plus a patch for bug-fix tasks. A
session is capped at `timeoutMin` (6 minutes by default) and `maxTurns`. It ends once it
has answered and has been idle for 30 seconds; wall time runs to the final answer.

| Key | What it does |
|---|---|
| `followups:` | Runs one multi-turn session; each follow-up is a new user turn |
| `followupDelaySec` | Idle time before each follow-up: one number, or one per follow-up (the last repeats) |
| `mcpTools` | Optional non-negative integer count of MCP tools for planning. To reproduce a synthetic seat, also pass `--mcp-catalog N` on the run; it applies to both arms. |
| `patch:` | One file or a list, applied in order |
| `hidePatch: true` | Re-imports the patched checkout as one commit, so `git diff` and `git log` cannot find the bug |
| `expect: text` | Optional. What a passing run looks like, in your words (up to 300 characters). Frozen with the plan, shown as "Expected: ..." beside the quality line in the local report and page, and never sent in the JSON body or a published result |
| `pastes: { name: file }` | Puts that file's text (beside `scenario.yaml`) wherever `{{name}}` stands in the task or a follow-up, byte for byte the same each time |
| `gatewaySettleSec` | Wait after the session before reading the Anyray arm's ping cost |

A session gets the Claude seat's access token once and cannot refresh it. A scenario
with pauses refuses to start when the token expires before the pauses end (plus 15
minutes). Start again after Claude Code renews it, or set `ANYRAY_UPSTREAM_TOKEN` to a
long-lived token (`claude setup-token`).

`npm run cold-turns -- results/agent/<file>.json` reads a pause-scenario round back: cost,
cache breaks and strategy actions for each turn after a long pause, and anything that
makes the round unreadable as a comparison.

## Other lanes

### On an Anthropic API key

`--upstream api-key` runs both arms on an Anthropic API key with only the base URL
changed, the way a customer on a key connects. The default, `--upstream seat`, uses the
Claude subscription seat.

```bash
cp -r twins/go-protogetter-lint ./client-scenarios/   # then plan and freeze it as above
ANTHROPIC_API_KEY=<key> npm run agent -- --scenarios-dir ./client-scenarios \
  --scenario go-protogetter-lint --rounds 6 --compare gateway --bare-a --upstream api-key
```

- The harness takes `ANTHROPIC_API_KEY` out of its own environment at startup and gives it
  to the Claude arm processes alone, warm-up included. Graders, git and helpers never see it.
  It is never written to settings, `--arm-env`, arguments, metadata or results.
- `--arm-env` refuses the key, and `--upstream api-key` refuses `--provider bedrock`.
- Seat-expiry checks are skipped on this lane. Rounds go to their own file (label `api-key`).
- It covers Claude Code on an API key only: not seat headroom, and not SDK agents.

The parity twin is [twins/go-protogetter-lint](twins/go-protogetter-lint): fix 43
protogetter lint findings in hashicorp/go-plugin. How it is pinned and graded is in
[docs/harness-internals.md](docs/harness-internals.md#parity-twin).

### On AWS Bedrock

`--provider bedrock` bills both arms to AWS instead of a Claude subscription:

| Arm | How it reaches the model |
|---|---|
| **A · direct** | Claude Code's own Bedrock client (`CLAUDE_CODE_USE_BEDROCK=1`), signed with an AWS profile on this machine. |
| **B · through Anyray** | Claude Code connected by `anyray-connect --org`: the gateway key authenticates, and the gateway's routing sends the request to Bedrock with the credentials it holds. Nothing on the client names a provider. |

```bash
npm run agent -- --scenario pyrepo-docs --rounds 4 --provider bedrock --kinds observation_mask,code_graph
```

| Env var | Default | Sets |
|---|---|---|
| `ANYRAY_BEDROCK_PROFILE` | `AWS_PROFILE`, else `default` | Arm A's AWS profile |
| `ANYRAY_BEDROCK_REGION` | `us-east-1` | Arm A's region. Use the gateway's region, or the arms are priced and served differently. |
| `ANYRAY_BEDROCK_MODEL` | read back from the gateway | Arm A's model id. Required when the gateway answers with the client's own model id. |
| `ANYRAY_BEDROCK_SMALL_MODEL` | Haiku 5.5 in the main model's profile | Arm A's small/fast model |

The gateway must have Bedrock as its provider. Before the first round, the harness sends
one 1-token request the way arm B will, and gives arm A the model id Bedrock served, so
both arms call the same model. Arm A also gets the same small model arm B uses, so side
calls (such as WebFetch summaries) are not priced at Sonnet rates on A only. Rounds go to
their own file (label `bedrock`).

### Per-token agents: `sdk-docs` and `framework-docs`

Both scenarios run their own agent in-process, without Claude Code or a subscription seat,
and send no `cache_control` markers. Both arms pay per token. The agent can read a file by
line range, list a directory, or search for text, all inside its own checkout.

| Scenario | Agent | Direct arm | Anyray arm |
|---|---|---|---|
| `sdk-docs` | A small tool loop on the Messages API | Bedrock `InvokeModel` via the AWS CLI | Native Messages body to the gateway's org lane |
| `framework-docs` | An agent-framework state graph (model node + tool node) | `AnthropicBedrock` client | Stock gateway setup: gateway URL as base URL, client key as API key |

```bash
node run_agent.mjs --scenario sdk-docs --rounds 1 --provider bedrock
node run_agent.mjs --scenario framework-docs --rounds 1 --provider bedrock --kinds <k1,k2>
```

- Set `ANYRAY_GATEWAY_URL` and `ANYRAY_BENCH_CLIENT_KEY` (or `ANYRAY_CLIENT_KEY`), and
  the AWS profile and region [as for Bedrock](#on-aws-bedrock).
- No `--kinds` means no optimization header is sent.
- `--max-turns`: 8 to 30 for `sdk-docs` (it runs at least eight requests), 2 to 80 for
  `framework-docs`.
- `--inter-turn-delay-sec 310` pauses past the five-minute cache lifetime.
- An answer that stays empty after one answer-only retry is graded `error_no_answer`.
- The result stores each request's usage, cost and latency.

### Codex (`--client codex`)

Runs the same scenarios with Codex CLI in both arms (`codex exec`, on this machine's
ChatGPT seat). The gateway's Codex seat lane relays traffic byte-identical and optimizes
nothing, so a `--compare anyray` pair measures the
relay's overhead and connect's client-side hook, not a gateway trim.

| Compare | A | B |
|---|---|---|
| `anyray` | Codex direct (its built-in provider, its own WebSocket to chatgpt.com) | Codex on the seat route anyray-connect writes, through the gateway |
| `control` | Codex direct | Codex direct |
| `gateway` | through the gateway | through the gateway, with the treatment |

- Each gateway arm is set up by `anyray-connect --tools codex --subscription` in a private
  home. The seat login is never copied, and hooks are off in both arms unless
  `--codex-hooks-b`.
- Cost is Codex's own per-response usage, priced from `config.yaml` (list-price
  equivalent; the seat bills in usage limits).
- `--kinds` only names which kinds to tally; it is not sent. The seat lane runs no strategy.
- No turn cap: `--max-turns` is refused; `--timeout-min` bounds each session.

```bash
# Connect's client-side PreToolUse source trim, on B only:
npm run agent -- --client codex --scenario gin-long-session --compare gateway \
  --kinds relevance_filter --codex-hooks-b --rounds 8 --retry-invalid 4
```

How B's hook is isolated from your real `~/.codex` is in
[docs/harness-internals.md](docs/harness-internals.md#codex-hook-isolation).

### Agent SDK app: code scan

`sdk-app-code-scan` is a Claude Agent SDK app, run by `run_sdk_app.mjs`. Its main agent
sends three `auditor` subagents out in parallel to trace security-critical functions in
the pinned Python codebase. `seeded-vulns.patch` plants nine vulnerabilities, each decided
by a helper far away in another module. A round is graded on how many of the nine
deciding constants the report quotes.

Every arm goes through the gateway on its own key, read from `<arm>.key` (mode 600) in
`--keys-dir`:

| Arm | What the app gets |
|---|---|
| A | The gateway's `/mcp` read path, harness retrieval off |
| B | The same, harness retrieval on |
| C | No read path, optimization bypassed (`x-anyray-optimize: off`) |
| D | B plus Anyray Connect's local MCP server, offering `anyray_read_batch` |
| E | D, with the server started as `__anyray-mcp-server sdk`, whose `initialize` result tells the model when to batch reads |

D differs from B by one tool. `D.key` must be an agent key. Arm E needs a Connect build
that serves the `sdk` source (`ANYRAY_CONNECT_BIN`). The run stops before the first paid
round if the server's batch read or instructions are missing.

```bash
node tools/probe-sdk-code-scan.mjs            # wiring check, no model request, no key; --arm E for arm E
node run_sdk_app.mjs --scenario sdk-app-code-scan --arms A,D --gateway <url> \
  --keys-dir <dir with A.key and D.key> --model claude-sonnet-5-5 --rounds 8 --budget 40 --label code-scan
node tools/compare-sdk-app.mjs results/agent/sdk-app-code-scan--code-scan.json
```

The comparison prints D/A, plus D/B when B ran (that pair isolates the batch read). It
first checks that D's agents really used the batch read in at least half the D sessions.

## Run options

| Flag / env | What it does |
|---|---|
| `--rounds N` | Rounds to run |
| `--label <name>` | Keep the run in its own result file |
| `--parallel N` | Rounds in flight at once (default 2, max 4) |
| `--retry-invalid N` | Run another round in place of one the verdict drops, up to N extra. With `--rounds 1`, ends a quick test with one usable pair. |
| `--max-turns N` | Both arms' turn cap. Below 80, Connect turns off its read hint and Explore decline, so B runs without what production gets (the run warns). Every Claude Code scenario is capped at 80. |
| `--timeout-min N` | Both arms' wall-clock cap, for a slower model or route |
| `--no-subagents` | Both arms run without `Task` and `Workflow` |
| `--warm-up` | A throwaway one-turn session per arm first, so both start with a warm cache |
| `--claude-bin <abs path>` / `ANYRAY_CLAUDE_BIN` | Pin the Claude Code binary. Without it, auto-update can change `claude` between rounds. |
| `--mcp-catalog N` | Add a stub MCP server with N unused tools (200 ≈ a seat with many connectors). Pair with `--arm-env ENABLE_TOOL_SEARCH=false`. |
| `--experiment <name>` | Tag the Anyray arm with `experiment=<name>`, for a gateway rule on this run only |
| `--kinds-b <k1,k2>` | `gateway` mode: B requests other kinds than `--kinds` |
| `--bare` / `--bare-a` | `gateway` mode: both arms / arm A alone is pass-through (base URL and headers only, optimization off) |
| `--upstream seat\|api-key` | Run the Claude arms on the seat (default) or on `ANTHROPIC_API_KEY`. See [On an Anthropic API key](#on-an-anthropic-api-key). |
| `--read-trim-b` / `--read-trim` | Connect's nested-Read trim on B only / on every Anyray arm |
| `--hook-posture-b <name>=<on\|off>` / `--hook-posture` | Pin one team-policy hook switch on B only / on every Anyray arm |
| `--client-tool-policy name=true\|false` | Set a Connect MCP switch in the Anyray arm, e.g. `readBatchRanges=true` |
| `--client-tool-policy-b name=true\|false` | `gateway` mode: set a Connect MCP switch on B only, e.g. `searchContext=false` (read with `--treatment a`) |
| `--seed-home <path>=<abs file>` | Copy a file into every Anyray arm's private HOME before Connect configures it |
| `--arm-env b:KEY=VALUE` / `b:KEY=-` | Set or remove an env var on an arm, e.g. `b:DISABLE_PROMPT_CACHING=1` |
| `--no-persist-session` | Run both arms without session transcripts, as runs before 2026-10-12 did |
| `--redraw-holdout N` | Restart a pair when the arms got different holdouts |
| `ANYRAY_BENCH_EXTRA_HEADERS` | Extra gateway headers for the Anyray arm (B only under `gateway`), one `name: value` per line |
| `ANYRAY_BENCH_SHARED_HEADERS` | Headers on every Anyray arm, such as `x-anyray-tool-defer: off` where the dev org's default differs from production |

Each flag is recorded in the result file. The exact fields, limits and refusals are in
[docs/harness-internals.md](docs/harness-internals.md#run-options-in-detail).

**Reading a round line.** Watch these to spot an unfair pair:

- `start <read> read / <written> written`: what each agent's first request read from and
  wrote to the cache. A large gap between the arms is a cold start, not the work.
- `N subagents · M sub-req (M/N per agent) · K main-req`: the subagent load.
- `OUTSIDE CHECKOUT`: the session touched files outside its checkout. Another copy of the
  repo on the machine is the usual cause: remove it.
- `SHARED FILE with the other arm`: both arms wrote the same file outside their checkouts,
  usually a test log under `/tmp`. The arms run at once, so each could overwrite or read
  the other's. The round is excluded as `shared file`.

## The replay suite (secondary)

`run.mjs` sends 38 fixed payloads (`<suite>/payloads/*.json`) once directly and once
through the gateway, and compares billed tokens, cost and a judge's view of the two
answers. It is a quick check that a gateway change does something on a known request
shape. It is **not** evidence of savings:

- **Payload design:** each payload was built around a pattern the optimizer targets.
- **No caching:** nothing is served from cache, so every trimmed token counts at full price.
- **Single requests:** there are no turns, subagents or cache writes to pay for.

```bash
npm run replay -- --suite code-context --workload 27-read-service-ts
node show.mjs code-context/27-read-service-ts    # one workload, printed in full
npm run replay:report                              # → RESULTS.md (local)
```

## On your own traffic

The scenarios here are ours, not yours. [`anyrayHQ/simulator`](https://github.com/anyrayHQ/simulator)
sends each of your own captured prompts to your gateway twice (once with
`x-anyray-optimize: off`) and reports the input-token delta and whether the facts you
marked as required survive. Its results stay with you.

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
docs/harness-internals.md  what each harness check does and records
docs/kit-internals.md      what each kit command checks, records and refuses
docs/results-history.md    earlier runs
```

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
- **Gateway pings,** when an admin key with `spend:read` is set: requests the gateway sends on the session's behalf (keep-warm pings) are billed but never reach Claude Code's total. After the Anyray arm finishes, the harness reads `GET /admin/v1/spend/sessions/<Claude Code session id>?includeSubagents=true` (re-reading for up to 30 s until the counts settle) and records `gatewayPingCount` and `gatewayPingCostUsd`. The arm's `costUsd`, which the ratio uses, becomes Claude Code's figure (kept as `clientCostUsd`) plus the ping cost. A gateway without that endpoint gives a one-line warning and null ping fields, and the cost stays the client figure.
- **Gateway restarts:** the admin health report's replica start times before and after the round. A replica that is new or started again (60 s tolerance) sets `gatewayRestarted` and prints a warning, since such a round is not a fair pair.

Across rounds it gives the **Rule 0 verdict** (`lib/stats.mjs`):
- **Win rate:** Anyray must be cheaper in clearly more rounds than the 53% noise floor (the bar is 63%).
- **Q3 ratio below 1:** Anyray must still be cheaper at the third quartile, so no more than a quarter of rounds may cost more.
- **Quality parity:** Anyray must solve as many rounds as direct.

The verdict counts **solved pairs only**: rounds where both arms solved the task. A
session that didn't solve it (e.g. it hit the turn cap) measured cost, not quality, so a
cheap failure is never a win. Rounds only one arm solved are listed as quality events
(who solved), rounds neither solved are listed apart, and rounds where an arm timed out
or crashed (no cost) are excluded and listed. With fewer than 3 solved pairs the verdict
is `INSUFFICIENT`. The earlier all-rounds line is still printed below it, and saved as
`stats` (the solved-pair Rule 0 summary is `rule0Verdict`).

### Reading the paired cost verdict

The final `verdict` in each result file tests whether B is cheaper than A across
valid paired rounds. Only rounds where **both arms solved**, both costs and the ratio
are positive and finite, and neither arm worked outside its checkout count. Failed
rounds and rounds across a gateway restart are excluded. The printout lists the
exclusion counts and each arm's mean cost and cost variation.

The verdict uses the geometric mean of B/A ratios and a two-sided 95% Student t
interval on their logarithms. `pass` requires at least 8 valid rounds and an upper
interval bound below 1. `fail` means the lower bound is above 1. Otherwise it is
`inconclusive`; below 8 valid rounds it also says how many more are needed. The
minimum detectable ratio is the largest hypothetical B/A ratio below 1 whose 95%
interval would clear 1 at the observed variation and sample size. It is a confidence
threshold, not a power guarantee. One round has no variance estimate, so its ratio
cannot establish a cost win.

To recalculate from existing files, with no agent or model traffic:

```bash
node tools/bench-verdict.mjs results/agent/cobra-flag-groups--control*.json
node tools/bench-verdict.mjs --json --min-rounds 12 results/agent/example.json
```

The tool checks scenario, compare mode, model, and provider before pooling. Use
`--allow-mixed` to override that check; the output then names the differences.
It exits 0 for pass, 1 for fail, and 2 for inconclusive.

A **control** comparison (`--compare control`) runs direct against direct to show how
far two identical setups drift apart. A result inside that band proves nothing.
`--with-control` runs one alongside the main comparison, in parallel, with the same
scenario, rounds, `--max-turns` and `--no-subagents`, into its own file (label suffixed
`-control`), and prints its solved-pair median and range next to the verdict as the
noise band, saying whether the main median falls below, inside or above it.

A **gateway** comparison (`--compare gateway`) runs the Anyray arm in both slots and
sends `ANYRAY_BENCH_EXTRA_HEADERS` on B only. Both arms carry everything the gateway
brings (e.g. Claude Code's behaviour behind a custom base URL, the shared tenant), so the
ratio isolates the one header-selected feature. Kinds, strategy, metadata and client
setup are the same in both slots; each slot gets its own session id (`…-a`, `…-b`) so the
gateway keeps their traces, spend and session state apart. Gateway ping cost is added to
both arms. Rounds the harness flags as run across a gateway restart are left out of the
Rule 0 stats.

```bash
ANYRAY_BENCH_EXTRA_HEADERS='x-example-feature: on' \
  npm run agent -- --scenario cobra-flag-groups --rounds 6 --compare gateway --strategy thinking_trim --label feature-ab
```

When the treatment is a gateway **rule** and not a header, tag arm B instead:
`--experiment-b <name>` sends `experiment=<name>` in B's `x-anyray-metadata` only, and
`bench-rule params <name> --params …` (below) adds a rule keyed on that tag. Both arms run
the same strategies; B runs them with the rule's params.

```bash
npm run bench-rule -- params my-exp-b --params '{"observation_mask":{"mintPaybackTurns":2}}'
npm run agent -- --scenario saltstack-long-session --compare gateway \
  --kinds relevance_filter,code_graph,observation_mask --experiment-b my-exp-b --label my-exp
npm run bench-rule -- remove-params my-exp-b
```

The run says before it starts which rule B's tag matches (or that none does), and each
round records the rule as it stood before and after (`experimentRule`, with `stable: false`
when it was missing or changed: drop that round).

A gateway may hold one strategy out of a session as its own control, drawn per session, so
the two sessions of a round are drawn separately. Each round records which requested kinds
were held out of each arm (`heldOut: { a, b, differs }`, from the `guard` the gateway names
on a `safety_gate` skip) and prints a warning when the arms differ: that round compared two
different strategy sets. `--redraw-holdout N` avoids spending a round on that: when either
session reports a holdout on one of its first three responses, both are stopped and the
pair starts again with fresh sessions (fresh draws), up to N times; the draws thrown away
are recorded in the round's `redraws`. Name every kind the gateway may hold out in
`--kinds`, since only requested kinds are watched.

### Scenarios

| Scenario | Repo | Task | Graded by |
|---|---|---|---|
| `cobra-flag-groups` | spf13/cobra (pinned) | Fix a planted bug in mutually exclusive flags | `go test ./...` passes |
| `cobra-dispatch` | spf13/cobra (pinned) | Explain how a command line is dispatched | Key facts in the answer |
| `gin-doc-audit` | gin-gonic/gin (pinned) | Audit 2,700 lines of docs against 24k lines of Go | Path:line citations resolve |
| `gin-test-triage` | gin-gonic/gin (pinned) | Fix two hidden regressions from ~80 KB of verbose test output | `go test ./...` passes |
| `gin-long-session` | gin-gonic/gin (pinned) | Six user turns in one session: triage, fix, re-test, two code walkthroughs, recap | `go test ./...` passes |
| `cobra-pause` | spf13/cobra (pinned) | Two questions with a 6-minute pause between them | Key facts in the answer |
| `cobra-3pause` | spf13/cobra (pinned) | Four questions with pauses of 6, 15 and 40 minutes | Key facts in the answer |
| `cobra-walkaway` | spf13/cobra (pinned) | One question, then the user never returns; ping cost read after the gateway's idle window | Key facts in the answer |
| `saltstack-docs` | saltstack/salt (pinned) | Developer docs: how a command reaches a minion and runs a module | Path:line citations resolve |
| `saltstack-pillar-docs` | saltstack/salt (pinned) | Developer docs: how grains and pillar data reach a minion | Path:line citations resolve |
| `saltstack-state-docs` | saltstack/salt (pinned) | Developer docs: how `state.apply` turns SLS files into executed states | Path:line citations resolve |
| `saltstack-loader` | saltstack/salt (pinned) | Explain how an execution module is found and loaded | Key facts in the answer |
| `saltstack-long-session` | saltstack/salt (pinned) | Five user turns of code walkthroughs over one large Python codebase | Path:line citations resolve |
| `saltstack-long-session-cold` | saltstack/salt (pinned) | The same five turns with three 62-minute pauses, so three turns start with the prompt cache expired (about 4 hours a round) | Path:line citations resolve |

Each is `scenarios/<name>/scenario.yaml` (plus a patch for bug-fix tasks). Every session
is capped at `timeoutMin` (6 minutes by default) and `maxTurns`. A scenario with
`followups:` runs as one multi-turn session: each follow-up is sent as a new user turn
when the previous answer is done. `hidePatch: true` re-imports the patched checkout as a
single commit, so the planted bug can't be found with `git diff` or `git log`.
`followupDelaySec` idles before each follow-up, the way a person pausing would: one
number for every follow-up, or a list with one per follow-up (the last repeats).
`gatewaySettleSec` waits that long after the session before reading the gateway's ping
cost for the Anyray arm, e.g. to let a keep-warm window run out.

A session is handed the Claude seat's access token once and cannot refresh it, so a
scenario with pauses refuses to start when the token expires before its pauses (plus 15
minutes of work) are over. Start it again once Claude Code has renewed the token, or set
`ANYRAY_UPSTREAM_TOKEN` to a long-lived one (`claude setup-token`).

`npm run cold-turns -- results/agent/<file>.json` reads a pause-scenario round back: each
arm's cost with pings, turns, requests, cache breaks, retrievals and held-out kinds, and
for each turn that followed a long pause whether the gateway attested the cache expiry,
the tokens each strategy removed, what the provider wrote and read, and why a strategy
declined. It lists what makes a round unreadable as a comparison (a gateway restart,
different kinds held out per arm, a rule that changed, a cold turn that was not attested).

### Running it

Requirements: Node.js 20+, the `claude` CLI signed in to a Claude subscription (the
upstream credential for both arms), `git`, and Go for the cobra/gin checks.

```bash
cp .env.example .env     # ANYRAY_GATEWAY_URL, ANYRAY_CLIENT_KEY, ANYRAY_ADMIN_KEY

npm run agent -- --scenario cobra-flag-groups --kinds observation_mask,code_graph   # 1 round, ~1 min
npm run agent -- --scenario cobra-flag-groups --rounds 6 --compare control
npm run agent -- --scenario cobra-flag-groups --rounds 6 --kinds observation_mask,code_graph
npm run agent:report     # → results/agent/report.html
```

`--parallel N` runs up to N rounds at once (default 2, max 4). Each round is still a
pair of concurrent sessions, so N rounds means up to 2N Claude Code sessions, all on the
one subscription, which is why the cap is low. `--parallel 1` runs rounds one after
another. Rounds are numbered when the run starts, each is saved as soon as it finishes
(an interrupted run keeps every finished round), and the result file stays in round
order whichever finishes first. Round lines print as each round finishes, prefixed with
its round number. With `--with-control`, the main comparison and the control share the
one budget: at most N rounds in flight across both (at most 2N sessions), half the slots
each (rounded up) while both are running. The default of 2 therefore runs one main and
one control round side by side. The value is recorded as `parallel` in each arm's setup.

Rounds accumulate in `results/agent/<scenario>--<compare>.json`, so re-running adds
rounds. `--label <name>` keeps a run in its own file (e.g. a single-strategy run). `results/` is local only, because transcripts hold tool output. Share the
report instead.

### Which strategies the Anyray arm runs

`--compare anyray` (and `gateway`) needs `--kinds <k1,k2>` (or `--strategy <kind>`, which means
`--kinds <kind>`). The Anyray arm sends them as `x-anyray-optimization-kinds`, so the
gateway runs exactly those strategies, off-by-default ones included, unless an admin
rule disables one. A run never inherits the tenant's defaults, which drift. The
requested kinds are recorded in the result's setup.

Claude Code does not surface response headers, so the Anyray arm's model traffic goes
through a local pass-through proxy that reads `x-anyray-optimization-result` on each
response. Each round records, per requested kind, how many requests applied it, skipped
it (with the gateway's reason) or gave no feedback (unconfirmed), and prints it.

### On AWS Bedrock

`--provider bedrock` bills both arms to AWS instead of a Claude subscription:

| Arm | How it reaches the model |
|---|---|
| **A · direct** | Claude Code's own Bedrock client (`CLAUDE_CODE_USE_BEDROCK=1`), signed with an AWS profile on this machine. |
| **B · through Anyray** | Claude Code connected by `anyray-connect --org`: the gateway key authenticates, and the gateway's routing sends the request to Bedrock with the credentials it holds. Nothing on the client names a provider. |

The gateway must have Bedrock as its provider. Before the first round the harness sends
one 1-token request the way arm B will, checks that Bedrock served it, and gives arm A
the Bedrock model id it was served as, so both arms call the same model. Neither arm
carries a subscription token. Rounds go to their own file (label `bedrock` by default).

```bash
npm run agent -- --scenario saltstack-docs --rounds 4 --provider bedrock --kinds observation_mask,code_graph
```

`ANYRAY_BEDROCK_PROFILE` (default: `AWS_PROFILE`, else `default`) and
`ANYRAY_BEDROCK_REGION` (default `us-east-1`) choose arm A's AWS profile and region;
`ANYRAY_BEDROCK_MODEL` pins its model id instead of the one read back from the gateway.
A gateway that answers with the client's own model id (it passes the request to Bedrock
untranslated) gives nothing to read back, so the run asks for `ANYRAY_BEDROCK_MODEL`.
Use the gateway's region, or the arms are priced and served differently.

### Connect's client-tool switches

`--client-tool-policy name=true|false` (repeatable) sets one of anyray-connect's local
switches for what its MCP server advertises, in the Anyray arm's connect profile
(`clientToolPolicies`), after connect has configured the arm. For example
`--client-tool-policy readBatchRanges=true` offers the ranged batch read. The switches
used are recorded in the arm's setup.

### Keeping the pair like for like

- `--warm-up` runs a throwaway one-turn session with each arm's exact setup before the
  timed one, so both arms start with their stable prefix already in the provider's cache.
  Without it, an arm whose setup changed since the previous run starts cold while the
  other reads a prefix that run left warm. The warm-up's cost is recorded on the session
  (`warmUp.costUsd`) and never added to the session's cost.
- Each round line shows `start <read> read / <written> written`: what the first request of
  each agent (main and subagents) read from the cache and wrote to it. A large difference
  between the arms is a cold start, not the work.
- A session that reads, searches or `cd`s outside its own checkout is flagged
  `OUTSIDE CHECKOUT` with a count (`outsideCheckout` on the session). Another copy of the
  scenario's repo elsewhere on the machine is the usual cause: remove it.
- Gateway rewrites that stood aside are counted by the reason their result header names
  (`budgetNoticeReasons`, `toolDeferReasons` on the session, and in brackets on the round
  line). A not-applied result with no reason is counted `unnamed`.
- Citations: a path from the repository root resolves exactly; a path that names exactly
  one file by its tail also resolves and is counted apart (`bySuffix`); a tail that names
  several files is `ambiguous` and stays unresolved.

### Choosing a Claude Code integration level

`--integration-level gateway|gateway_hooks|gateway_hooks_mcp` assigns that level to the
benchmark key before the first round and restores its previous assignment after the
run, including a failed run or Ctrl-C. It is available with `--compare anyray` and
`--compare gateway`. Leave it unset to keep the current behavior. `--read-trim` needs
`gateway_hooks_mcp`, because the lower levels have no retrieval tool. The requested
level is recorded in the result, and each Anyray arm must report the same applied
level and pass the matching hooks, MCP, permission, skill, and session checks.

Use a Connect build that reports `appliedIntegrationLevel` in `status --json`:

```bash
ANYRAY_CONNECT_BIN=/absolute/path/to/anyray-connect npm run agent -- \
  --scenario cobra-flag-groups --kinds observation_mask --integration-level gateway_hooks
npm run bench-level -- show
npm run bench-level -- set gateway
npm run bench-level -- clear
```

The override is used for enrollment, status, and fallback MCP commands; results
record only its basename. `bench-level` uses `ANYRAY_GATEWAY_URL`,
`ANYRAY_ADMIN_KEY`, and `ANYRAY_BENCH_CLIENT_KEY` (or `ANYRAY_CLIENT_KEY`). It
backs up the prior assignment under ignored `results/` and sends revision-checked
team-policy writes that preserve the skills list and other policy fields. For a
service key pass `--agent <id>` (the key's policy ID); for a user seat pass
`--user <id>`. `ANYRAY_BENCH_AGENT_ID` / `ANYRAY_BENCH_USER_ID` set the same for
`run_agent.mjs`. The tool never reads any key's secret.

### Is the Anyray arm connected correctly?

The Anyray arm is set up by `anyray-connect` in a private HOME, and every round checks
the result twice (`lib/connectChecks.mjs`), recording both lists in the arm's setup
(`connectChecks`, `sessionChecks`) and printing how many passed:

- **What connect wrote**, before the session starts: `ANTHROPIC_BASE_URL` is the gateway,
  no direct-cloud switch is set, the metadata header is there, the auth matches the lane
  (subscription: passthrough headers and no auth token; org: the gateway key as the auth
  token and no provider pin). Hooks, the `anyray` MCP server, its tool permission and
  the `anyray` skill are checked against the requested integration level.
- **What the session loaded**, from Claude Code's init event: the `anyray` MCP server
  and retrieve tool are present at `gateway_hooks_mcp` and absent at lower levels.

A failed required check fails the round instead of measuring a half-connected client.
Advisory checks (tool search setting, connectors MCP) are reported only.

`--arm-env b:KEY=-` removes a key connect wrote. connect re-applies its configuration
when its MCP server starts, which would write the key straight back, so such a session
runs with connect's refresh off, and the round fails if the key is back in the arm's
settings afterwards.

### Other run options

- `--max-turns N`: both arms' turn cap instead of the scenario's `maxTurns`. Recorded in
  each arm's setup (`maxTurns`, `maxTurnsSource: "--max-turns"`).
- `--no-subagents`: both arms run Claude Code with `--disallowed-tools Task Workflow`, so
  neither can spawn subagents. Recorded in the result's `request.noSubagents`.
- `--experiment <name>` (`--compare anyray`): the Anyray arm sends `experiment=<name>` in
  `x-anyray-metadata`, so a gateway rule matching that experiment applies to this run
  only. Unlike `--strategy` it does not imply a kind or an isolation check; the two can't
  be combined. Recorded in `request.experiment`.
- `--experiment-b <name>` (`--compare gateway`): arm B alone sends `experiment=<name>`; A
  keeps `--experiment` if given, else no tag. For a treatment that is a gateway rule (see
  `bench-rule params`). Recorded in `request.experimentB`.
- `--redraw-holdout N`: restart a pair when the gateway drew either session into a holdout
  (see the gateway comparison above). Stopped attempts are not in the round's cost.
- `ANYRAY_BENCH_EXTRA_HEADERS`: extra gateway headers for the Anyray arm, one
  `name: value` per line. The harness's own headers (key, metadata, provider, auth mode,
  kinds) can't be overridden. Only the header names are recorded (`request.extraHeaders`,
  and which slots sent them in `request.extraHeadersOn`). Under `--compare gateway` they go
  to B only.
- `--arm-env b:DISABLE_PROMPT_CACHING=1` (`--compare anyray`): the Anyray arm's Claude Code
  sends no `cache_control` markers of its own, leaving prompt caching to the gateway.

### Keeping benchmark traffic in its own tenant

The gateway keeps regret-guard verdicts, session cooloffs and holdouts per tenant, and a
request's tenant comes from its client key. Set `ANYRAY_BENCH_CLIENT_KEY` to a key whose
tenant only benchmarks use, and `ANYRAY_BENCH_TENANT` to that tenant's id. The Anyray
arm (harness- or connect-configured) then uses it instead of `ANYRAY_CLIENT_KEY`, and
the result records `tenant: { tenant, keyVar, dedicated }` (never the key). Without it
the run warns and records the shared `default` tenant. A separate tenant needs a
multi-tenant gateway (`ANYRAY_MULTI_TENANT=true`, tenants and keys from the control
plane): on a single-tenant deployment every key is in `default`.

### Turning strategies on for benchmark traffic only

```bash
npm run bench-rule -- show           # what the gateway has on and off, and what its regret guard suppresses now
npm run bench-rule -- enable [kind…] # default: every strategy that is off
npm run bench-rule -- only <kind…>   # just these on, every other strategy off
                                     # either takes --params '{"<kind>":{…}}'
npm run bench-rule -- per-experiment <kind…>  # one rule per kind, selected per session
npm run bench-rule -- remove
npm run bench-rule -- params <experiment> --params '{"<kind>":{…}}'  # params for one experiment tag
npm run bench-rule -- remove-params <experiment>                    # removes exactly that rule
```

`per-experiment` adds one rule per strategy. A rule matches `tool == "anyray-bench"` and
`experiment == <kind>`, turns that strategy on and every other one off. Pick the strategy
for a run with `npm run agent -- --scenario <name> --strategy <kind>`: the Anyray arm
sends `experiment=<kind>` in `x-anyray-metadata`, and each round records whether any
other strategy acted (`isolation.ok`). `remove` deletes every rule `enable`, `only` and
`per-experiment` added.

`params <experiment>` adds one rule that matches `tool == "anyray-bench"` and
`experiment == <experiment>` and carries strategy params only: it turns nothing on or off,
so a session with that tag runs the strategies it would have run anyway, with those
params. Param names are checked against the strategies the deployed optimizer lists, since
a misspelt one is accepted and then does nothing. The optimizer config is one document
that other people edit too, so `params` and `remove-params` re-read it right before
writing, send the revision they read (a concurrent change is refused and retried, never
overwritten), and read it back to confirm every other rule is unchanged. `remove` and
`per-experiment` do not touch these rules.

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
```

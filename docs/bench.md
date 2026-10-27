# Our bench

Our own paired bench on public scenarios, the one behind the
[latest results](results.md#latest-results-2026-10-15). Each round runs the same task on
a real open-source repo twice, direct and through an Anyray gateway, and the verdict is
judged over the pairs. It needs a gateway you control. To test Anyray on your own work
instead, start at the [README](../README.md#test-it-on-your-own-work).

- [Running our bench](#running-our-bench)
- [Gateway setup](#gateway-setup)
- [How a round works](#how-a-round-works)
- [Reading the verdict](#reading-the-verdict)
- [Comparison modes](#comparison-modes)
- [Scenarios](#scenarios)
- [Run options](#run-options)
- [The replay suite (secondary)](#the-replay-suite-secondary)

Other clients and providers (an Anthropic API key, AWS Bedrock, per-token agents, Codex,
an Agent SDK app) are in [lanes.md](lanes.md).

## Running our bench

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

Set the gateway up once before the first round.

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
[docs/harness-internals.md](harness-internals.md#connect-checks).

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
[docs/harness-internals.md](harness-internals.md#tail-check).

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
| `--upstream seat\|api-key` | Run the Claude arms on the seat (default) or on `ANTHROPIC_API_KEY`. See [On an Anthropic API key](lanes.md#on-an-anthropic-api-key). |
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
[docs/harness-internals.md](harness-internals.md#run-options-in-detail).

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

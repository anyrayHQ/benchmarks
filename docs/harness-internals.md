# Harness internals

Maintainer detail for the agent benchmark: what each check does, and which result fields
it records. For running the benchmark, start at the [README](../README.md).

- [What a round records](#what-a-round-records)
- [Verdict details](#verdict-details)
- [Tail check](#tail-check)
- [Comparison mode details](#comparison-mode-details)
- [Session end and grading](#session-end-and-grading)
- [Parity twin](#parity-twin)
- [Bedrock small model](#bedrock-small-model)
- [Per-token agents](#per-token-agents)
- [Codex hook isolation](#codex-hook-isolation)
- [Agent SDK app preflight](#agent-sdk-app-preflight)
- [Run options in detail](#run-options-in-detail)
- [Connect checks](#connect-checks)
- [Integration level](#integration-level)
- [Dedicated tenant](#dedicated-tenant)
- [bench-rule params](#bench-rule-params)

## What a round records

| Item | Fields and behaviour |
|---|---|
| Subagent load | `mainRequests`, `subagentRequests`, `requestsPerSubagent` (null with no subagents). The round line prints `4 subagents · 68 sub-req (17.0/agent) · 20 main-req`; the result's `subagentLoad` pools it per arm. |
| Claude Code build | `setup.{a,b}.claudeVersion` per round, and the run's `claudeVersions` per arm, with a warning when a block mixed versions. |
| Gateway record | With an admin key: which strategies were on, and what each did on each request (saved, stood down, held by the guard). |
| Gateway pings | With an admin key with `spend:read`: after the Anyray arm ends, the harness reads `GET /admin/v1/spend/sessions/<Claude Code session id>?includeSubagents=true`, re-reading for up to 30 s until the counts settle. It records `gatewayPingCount` and `gatewayPingCostUsd`. The arm's `costUsd` becomes Claude Code's figure (kept as `clientCostUsd`) plus the ping cost. A gateway without that endpoint gives a one-line warning and null ping fields. |
| Booked vs measured savings | The sum of the session's traces' `savingsUsd` (the figure spend rows and console report) against direct minus Anyray, pings included. `savingsCheck` on the round and on the result. |
| Gateway restarts | The admin health report's replica start times before and after the round. A new or restarted replica (60 s tolerance) sets `gatewayRestarted` and prints a warning. |
| Strategy feedback | Per requested kind: applied, skipped (with the gateway's reason) or unconfirmed, read by a local pass-through proxy from `x-anyray-optimization-result`, since Claude Code does not surface response headers. |
| Stand-aside reasons | Rewrites that stood aside are counted by the reason in their result header (`budgetNoticeReasons`, `toolDeferReasons`, and in brackets on the round line). A not-applied result with no reason is counted `unnamed`. |
| Outside checkout | A session that reads, searches or `cd`s outside its checkout: `outsideCheckout`, with a count. |
| Shared file | The absolute paths outside its checkout a session wrote (shell redirects and `tee`, an unquoted `-o`, `cp`/`mv` targets, the Write and Edit tools; not Claude Code's own files, the hook tee or `/dev`): `outsideWrites`, up to 50 paths and a count, never contents. The paths both arms wrote are the round's `sharedOutsideWrites`: the arms run at once, so each can overwrite or read the other's file. The ratio line prints `SHARED FILE with the other arm: <path> (+N)`. |
| Citations | A path from the repository root resolves exactly. A tail that names exactly one file also resolves and is counted apart (`bySuffix`). A tail that names several files is `ambiguous` and stays unresolved. |

## Verdict details

**Rule 0** (`lib/stats.mjs`) counts solved pairs only. Rounds only one arm solved are
listed as quality events (who solved), rounds neither solved are listed apart, and rounds
where an arm timed out or crashed (no cost) are excluded and listed. The earlier
all-rounds line is still printed below it and saved as `stats`; the solved-pair summary
is `rule0Verdict`.

**Paired cost verdict** (`verdict`). Valid rounds: both arms solved, both costs and the
ratio are positive and finite, neither arm worked outside its checkout, the arms wrote no
file outside their checkouts in common (`shared file`), and no gateway restart. The
printout lists the exclusion counts and each arm's mean cost and cost variation.

It uses the geometric mean of B/A ratios and a two-sided 95% Student t interval on their
logarithms. The minimum detectable ratio is the largest hypothetical B/A ratio below 1
whose 95% interval would clear 1 at the observed variation and sample size. It is a
confidence threshold, not a power guarantee. One round has no variance estimate, so its
ratio cannot establish a cost win.

## Tail check

The win-rate, Q3 and mean gates say nothing about one very expensive session. The tail
check does. It takes T, the largest `log(B / P)` cost ratio over the valid pairs, and
fails the run when T is above the largest value in every one of K blocks of the same
number of no-op pairs. Under no effect T and those block maxima are exchangeable, so a
no-op run fails with probability at most 1/(K+1): 5% at K = 19.

The no-op is the judged pair with the treatment taken out, from result files already on
disk. Rounds accumulate in them, so every run tops them up:

| Judged pair | Read against |
|---|---|
| direct vs Anyray (`--compare anyray`, and every `kit` plan) | `--compare control` pairs (direct vs direct); for a plan, its own `noise` rounds |
| pass-through vs B (`--compare gateway --bare-a`) | `--compare gateway --bare` pairs (P/P), including the `api-key` lane |
| any other gateway pair | none: no recorded run is it without its treatment, so no tail check is printed |

A file joins only if its scenario, model, upstream lane, Claude Code version (and gateway
host, for P/P) match the run being judged; the others are skipped by name.

- **Needs 19 blocks.** For 12 pairs that is 228 P/P pairs. With fewer, the check prints
  `insufficient calibration` and how many more to collect. It never passes.
- **Printed with every verdict** that is not itself the noise: `npm run agent`, and
  `npm run verdict` for a plan (one line per scenario, local only, never published). Or on
  its own: `node tools/bench-verdict.mjs --noise-library pp.json result.json`, where an
  excess exits 1 and a library too small to calibrate turns a passing verdict into exit 2.
- **Topping a plan up:** the verdict prints the command, `npm run noise -- --scenarios-dir
  <dir> --rounds N`. It appends N control pairs to every scenario in the plan (the floor is
  6 per call) and keeps the noise block valid.
- **It is weak, and says so.** At 12 pairs and a log-ratio SD of 0.924 it misses about 93%
  of runs where one session costs double, and about 74% where every session does: a
  doubling is smaller than the noise, and more pairs barely help because the largest
  value grows with them. Those cases are what the win-rate, Q3 and mean gates are for.
  A run within noise is not proof of safety.

## Comparison mode details

- **`--with-control`** runs in parallel with the same scenario, rounds, `--max-turns` and
  `--no-subagents`, into its own file (label suffixed `-control`). It prints its
  solved-pair median and range next to the verdict and says whether the main median falls
  below, inside or above it.
- **`--compare gateway`**: kinds, strategy, metadata and client setup are the same in both
  slots. Each slot gets its own session id (`…-a`, `…-b`) so the gateway keeps their
  traces, spend and session state apart. Ping cost is added to both arms. Rounds across a
  gateway restart are left out of the Rule 0 stats.
- **`--experiment-b`**: the run says before it starts which rule B's tag matches (or that
  none does). Each round records the rule before and after (`experimentRule`, with
  `stable: false` when it was missing or changed).
- **Holdouts**: each round records which requested kinds were held out of each arm
  (`heldOut: { a, b, differs }`, from the `guard` the gateway names on a `safety_gate`
  skip). Under `--redraw-holdout N`, when either session reports a holdout on one of its
  first three responses, both are stopped and the pair starts again with fresh sessions,
  up to N times. Discarded draws are in the round's `redraws` and not in its cost.

## Session end and grading

`claude -p` can stay alive after its final answer (a scheduled wakeup, a background
command). Once the last turn's result is in, the input is closed, no background task runs
and nothing has happened for 30 seconds, the harness ends it. Wall time runs to the final
answer, never to the kill.

A session killed at its timeout is graded on what it had answered. Claude Code holds a
turn's result back while a background agent still runs, so when the main agent's last
message completed its turn, that text is the answer (`timedOutAfterAnswer`). It is
graded, but has no cost: Claude Code never reported the bill, so the round is excluded. A
main agent killed mid-request or mid-tool-call never answered: unsolved, no cost.

Findings the main agent files with Claude Code's `ReportFindings` tool (accepted calls)
are part of its answer: each is graded as `file:line — summary — failure scenario` beside
the result text, at the same bar. Both arms follow the same rules.

A session can write its documentation to a file in the checkout and answer with a short
pointer to it. `git diff` (and so `diff`/`diffPatch`) skips untracked files, so before the
checkout is deleted the harness lists the doc files (`.md`, `.markdown`, `.rst`, `.txt`) the
session created or changed: `writtenDocs`, each with its path, git status and bytes, never
its contents (at most 20, the rest counted in `writtenDocsOmitted`). Files already changed
before the session (a scenario patch, the warm-up) are left out. On a citation-graded
scenario each file up to 2 MB gets the answer's citation check. A listing that fails
records `writtenDocs: null` and `writtenDocsError`; the round goes on. When an unsolved
citation-graded session wrote a file that would pass the citation rule, `answeredViaFile`
names it (`{ path, resolved, total }`). The session stays unsolved: the final answer is
what is graded, and Rule 0 and the verdict are unchanged. The round line adds
` · wrote <path> (<resolved>/<total> citations)` and ` · answered via file (not solved)`,
and the verdict's Excluded line counts such rounds within not solved
(`not solved 2 (answered via file 1)`).

The gin scenarios also apply `fixed-ports-lock.patch`. Several gin tests bind fixed ports,
and both arms run `go test` on one machine at once. The patch adds a `TestMain` that makes
concurrent runs of that package's tests take turns, and gives each test binary its own
temp dir, so `TestUnixSocket` never meets another run's socket. No test or library code
changes.

`npm run cold-turns` reports, for each turn after a long pause: whether the gateway
attested the cache expiry, the tokens each strategy removed, what the provider wrote and
read, and why a strategy declined. It flags a gateway restart, different kinds held out
per arm, a rule that changed, or a cold turn that was not attested.

## Parity twin

The parity twin is [twins/go-protogetter-lint](../twins/go-protogetter-lint): fix the
protogetter findings in hashicorp/go-plugin v1.6.3 (43 findings in six files), pinned to
Go 1.27.1 and golangci-lint 2.13.2. A shim maps the old `--disable-all` flag to
golangci-lint v2's `--default=none`. The grader runs the real binary and fails on any
finding, a failed build or test, a `nolint` comment, or a lint-config edit.

A twin names no customer. `tests/customerIdentifiers.test.mjs` checks every tracked file
against hashed identifiers, by whole word.

## Bedrock small model

Claude Code sends some side calls, such as WebFetch's page summary, to a small model. Arm
B looks like the Anthropic API to Claude Code, so Claude Code picks its own Haiku there.
On Bedrock, Claude Code sends those calls to the main model unless
`ANTHROPIC_DEFAULT_HAIKU_MODEL` is set. Arm A would then pay Sonnet prices for calls arm B
makes on Haiku, and the gap would look like a gateway saving.

So arm A gets `ANTHROPIC_DEFAULT_HAIKU_MODEL` = Haiku 5.5 in the main model's inference
profile (`us.anthropic.claude-sonnet-5` → `us.anthropic.claude-haiku-5-5`). Each arm's
setup records the model and where it came from (`setup.<arm>.smallFastModel`). A round
where the arms ran one model family on different models (`result.modelUsage`) is flagged
in `modelsDiffer` with a warning. Neither Bedrock arm carries a subscription token.

## Per-token agents

**`sdk-docs`.** InvokeModel does not stream, and a long answer takes minutes, so the AWS
CLI read timeout is raised from its 60 s default to 600 s; a failed call's error carries
the CLI's stderr. The Anyray arm sends the benchmark client key as bearer, and the gateway
selects its provider. `ANYRAY_BEDROCK_MODEL` can pin the direct model; otherwise the
gateway route probe resolves it. The scenario continues early answers until at least
eight model requests have run. Sonnet 5 can end a turn on thinking alone, so a final
reply with no text gets one more answer-only request with the same tools.

**`framework-docs`.** The chat model is bound to three zod-declared tools (the same read,
list and search as `sdk-docs`). Both arms run the same graph and model class; only the
HTTP client under the chat model differs. Each model request is one turn. The last
allowed turn asks for the answer with the tools still declared but not callable. A reply
with neither tool calls nor text gets one more answer-only request.

The Anthropic SDK reads `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` and API keys from
the environment, so a shell inside a routed Claude Code session would otherwise send both
arms elsewhere. The agent builds its clients without them, and refuses any request to
another host or with an `x-anyray-*` header it did not set. Each request's content block
types are stored too.

**`framework-api-agent`.** The same graph agent on a synthetic internal API: `searchApi`,
`selectApi` and `apiCall` over a catalog generated from a seed (`lib/apiCatalog.mjs`, written
to the work directory as `catalog.json`), so both arms see identical data. It reproduces the
general form of a graph agent on a company API: a search, select, call chain, six pages of
results piling into the context, and a model call per step. The task is graded by an exact
answer line (`keyFacts`), computed from the raw records, not by a model. Direct is Bedrock,
as for `framework-docs`. A live run is required to establish route parity and measured savings.

A live run is required to establish route parity and measured savings.

## Codex hook isolation

Codex keeps the real `~/.codex` (the seat login is never copied), with
`--ignore-user-config`, the route as `-c` overrides, and the client key in an env var
(never argv). Each session's threads are deleted afterwards (`--keep-codex-threads` keeps
them). With `ANYRAY_CONNECT_BIN` or `--connect-bin-b` set, each arm's home starts from a
no-app profile, and the round fails unless its MCP server (and hook) run the named build.

`--kinds` is not sent because the gateway refuses `x-anyray-optimization-kinds` on
anything but an inference POST, so it would fail Codex's WebSocket upgrade (a GET). What
the gateway did comes from its traces (`ANYRAY_ADMIN_KEY`). Cache writes are priced at
1.25x.

The gateway's Codex seat lane relays byte-identical and optimizes nothing. `--compare anyray` asks whether the relay costs
anything; `--codex-hooks-b` isolates connect's client-side hook.

Under `--codex-hooks-b`, B runs exactly one hook: the one anyray-connect installed in B's
home, declared as session config and trusted by its own `hooks.state` entry (never
`--dangerously-bypass-hook-trust`). Every handler in the real `~/.codex/hooks.json` is
switched off by key as well. It runs through `lib/codexHookShim.mjs`, which runs connect's
hook under B's home and puts that home in front of the `__anyray-shell-run` it answers
with. The trim then reads B's profile and tees into B's `~/.anyray/hook-tee`, never the
real one. The wrapped command keeps the real Go caches and git config
(`wrappedCommandEnv`).

A round counts B as acting only when B's own connect wrapped a command. The trace tallies
are kept apart in `gatewayOptimization`, since the gateway edits both arms alike. The
round leaves the stats (`hookLeak`) if any command was wrapped on A or by another connect
on B. Each B session records the wraps, digest footers, the shim's outcomes and the tee
count. `--connect-bin-b /abs/<dir>/anyray-connect` configures B from another build (its
sha256 prefix is recorded, never the path).

## Agent SDK app preflight

The auditors trace with the SDK's Read, Grep and Glob tools. Each audited function calls a
helper that decides the outcome, defined at the end of another module (eight of nine past
line 1,000), so finding one takes a search, then reads of located ranges in several files.
`seeded-vulns.patch` is imported as one commit.

For arm D the runner first enrolls Connect in a private HOME, once per run, the way an
agent host does it. It configures no client there: the server needs only the enrolled
profile. It then mounts only Connect's MCP server (`anyray-connect __anyray-mcp-server
claude`, HOME set to that private HOME) in the app as `anyray-connect`. The app runs under
its own environment and never reads that HOME. D hides the server's own
`anyray_retrieve` and `anyray_recall`.

Before the first paid round the runner checks with `tools/list` that the server offers the
batch read. It then makes one batch read by absolute path in a fresh checkout, because the
SDK's Read and Grep hand the model absolute paths. It stops if either check fails: a
Connect build older than ANY-1124 refuses those paths (`unsafe_path`). Arm E's preflight
also requires that `initialize` carries instructions, so a build without them stops the
run instead of measuring D twice.

`tools/probe-sdk-code-scan.mjs` starts the server as the arm does in a fresh checkout,
makes one batch read call, then starts the SDK with the arm's options against a closed
local port and reads its init message. It shows which tools the model is offered and
where the server runs. Last, it runs the app against a local fake of the Messages API
that spawns one auditor, and reports whether the server's instructions reached the main
agent's request and the auditor's.

`tools/compare-sdk-app.mjs` checks that D's agents called the batch read, with at least one
call not errored, in at least half the D sessions. Each session records its tool calls by
name and its `readBatch` calls and errors.

## Run options in detail

- **`--parallel N`**: rounds are numbered when the run starts, and the result file stays in
  round order whichever finishes first. Round lines are prefixed with the round number.
  With `--with-control`, the main comparison and the control share the one budget: at most
  N rounds in flight across both, half the slots each (rounded up) while both run. The
  value is recorded as `parallel` in each arm's setup.
- **`--max-turns N`**: recorded as `maxTurns`, `maxTurnsSource: "--max-turns"`. connect
  reads the cap off the Claude Code process. Below 80 the result records
  `connectWorkMode: "off_turn_cap"`. Results recorded before 2026-10-12 ran at 20 to 40
  turns, with the mode off.
- **`--claude-bin <abs path>`** (or `ANYRAY_CLAUDE_BIN`; the flag wins): a `claude`
  executable (for example `~/.local/share/claude/versions/2.1.286`) or a directory holding
  one; it must exist and be executable. It is used for the task session and the warm-up.
  Auto-update changes how sessions split work into subagents without the harness saying
  so. The run header ends with the version in use. Recorded in `request.claudeBin`
  (`source`, `version`) and each arm's `client`, `claudeVersion`, `claudeBinSource` (never
  the path).
- **`--timeout-min N`**: e.g. Opus 5.5 on Bedrock runs past `pyrepo-docs`'s 10 minutes.
  Recorded in `request.timeoutMin`.
- **`--no-subagents`**: `--disallowed-tools Task Workflow`. Recorded in
  `request.noSubagents`.
- **`--warm-up`**: without it, an arm whose setup changed since the previous run starts
  cold while the other reads a prefix that run left warm. The cost is recorded as
  `warmUp.costUsd` and never added to the session's cost.
- **`--mcp-catalog N`**: `tools/mcp-catalog-server.mjs`, tools of about 2,085 chars each
  (200 ≈ 417k chars of MCP schema). Recorded in `request.mcpCatalog`.
- **`--experiment <name>`**: unlike `--strategy` it implies no kind and no isolation check;
  the two cannot be combined. Recorded in `request.experiment`. `--experiment-b`: A keeps
  `--experiment` if given, else no tag. Recorded in `request.experimentB`.
- **Session persistence**: both arms keep their transcript, as Claude Code does outside
  the bench, so connect hooks that read it (the digest cost gate's usage, read trim,
  retrieval proof) see one. Transcripts in the real HOME are removed after the session.
  Recorded as `request.persistSession` (absent in older files, which did not persist).
- **`--retry-invalid N`**: the dropped round stays in the result file and the verdict;
  `retries` lists each one and the round that replaced it.
- **`--kinds-b`**: e.g. the shipped defaults vs the defaults plus one default-off kind.
  Recorded in `request.kindsB` and each arm's `optimizationKinds`.
- **`--read-trim-b`**: needs `--integration-level gateway_hooks_mcp` when a level is set.
  Recorded in `request.readTrimB`. It is `--hook-posture-b readTrim=on`, and `--read-trim`
  is `--hook-posture readTrim=on`.
- **`--hook-posture-b <name>=<on|off>`** pins `fleetHookPolicy.<name>`, e.g. `logRead=on`.
  - The pinned arm's hooks read a private copy of connect's profile with key refresh off,
    so policy sync cannot rewrite it. With a switch on, session persistence is on too.
  - After each round the harness reads the profile back. If a pinned switch changed or
    disappeared, the round fails.
  - A switch set both on and off for one arm is refused, and so is the same switch in both
    flags. `--integration-level gateway` and `--bare` install no hooks, so they refuse it.
  - A keeps the team posture (`anyray.connectPolicy.hooks`). The harness does not know
    which switches your connect build reads, so an unknown name changes nothing.
  - Recorded in `request.hookPostureB` / `request.hookPosture`, each arm's
    `setup.hookPosture`, the session's `hookPosture` (`set`, `pinned`, `atEnd`), and the
    round line's arm label (`anyray + hook:logRead`, or `hook:logRead=off`).
- **`--seed-home <path>=<absolute file>`**: e.g. `.anyray/hook-digest-routers.json` for
  the digest cost gate (`hooks.digestEconomics`). Under `--compare gateway` both arms get
  the same files, so it is never the treatment.
  - `<path>` is relative to the HOME and must stay inside it. `--compare control`, `--bare`
    and an arm connect could not configure refuse it.
  - Recorded as each file's HOME path and a sha256 prefix (`request.seedHome`,
    `setup.seedHome`). Keep a seeded run apart with `--label`.
  - After each session the arm records `setup.activity.hookDigestRouters` (router, version,
    emits, read-backs), `setup.activity.hookTeeDigest`, and
    `setup.activity.hookHints.truncatedTestRun` by wording: `first_10k` (the original) and
    `head_tail` (the wording `hooks.shellRewrite` turns on, ANY-995).
- **`--arm-env b:KEY=-`**: connect re-applies its configuration when its MCP server starts,
  which would write the key straight back. Such a session runs with connect's refresh off,
  and the round fails if the key is back in the arm's settings afterwards.
- **`--client-tool-policy`**: written to the Anyray arm's connect profile
  (`clientToolPolicies`) after connect configured it. Recorded in the arm's setup.
- **`--client-tool-policy-b`**: the same, on arm B alone, layered over `--client-tool-policy`
  (a switch set by both is refused). Recorded as `request.clientToolPoliciesB`. A switch left
  unset follows the tenant's policy, so a tenant-on tool is measured with A on the default,
  B set off, and `--treatment a`. The arms share their kinds, so the verdict counts the
  treatment as acting only where it made more connect client-tool calls than the control:
  each session records `readBatchCalls` / `readBatchOk` and `searchContextCalls` /
  `searchContextOk` (`mcp__anyray__anyray_search_context`, Symbol context), main agent and
  subagents.
- **`ANYRAY_BENCH_EXTRA_HEADERS`**: the harness's own headers (key, metadata, provider,
  auth mode, kinds) cannot be overridden. Only names are recorded (`request.extraHeaders`,
  and `request.extraHeadersOn` for the slots).
- **`ANYRAY_BENCH_SHARED_HEADERS`**: never the treatment, so a header in both lists is an
  error. Names are recorded in `request.sharedHeaders`.

## Connect checks

`lib/connectChecks.mjs` records both lists in the arm's setup (`connectChecks`,
`sessionChecks`) and prints how many passed.

- **What connect wrote**, before the session: `ANTHROPIC_BASE_URL` is the gateway, no
  direct-cloud switch is set, the metadata header is there, and the auth matches the lane
  (subscription: passthrough headers and no auth token; org: the gateway key as the auth
  token and no provider pin). Hooks, the `anyray` MCP server, its tool permission and the
  `anyray` skill are checked against the requested integration level.
- **What the session loaded**, from Claude Code's init event: the `anyray` MCP server and
  retrieve tool are present at `gateway_hooks_mcp` and absent at lower levels.

Advisory checks (tool search setting, connectors MCP) are reported only.

**Pinned builds.** If the Connect desktop app is installed, connect hands its setup to the
app. The arm's launcher (`<HOME>/.anyray/bin/anyray-connect`) then links to the app's
binary, and hooks and the MCP server would run the app's build under the same command
name. Two things stop that:

- Before connect runs, every arm of a run with a pinned build gets a profile with
  `{"trayAppPath": "/nonexistent/Anyray Connect.app"}` at `.anyray/connect.json`, so
  connect does the setup itself. With `--connect-bin-b`, arm A gets the same profile. Your
  own `--seed-home .anyray/connect.json=<file>` replaces it. `setup.seedHome` records it
  with `by: "harness: …"`.
- A check follows each hook, MCP server and `apiKeyHelper` command to the file it runs,
  symlinks included, and compares it to the pinned build by real path, or by content for a
  copy. A different build fails the arm's setup before the session. The same check runs
  after the session (`session: …`) and fails the round if a refresh re-pointed the
  launcher. Details name sha256 prefixes and an app bundle name, never an absolute path.
  Without a pinned build the check is reported only.

## Integration level

`--integration-level` works with `--compare anyray` and `--compare gateway`. Leave it unset
to keep the current behaviour. The requested level is recorded in the result, and each
Anyray arm must report the same applied level and pass the matching hooks, MCP,
permission, skill and session checks. Use a Connect build that reports
`appliedIntegrationLevel` in `status --json`.

The `ANYRAY_CONNECT_BIN` override is used for enrollment, status and fallback MCP
commands; results record only its basename. `bench-level` uses `ANYRAY_GATEWAY_URL`,
`ANYRAY_ADMIN_KEY` and `ANYRAY_BENCH_CLIENT_KEY` (or `ANYRAY_CLIENT_KEY`). It backs up the
prior assignment under ignored `results/` and sends revision-checked team-policy writes
that preserve the skills list and other policy fields. `ANYRAY_BENCH_AGENT_ID` /
`ANYRAY_BENCH_USER_ID` set `--agent` / `--user` for `run_agent.mjs`. The tool never reads
any key's secret.

## Dedicated tenant

The Anyray arm (harness- or connect-configured) uses `ANYRAY_BENCH_CLIENT_KEY` instead of
`ANYRAY_CLIENT_KEY`, and the result records `tenant: { tenant, keyVar, dedicated }` (never
the key). A separate tenant needs tenants and keys from the control plane; on a
single-tenant deployment every key is in `default`.

## bench-rule params

`per-experiment` adds one rule per strategy. A rule matches `tool == "anyray-bench"` and
`experiment == <kind>`, and turns that strategy on and every other one off. With
`--strategy <kind>` the Anyray arm sends `experiment=<kind>` in `x-anyray-metadata`, and
each round records whether any other strategy acted (`isolation.ok`).

`params <experiment>` adds one rule that matches `tool == "anyray-bench"` and
`experiment == <experiment>` and carries strategy params only: it turns nothing on or
off. The optimizer config is one document that other people edit too, so `params` and
`remove-params` re-read it right before writing, send the revision they read, and read it
back to confirm every other rule is unchanged. `remove` and `per-experiment` do not touch
these rules. Gateways in `config.yaml` `run.blocked_gateways` are refused by both the
runner and this tool, and this tool never changes our hosted gateway (gateway.anyray.ai).

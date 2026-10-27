# Kit internals

Detail for running the client-test kit by hand, in CI, or as an operator: what each
command checks, records and refuses. To run a test, start at the
[README](../README.md#test-it-on-your-own-work); the `anyray-test` skill runs these
commands for you.

- [Doctor](#doctor)
- [Plan](#plan)
- [Predictions and calibration](#predictions-and-calibration)
- [Freeze and verify](#freeze-and-verify)
- [Multi-tenant gateways](#multi-tenant-gateways)
- [Noise and paired runs](#noise-and-paired-runs)
- [Records](#records)
- [Verdict, report and publish](#verdict-report-and-publish)
- [Rerun on every release](#rerun-on-every-release)
- [Public twins](#public-twins)

## Doctor

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

## Plan

For client scenarios, set `source: client` (or `proposed` for a task we proposed) and pin
`repo.ref` to a 40-character commit. Keep the directory locally.

```bash
npm run -s plan -- --scenarios-dir ./client-scenarios --budget-usd 500 --gateway https://your-gateway.example --json
```

With a budget alone, the plan sets `pairsPlanned: null` and the spend ceiling to your
budget. Pairs are set after noise measures your session cost.

Optional `--session-cost-usd 0.15` supplies your typical direct session cost. The plan
then takes the six noise rounds (two direct sessions per scenario each) off the budget
first, splits the rest evenly across scenarios, and reports pairs needed, the saving
detectable at that budget, and a spend ceiling that includes the noise rounds.

- A budget that cannot cover noise plus one pair per scenario is refused with
  `plan_budget_too_small` and the minimum budget. An insufficient budget is reported with
  `resolvable: false`.
- It uses the paired log-ratio SD prior of 0.924, 80% power and two-sided 95% confidence:
  20%, 10% and 30% savings need 135, 604 and 53 pairs.
- With the test key, the plan reads your tenant's context. Kinds that are on or in shadow
  are evaluated on the test sessions only. Kinds that are off stay off. An unreadable
  context blocks planning.
- The plan makes no model calls and writes no files. Omit `--json` for human output; use
  `--client codex` to classify a Codex seat (the default is Claude Code).
- Operators and CI can still set an admin token to use the existing routes. On that path,
  `--tenant <id>` selects a tenant and an all-shadow gate blocks planning.

## Predictions and calibration

[predictions.yaml](../predictions.yaml) records bands from the published results. Every
current seed has fewer than eight attributable public rounds, so it prints
`prediction: none`. The older aggregate run cannot supply per-shape round counts. The
check-single shape also cannot distinguish a short fix from test-output triage; its
source records both ratios and the resulting wide band.

Each release refreshes the catalog from vendor-admin's content-free calibration document:
run `npm run calibrate -- --from <file>`, then review and commit `predictions.yaml`.
Calibration keeps every miss and publishes a band's hit rate after eight client test
rounds. Plans show how often the band was right; reports read the current catalog.

## Freeze and verify

Freeze records the predictions and the kit's Git HEAD before the run:

```bash
npm run -s freeze -- --scenarios-dir ./client-scenarios --model claude-sonnet-5 --provider anthropic --client claude-code --client-version 2.1.300 --gateway https://your-gateway.example --json
npm run -s verify -- --scenarios-dir ./client-scenarios --json
```

- The keyed plan hash covers every scenario file, pins, kit commit and prediction.
- Verify keeps the frozen predictions even if the catalog changes.
- `freeze --replace` writes a new plan with a fresh nonce and the current catalog.
- The lock contains ids, hashes and predictions; task and file contents stay local. The
  lock's nonce stays local too.
- `--kinds auto|<k1,k2>` pins the optimizer kinds the test evaluates, for multi-tenant
  gateways. See [Multi-tenant gateways](#multi-tenant-gateways).

## Multi-tenant gateways

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

## Noise and paired runs

Run `anyray-connect test-key --json`, then `npm run -s doctor -- --json`. Plan, noise,
run, verdict, report, publish-result and release-check need no admin token. Both arms use
the resolved `--claude-bin` build, checked against the version in the lock. Keep the same
gateway and key throughout the test.

```bash
npm run -s noise -- --scenarios-dir ./client-scenarios --claude-bin /absolute/path/to/claude --rounds 6 --budget-usd 500 --json
npm run -s run -- --scenarios-dir ./client-scenarios --claude-bin /absolute/path/to/claude --budget-usd 500 --redraw-holdout 2 --json
```

**Noise.** At least six interleaved direct-vs-direct pairs per scenario measure the
pooled within-scenario log-ratio SD. A signed `noise` block records that floor without
changing the plan hash, and the command reprints pairs needed at the measured SD.
Repeating `noise` or `run` adds rounds to that plan.

**Budget guard.** Pass the same positive `--budget-usd` to noise and run. Before every
round, the guard counts all recorded session costs for the plan, including earlier noise
and failed rounds. It stops if spend has reached the budget or if adding the most
expensive recorded round would exceed it. Only a plan's first round has no cost estimate.
`budget_reached` exits successfully and reports spend, budget and rounds run by this
command, possibly zero. Without `--rounds`, a budgeted run uses the remaining budget
divided by the mean recorded pair cost, rounded down and capped at the band's pairs
needed.

**Failures.** Each finished round prints its id, costs, ratio, total spend and estimated
time left on stderr. Failed rounds are saved and excluded from scoring. One failure lets
the run continue. Two consecutive failures stop with `run_failed`; `auth_error` stops at
once. Other failure labels are `timeout`, `no_result`, `crash` and `gateway_error`. A
failure stop exits 1.

**What a paired run sends.** Paired runs use the test key's evaluation cohort without a
kinds selection header (unless the plan pinned `--kinds`). They record `kindsObserved`,
send `tool: anyray-bench` on every gateway request, and use a hash prefix for attribution
instead of the client's scenario name. Early holdouts of any kind trigger fresh pairs; the
final draw is excluded as `holdout drawn`, even with `--redraw-holdout 0`. The default is
two redraws. Header overrides from `ANYRAY_BENCH_EXTRA_HEADERS` or
`ANYRAY_BENCH_SHARED_HEADERS` are refused.

## Records

Records live in `<scenarios-dir>/.kit-results/<planHash>/`, with an ignoring
`.gitignore`. They keep hashes, counts, costs, outcomes and versions, built from an
allowlist after grading. Tasks, repositories, patches, transcripts, tool I/O, diffs and
check output do not enter the records. Replacing a frozen plan starts a separate results
directory.

## Verdict, report and publish

```bash
npm run -s verdict -- --scenarios-dir ./client-scenarios --json
npm run -s report -- --scenarios-dir ./client-scenarios --redact
npm run -s report -- --scenarios-dir ./client-scenarios --redact --json
npm run -s publish-result -- --scenarios-dir ./client-scenarios --json
```

- Verdict uses both verdict libraries and compares actual medians with the frozen bands.
  It also prints the [tail check](harness-internals.md#tail-check), one line per
  scenario, local only.
- Report requires `--redact`. Its human form includes scenario ids; JSON contains
  aggregate shapes and statistics only. The JSON body keeps full precision; human ratios
  and confidence bounds use three decimals.
- The body is validated against the gateway client-tests schema before it is printed or
  published. A missing or mixed gateway version prevents sharing.
- Publishing sends that same body to the frozen gateway and prints only the result id.
- For legacy `results/agent/` records, `npm run agent:report -- --redact` builds an HTML
  page from an allowlist too.

## Rerun on every release

Copy [kit/workflows/anyray-regression.yml](../kit/workflows/anyray-regression.yml) into
your private scenarios repository as `.github/workflows/anyray-regression.yml`. Commit the
scenarios and `plan.lock.json` at its root after measuring noise.

| Setting | Kind | Value |
|---|---|---|
| `ANYRAY_GATEWAY_URL` | variable | your gateway |
| `ANYRAY_ADMIN_KEY` | secret | needs `settings:read`, `client-tests:read`, `client-tests:write`, `optimizer:read`, `traces:read`, `spend:read` |
| `ANYRAY_BENCH_CLIENT_KEY` | secret | the benchmark client key |
| `ANYRAY_UPSTREAM_TOKEN` | secret | provider API credentials for CI |
| `ANYRAY_TEST_RUNNER` | variable, optional | runner label, default `ubuntu-latest` |

The daily check runs `release-check`: it compares the gateway version with the newest
published result of this plan. Only a changed version starts paid rounds; a manual
dispatch also runs them. The kit commit and Claude Code version come from the lock, and CI
keeps the frozen plan and noise floor. An unreadable gateway fails the check. To check
locally:

```bash
npm run -s release-check -- --scenarios-dir ./client-scenarios --json
```

- For a Bedrock plan, select a self-hosted runner whose instance role reaches Bedrock.
- If you add OIDC, add `id-token: write` to your workflow copy.
- The template supports Claude Code plans.

## Public twins

Our public [twins/](../twins/) describe task shapes on public repositories. Their ids and
titles describe the task; client scenarios stay private. Optional `twinOf` links a
proposed scenario to a client's frozen plan hash (64 lowercase hex, never all zeros).
Leave it absent until a client plan exists. Publishing that field needs a gateway whose
client-tests schema accepts it; the seed twin omits it.

```bash
npm run twins -- --release v1.10.520 --gateway https://your-gateway.example --rounds 8 --json
```

Twins need benchmark and admin credentials. They freeze a fresh temporary copy, measure
six noise rounds, run paired rounds (eight by default), and publish with the supplied
release tag. The gateway version is recorded separately. The committed twins stay
unchanged, and the temporary copy is removed on exit.

A twin with `lane: api-key` in its `scenario.yaml` is left out of this rerun: it is for
the parity check with `--upstream api-key`, and the rerun is the seat lane.

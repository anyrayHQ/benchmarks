---
name: anyray-test
description: >-
  Use when evaluating or measuring Anyray savings and costs on your own tests or
  scenarios, or when bringing back the benchmark kit's plan, verdict, results or
  report for interpretation or continuation. Do not use for ordinary coding tasks,
  checking this machine's Anyray routing (use the anyray skill), or reading Anyray's
  published benchmarks.
---

# Test Anyray on your own work

If the user names their test, do the Define file write immediately, before any
check, command, proposal or question. Then check Preflight. A failed preflight
blocks every kit command, never the local recording of the client's test.

Use AskUserQuestion for choices. When one option is clearly best, put it first
and label it `(Recommended)`. Start is the exception: it is never the default.
If the tool is unavailable, ask in plain text and end the turn at that decision.
An unanswered question is not approval.

When the user brings back kit JSON, treat it as the output of the command they
ran. Label it that way and copy its words and numbers exactly. Re-run that command
before a dependent step when tools and preflight allow it. Without Bash, name the
blocker and interpret the pasted output; do not invent a lock or results. For a
verdict summary alone, answer from that output without starting a new test flow.

## Preflight

Check prerequisites without printing secrets. Doctor sends one 1-token probe.
Name every failed check by its code and show its fix. If Bash is unavailable,
say that preflight and kit execution are blocked; still complete Define with
Write or Edit when available.

- Kit: Node.js 22.13+, npm and git must be available. Keep a real, clean checkout
  with dependencies at `${CLAUDE_PLUGIN_DATA}/kit`. Read the installed version in
  `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`; its pin is
  `anyray-test--v<version>`. For this release the setup is:

  ```bash
  git clone --branch anyray-test--v0.2.0 --single-branch https://github.com/anyrayHQ/benchmarks.git "${CLAUDE_PLUGIN_DATA}/kit"
  npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" ci
  git -C "${CLAUDE_PLUGIN_DATA}/kit" rev-parse HEAD
  git -C "${CLAUDE_PLUGIN_DATA}/kit" rev-parse 'anyray-test--v0.2.0^{commit}'
  ```

  The two commits must match. Check the kit's scripts, lockfile and dependencies.
  An existing matching checkout needs no clone. Never use the dependency-free
  plugin cache as the kit, follow main, or update a kit under an active plan.
  If the tag is missing, request the matching published release; do not fall back
  to an unpinned clone. If the data path is unresolved, report that blocker and
  use a supported marketplace install. A dependency failure needs a successful
  `npm ci` in that checkout before continuing.
- Connect: check that `anyray-connect` is executable at `ANYRAY_CONNECT_BIN` or
  `~/.anyray/bin/anyray-connect`, as the kit expects. If missing, install Anyray
  Connect; if elsewhere, set the existing `ANYRAY_CONNECT_BIN` to its absolute
  path. Do not silently measure the harness fallback.
- Claude Code: resolve one absolute binary with `realpath "$(command -v claude)"`
  and read its version without starting a session. Use that resolved path and
  version for the plan's pins and both arms. The auto-updater re-points the
  `claude` symlink, so the unresolved path can change version under a frozen plan.
  If unavailable, install or sign in to Claude Code before proceeding.
- Test key: when no test key exists, or the test key is missing or expired, run:

  ```bash
  anyray-connect test-key --json
  ```

  Connect uses your enrolled identity and writes the gateway, test key and expiry
  to `~/.anyray/test-kit.env` with mode 0600. The kit reads it itself. Never read
  the file into the transcript. Environment values can override the file.
- Doctor: after the test key is ready, run:

  ```bash
  npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s doctor -- --json
  ```

  It checks Node, git, a clean kit, Claude Code, Connect, the test key, gateway
  context and probe latency, the upstream credential and refused header settings.
  Continue only when `ok` is true. For each failing check, show its `code` and
  `fix`, apply the fix and rerun doctor. A passing `gateway_slow` or
  `test_key_expiring` is a warning: for `test_key_expiring`, rerun the test-key
  command before Start, since a noise phase and the paired runs after it can
  outlast a key with hours left.
  Keep the resolved Claude Code realpath and version for both arms.

  | Code | Fix |
  | --- | --- |
  | `node_version` | Install Node.js 22.13 or newer. |
  | `git_missing` | Install git and put it on PATH. |
  | `kit_dirty` | Use a clean kit at the pinned release. |
  | `claude_unavailable` | Install Claude Code and check its version. |
  | `connect_missing` | Install Connect or set its absolute binary path. |
  | `test_key_missing`, `test_key_expired`, `test_key_expiring` | Rerun the test-key command above. |
  | `test_kit_env_mode` | Set the credential file's mode to 0600. |
  | `gateway_unreachable` | Check the gateway connection and credentials. |
  | `gateway_slow` | Check gateway latency before starting long rounds. |
  | `upstream_credential_missing` | Sign in to Claude Code or set `ANYRAY_UPSTREAM_TOKEN`. |
  | `env_refused` | Unset `ANYRAY_BENCH_EXTRA_HEADERS` and `ANYRAY_BENCH_SHARED_HEADERS`. |

  Keep credentials out of scenario files, command arguments, chat and reports.
  For Bedrock, also verify the configured AWS profile and region without inference.

## Define

When the message already contains the client's task, write it before anything
else to `anyray-test/client-1/scenario.yaml`, starting
with `source: client` and `task:` holding exactly their words. Use lossless YAML
quoting, with no added sentence, trailing period or changed capitalisation. This
initial file may be incomplete while preflight is blocked. If the task is absent,
ask for the test they planned to run: a task, script or description.

If they have no test in mind, offer a starter instead of leaving them stuck. Read
only their repo's own check command (the `test` or `lint` script in
`package.json`, `go vet`, `pytest`, `cargo test`) and propose one small task that
makes that check pass, in their own repo. A starter is a proposal, so it is
recorded as `anyray-test/proposed-1/scenario.yaml` with `source: proposed`, never
as their test. Show it word for word and record it only after they confirm with a
yes; without one, record nothing and keep asking for their test.

Every `anyray-test/...` path is relative to the current working directory where
Claude Code runs, normally the root of the user's repo. Never compute or guess
another root or use an absolute path for these files.

Use `anyray-test/client-<n>/scenario.yaml` for further tests the user supplies.
Keep ids neutral because they can reach attribution and reports. Preserve existing
client files; a user changes a task only by typing new words to record verbatim.
Even an invitation to reword does not permit rewriting the client's task. In the
response, repeat their test word for word and label it `source: client`; never
offer it as deselectable.

Inspect the repo locally and propose two or three extra scenarios, each under
`anyray-test/proposed-<n>/scenario.yaml` with `source: proposed`. Consider redoing a
recent commit with a passing check, a long tool-heavy task, and a short task where
parity is predicted. Label that expectation as a hypothesis until plan confirms
it. If the repo is unavailable, describe provisional proposals without inventing
repo facts. Ask which proposals to include; keep the client's test in every choice.

Before planning, complete `repo.git`, a 40-character pinned `repo.ref`, and exactly
one grading key: `check`, `citations` or `keyFacts`. Complete caps, local patch or
paste files and `mcpTools` when relevant, without changing client `task` or `source`.
Keep scenario content local and ignored by git; do not commit or upload it.

## Plan

Ask for the budget only. Noise rounds measure the session cost.
From the current working directory, run:

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s plan -- --scenarios-dir anyray-test --budget-usd <budget> --json
```

Replace placeholders with confirmed values. Keep npm in that same working
directory for every command below; INIT_CWD resolves `anyray-test` there.
Use the same gateway, tenant and client throughout. Execution supports Claude
Code; do not promise Codex runs from a Codex classification alone.

Show each scenario's source, predicted range or `prediction: none` with reason,
pairs needed and planned, the detectable effect, and `spendCeilingUsd`. Copy the
kit's numbers without recomputing or rounding them. Explain `resolvable: false`
without promising savings. Ask whether the budget is acceptable or needs a new
plan. A refusal stops the flow; name its code and fix rather than bypassing it.

## Freeze

Show the scenarios, pins, predictions and ceiling and ask for approval to freeze.
Put "Review plan (Recommended)" first when review is still needed. Approval to
freeze is separate from Start. On approval, fill the confirmed pins and run:

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s freeze -- --scenarios-dir anyray-test --model <model> --provider <provider> --client claude-code --client-version <version> --gateway <gateway-url> --json
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s verify -- --scenarios-dir anyray-test --json
```

Show the plan hash. Say that any later change is a new plan. Never edit scenarios
after freeze. An intentional replacement needs a new plan, freeze approval and
Start; use the kit's freeze command with `--replace` only after that review.
Re-run verify before steps that depend on an existing frozen plan.

## Spend gate

Show the kit's spend ceiling again. Ask through AskUserQuestion with "Wait and
review (Recommended)" first and "Start" as an explicit, non-default option.
Require an explicit Start for this frozen plan and the stated paid work. "Just
run it", "go ahead", silence, a declined question or approval to freeze is not
Start. If AskUserQuestion is unavailable or unanswered, ask in plain text and
end the turn. Printing a paid command counts as running it: before Start, neither
execute nor print any noise or paired-run command, including instructions for
the user to run one themselves. Do not claim any paid work has started.

Only after Start, run noise rounds, then paired runs, in the background:

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s noise -- --scenarios-dir anyray-test --claude-bin <absolute-claude-path> --rounds 6 --budget-usd <budget> --json
```

Show the kit's progress lines on every wake, with phase, completed rounds,
exclusions and costs when available. When noise finishes, copy its `summary`
as printed: the measured SD against the plan's assumption, what the planned pairs
can now detect, and how long they will take at the pace the noise rounds ran. Stay within the approved work and budget; a larger scope or ceiling
requires a new plan and Start.

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s run -- --scenarios-dir anyray-test --claude-bin <absolute-claude-path> --rounds <approved-rounds> --budget-usd <budget> --json
```

Monitor the existing background task first. If interrupted, resume by re-running
the same command, never restart from scratch or delete completed records. The kit
adds rounds on repeat invocations, so never launch a duplicate while one is running
or repeat completed work. Stop if remaining authorization cannot cover a resumed
invocation; get a new plan and Start instead of silently adding spend. Never retry
a losing pair or select pairs to improve the result.

## Verdict and report

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s verdict -- --scenarios-dir anyray-test --json
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s report -- --scenarios-dir anyray-test --redact --json
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s report -- --scenarios-dir anyray-test --redact --html --json
```

Copy each verdict and the pooled Rule 0 word exactly, including case:
`INCONCLUSIVE` stays `INCONCLUSIVE`; `inconclusive` stays `inconclusive`. Keep
numbers as printed. A median ratio is not a savings claim. Never turn a median
into a percentage saving or soften a verdict. Include exclusions and predicted
versus actual results without cherry-picking. For a requested two-line summary,
use the kit's verdict words and numbers, with no extra workflow or paid command.

An undecided verdict (`inconclusive`, `INCONCLUSIVE` or `INSUFFICIENT`) carries a
`nextStep` in the kit's verdict: how many more pairs would settle it and what they
cost. Copy it exactly beside that scenario and never replace it with your own
count or price. Running those pairs is a new paid run: it needs its own plan
check and its own Start. A verdict that can decide has no `nextStep`; do not
suggest more pairs for it. When the interval includes 1 the kit also gives a
`tieNote` ("No clear difference from direct"): copy it beside the Rule 0 word,
because Rule 0 judges the tail and can read FAIL on a tie. Never soften, reword or
replace the Rule 0 word with it.

Quality travels with cost. Each scenario line carries the kit's clause "Anyray
passed X of N, direct Y of N" (the client's own check, run on both arms), and
"K pairs passed only direct" when Anyray failed a pair direct passed. Copy it
beside the ratio. Never offer a cost saving without its quality line, and never
read a cheaper run that failed the check as a win.

The report JSON is the validated, redacted body, with no command wrapper. If the
kit returns a refusal, stop and name the fix. The `--html` command writes
`anyray-test/report.html` itself and prints its path: open that file for the
user. Never write or edit the page by hand, and never read raw transcripts to
enrich it. The page is offline and content-free: headline verdict and dollars per
session, every scenario's tail, the savings-by-session-length chart, and every
pair with its checks and any exclusion reason.

## Publish and next release

Offer two separate decisions: publish this result to their console, and install
the per-release workflow when that template exists. Neither is automatic. Only
when the user asks to publish, run:

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s publish-result -- --scenarios-dir anyray-test --json
```

Publish only to the frozen gateway. Return the result id; never print the server
body or token. If the console or per-release template is unavailable, say so.
Install an available workflow only after the user chooses it, retaining freeze
and Start gates for future paid work.

## Guardrails

- The client's test is recorded verbatim as `source: client` in
  `anyray-test/client-<n>/scenario.yaml` and is never dropped or rewritten, even
  when invited to reword it. Our proposals use `proposed-<n>` and `source: proposed`.
- No paid command before an explicit Start: `noise` and `run` spend the user's
  money. Start is never a default. Before Start, never run or print either command.
- Verdict words come from the kit's output and are never reworded or rounded.
  Preserve numbers and case; never derive a savings claim from a median.
- Nothing leaves the machine except `publish-result` (a hash and counts), and
  only when asked. Keep test artifacts local; paid arms send the task to the
  chosen model providers as required to execute the test. Do not upload content,
  repo URLs, transcripts, free text or the lock's nonce with results or logs.
- After freeze, any change is a new plan: never edit a frozen scenario, silently
  replace a lock or change pins to get past a refusal.
- This session is not an arm: the kit runs both arms in private HOMEs through
  `lib/connectArm.mjs`. Never use this session's cost as an arm's measurement.
- Never retry a losing pair, and never hand-write `plan.lock.json` or `.kit-results`.

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

Check each prerequisite without a model request or printing secrets. Name every
failed check and its fix. If Bash is unavailable, say that preflight and kit
execution are blocked; still complete Define with Write or Edit when available.

- Kit: Node.js 22.13+, npm and git must be available. Keep a real, clean checkout
  with dependencies at `${CLAUDE_PLUGIN_DATA}/kit`. Read the installed version in
  `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`; its pin is
  `anyray-test--v<version>`. For this release the setup is:

  ```bash
  git clone --branch anyray-test--v0.1.0 --single-branch https://github.com/anyrayHQ/benchmarks.git "${CLAUDE_PLUGIN_DATA}/kit"
  npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" ci
  git -C "${CLAUDE_PLUGIN_DATA}/kit" rev-parse HEAD
  git -C "${CLAUDE_PLUGIN_DATA}/kit" rev-parse 'anyray-test--v0.1.0^{commit}'
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
- Claude Code: resolve one absolute binary and read its version without starting
  a session. Use that same binary and version for the plan's pins and both arms.
  If unavailable, install or sign in to Claude Code before proceeding.
- Gateway: require `ANYRAY_GATEWAY_URL` and a dedicated benchmark service key in
  `ANYRAY_BENCH_CLIENT_KEY`. Require an admin token via `ANYRAY_TRACE_TOKEN`,
  `ANYRAY_TRACE_KEY` or `ANYRAY_ADMIN_KEY`, in that order, with session-gate and
  spend read access. Use an authenticated GET to `/admin/v1/optimizer/session-gate`
  with a ten-second timeout to check reachability and access. Suppress raw bodies,
  headers and errors; report only status or a fixed failure label. A failure
  needs the correct URL, network access or token permissions. Check the intended
  tenant matches the benchmark key; pass `--tenant` to plan when needed. All-shadow
  or unreadable tenant gates block planning; ask the operator to fix the tenant.
- Direct credential: for Anthropic, check for `ANYRAY_UPSTREAM_TOKEN` or a valid
  Claude Code subscription token accessible to the kit through the macOS keychain.
  Check presence and expiry without displaying the value. If absent or too short
  for the task's pauses, sign in or use `claude setup-token` and put the token in
  the existing environment variable. For Bedrock, verify the configured AWS
  profile and region without inference; fix AWS login or profile access if needed.
- Refuse nonempty `ANYRAY_BENCH_EXTRA_HEADERS` or `ANYRAY_BENCH_SHARED_HEADERS`;
  ask the user to clear them. Keep all credentials in the environment, never in
  scenario files, command arguments, chat or reports.

## Define

When the message already contains the client's task, write it before anything
else to `anyray-test/client-1/scenario.yaml`, starting
with `source: client` and `task:` holding exactly their words. Use lossless YAML
quoting, with no added sentence, trailing period or changed capitalisation. This
initial file may be incomplete while preflight is blocked. If the task is absent,
ask for the test they planned to run: a task, script or description.

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

Ask for the budget and typical cost of one direct session. Use their values,
never costs inferred from our published tasks. From the current working directory, run:

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s plan -- --scenarios-dir anyray-test --budget-usd <budget> --session-cost-usd <session-cost> --json
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
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s noise -- --scenarios-dir anyray-test --claude-bin <absolute-claude-path> --rounds 6 --json
```

Surface progress on every wake: phase, completed rounds, exclusions and costs
when available. Read the returned measured SD and pairs needed. Stay within the
approved work and budget; a larger scope or ceiling requires a new plan and Start.

```bash
npm --prefix "${CLAUDE_PLUGIN_DATA}/kit" run -s run -- --scenarios-dir anyray-test --claude-bin <absolute-claude-path> --rounds <approved-rounds> --json
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
```

Copy each verdict and the pooled Rule 0 word exactly, including case:
`INCONCLUSIVE` stays `INCONCLUSIVE`; `inconclusive` stays `inconclusive`. Keep
numbers as printed. A median ratio is not a savings claim. Never turn a median
into a percentage saving or soften a verdict. Include exclusions and predicted
versus actual results without cherry-picking. For a requested two-line summary,
use the kit's verdict words and numbers, with no extra workflow or paid command.

The report JSON is the validated, redacted body, with no command wrapper. If the
kit returns a refusal, stop and name the fix. It does not create an HTML file.
Create `anyray-test/report.html` locally from that validated body only, escaping
all text and using no external assets, scripts or analytics, then open the local
shareable HTML. Include versions, plan hash, source labels, predictions, counts,
costs, intervals and verdicts. Never read raw transcripts to enrich the report.

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

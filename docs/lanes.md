# Other lanes

The bench on other clients and providers: what each lane runs, how its two arms reach
the model, and what it measures. The round rules and the verdict are in
[bench.md](bench.md).

- [On an Anthropic API key](#on-an-anthropic-api-key)
- [On AWS Bedrock](#on-aws-bedrock)
- [Per-token agents: `sdk-docs` and `framework-docs`](#per-token-agents-sdk-docs-and-framework-docs)
- [Codex (`--client codex`)](#codex---client-codex)
- [Agent SDK app: code scan](#agent-sdk-app-code-scan)

## On an Anthropic API key

`--upstream api-key` runs both arms on an Anthropic API key with only the base URL
changed, the way a customer on a key connects. The default, `--upstream seat`, uses the
Claude subscription seat.

```bash
cp -r twins/go-protogetter-lint ./client-scenarios/   # then plan and freeze it with the kit commands
ANTHROPIC_API_KEY=<key> npm run agent -- --scenarios-dir ./client-scenarios \
  --scenario go-protogetter-lint --rounds 6 --compare gateway --bare-a --upstream api-key
```

- The harness takes `ANTHROPIC_API_KEY` out of its own environment at startup and gives it
  to the Claude arm processes alone, warm-up included. Graders, git and helpers never see it.
  It is never written to settings, `--arm-env`, arguments, metadata or results.
- `--arm-env` refuses the key, and `--upstream api-key` refuses `--provider bedrock`.
- Seat-expiry checks are skipped on this lane. Rounds go to their own file (label `api-key`).
- It covers Claude Code on an API key only: not seat headroom, and not SDK agents.

The parity twin is [twins/go-protogetter-lint](../twins/go-protogetter-lint): fix 43
protogetter lint findings in hashicorp/go-plugin. How it is pinned and graded is in
[docs/harness-internals.md](harness-internals.md#parity-twin).

## On AWS Bedrock

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

## Per-token agents: `sdk-docs` and `framework-docs`

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

## Codex (`--client codex`)

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
[docs/harness-internals.md](harness-internals.md#codex-hook-isolation).

## Agent SDK app: code scan

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

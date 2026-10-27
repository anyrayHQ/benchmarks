# Results

The latest headline run first, then earlier and narrower runs, kept for reference. How
the rounds are run and judged is in [bench.md](bench.md).

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
- The [paired verdict](bench.md#reading-the-verdict) needs at least 8 valid rounds per scenario;
  this run is a one-round check against the last multi-round one.

## Agent SDK app: arm E against arm B (2026-10-13)

16 paired rounds of [`sdk-app-code-scan`](lanes.md#agent-sdk-app-code-scan) on a
development gateway, Claude Sonnet 5.5, each arm on its own fresh key. Arm E ran a
prototype Connect build that served the `sdk` source with a path fix. Rounds 1 to 8 used
the fix branch (Connect 5e6daef1a), rounds 9 to 16 used main (ee91f8337). The
instructions were the same in both builds.

| Rounds | E cheaper | Median E/B | Q3 | Max | Geometric mean (95% interval) |
|---|---|---|---|---|---|
| 1 to 8 | 6 of 8 | 0.941 | 0.989 | 1.103 | 0.961 (0.897 to 1.029) |
| 9 to 16 | 8 of 8 | 0.844 | 0.877 | 0.939 | 0.830 (0.768 to 0.896) |
| All 16 | 14 of 16 | 0.896 | 0.940 | 1.103 | 0.893 (0.841 to 0.949) |

Every E session made 1 to 5 batch reads; 40 of 41 were served (one `invalid_arguments`).
E made 238 Reads to B's 423, and 390 requests to B's 424. Every session completed in 7
main-agent turns. B found 8 of 9 facts in every round; E found 8 of 9 in 15 rounds and 7
in round 10. Both arms always missed `_SESSION_AUDIT_FORMAT`.

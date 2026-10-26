# Results history

Earlier and narrower runs, kept for reference. The current headline run is in the
[README](../README.md#latest-results-2026-10-15).

## Agent SDK app: arm E against arm B (2026-10-13)

16 paired rounds of [`sdk-app-code-scan`](../README.md#agent-sdk-app-code-scan) on a
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

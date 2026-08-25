# Comparison, loop cost & cache economics

Three things this repo could not previously answer, because every other number in
it is Anyray measuring Anyray on one request at a time:

1. **Is the saving any good?** — [head-to-head against Headroom](#head-to-head-vs-headroom)
   on identical payloads with an identical scorer.
2. **Does the saving survive an agent loop?** — [loop cost](#loop-cost-does-optimizing-add-turns):
   the same task run to completion with the optimizer off and on, counting turns.
3. **Does the saving actually pay?** — [cache economics](#cache-economics-does-a-saving-pay-for-itself):
   a saving that rewrites a cached prefix can cost ~10× what it saves, so this
   one prices the turn instead of counting its bytes.

All three are reproducible: `tools/compare-headroom.mjs`, `tools/loop-cost.mjs`,
`tools/cache-economics.mjs`. Each produced a result that is **not** flattering —
including one that refutes the hypothesis it was built to test — and all are
published as measured.

---

## Head-to-head vs Headroom

[Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0) is the
closest public comparable — a local context-compression layer aimed at the same
waste, with a Python `compress()` taking the same OpenAI message shape our
payloads already use. So it runs on the **same bytes**, scored by the **same**
`keyFactSurvival` from `lib/quality.mjs`, with no translation in between.

**Both sides run at their shipped defaults.** Anyray runs its **full default
pipeline**, not the per-workload hero strategy at a swept knob that the
[README headline](README.md#headline) uses — scoring a tuned system against an
untuned one would be the easiest way to rig this. That also means the Anyray
column here is **not** comparable to the 83% headline and should not be read as
a restatement of it.

Measured 2026-08-25, optimizer 0.3.132, headroom-ai 0.36.5, 40 payloads.

### Results, split by payload shape

Headroom compresses what an agent **read back** and by default leaves user
messages alone (`compress_user_messages=False`). 23 of our 41 payloads are a
single user turn with a pasted blob — a shape it deliberately declines. Pooling
the two families into one average would report a shape mismatch as a win, so
they are separated, and **the tool-bearing split is the like-for-like number**:

| Shape | n | Anyray agg | Headroom agg | Anyray median | Headroom median | Anyray fired | Headroom fired |
|---|--:|--:|--:|--:|--:|--:|--:|
| **tool-bearing** (like-for-like) | 17 | 33% | **51%** | **33%** | 0% | 14/17 | 8/17 |
| single-turn (Headroom declines by design) | 23 | **42%** | 7% | **40%** | 0% | 16/23 | 4/23 |

**Headroom wins the aggregate on the comparison that matters.** On tool-bearing
payloads it removes more total bytes than we do (51% vs 33%), driven by a few
very large wins: `37-durable-blob` 95% vs our 13%, `30-metrics-json` 69% vs 42%,
`29-orders-json` 68% vs 42%. It beat us on 6 of 40 workloads outright.

The two columns describe different distributions, and that is the substance
rather than a hedge. Anyray fires on **30 of 40** payloads and Headroom on
**12** — so Anyray's median is 33–40% against Headroom's 0%, while Headroom's
aggregate is higher because the handful of payloads it does engage are the
biggest ones. Broad-and-moderate versus narrow-and-deep. On JSON record arrays
specifically, their SmartCrusher is simply better than our
`context_compression`, and that is worth acting on rather than explaining away.

### Quality, same scorer, same markers

| | Workloads scored | PASS | MARGINAL | FAIL |
|---|--:|--:|--:|--:|
| Anyray (full default pipeline) | 33 | 24 | 3 | **6** |
| Headroom (defaults) | 33 | 29 | 4 | **0** |

**Headroom drops no key fact; the Anyray default pipeline drops facts on 6
workloads.** That needs stating plainly because it looks like it contradicts
[QUALITY.md](QUALITY.md), and it does not — it is a different configuration:

- **QUALITY.md (33/33 PASS)** pins **one** hero strategy per workload at a knob
  swept for that workload. That is what the published headline measures.
- **Here (6 FAIL)** runs every default-enabled strategy at stock knobs, which is
  what a fresh install does before anyone tunes it.

On `7-codebase-explore` the pinned run uses `code_graph` and keeps 5/5; the
default pipeline lets `relevance_filter` take the message first and keeps 1/5.
Same payload, same markers, different strategy reaching it first.

**This is a real finding about stock defaults, not a scoring artifact**, and the
honest reading is that our published quality numbers describe a tuned
configuration. Full per-workload rows: `tools/headroom-comparison.json`.

### Reproducing

```
node tools/compare-headroom.mjs --python /path/to/venv/bin/python
```

One caveat that invalidates the run if ignored: Headroom's text compressor is a
274MB model loaded on a **background** thread, and `compress()` returns input
unchanged until it is resident. A process-per-payload harness exits first and
scores every row at 0% — which is exactly what the first version of this
comparison did, on 34 of 40 workloads. The harness now blocks on `is_ready()`
and **refuses to run** if the model is cold, because a silent 0% is
indistinguishable from a genuine decline.

---

## Loop cost: does optimizing add turns?

Every other number here scores one request in isolation, which assumes the trim
is free. In an agent loop it may not be: if the optimizer elides something the
agent still needs, the agent does not fail — it **reads it again**, and a whole
extra round trip re-bills the accumulated history to buy back one file. A
single-request benchmark cannot see this; the extra turn is scored as its own
independent row.

`tools/loop-cost.mjs` runs the same task to completion with the optimizer **off**
and **on**, against a deterministic in-memory repo, 5 trials per arm.

Measured 2026-08-25, gpt-4o-mini, optimizer 0.3.132, median of 5 trials:

| Task | Turns (plain → optimized) | Loop input tokens | Correct | Re-reads |
|---|---|--:|--:|--:|
| `retry-policy` | 4 → 4 | 60,270 → 60,270 | 5/5 both | 0 |
| `auth-expiry` | 3 → 3 | 21,037 → 21,037 | 5/5 both | 0 |
| `billing-grace` | 3 → 3 | 20,978 → 20,978 | 5/5 both | 0 |
| `audit-all` | 3 → 3 | 77,114 → 77,075 | 5/5 both | 0 |

**No turns are added, and no tokens are saved either.** Correctness is identical,
re-reads are zero in both arms — the failure mode this harness was built to catch
does not occur. But the reason is not that the trims are free; it is that **no
eliding strategy ran at all**. The only decisions recorded across every optimized
trial are `cache_optimizer` and `content_census`, both diagnostics.

This is the cache-safety guard behaving **as designed**, and it is the most
useful thing the harness found. On a warm multi-turn loop against a
prompt-caching provider, a turn-varying rewrite of already-sent history busts the
provider's cache from the first changed byte, and re-billing a ~99%-cached prefix
to save a few percent of one turn is a large net loss. So the guard stands the
eliding strategies down (`suppressedKinds: [{reason: "cache_guard"}]`) and the
optimizer deliberately does nothing.

**The honest conclusion: Anyray's savings come from single-turn and cold-prefix
traffic, not from trimming warm agent loops** — on those, it correctly gets out
of the way. The 83% headline is measured on exactly the traffic where trimming is
safe, and this repo should not be read as claiming that figure applies to a warm
coding-agent session. That is consistent with the realism gap already stated in
[DATASETS.md](DATASETS.md#the-realism-gap-stated-plainly): published measurement
puts real coding-agent rounds at ~140k median input reading ~99% from cache,
which is precisely the traffic the guard protects.

### A harness bug worth recording

The first version of this measurement omitted the `pins` field from its
`/v1/optimize` calls. The gateway sends decision pins on every turn and persists
what comes back; without them the guard cannot locate the cache boundary and
suppresses **everything**, including on traffic where trimming would have been
safe. The harness now threads pins the way the gateway does
(`OptimizerClient.optimizeWithPins`). A benchmark that skips that field measures
a no-op and reports it as "the optimizer does not help here" — a statement about
the harness, not the product.

---

## Cache economics: does a saving pay for itself?

Everything above scores **bytes**. A provider does not bill bytes at face value
on a warm turn — it bills a cached prefix at ~0.1× and a *re-written* one at
~1.25×, so removing tokens from a prefix you already had cached can cost roughly
**10× more** than leaving them alone. A byte-counting benchmark reports that
rewrite as a saving. `tools/cache-economics.mjs` prices it instead.

**The harness.** A mock upstream stands in for the provider: it measures the
longest common byte prefix against the last prompt it saw for that conversation
and bills the match as a cache read, the rest as a cache write. No provider
account, no key, no network — anyone can re-run it. A 5-turn agent session
(~47k-token prefix, ~1.9k-token delta per turn) replays byte-identically through
every arm. Cost is in fresh-input-token equivalents over the **4 warm turns**
(turn 1 writes the cache in every arm, so it is excluded).

This needs no compressor to be nondeterministic. **Any** rewrite of
previously-cached bytes is enough, which is what makes it fair.

| Arm | Turn-1 prompt | Warm busts | Warm cost | vs no compressor |
|---|--:|--:|--:|--:|
| `none` (control) | 46,725 | 0/4 | 29,296u | 1.00× |
| `anyray` | 46,725 | 1/4 | 24,836u | **0.85×** |
| `anyray-nopins` (state lost every turn) | 46,725 | 1/4 | 24,836u | **0.85×** |
| `headroom-token` | 3,321 | 0/4 | 11,934u | **0.41×** |
| `headroom-cache` | 40,621 | 1/4 | 37,048u | **1.26×** |
| `headroom-cache-restart` (proxy restarted each turn) | 40,621 | 1/4 | 82,922u | **2.83×** |

### The hypothesis was half right, and the half it got wrong is the interesting half

**`token` mode did not bust the cache — it was the cheapest arm.** The predicted
failure was that "prior turns may be rewritten" would churn the prefix every
turn. It does not, because the rewrite is **deterministic**: the same history
compresses to the same bytes each turn, so the prefix stays stable *and* it is
~14× smaller (3.3k vs 46.7k). Stable-and-small beats stable-and-large. A rewrite
of cached bytes is only expensive if it **differs** turn-to-turn, and this one
does not.

**`cache` mode — the one that advertises prefix stability — is the arm that bust
it.** It compressed the turn-1 prompt (46.7k → 40.6k), then on turn 2 forwarded
bytes that did not extend what turn 1 had cached: 8,592 fresh tokens against
1,894 in the control, costing 1.26× overall while removing 13% of the bytes.
It then held cleanly for turns 3–5. So the bust is a **one-time transition**, not
per-turn churn, and it lands precisely where the delta engine takes over.

**The restart arm is the one that matters operationally: 2.83×.** Restarting the
proxy between turns loses the frozen prefix, and the replacement forwards the
*original* uncompressed transcript against a cache holding the *compressed* one —
93 cached tokens out of 48,618. One pod roll, one load-balancer hop to a cold
replica, and a single turn costs 60,666u where the control pays 7,040u. That is
the failure a warm single-process benchmark can never see, and it is not exotic:
it is an ordinary Tuesday deploy.

### Anyray is not clean here either

Anyray came out at 0.85×, but it **bust the prefix once too**, on turn 4 — the
turn `command_digest` and `observation_mask` first fire and rewrite settled
history (46.7k of cached prefix down to 7.7k). It pays 7,426u for that turn and
earns the rewrite back over turns 4–5, ending net cheaper than the control. The
honest reading is *a one-time re-write that amortises*, not *never touches the
cache* — and on a session that ended at turn 4 it would have been a straight
loss.

**`anyray-nopins` is identical to `anyray`, and that is a null result, not a
pass.** The optimizer returns 4 pins from turn 4 onward, so there is genuine
state to lose — but discarding it changed neither the bytes nor the cost here.
This transcript does not exercise the replay path that pins exist to protect, so
the arm should be read as "not yet tested", not as evidence Anyray survives a
cold replica. Building a transcript that does exercise it is the obvious next
step.

### What this does and does not establish

- It **does** show that mode names are not guarantees: the mode advertising cache
  safety bust the cache, and the mode advertising aggressive rewriting did not.
- It **does** show state-loss is the dominant cost for a stateful compressor —
  2.83× from restarts alone, on a product whose prefix stability is real while
  the process lives.
- It does **not** model TTL expiry, multi-breakpoint Anthropic caching, or
  concurrent sessions sharing a prefix.
- Prices are the public Anthropic ratios (read 0.1×, write 1.25×). The exact
  schedule varies by provider and model; the **direction** does not.

Reproduce: `node tools/cache-economics.mjs --python /path/to/venv/bin/python`.
Per-turn rows, decisions, and pin counts: `tools/cache-economics.json`.

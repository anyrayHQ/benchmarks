# Datasets

What the Anyray optimizer is evaluated against, where those bytes come from, and
which of them you can go and fetch yourself.

**There are two evaluation surfaces, and conflating them is how a fixture ends up
cited as evidence.** They answer different questions:

| | [The committed suite](#surface-1--the-committed-suite-this-repo) | [The replay lab](#surface-2--the-replay-lab-public-corpora) |
|---|---|---|
| Lives | in this repo | internal; results summarised [below](#surface-2--the-replay-lab-public-corpora) |
| Payloads | 41 synthetic, checked into git | public datasets + non-publishable corpora |
| Question | *does each strategy do what it claims, reproducibly?* | *does it still hold on traffic nobody wrote for it?* |
| You can re-run it | **yes** — `./run.sh --all`, needs only an optimizer | no, but every public corpus is linked and every number is stated |

Every number in [RESULTS.md](RESULTS.md), [SUMMARY.md](SUMMARY.md) and the README
headline comes from **surface 1** — the synthetic suite in this repo. Nothing on
this page changes those figures. This page exists because "83% on our own
fixtures" is a weaker claim than it looks until you can also see what happens on
data we did not write.

---

## Surface 1 — the committed suite (this repo)

Every payload under `*/payloads/` is **synthetic**: written for this repo,
carrying no real user content, no customer traffic, and no third-party corpus.
That is deliberate and it is not going to change — see
[Why the committed payloads stay synthetic](#why-the-committed-payloads-stay-synthetic).

The trade-off is honest to state: a synthetic payload is written by someone who
knows which strategy is about to run on it. The suite manages that with per-suite
knobs pinned in `config.yaml`, key-fact quality gates (`keyfacts.json`), and
strategies that are measured at a single knob rather than tuned per workload —
but it cannot fully escape it. Surface 2 is the check on it.

---

## Surface 2 — the replay lab (public corpora)

The optimizer is additionally replayed against public datasets nobody assembled
with Anyray in mind. **These are linked, not vendored** — the lab fetches them at
load time, this repo ships none of their bytes, and each one below is a live link
you can open and inspect.

Licences below are the licence **tag** each project publishes (read from the
Hugging Face / GitHub APIs on 2026-08-25). Read the upstream terms before you
redistribute anything — a tag is a pointer, not a grant.

### Agent & coding trajectories

| Dataset | Rows (upstream) | Licence | What it contributes |
|---|--:|---|---|
| [AlienKevin/SWE-ZERO-12M-trajectories](https://huggingface.co/datasets/AlienKevin/SWE-ZERO-12M-trajectories) | 12,290,800 | Apache-2.0 | Agentic coding traces with bulky tool observations |
| [nebius/SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) | 80,036 | CC-BY-4.0 | Real SWE-agent runs against SWE-bench issues |
| [togethercomputer/CoderForge-Preview](https://huggingface.co/datasets/togethercomputer/CoderForge-Preview) | 33k–155k per split (4) | **no licence tag** ⚠️ | OpenHands trajectories — the heaviest public corpus in the set |

⚠️ CoderForge-Preview publishes no licence tag. It is replayed by link only and
**nothing derived from its bytes is redistributed**, here or anywhere.

### Multi-turn, tool-calling and chat

| Dataset | Rows (upstream) | Licence | What it contributes |
|---|--:|---|---|
| [allenai/WildChat-1M](https://huggingface.co/datasets/allenai/WildChat-1M) | 837,989 | ODC-BY | Logged real-user chat — the only source where the *same* prompt recurs across *separate* sessions |
| [Agent-Ark/Toucan-1.5M](https://huggingface.co/datasets/Agent-Ark/Toucan-1.5M) | 457,130 | Apache-2.0 | Trajectories generated against real MCP servers; each row carries the catalogue actually connected (up to 40 tools) |
| [minpeter/xlam-function-calling-60k-parsed](https://huggingface.co/datasets/minpeter/xlam-function-calling-60k-parsed) | 60,000 | CC-BY-4.0 | Single-turn requests with 1–3 tool registries |
| [microsoft/orca-agentinstruct-1M-v1](https://huggingface.co/datasets/microsoft/orca-agentinstruct-1M-v1) | 25k–100k per split | CDLA-Permissive-2.0 | Ordinary instruction-following prose |
| [KwanWaiChung/MT-Eval](https://github.com/KwanWaiChung/MT-Eval) | 6 JSONL splits | MIT | Multi-turn dialogue with a growing, mostly-stable prefix |

### The two corpora that are supposed to fire nothing

This is the part most benchmark suites leave out, and it is the part worth
reading first.

- **`orca-agentinstruct` is the control.** Ordinary prose, ~350 tokens a turn. A
  strategy that fires here is usually a bug, not a saving. **Measured: 0.0% on
  every sampled turn, no strategy fired at all.**
- **`xlam-function-calling-60k` is the floor.** Its registries hold 1–3 tools, so
  a tool strategy firing here is firing on almost nothing. **Measured: 28.3%
  median, and 3 of 8 sampled turns reduced by exactly 0%** — `tool_pruning`
  declining outright on the smallest catalogues is the correct behaviour.

Neither is "fixed" by making it heavier. A control that reacts is not a control.

### What the public corpora actually measured

One clean run, optimizer **0.3.132** (monorepo `0c6d013e`) — the same build PR
#22 measured surface 1 on. Full default pipeline, no per-corpus tuning, no knob
pinned to flatter a strategy.

| | Turns | Instances | Median input | p90 | Max | Median saved | Aggregate saved |
|---|--:|--:|--:|--:|--:|--:|--:|
| All public corpora | 1,056 | 72 | 22,542 tok | 49,466 | 85,113 | **16.3%** | **23.1%** |

**That is well below the 83% this repo headlines, and the gap is the point.** The
committed suite pins one hero strategy per workload on a payload built to exhibit
that workload's waste pattern. The lab runs the whole default pipeline over
whatever the trajectory happened to contain — including turns with nothing to
save. Both numbers are real; they answer different questions, and the honest
reading of the pair is that **83% is the ceiling a matched workload reaches, not
the number a given deployment should expect.**

---

## Non-public evaluation data

Some of what the optimizer is evaluated against cannot be published here. Three
different reasons, and they are worth separating, because only one of them is
about privacy:

1. **Licence** — Apache-licensed source is fetched live at replay time rather
   than vendored, so this repo does not redistribute it or pin a stale copy.
2. **Shape, not text** — a prefix that churns or a duplicated ask is a
   *structure*; the bytes carrying it are arbitrary and publishing them would
   suggest the text mattered.
3. **Privacy** — production telemetry, which never contains content in the first
   place (see [Production traffic profile](#production-traffic-profile)).

**No customer prompt, completion, or payload appears in any of it.** What follows
is the full inventory of what runs, at what size, with what result — and no
sample of the content itself, by design.

### What runs, and what it measured

Same run, same build, same default pipeline as the table above.

| Corpus | What the bytes are | Why not published | Turns | Median input | Max input | Median saved |
|---|---|---|--:|--:|--:|--:|
| Large-repo source sweeps | Apache-2.0 Java source from public repositories, read back as agent tool results | licence — fetched live, never vendored | 94 | 54,714 tok | 245,937 | **61.6%** |
| Public API dumps | published open-data JSON record arrays, read back as tool results | licence + size | 9 | 45,412 tok | 272,145 | **20.9%** |
| OpenAPI tool catalogues | ~90 real operations from published OpenAPI specs, as tool definitions | licence | 9 | 6,638 tok | 6,988 | **59.5%** |
| CI runner output | real test names from public projects in pytest / jest / cargo framing | licence | 9 | 838 tok | 4,556 | **41.3%** |
| Structural probes | deterministic fixtures — churning prefix, runaway `max_tokens`, repeated ask, reasoning loop | shape, not text | 121 | 3,756 tok | 60,181 | **64.5%** |

The five together are 242 turns against the 1,056 public-corpus turns above, so
they shift no headline; they exist to reach strategies the public corpora do not
exercise (`param_tuning`, `cache_lint`, `columnar_fold`, `repeat_factor`).

**Traffic types covered across both surfaces:** coding-agent tool loops · CI and
test-runner output · large source-file reads · JSON record arrays and API dumps ·
MCP and OpenAPI tool catalogues · multi-turn chat with a growing prefix ·
single-turn function calling · ordinary instruction-following prose · repeated
requests across sessions · extended-thinking / reasoning loops.

**Input sizes covered:** 7 tokens to 272,145 tokens a single turn, across 1,298
turns; per-corpus medians range 204 → 245,937.

### Production traffic profile

The optimizer's own deployments are read as a **reference distribution** — never
as a corpus. There is nothing to replay: the gateway runs
`ANYRAY_CONTENT_MODE=encrypted`, prompts and completions live encrypted at rest,
and the profiling path does not select those columns at all. Aggregation happens
in the database over counts and timings — token counts, per-session prefix
growth, which strategies fired, which gates suppressed — so individual rows never
leave it. The connection is read-only.

This is a stronger guarantee than "we choose not to look": the query cannot
return content, so a bug in the profiler cannot leak a prompt.

What it is used for is calibration in one direction only — telling us **which**
strategies real traffic exercises and at what prompt sizes, so the corpora above
can be checked for being unrepresentative. No published savings figure is derived
from it.

---

## Why the committed payloads stay synthetic

Anyray's core product invariant is that prompt and response **content** is never
exposed — not to logs, not to the spend store, not to us. A benchmark repo that
vendored real logged traffic to look more credible would be contradicting the
product it benchmarks.

So the split is deliberate: **anything checked into this repo is synthetic and
reproducible by anyone; anything real is linked, replayed, and reported as
aggregates.** WildChat is the clearest case — it is genuinely useful for
`semantic_cache`, because a cache hit requires the same prompt arriving in a
*separate* session, which is a property of a population and cannot be
constructed. It is still logged conversation from real people, so it is replayed
by link and never vendored here.

## Adding a dataset

1. **Measure what it reaches; don't infer it from the dataset card.** A corpus
   picked by its description is how you end up with one that measures nothing.
   `xlam-function-calling-60k` is in the set precisely *because* it was measured
   and found to fire almost nothing.
2. **Say which kind it is** — real bytes and real conversation, real bytes in a
   constructed envelope, or a constructed shape. A dashboard that cannot tell a
   real trace from a probe will eventually report a fixture as evidence.
3. **Check the licence before anything is vendored**, and prefer replay-by-link.

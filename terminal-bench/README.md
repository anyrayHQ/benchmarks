# Terminal-Bench 2

Anyray against direct Claude Code on [Terminal-Bench 2](https://www.tbench.ai/), run through
[Harbor](https://github.com/laude-institute/harbor). This is a different runner from `run_agent.mjs`: the
tasks are Terminal-Bench's own, graded by their own tests, so there is no `scenario.yaml` here. This
directory pins which tasks we ran and which version of each.

## The tasks

`tasks.json` lists 26 tasks. 22 are the reported set; 4 (`fix-git`, `install-windows-3-11`, `qemu-alpine-ssh`,
`qemu-startup`) were only probed and are not in any result.

A task is pinned by its Harbor `task_checksum`, a content hash of the task directory. We ran with `ref: latest`,
which moves, so the checksum is the pin: a re-run whose checksum differs is a different task. Twelve tasks have a
second checksum, `pilotChecksum`, from the first pilot (an older dataset revision); those trials are not in the
reported numbers.

| List | Tasks | Used for |
|---|---|---|
| `short10` | 10 short tasks | Cold-start cost pairs |
| `rr_pilot` | 12 short tasks | Round robin across all arms, pass/fail |
| `long` | 10 long tasks | Long-session cost and cache busts |

The lists overlap; `tasks.json` names each task's lists.

## How we ran it

Harbor 0.25.0, Claude Code 2.1.322, `us.anthropic.claude-sonnet-5-5` on Bedrock us-east-1, reasoning effort
medium, 3 trials per cell. Direct is Claude Code's own Bedrock client. Anyray is Claude Code in Bedrock mode
through a small shim to the gateway (`anybedrock`), so both arms send the same request shape. Every arm and
trial starts cold, with sessions that share a prefix at least 6.5 minutes apart: a warm shared prefix made the
control look cheaper than it was. Cost is comparable only cold; scale a warm run by the cold direct mean over the
same-run direct mean per task.

The arms also covered RTK, Boost, Headroom and a gateway pass-through control, which you can skip.

## Re-run it

The harness, the task lists, the metrics collector and the offline replays live in
[`anyrayHQ/monorepo`](https://github.com/anyrayHQ/monorepo) under `optimizer/experiments/terminalBench`
(branch `exp/terminal-bench` until merged); its README has the steps. To check you got the same tasks:

```bash
python3 -I -c "
import json,sys
pins = json.load(open('terminal-bench/tasks.json'))['tasks']
for f in sys.argv[1:]:
    r = json.load(open(f)); t = r['task_name'].split('/')[1]
    ok = r['task_checksum'] == pins[t]['checksum']
    print(t, 'ok' if ok else 'DIFFERENT TASK VERSION')
" jobs/<prefix>-<task>-<arm>/*/*/result.json
```

It needs a gateway you control, a Bedrock token on this machine and an Anyray key. Neither is stored here.

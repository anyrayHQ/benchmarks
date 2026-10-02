#!/usr/bin/env node
// Paired, free-running agent benchmark.
//
// Each ROUND runs the same task on a real repo in two arms AT THE SAME TIME, each a
// fresh checkout and a full Claude Code session (all default tools, subagents allowed):
//
//   --compare anyray   A = direct to Anthropic, B = through Anyray  (the question)
//   --compare control  A = direct,              B = direct          (the noise floor)
//   --compare gateway  A = through Anyray,      B = through Anyray + ANYRAY_BENCH_EXTRA_HEADERS
//                      (isolates one header-selected gateway feature: both arms carry the
//                       gateway's confounders, only B carries the treatment)
//
// Per round: cost (Claude Code's billed total, cache-aware), turns, model requests,
// subagents and their share, whether the task was solved (a check command, or key
// facts in the answer), and the ratio B ÷ A. Across rounds: the Rule 0 verdict — win
// rate vs the 53% noise floor, median, Q3 and max ratio — over SOLVED PAIRS only (both
// arms solved; fewer than 3 is insufficient). Rounds one arm solved are quality events,
// never cost wins; timeouts/crashes (no cost) are excluded and listed. The old
// all-rounds line is still printed below it.
//
// Usage:
//   node run_agent.mjs --scenario cobra-flag-groups --rounds 1 --kinds observation_mask,code_graph
//     (--compare anyray needs --kinds or --strategy: the Anyray arm sends
//      x-anyray-optimization-kinds and records each response's x-anyray-optimization-result)
//   node run_agent.mjs --scenario cobra-flag-groups --rounds 6 --compare control
//   node run_agent.mjs --scenario cobra-dispatch --rounds 6 --kinds observation_mask --label observation_mask
//   node run_agent.mjs --scenario cobra-dispatch --rounds 6 --strategy thinking_trim
//     (tags the Anyray arm's x-anyray-metadata with experiment=<kind>; needs
//      `bench-rule per-experiment <kind>`; each round fails if another strategy acted)
//   node run_agent.mjs --scenario pyrepo-docs --rounds 3 --kinds observation_mask --label read-trim --read-trim
//     (Anyray arm only: anyray-connect's Read trim on for that session, without
//      touching the shared connect policy; see readTrimHome in lib/agentRun.mjs)
//   node run_agent.mjs --scenario pyrepo-docs --compare control --label max-ctx \
//     --arm-env b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
//     (extra Claude Code settings env on arm a, b, or both with no prefix; repeatable.
//      Combines with --read-trim: the env goes into the session settings, not the private HOME)
//   node run_agent.mjs --scenario pyrepo-docs --rounds 5 --kinds observation_mask --no-subagents --max-turns 80 --with-control
//     (--max-turns N: both arms' turn cap instead of the scenario's, recorded in setup;
//      --with-control: a direct-vs-direct control runs in parallel, same scenario, rounds,
//      turn cap and subagent setting, into <scenario>--control--<label|compare>-control.json;
//      its solved-pair median and range are printed as the noise band beside the verdict)
//   node run_agent.mjs --scenario pyrepo-docs --rounds 4 --kinds observation_mask --provider bedrock
//     (--provider bedrock: direct = Claude Code's own Bedrock client on an AWS profile;
//      anyray = connect's org lane, the gateway routing to Bedrock; see lib/bedrock.mjs)
//   node run_agent.mjs --scenario pyrepo-docs --rounds 6 --kinds observation_mask --parallel 3
//     (--parallel N: up to N rounds at once, default 2, max 4; each round is still A ‖ B,
//      so N rounds is up to 2N Claude sessions on the one subscription. --parallel 1 runs
//      rounds one after another. Rounds are numbered up front, saved to the result file
//      as each finishes and kept in round order; their lines print as they finish,
//      each prefixed with its round number. With --with-control the budget is SHARED:
//      at most N rounds in flight across main and control together (≤ 2N sessions),
//      each taking half the slots (rounded up) while both run and all of them once the
//      other is done. So the default 2 runs one main and one control round side by
//      side, as before --parallel; --parallel 1 --with-control alternates them)
//   node run_agent.mjs --scenario cobra-3pause --kinds observation_mask --no-subagents --experiment idle-kw
//     (--no-subagents: both arms run without Task/Workflow; --experiment <name>: the Anyray
//      arm sends experiment=<name> in x-anyray-metadata, for a gateway rule keyed on it)
//   ANYRAY_BENCH_EXTRA_HEADERS=$'x-example: 1' node run_agent.mjs …
//     (extra "name: value" gateway headers on the Anyray arm, newline-separated;
//      under --compare gateway on slot B only)
//   ANYRAY_BENCH_EXTRA_HEADERS='x-example: on' node run_agent.mjs --scenario s --compare gateway --strategy thinking_trim
//     (both slots are the anyray arm with the same kinds and metadata, each with its own
//      session id so traces and spend stay apart; B alone sends the extra headers)
// Output: results/agent/<scenario>--<compare>[--<label>].json (resumes; adds rounds), then
//   `npm run agent:report`.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { loadConfig } from './lib/loadConfig.mjs';
import { runAgent, describeSetup, describeRepo, prepareRepo, benchExtraHeaders } from './lib/agentRun.mjs';
import { costOfAnthropicUsage } from './lib/cost.mjs';
import { bandPosition, noiseBand, rule0, solvedPairVerdict } from './lib/stats.mjs';
import { countCacheBreaks } from './lib/cacheBreaks.mjs';
import { addGatewayPings, connectPolicy, gatewayReplicaStarts, optimizerConfig, restartedDuring, sessionGatewaySpend, sessionTraces } from './lib/traces.mjs';
import { rmSync } from 'node:fs';
import { parseArmEnv, assertArmEnvSafe } from './lib/armEnv.mjs';
import { parseKinds, tallyKinds, formatKindTally, otherKindsThatActed } from './lib/optimizationKinds.mjs';
import { resolveBenchKey, benchTenantSetup } from './lib/benchKey.mjs';
import { bedrockOptions, probeGatewayRoute, assertBedrockRoute } from './lib/bedrock.mjs';
import { formatChecks } from './lib/connectChecks.mjs';

const COMPARES = ['anyray', 'control', 'gateway'];

/** Which arm runs in each slot. */
export const armsFor = (compare) =>
  ({ anyray: { a: 'direct', b: 'anyray' }, control: { a: 'direct', b: 'direct' }, gateway: { a: 'anyray', b: 'anyray' } })[compare];

/** The slots that go through the gateway (their spend, traces and feedback are read back). */
export const gatewaySlots = (arms) => ['a', 'b'].filter((slot) => arms[slot] === 'anyray');

/**
 * The slot that carries ANYRAY_BENCH_EXTRA_HEADERS: always B, and only when B is the
 * anyray arm. Under --compare gateway that header is the treatment; A is the baseline.
 */
const carriesExtraHeaders = (arms, slot) => slot === 'b' && arms.b === 'anyray';

/** --parallel's ceiling: every session shares one Claude subscription, and its rate limits bite. */
export const MAX_PARALLEL = 4;

function parseParallel(v) {
  if (!/^[0-9]+$/.test(v ?? '') || Number(v) < 1) throw new Error(`--parallel needs a positive integer, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  if (Number(v) > MAX_PARALLEL) {
    throw new Error(`--parallel ${v} is above the cap of ${MAX_PARALLEL}: every session shares one Claude subscription, and its rate limits bite`);
  }
  return Number(v);
}

function parseMaxTurns(v) {
  if (!/^[0-9]+$/.test(v ?? '') || Number(v) < 1) throw new Error(`--max-turns needs a positive integer, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  return Number(v);
}

export function parseArgs(argv) {
  const a = { scenario: null, rounds: 1, compare: 'anyray', label: null, strategy: null, readTrim: false, armEnv: [], kinds: null, kindsSource: null, noSubagents: false, experiment: null, maxTurns: null, withControl: false, parallel: 2, provider: 'anthropic' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scenario') a.scenario = argv[++i];
    else if (argv[i] === '--rounds') a.rounds = Number(argv[++i]);
    else if (argv[i] === '--compare') a.compare = argv[++i];
    else if (argv[i] === '--label') a.label = argv[++i]; // keeps e.g. a single-strategy run apart
    else if (argv[i] === '--strategy') a.strategy = argv[++i]; // experiment=<kind> in the metadata header
    else if (argv[i] === '--read-trim') a.readTrim = true; // Anyray arm: hooks.readTrim on for this session only
    else if (argv[i] === '--arm-env') a.armEnv.push(argv[++i]); // [a:|b:]KEY=VALUE[,…]: extra session env
    else if (argv[i] === '--kinds') [a.kinds, a.kindsSource] = [parseKinds(argv[++i]), '--kinds']; // x-anyray-optimization-kinds
    else if (argv[i] === '--no-subagents') a.noSubagents = true; // both arms: --disallowed-tools Task Workflow
    else if (argv[i] === '--experiment') a.experiment = argv[++i]; // experiment=<name> in x-anyray-metadata, for a gateway rule
    else if (argv[i] === '--max-turns') a.maxTurns = parseMaxTurns(argv[++i]); // both arms: overrides scenario.maxTurns
    else if (argv[i] === '--with-control') a.withControl = true; // also run direct vs direct, in parallel: the noise band
    else if (argv[i] === '--parallel') a.parallel = parseParallel(argv[++i]); // rounds in flight, shared with --with-control
    else if (argv[i] === '--provider') a.provider = argv[++i]; // anthropic (seat) | bedrock (AWS direct vs the gateway's Bedrock route)
    else if (argv[i] === '--bare') a.bare = true; // Anyray arm = base URL + headers only: no anyray-connect, optimization off
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.scenario) throw new Error('--scenario <name> is required');
  if (!COMPARES.includes(a.compare)) throw new Error('--compare anyray|control|gateway');
  if (!['anthropic', 'bedrock'].includes(a.provider)) throw new Error('--provider anthropic|bedrock');
  const gateway = a.compare !== 'control';
  for (const [flag, on] of [['--strategy', a.strategy], ['--read-trim', a.readTrim], ['--kinds', a.kinds], ['--experiment', a.experiment]]) {
    if (on && !gateway) throw new Error(`${flag} needs --compare anyray or gateway`);
  }
  if (a.withControl && a.compare === 'control') throw new Error('--with-control adds a direct-vs-direct control; --compare control already is one');
  if (a.experiment && a.strategy) throw new Error('--experiment and --strategy both set the experiment tag: use one');
  // The Anyray arm always names the strategies it measures: the tenant's defaults drift
  // (admin changes, regret-guard verdicts), so a run that inherits them is not reproducible.
  if (a.strategy && a.kinds && !a.kinds.includes(a.strategy)) throw new Error(`--strategy ${a.strategy} must be one of --kinds`);
  if (a.strategy && !a.kinds) [a.kinds, a.kindsSource] = [parseKinds(a.strategy), '--strategy'];
  // --bare measures the seat that changed only its base URL: nothing client-side, nothing optimized.
  if (a.bare && !gateway) throw new Error('--bare needs --compare anyray or gateway');
  if (a.bare && (a.kinds || a.readTrim || a.provider === 'bedrock')) throw new Error('--bare runs with optimization off on the seat lane: it takes no --kinds, --strategy, --read-trim or --provider bedrock');
  if (gateway && !a.kinds && !a.bare) {
    throw new Error(`--compare ${a.compare} needs --kinds <k1,k2> (or --strategy <kind>): the Anyray arm requests its strategies explicitly, never the gateway defaults`);
  }
  a.label ??= a.strategy;
  if (a.provider === 'bedrock') a.label ??= 'bedrock'; // never mixed into a seat run's file
  if (a.bare) a.label = a.label ? `bare-${a.label}` : 'bare'; // never mixed into a connect-configured run's file
  a.env = parseArmEnv(a.armEnv);
  assertArmEnvSafe(a.env.a);
  assertArmEnvSafe(a.env.b);
  return a;
}

/** The scenario as both arms run it: --max-turns replaces its turn cap. */
export const effectiveScenario = (scenario, args) => (args.maxTurns ? { ...scenario, maxTurns: args.maxTurns } : scenario);

/**
 * --with-control: the direct-vs-direct run beside the main one. Same scenario, rounds,
 * turn cap and subagent setting; nothing gateway-side, no per-arm env (a treatment);
 * its own result file (label suffixed -control).
 */
export const controlArgs = (args) => ({
  ...args,
  compare: 'control',
  label: `${args.label ?? args.compare}-control`,
  kinds: null,
  kindsSource: null,
  strategy: null,
  experiment: null,
  readTrim: false,
  armEnv: [],
  env: { a: {}, b: {} },
  extraHeaders: [],
  withControl: false,
  bare: false,
});

/** `--read-trim` applies to the Anyray arm only. */
export const armReadTrim = (args, arm) => args.readTrim && arm === 'anyray';

/**
 * One slot's runAgent options beyond the shared ones. --read-trim follows the ARM (anyray),
 * --arm-env follows the SLOT (a/b): under --compare control both slots are 'direct'.
 */
export const slotOptions = (args, arms, slot) => ({
  arm: arms[slot],
  readTrim: armReadTrim(args, arms[slot]),
  env: args.env?.[slot] ?? {},
  kinds: arms[slot] === 'anyray' ? args.kinds ?? null : null,
  kindsSource: arms[slot] === 'anyray' ? args.kindsSource ?? null : null,
  extraHeaders: carriesExtraHeaders(arms, slot) ? args.extraHeaders ?? [] : [],
  noSubagents: !!args.noSubagents, // both slots, so the pair stays like for like
  provider: args.provider ?? 'anthropic',
  bedrock: args.bedrock ?? null,
  bare: !!args.bare && arms[slot] === 'anyray',
});

/** What the run asked of the arms beyond --kinds / --read-trim, as recorded (header names only). */
export const requestRecord = (args) => ({
  noSubagents: !!args.noSubagents,
  bare: !!args.bare,
  experiment: args.experiment ?? null,
  extraHeaders: (args.extraHeaders ?? []).map((h) => h.slice(0, h.indexOf(':')).trim()),
  extraHeadersOn: (args.extraHeaders ?? []).length ? ['a', 'b'].filter((slot) => carriesExtraHeaders(armsFor(args.compare), slot)) : [],
});

/** results/agent/<scenario>--<compare>[--<label>].json */
export const resultFileName = (args) => `${args.scenario}--${args.compare}${args.label ? `--${args.label}` : ''}.json`;

/**
 * B ÷ A cost. An arm that ended without a result event (timed out, killed) has no
 * cost: the round is an error, never a ratio of 0 or ∞.
 */
export function roundRatio(a, b) {
  const missing = [['A', a], ['B', b]].filter(([, s]) => s.totals.costUsd == null).map(([n]) => n);
  if (missing.length) return { ratio: null, error: `${missing.join(' and ')} ended without a result (no cost)` };
  return { ratio: a.totals.costUsd ? b.totals.costUsd / a.totals.costUsd : null };
}

/** The rounds Rule 0 scores: not failed, and no gateway restart under them. */
export const scoredRounds = (rounds) => rounds.filter((x) => !x.error && !x.gatewayRestarted);

/** Main-agent requests that issued more than one tool call (Claude Code's parallel tool use). */
export const parallelToolTurns = (requests) =>
  requests.filter((r) => r.agent === 'main' && r.blocks.filter((b) => b.type === 'tool_use').length > 1).length;

/**
 * Each slot's x-anyray-metadata tag. Under --compare gateway both slots are gateway
 * arms, so each gets its own session id (suffix -a / -b): otherwise their traces,
 * spend and optimizer session state would merge. Other compares share one tag.
 */
export function roundTags(args, round, now = Date.now()) {
  const tag = roundTag(args, round, now);
  if (args.compare !== 'gateway') return { a: tag, b: tag };
  return { a: { ...tag, sessionId: `${tag.sessionId}-a` }, b: { ...tag, sessionId: `${tag.sessionId}-b` } };
}

/** One round's x-anyray-metadata tag. */
export function roundTag(args, round, now = Date.now()) {
  const tag = { sessionId: `anyray-bench-${args.scenario}-${args.compare}-r${round}-${now}`, tool: 'anyray-bench', intent: args.scenario };
  const experiment = args.strategy ?? args.experiment;
  if (experiment) tag.experiment = experiment;
  return tag;
}

/** Both arms' setup, as recorded in the result file. */
export function armSetups(args, arms, run, scenario, { enrolled, tenant } = {}) {
  const describe = (slot) => describeSetup({
    ...slotOptions(args, arms, slot), model: run.model, gatewayUrl: run.gatewayUrl, runTag: '<per round>', maxTurns: scenario.maxTurns, enrolled, tenant,
  });
  const one = (slot) => ({ ...describe(slot), maxTurnsSource: args.maxTurns ? '--max-turns' : 'scenario', parallel: args.parallel ?? 1 });
  return { a: one('a'), b: one('b') };
}

/** What each arm was actually configured with this round (the Anyray arm by anyray-connect) over the planned setup. */
export const withSessionSetups = (setup, sessions) =>
  Object.fromEntries(Object.entries(setup).map(([slot, planned]) => [slot, sessions[slot]?.setup ? { ...planned, ...sessions[slot].setup } : planned]));

/** Session totals. Claude Code's result record is the billed truth (main + subagents). */
function summarize(session, pricing) {
  const t = { requests: session.requests.length, subagents: session.subagents.length, toolCalls: 0, hookTrimmed: 0, retrieveCalls: 0, retrieveOk: 0 };
  let mainIn = 0;
  let subIn = 0;
  // Direct sessions break ~0 times; a gateway that edits history unevenly shows up here.
  t.cacheBreaks = countCacheBreaks(session.requests);
  t.parallelToolTurns = parallelToolTurns(session.requests);
  t.resultSubtype = session.result?.subtype ?? null; // e.g. error_max_turns
  t.compactions = session.compactions?.length ?? 0;
  t.peakContext = {}; // largest input (fresh + cache read + write) any one request of each agent sent
  for (const r of session.requests) {
    const u = { ...(r.usage ?? {}), output_tokens: 0 };
    r.inputTotal = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    t.peakContext[r.agent] = Math.max(t.peakContext[r.agent] ?? 0, r.inputTotal);
    r.inputCostUsd = costOfAnthropicUsage(pricing, r.model, u);
    delete r.usage.output_tokens; // message-start snapshot, not the real count
    if (r.agent === 'main') mainIn += r.inputCostUsd ?? 0;
    else subIn += r.inputCostUsd ?? 0;
    for (const b of r.blocks) {
      if (b.type !== 'tool_use') continue;
      t.toolCalls++;
      if (b.result?.trimmedByAnyrayHook) {
        t.hookTrimmed++;
        t.hookTrimmedByTool = { ...t.hookTrimmedByTool, [b.name]: (t.hookTrimmedByTool?.[b.name] ?? 0) + 1 };
      }
      if (b.name === 'mcp__anyray__anyray_retrieve') {
        t.retrieveCalls++;
        if (b.result && !b.result.isError) t.retrieveOk++;
      }
    }
  }
  const mu = Object.values(session.result?.modelUsage ?? {});
  t.input = mu.reduce((a, m) => a + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0);
  t.cacheRead = mu.reduce((a, m) => a + (m.cacheReadInputTokens ?? 0), 0);
  t.cacheWrite = mu.reduce((a, m) => a + (m.cacheCreationInputTokens ?? 0), 0);
  t.output = mu.reduce((a, m) => a + (m.outputTokens ?? 0), 0);
  t.costUsd = session.result?.costUsd ?? null;
  t.subagentInputShare = mainIn + subIn ? subIn / (mainIn + subIn) : 0;
  t.turns = session.result?.numTurns ?? null;
  t.wallMs = session.wallMs;
  t.models = Object.keys(session.result?.modelUsage ?? {});
  return t;
}

/** How the round printout names a slot's arm; under gateway, B names its extra headers. */
export const armLabel = (args, arms, slot) =>
  args.compare === 'gateway'
    ? `anyray${slot === 'b' && args.extraHeaders?.length ? ` + ${requestRecord(args).extraHeaders.join(', ')}` : ' (baseline)'}`
    : arms[slot];

/** The round line's gateway-ping part: '' for a direct arm, 'n/a' when unreadable. */
export const pingNote = (t) =>
  t.gatewayPingCount === undefined ? ''
    : t.gatewayPingCount === null ? ' · pings n/a'
    : ` · ${t.gatewayPingCount} pings $${t.gatewayPingCostUsd.toFixed(3)} (client $${t.clientCostUsd?.toFixed(3)})`;

function solved(scenario, session) {
  if (scenario.check) return !!session.check?.passed;
  if (scenario.citations) {
    const c = session.citations ?? { total: 0, resolved: 0 };
    return c.resolved >= scenario.citations.min && c.resolved / Math.max(1, c.total) >= (scenario.citations.resolveRate ?? 0.9);
  }
  const text = session.result?.text ?? '';
  return (scenario.keyFacts ?? []).every((f) => text.includes(f));
}

const x2 = (v) => (v == null ? 'n/a' : v.toFixed(2));

const BAND_SAYS = {
  below: 'is below the noise band: cheaper beyond direct-vs-direct noise',
  inside: 'is inside the noise band: not distinguishable from noise',
  above: 'is above the noise band: costs more beyond direct-vs-direct noise',
};

/**
 * The end-of-run printout. First the Rule 0 verdict over solved pairs (both arms solved),
 * the rounds only one arm solved (quality events), the rounds without a cost (timeouts,
 * crashes); then, with --with-control, the control's noise band; last, the pre-ANY-733
 * all-rounds line unchanged, so earlier outputs stay comparable.
 */
export function formatVerdict({ scenario, compare, rounds, controlRounds }) {
  const kept = rounds.filter((x) => !x.gatewayRestarted);
  const v = solvedPairVerdict(kept);
  const p = v.stats;
  const out = [
    `\n${scenario} [${compare}] solved pairs ${v.k}/${v.n}: wins ${p.wins}/${v.k}, median ${x2(p.median)}, Q3 ${x2(p.q3)}, max ${x2(p.max)} → ${v.verdict}`,
  ];
  if (v.insufficient) out.push(`  verdict insufficient: ${v.reasons[0]}`);
  out.push(...v.reasons.slice(v.insufficient ? 1 : 0).map((x) => `  ${x}`));
  if (v.qualityEvents.length) out.push(`  quality events (one arm solved): ${v.qualityEvents.map((e) => `round ${e.round} ${e.solvedBy.toUpperCase()} only`).join(', ')}`);
  if (v.neither.length) out.push(`  neither arm solved: round(s) ${v.neither.join(', ')}`);
  if (v.noCost.length) out.push(`  no cost (timeout/crash), excluded: ${v.noCost.map((e) => `round ${e.round} (${e.reason})`).join(', ')}`);
  if (controlRounds) {
    const band = noiseBand(solvedPairVerdict(controlRounds.filter((x) => !x.gatewayRestarted)));
    if (!band) out.push('  noise band (control): n/a, no solved pairs');
    else {
      out.push(`  noise band (control, ${band.k} solved pairs): median ${x2(band.median)}, range ${x2(band.min)}–${x2(band.max)}`);
      const pos = bandPosition(p.median, band);
      out.push(`  median ${x2(p.median)} ${pos ? BAND_SAYS[pos] : 'n/a: no solved pairs to compare'}`);
    }
  }
  const s = rule0(scoredRounds(rounds));
  const dropped = rounds.filter((x) => x.gatewayRestarted).map((x) => x.round);
  out.push(
    `  all rounds (pre-ANY-733 verdict, unsolved sessions included): ${scenario} [${compare}] after ${s.n} round(s): wins ${s.wins}/${s.n}, median ${s.median?.toFixed(2)}, Q3 ${s.q3?.toFixed(2)}, max ${s.max?.toFixed(2)} → ${s.verdict}` +
      (dropped.length ? `\n  dropped (gateway restarted): round(s) ${dropped.join(', ')}` : '') +
      (s.reasons.length ? `\n    ${s.reasons.join('\n    ')}` : '')
  );
  return out.join('\n');
}

/**
 * A concurrency budget: at most `limit` tasks run at once. Each caller takes a lane.
 * While more than one lane is open, each may hold at most its fair share of the
 * slots (limit ÷ open lanes, rounded up) and free slots go to the lanes in turn, so with
 * --with-control the main comparison and the control run side by side instead of one
 * queuing behind the other. `close()` a lane when its caller is done: the others then
 * share its slots.
 */
export function createPool(limit) {
  const lanes = []; // { queue: [{ task, resolve, reject }], active, closed }
  let active = 0;
  let turn = 0;
  const pump = () => {
    while (active < limit) {
      const share = Math.ceil(limit / Math.max(1, lanes.filter((l) => !l.closed).length));
      const k = lanes.findIndex((_, i) => {
        const l = lanes[(turn + i) % lanes.length];
        return l.queue.length && (l.closed || l.active < share);
      });
      if (k < 0) return;
      const lane = lanes[(turn + k) % lanes.length];
      turn = (turn + k + 1) % lanes.length;
      const { task, resolve, reject } = lane.queue.shift();
      active++;
      lane.active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          lane.active--;
          pump();
        });
    }
  };
  return {
    lane() {
      const lane = { queue: [], active: 0, closed: false };
      lanes.push(lane);
      const schedule = (task) => new Promise((resolve, reject) => {
        lane.queue.push({ task, resolve, reject });
        pump();
      });
      schedule.close = () => {
        lane.closed = true;
        pump();
      };
      return schedule;
    },
  };
}

/** Put a finished round in its index place: the result file stays in round order whatever finishes first. */
export function insertRound(rounds, r) {
  const at = rounds.findIndex((x) => x.round > r.round);
  rounds.splice(at < 0 ? rounds.length : at, 0, r);
}

/**
 * Serialised saves of one result file. Every save writes the whole record as it stands
 * then, queued behind the previous one, so concurrent rounds never land a stale snapshot
 * over a newer one.
 */
function recordSaver(file, record, write) {
  let queue = Promise.resolve();
  return () => (queue = queue.then(() => write(file, JSON.stringify(record, null, 2) + '\n')));
}

/**
 * The main comparison and, with --with-control, the control beside it. Both draw on ONE
 * --parallel budget: at most N rounds in flight in total (so at most 2N Claude sessions),
 * the two taking turns for free slots.
 */
export async function runAll(args, cfg, { runComparison: compare = runComparison, log = console.log, deps } = {}) {
  const pool = createPool(args.parallel);
  if (args.withControl) log(`--parallel ${args.parallel} is shared with the control: at most ${args.parallel} round(s), ${2 * args.parallel} sessions, in flight across both`);
  // --with-control: the control runs at the same time as the main comparison, so both
  // see the same upstream conditions; its rounds give the noise band.
  // Their round lines interleave, so each carries its comparison's tag.
  const runs = [[args, args.withControl ? `[${args.compare}] ` : '']];
  if (args.withControl) runs.push([controlArgs(args), '[control] ']);
  // Every lane exists before either comparison queues a round, so neither takes the whole budget first.
  const lanes = runs.map(() => pool.lane());
  const jobs = runs.map(([a, prefix], i) => compare(a, cfg, { prefix, schedule: lanes[i], deps }).finally(lanes[i].close)); // its slots pass to the other
  const [main, control] = await Promise.allSettled(jobs);
  return { main, control };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const { main, control } = await runAll(args, cfg);
  if (main.status === 'rejected') throw main.reason;
  if (control?.status === 'rejected') console.log(`control run failed: ${control.reason?.message ?? control.reason}`);
  const { record, file, viaGateway } = main.value;
  const controlRecord = control?.status === 'fulfilled' ? control.value.record : null;
  if (controlRecord) console.log(formatVerdict({ scenario: args.scenario, compare: 'control', rounds: controlRecord.rounds }).replace(/\n(?!$)/g, '\n[control] '));
  if (controlRecord) {
    record.control = { file: resultFileName(controlArgs(args)) };
    record.noiseBand = noiseBand(solvedPairVerdict(controlRecord.rounds.filter((x) => !x.gatewayRestarted)));
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  }
  console.log(formatVerdict({ scenario: args.scenario, compare: args.compare, rounds: record.rounds, controlRounds: controlRecord?.rounds }));
  for (const slot of viaGateway) {
    const feedback = record.rounds.flatMap((x) => x.sessions?.[slot]?.optimization?.results ?? []);
    if (args.kinds && feedback.length) console.log(`  all rounds${viaGateway.length > 1 ? `, ${slot.toUpperCase()}` : ''}, ${formatKindTally(tallyKinds(feedback, args.kinds))}`);
  }
}

/**
 * --provider bedrock: the direct arm's AWS profile and region, and the Bedrock model id
 * both arms end up on. Unless ANYRAY_BEDROCK_MODEL pins it, the id is read back from one
 * 1-token request through the gateway's org lane, which must be served by Bedrock.
 */
export async function resolveBedrock(run, { env = process.env, probe = probeGatewayRoute } = {}) {
  const opts = bedrockOptions(env);
  if (!run.gatewayUrl) {
    if (!opts.model) throw new Error('--provider bedrock without a gateway needs ANYRAY_BEDROCK_MODEL (the Bedrock model id)');
    return { ...opts, modelSource: 'ANYRAY_BEDROCK_MODEL' };
  }
  const route = await probe({ gatewayUrl: run.gatewayUrl, clientKey: resolveBenchKey(env, () => {}).key, model: run.model });
  const served = assertBedrockRoute(route, { pinned: opts.model });
  return { ...opts, model: opts.model ?? served, modelSource: opts.model ? 'ANYRAY_BEDROCK_MODEL' : 'gateway route probe', gatewayServedAs: served ?? route.model };
}

/** What runComparison reaches outside the process through; tests stub them. */
const LIVE = { runAgent, prepareRepo, describeRepo, write: writeFileSync, log: console.log, resolveBedrock };

/**
 * One comparison's rounds, into its own result file. Returns the record. Up to
 * --parallel rounds run at once through `schedule` (a pool lane; runAll shares one
 * pool with the control); each is saved as it finishes, in round order.
 */
export async function runComparison(args, cfg, { prefix = '', schedule = createPool(args.parallel ?? 1).lane(), deps } = {}) {
  const { runAgent, prepareRepo, describeRepo, write, log: print, resolveBedrock } = { ...LIVE, ...deps };
  const log = (msg) => print(prefix ? msg.split('\n').map((l) => (l ? prefix + l : l)).join('\n') : msg);
  const arms = armsFor(args.compare);
  const viaGateway = gatewaySlots(arms); // slots whose spend, traces and feedback the gateway holds
  args.extraHeaders = viaGateway.length ? benchExtraHeaders() : [];
  if (args.compare === 'gateway' && !args.extraHeaders.length) {
    console.warn('--compare gateway without ANYRAY_BENCH_EXTRA_HEADERS: A and B are the same arm (a gateway noise floor)');
  }
  const { run, pricing } = cfg;
  if (viaGateway.length && !run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const dir = join(cfg.root, 'scenarios', args.scenario);
  const scenarioFile = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));
  const scenario = effectiveScenario(scenarioFile, args); // what both arms run (--max-turns)

  const out = join(cfg.root, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const file = join(out, resultFileName(args));
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  const save = recordSaver(file, record, write);

  // Static context: the repo, both arms' setup, what Anyray has turned on.
  const probe = prepareRepo(scenario, dir);
  record.scenario = { name: args.scenario, ...scenarioFile, repoInfo: describeRepo(probe, scenario) };
  rmSync(probe, { recursive: true, force: true });
  record.compare = args.compare;
  record.label = args.label;
  record.gateway = run.gatewayUrl;
  record.readTrim = args.readTrim;
  record.kinds = args.kinds; // what the Anyray arm requested (x-anyray-optimization-kinds)
  record.arms = arms;
  record.provider = args.provider ?? 'anthropic';
  if (args.provider === 'bedrock') {
    args.bedrock ??= await resolveBedrock(run);
    record.bedrock = args.bedrock;
    log(`provider bedrock: direct arm on AWS profile "${args.bedrock.profile}" (${args.bedrock.region}) as ${args.bedrock.model}` + (args.bedrock.gatewayServedAs ? `; the gateway serves ${run.model} as ${args.bedrock.gatewayServedAs}` : ''));
    if (/anthropic\./.test(args.bedrock.gatewayServedAs ?? '') && args.bedrock.gatewayServedAs !== args.bedrock.model) log(`  WARNING: the arms are on different Bedrock ids (${args.bedrock.model} vs ${args.bedrock.gatewayServedAs})`);
  }
  record.request = requestRecord(args);
  // The Anyray arm's key decides its tenant (warns here, once, on the shared fallback).
  // Under --compare gateway both slots use the same key, so the same tenant.
  const tenant = viaGateway.length ? benchTenantSetup(resolveBenchKey()) : null;
  record.tenant = tenant;
  record.setup = armSetups(args, arms, run, scenario, { tenant });
  if (viaGateway.length) {
    record.anyray = { connectPolicy: await connectPolicy(run.gatewayUrl), optimizerConfig: await optimizerConfig(run.gatewayUrl) };
  }

  // Round numbers are fixed up front (after any rounds already in the file), so they
  // and each round's session id stay unique however the rounds overlap.
  const first = Math.max(record.rounds.length, ...record.rounds.map((x) => x.round ?? 0)) + 1;
  const numbers = Array.from({ length: args.rounds }, (_, k) => first + k);
  log(`${args.scenario} [${args.compare}] rounds ${first}–${first + args.rounds - 1}, parallel ${args.parallel ?? 1} (up to ${args.parallel ?? 1} round(s) at once, each A ‖ B)`);

  const runRound = async (round) => {
    const runTags = roundTags(args, round);
    log(`${args.scenario} [${args.compare}] round ${round}: ${armLabel(args, arms, 'a')} ‖ ${armLabel(args, arms, 'b')} (concurrent)…`);
    const run1 = (slot) => runAgent({ ...slotOptions(args, arms, slot), scenario, scenarioDir: dir, model: run.model, gatewayUrl: run.gatewayUrl, runTag: runTags[slot] });
    // Replica start times around the round: a gateway restart under it spoils the pair.
    const replicasBefore = viaGateway.length ? await gatewayReplicaStarts(run.gatewayUrl) : null;
    const startedAt = new Date().toISOString();
    const [sa, sb] = await Promise.allSettled([run1('a'), run1('b')]);
    const endedAt = new Date().toISOString();
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      const err = (sa.reason ?? sb.reason)?.message;
      log(`  round ${round} failed: ${err}`);
      insertRound(record.rounds, { round, error: err });
      await save();
      return;
    }
    const sessions = { a: sa.value, b: sb.value };
    for (const s of Object.values(sessions)) s.totals = summarize(s, pricing);
    record.setup = withSessionSetups(record.setup, sessions);
    // How anyray-connect set the Anyray arm up, and what the session loaded of it.
    for (const slot of viaGateway) {
      const checks = [...(sessions[slot].setup?.connectChecks ?? []), ...(sessions[slot].setup?.sessionChecks ?? [])];
      if (checks.length) log(`  round ${round} ${slot.toUpperCase()} connect checks (${sessions[slot].setup.lane} lane): ${checks.filter((c) => c.ok).length}/${checks.length} ok\n${formatChecks(checks.filter((c) => !c.ok))}`.trimEnd());
    }
    // The gateway's keep-warm pings are billed but absent from Claude Code's total:
    // add them to each gateway arm's cost, so the ratio compares what each arm cost.
    // `gatewaySettleSec`: e.g. a walk-away scenario waits out the keep-warm window first.
    if (viaGateway.length && scenario.gatewaySettleSec) await new Promise((res) => setTimeout(res, scenario.gatewaySettleSec * 1000));
    const spend = {};
    for (const slot of viaGateway) {
      spend[slot] = await sessionGatewaySpend(run.gatewayUrl, sessions[slot].init?.sessionId);
      if (spend[slot].unavailable) log(`  round ${round} warning: gateway ping cost unavailable (${spend[slot].unavailable}); ${slot.toUpperCase()} cost is the client figure only`);
      sessions[slot].totals = addGatewayPings(sessions[slot].totals, spend[slot]);
    }
    // --compare anyray keeps its one-arm shape; gateway records both slots.
    const gatewaySpend = args.compare === 'gateway' ? spend : spend.b ?? null;
    const r = {
      round,
      runTag: runTags.b,
      ...(args.compare === 'gateway' ? { runTags } : {}),
      // Both ends of the agent runs, to check a round against a deploy window by hand
      // (a redeploy doesn't always change the replica start times the restart check reads).
      startedAt,
      endedAt,
      sessions,
      ...roundRatio(sessions.a, sessions.b),
      quality: { a: solved(scenario, sessions.a), b: solved(scenario, sessions.b) },
      gatewaySpend,
    };
    if (viaGateway.length) {
      r.gatewayReplicas = { before: replicasBefore, after: await gatewayReplicaStarts(run.gatewayUrl) };
      r.gatewayRestarted = restartedDuring(r.gatewayReplicas.before, r.gatewayReplicas.after);
      if (r.gatewayRestarted) log(`  round ${round} WARNING: the gateway restarted during this round; drop it from the comparison`);
      // Config as it stood for this round (org strategies + the bench rule), and what
      // the gateway recorded doing on each request.
      r.optimizerConfig = await optimizerConfig(run.gatewayUrl);
      const traces = {};
      for (const slot of viaGateway) traces[slot] = await sessionTraces(run.gatewayUrl, runTags[slot].sessionId, { waitMs: 30000 });
      // r.traces / r.optimization / r.isolation stay B's (the arm under test); gateway adds A's.
      r.traces = traces.b ?? null;
      // What the gateway reported doing with the requested kinds, per request.
      r.optimization = sessions.b.optimization?.tally ?? null;
      if (args.compare === 'gateway') {
        r.tracesA = traces.a ?? null;
        r.optimizationA = sessions.a.optimization?.tally ?? null;
      }
      if (args.strategy) {
        // Isolation check: nothing but the named strategy may have acted on either gateway arm.
        const iso = {};
        for (const slot of viaGateway) {
          const others = otherKindsThatActed((traces[slot]?.traces ?? []).flatMap((t) => t.decisions ?? []), args.strategy);
          iso[slot] = others.length ? { ok: false, otherKinds: others } : { ok: true };
          if (others.length) log(`  round ${round} ISOLATION BROKEN on ${slot.toUpperCase()}: ${others.join(', ')} also acted`);
        }
        r.isolation = iso.b;
        if (args.compare === 'gateway') r.isolationA = iso.a;
      }
    }
    insertRound(record.rounds, r);
    const ta = sessions.a.totals;
    const tb = sessions.b.totals;
    const line = (slot, t) =>
      `  round ${round} ${slot.toUpperCase()} ${armLabel(args, arms, slot)}: $${t.costUsd?.toFixed(3)} · ${t.turns} turns · ${t.subagents} subagents · ${t.parallelToolTurns} parallel-tool turns · ${t.cacheBreaks} cache breaks` +
      (arms[slot] === 'anyray' ? ` · ${t.hookTrimmed} hook-trimmed` : '') +
      (sessions[slot].budgetNotice ? ` · notice applied ${sessions[slot].budgetNotice.applied}/${Object.values(sessions[slot].budgetNotice).reduce((x, y) => x + y, 0)}` : '') +
      `${pingNote(t)} · ${r.quality[slot] ? 'solved' : 'NOT solved'}${t.resultSubtype && t.resultSubtype !== 'success' ? ` (${t.resultSubtype})` : ''}`;
    log(
      `${line('a', ta)}\n${line('b', tb)}\n` +
        `  round ${round} ratio B/A ${r.ratio?.toFixed(3)}` +
        (r.optimizationA ? `\n  round ${round} A ${formatKindTally(r.optimizationA)}` : '') +
        (r.optimization ? `\n  round ${round} ${args.compare === 'gateway' ? 'B ' : ''}${formatKindTally(r.optimization)}` : '')
    );
    record.stats = rule0(scoredRounds(record.rounds));
    record.verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted));
    await save();
  };

  // Every round is queued at once; the pool lets --parallel of them run. All settle
  // (and are saved) before the first unexpected error, if any, is rethrown.
  const settled = await Promise.allSettled(numbers.map((round) => schedule(() => runRound(round))));
  const failed = settled.find((x) => x.status === 'rejected');
  if (failed) {
    await save();
    throw failed.reason;
  }
  record.stats = rule0(scoredRounds(record.rounds)); // all rounds, as before (the report reads it)
  record.verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted)); // solved pairs only
  await save();
  return { record, file, viaGateway };
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

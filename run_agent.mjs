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
// rate vs the 53% noise floor, median, Q3 and max ratio, quality parity.
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
//   node run_agent.mjs --scenario saltstack-docs --rounds 3 --kinds observation_mask --label read-trim --read-trim
//     (Anyray arm only: anyray-connect's Read trim on for that session, without
//      touching the shared connect policy; see readTrimHome in lib/agentRun.mjs)
//   node run_agent.mjs --scenario saltstack-docs --compare control --label max-ctx \
//     --arm-env b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
//     (extra Claude Code settings env on arm a, b, or both with no prefix; repeatable.
//      Combines with --read-trim: the env goes into the session settings, not the private HOME)
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
import { rule0 } from './lib/stats.mjs';
import { countCacheBreaks } from './lib/cacheBreaks.mjs';
import { addGatewayPings, connectPolicy, gatewayReplicaStarts, optimizerConfig, restartedDuring, sessionGatewaySpend, sessionTraces } from './lib/traces.mjs';
import { rmSync } from 'node:fs';
import { parseArmEnv, assertArmEnvSafe } from './lib/armEnv.mjs';
import { parseKinds, tallyKinds, formatKindTally } from './lib/optimizationKinds.mjs';
import { resolveBenchKey, benchTenantSetup } from './lib/benchKey.mjs';

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

export function parseArgs(argv) {
  const a = { scenario: null, rounds: 1, compare: 'anyray', label: null, strategy: null, readTrim: false, armEnv: [], kinds: null, kindsSource: null, noSubagents: false, experiment: null };
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
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.scenario) throw new Error('--scenario <name> is required');
  if (!COMPARES.includes(a.compare)) throw new Error('--compare anyray|control|gateway');
  const gateway = a.compare !== 'control';
  for (const [flag, on] of [['--strategy', a.strategy], ['--read-trim', a.readTrim], ['--kinds', a.kinds], ['--experiment', a.experiment]]) {
    if (on && !gateway) throw new Error(`${flag} needs --compare anyray or gateway`);
  }
  if (a.experiment && a.strategy) throw new Error('--experiment and --strategy both set the experiment tag: use one');
  // The Anyray arm always names the strategies it measures: the tenant's defaults drift
  // (admin changes, regret-guard verdicts), so a run that inherits them is not reproducible.
  if (a.strategy && a.kinds && !a.kinds.includes(a.strategy)) throw new Error(`--strategy ${a.strategy} must be one of --kinds`);
  if (a.strategy && !a.kinds) [a.kinds, a.kindsSource] = [parseKinds(a.strategy), '--strategy'];
  if (gateway && !a.kinds) {
    throw new Error(`--compare ${a.compare} needs --kinds <k1,k2> (or --strategy <kind>): the Anyray arm requests its strategies explicitly, never the gateway defaults`);
  }
  a.label ??= a.strategy;
  a.env = parseArmEnv(a.armEnv);
  assertArmEnvSafe(a.env.a);
  assertArmEnvSafe(a.env.b);
  return a;
}

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
});

/** What the run asked of the arms beyond --kinds / --read-trim, as recorded (header names only). */
export const requestRecord = (args) => ({
  noSubagents: !!args.noSubagents,
  experiment: args.experiment ?? null,
  extraHeaders: (args.extraHeaders ?? []).map((h) => h.slice(0, h.indexOf(':')).trim()),
  extraHeadersOn: (args.extraHeaders ?? []).length ? ['a', 'b'].filter((slot) => carriesExtraHeaders(armsFor(args.compare), slot)) : [],
});

/** results/agent/<scenario>--<compare>[--<label>].json */
export const resultFileName = (args) => `${args.scenario}--${args.compare}${args.label ? `--${args.label}` : ''}.json`;

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
  const one = (slot) => describeSetup({
    ...slotOptions(args, arms, slot), model: run.model, gatewayUrl: run.gatewayUrl, runTag: '<per round>', maxTurns: scenario.maxTurns, enrolled, tenant,
  });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const arms = armsFor(args.compare);
  const viaGateway = gatewaySlots(arms); // slots whose spend, traces and feedback the gateway holds
  args.extraHeaders = viaGateway.length ? benchExtraHeaders() : [];
  if (args.compare === 'gateway' && !args.extraHeaders.length) {
    console.warn('--compare gateway without ANYRAY_BENCH_EXTRA_HEADERS: A and B are the same arm (a gateway noise floor)');
  }
  const cfg = loadConfig();
  const { run, pricing } = cfg;
  if (viaGateway.length && !run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const dir = join(cfg.root, 'scenarios', args.scenario);
  const scenario = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));

  const out = join(cfg.root, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const file = join(out, resultFileName(args));
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };

  // Static context: the repo, both arms' setup, what Anyray has turned on.
  const probe = prepareRepo(scenario, dir);
  record.scenario = { name: args.scenario, ...scenario, repoInfo: describeRepo(probe, scenario) };
  rmSync(probe, { recursive: true, force: true });
  record.compare = args.compare;
  record.label = args.label;
  record.gateway = run.gatewayUrl;
  record.readTrim = args.readTrim;
  record.kinds = args.kinds; // what the Anyray arm requested (x-anyray-optimization-kinds)
  record.arms = arms;
  record.request = requestRecord(args);
  // The Anyray arm's key decides its tenant (warns here, once, on the shared fallback).
  // Under --compare gateway both slots use the same key, so the same tenant.
  const tenant = viaGateway.length ? benchTenantSetup(resolveBenchKey()) : null;
  record.tenant = tenant;
  record.setup = armSetups(args, arms, run, scenario, { tenant });
  if (viaGateway.length) {
    record.anyray = { connectPolicy: await connectPolicy(run.gatewayUrl), optimizerConfig: await optimizerConfig(run.gatewayUrl) };
  }

  for (let k = 0; k < args.rounds; k++) {
    const round = record.rounds.length + 1;
    const runTags = roundTags(args, round);
    console.log(`${args.scenario} [${args.compare}] round ${round}: ${armLabel(args, arms, 'a')} ‖ ${armLabel(args, arms, 'b')} (concurrent)…`);
    const run1 = (slot) => runAgent({ ...slotOptions(args, arms, slot), scenario, scenarioDir: dir, model: run.model, gatewayUrl: run.gatewayUrl, runTag: runTags[slot] });
    // Replica start times around the round: a gateway restart under it spoils the pair.
    const replicasBefore = viaGateway.length ? await gatewayReplicaStarts(run.gatewayUrl) : null;
    const startedAt = new Date().toISOString();
    const [sa, sb] = await Promise.allSettled([run1('a'), run1('b')]);
    const endedAt = new Date().toISOString();
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      const err = (sa.reason ?? sb.reason)?.message;
      console.log(`  round ${round} failed: ${err}`);
      record.rounds.push({ round, error: err });
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      continue;
    }
    const sessions = { a: sa.value, b: sb.value };
    for (const s of Object.values(sessions)) s.totals = summarize(s, pricing);
    record.setup = withSessionSetups(record.setup, sessions);
    // The gateway's keep-warm pings are billed but absent from Claude Code's total:
    // add them to each gateway arm's cost, so the ratio compares what each arm cost.
    // `gatewaySettleSec`: e.g. a walk-away scenario waits out the keep-warm window first.
    if (viaGateway.length && scenario.gatewaySettleSec) await new Promise((res) => setTimeout(res, scenario.gatewaySettleSec * 1000));
    const spend = {};
    for (const slot of viaGateway) {
      spend[slot] = await sessionGatewaySpend(run.gatewayUrl, sessions[slot].init?.sessionId);
      if (spend[slot].unavailable) console.log(`  warning: gateway ping cost unavailable (${spend[slot].unavailable}); ${slot.toUpperCase()} cost is the client figure only`);
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
      ratio: sessions.a.totals.costUsd ? sessions.b.totals.costUsd / sessions.a.totals.costUsd : null,
      quality: { a: solved(scenario, sessions.a), b: solved(scenario, sessions.b) },
      gatewaySpend,
    };
    if (viaGateway.length) {
      r.gatewayReplicas = { before: replicasBefore, after: await gatewayReplicaStarts(run.gatewayUrl) };
      r.gatewayRestarted = restartedDuring(r.gatewayReplicas.before, r.gatewayReplicas.after);
      if (r.gatewayRestarted) console.log('  WARNING: the gateway restarted during this round; drop it from the comparison');
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
          const others = new Set((traces[slot]?.traces ?? []).flatMap((t) => (t.decisions ?? []).map((d) => d.kind)).filter((k) => k !== args.strategy && k !== 'mint_economics')); // mint_economics = the strategy's own admission estimate
          iso[slot] = others.size ? { ok: false, otherKinds: [...others] } : { ok: true };
          if (others.size) console.log(`  ISOLATION BROKEN on ${slot.toUpperCase()}: ${[...others].join(', ')} also acted`);
        }
        r.isolation = iso.b;
        if (args.compare === 'gateway') r.isolationA = iso.a;
      }
    }
    record.rounds.push(r);
    const ta = sessions.a.totals;
    const tb = sessions.b.totals;
    const line = (slot, t) =>
      `  ${slot.toUpperCase()} ${armLabel(args, arms, slot)}: $${t.costUsd?.toFixed(3)} · ${t.turns} turns · ${t.subagents} subagents · ${t.parallelToolTurns} parallel-tool turns · ${t.cacheBreaks} cache breaks` +
      (arms[slot] === 'anyray' ? ` · ${t.hookTrimmed} hook-trimmed` : '') +
      `${pingNote(t)} · ${r.quality[slot] ? 'solved' : 'NOT solved'}${t.resultSubtype && t.resultSubtype !== 'success' ? ` (${t.resultSubtype})` : ''}`;
    console.log(
      `${line('a', ta)}\n${line('b', tb)}\n` +
        `  ratio B/A ${r.ratio?.toFixed(3)}` +
        (r.optimizationA ? `\n  A ${formatKindTally(r.optimizationA)}` : '') +
        (r.optimization ? `\n  ${args.compare === 'gateway' ? 'B ' : ''}${formatKindTally(r.optimization)}` : '')
    );
    record.stats = rule0(scoredRounds(record.rounds));
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  }
  const s = rule0(scoredRounds(record.rounds));
  const dropped = record.rounds.filter((x) => x.gatewayRestarted).map((x) => x.round);
  record.stats = s;
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  console.log(
    `\n${args.scenario} [${args.compare}] after ${s.n} round(s): wins ${s.wins}/${s.n}, median ${s.median?.toFixed(2)}, Q3 ${s.q3?.toFixed(2)}, max ${s.max?.toFixed(2)} → ${s.verdict}` +
      (dropped.length ? `\n  dropped (gateway restarted): round(s) ${dropped.join(', ')}` : '') +
      (s.reasons.length ? `\n  ${s.reasons.join('\n  ')}` : '')
  );
  for (const slot of viaGateway) {
    const feedback = record.rounds.flatMap((x) => x.sessions?.[slot]?.optimization?.results ?? []);
    if (args.kinds && feedback.length) console.log(`  all rounds${viaGateway.length > 1 ? `, ${slot.toUpperCase()}` : ''}, ${formatKindTally(tallyKinds(feedback, args.kinds))}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

#!/usr/bin/env node
// Paired, free-running agent benchmark.
//
// Each ROUND runs the same task on a real repo in two arms AT THE SAME TIME, each a
// fresh checkout and a full Claude Code session (all default tools, subagents allowed):
//
//   --compare anyray   A = direct to Anthropic, B = through Anyray  (the question)
//   --compare control  A = direct,              B = direct          (the noise floor)
//
// Per round: cost (Claude Code's billed total, cache-aware), turns, model requests,
// subagents and their share, whether the task was solved (a check command, or key
// facts in the answer), and the ratio B ÷ A. Across rounds: the Rule 0 verdict — win
// rate vs the 53% noise floor, median, Q3 and max ratio, quality parity.
//
// Usage:
//   node run_agent.mjs --scenario cobra-flag-groups --rounds 1
//   node run_agent.mjs --scenario cobra-flag-groups --rounds 6 --compare control
//   node run_agent.mjs --scenario cobra-dispatch --rounds 6 --label observation_mask
//   node run_agent.mjs --scenario cobra-dispatch --rounds 6 --strategy thinking_trim
//     (tags the Anyray arm's x-anyray-metadata with experiment=<kind>; needs
//      `bench-rule per-experiment <kind>`; each round fails if another strategy acted)
//   node run_agent.mjs --scenario saltstack-docs --rounds 3 --label read-trim --read-trim
//     (Anyray arm only: anyray-connect's Read trim on for that session, without
//      touching the shared connect policy; see readTrimHome in lib/agentRun.mjs)
//   node run_agent.mjs --scenario saltstack-docs --compare control --label max-ctx \
//     --arm-env b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
//     (extra Claude Code settings env on arm a, b, or both with no prefix; repeatable.
//      Combines with --read-trim: the env goes into the session settings, not the private HOME)
// Output: results/agent/<scenario>--<compare>[--<label>].json (resumes; adds rounds), then
//   `npm run agent:report`.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { loadConfig } from './lib/loadConfig.mjs';
import { runAgent, describeSetup, describeRepo, prepareRepo } from './lib/agentRun.mjs';
import { costOfAnthropicUsage } from './lib/cost.mjs';
import { rule0 } from './lib/stats.mjs';
import { countCacheBreaks } from './lib/cacheBreaks.mjs';
import { connectPolicy, optimizerConfig, sessionTraces } from './lib/traces.mjs';
import { rmSync } from 'node:fs';
import { parseArmEnv, assertArmEnvSafe } from './lib/armEnv.mjs';

export function parseArgs(argv) {
  const a = { scenario: null, rounds: 1, compare: 'anyray', label: null, strategy: null, readTrim: false, armEnv: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scenario') a.scenario = argv[++i];
    else if (argv[i] === '--rounds') a.rounds = Number(argv[++i]);
    else if (argv[i] === '--compare') a.compare = argv[++i];
    else if (argv[i] === '--label') a.label = argv[++i]; // keeps e.g. a single-strategy run apart
    else if (argv[i] === '--strategy') a.strategy = argv[++i]; // experiment=<kind> in the metadata header
    else if (argv[i] === '--read-trim') a.readTrim = true; // Anyray arm: hooks.readTrim on for this session only
    else if (argv[i] === '--arm-env') a.armEnv.push(argv[++i]); // [a:|b:]KEY=VALUE[,…]: extra session env
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.scenario) throw new Error('--scenario <name> is required');
  if (!['anyray', 'control'].includes(a.compare)) throw new Error('--compare anyray|control');
  if (a.strategy && a.compare !== 'anyray') throw new Error('--strategy needs --compare anyray');
  if (a.readTrim && a.compare !== 'anyray') throw new Error('--read-trim needs --compare anyray');
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
export const slotOptions = (args, arms, slot) => ({ arm: arms[slot], readTrim: armReadTrim(args, arms[slot]), env: args.env?.[slot] ?? {} });

/** Both arms' setup, as recorded in the result file. */
export function armSetups(args, arms, run, scenario, { enrolled } = {}) {
  const one = (slot) => describeSetup({
    ...slotOptions(args, arms, slot), model: run.model, gatewayUrl: run.gatewayUrl, runTag: '<per round>', maxTurns: scenario.maxTurns, enrolled,
  });
  return { a: one('a'), b: one('b') };
}

/** Session totals. Claude Code's result record is the billed truth (main + subagents). */
function summarize(session, pricing) {
  const t = { requests: session.requests.length, subagents: session.subagents.length, toolCalls: 0, hookTrimmed: 0, retrieveCalls: 0, retrieveOk: 0 };
  let mainIn = 0;
  let subIn = 0;
  // Direct sessions break ~0 times; a gateway that edits history unevenly shows up here.
  t.cacheBreaks = countCacheBreaks(session.requests);
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
  const cfg = loadConfig();
  const { run, pricing } = cfg;
  if (args.compare === 'anyray' && !run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const dir = join(cfg.root, 'scenarios', args.scenario);
  const scenario = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));
  const arms = args.compare === 'anyray' ? { a: 'direct', b: 'anyray' } : { a: 'direct', b: 'direct' };

  const out = join(cfg.root, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${args.scenario}--${args.compare}${args.label ? `--${args.label}` : ''}.json`);
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };

  // Static context: the repo, both arms' setup, what Anyray has turned on.
  const probe = prepareRepo(scenario, dir);
  record.scenario = { name: args.scenario, ...scenario, repoInfo: describeRepo(probe, scenario) };
  rmSync(probe, { recursive: true, force: true });
  record.compare = args.compare;
  record.label = args.label;
  record.gateway = run.gatewayUrl;
  record.readTrim = args.readTrim;
  record.arms = arms;
  record.setup = armSetups(args, arms, run, scenario);
  if (args.compare === 'anyray') {
    record.anyray = { connectPolicy: await connectPolicy(run.gatewayUrl), optimizerConfig: await optimizerConfig(run.gatewayUrl) };
  }

  for (let k = 0; k < args.rounds; k++) {
    const round = record.rounds.length + 1;
    const runTag = { sessionId: `anyray-bench-${args.scenario}-${args.compare}-r${round}-${Date.now()}`, tool: 'anyray-bench', intent: args.scenario };
    if (args.strategy) runTag.experiment = args.strategy;
    console.log(`${args.scenario} [${args.compare}] round ${round}: ${arms.a} ‖ ${arms.b} (concurrent)…`);
    const run1 = (slot) => runAgent({ ...slotOptions(args, arms, slot), scenario, scenarioDir: dir, model: run.model, gatewayUrl: run.gatewayUrl, runTag });
    const [sa, sb] = await Promise.allSettled([run1('a'), run1('b')]);
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      const err = (sa.reason ?? sb.reason)?.message;
      console.log(`  round ${round} failed: ${err}`);
      record.rounds.push({ round, error: err });
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      continue;
    }
    const sessions = { a: sa.value, b: sb.value };
    for (const s of Object.values(sessions)) s.totals = summarize(s, pricing);
    const r = {
      round,
      runTag,
      startedAt: new Date().toISOString(),
      sessions,
      ratio: sessions.a.totals.costUsd ? sessions.b.totals.costUsd / sessions.a.totals.costUsd : null,
      quality: { a: solved(scenario, sessions.a), b: solved(scenario, sessions.b) },
    };
    if (args.compare === 'anyray') {
      // Config as it stood for this round (org strategies + the bench rule), and what
      // the gateway recorded doing on each request.
      r.optimizerConfig = await optimizerConfig(run.gatewayUrl);
      r.traces = await sessionTraces(run.gatewayUrl, runTag.sessionId, { waitMs: 30000 });
      if (args.strategy) {
        // Isolation check: nothing but the named strategy may have acted on this session.
        const others = new Set((r.traces?.traces ?? []).flatMap((t) => (t.decisions ?? []).map((d) => d.kind)).filter((k) => k !== args.strategy && k !== 'mint_economics')); // mint_economics = the strategy's own admission estimate
        r.isolation = others.size ? { ok: false, otherKinds: [...others] } : { ok: true };
        if (others.size) console.log(`  ISOLATION BROKEN: ${[...others].join(', ')} also acted`);
      }
    }
    record.rounds.push(r);
    const ta = sessions.a.totals;
    const tb = sessions.b.totals;
    console.log(
      `  A ${arms.a}: $${ta.costUsd?.toFixed(3)} · ${ta.turns} turns · ${ta.subagents} subagents · ${ta.cacheBreaks} cache breaks · ${r.quality.a ? 'solved' : 'NOT solved'}\n` +
        `  B ${arms.b}: $${tb.costUsd?.toFixed(3)} · ${tb.turns} turns · ${tb.subagents} subagents · ${tb.cacheBreaks} cache breaks · ${r.quality.b ? 'solved' : 'NOT solved'}\n` +
        `  ratio B/A ${r.ratio?.toFixed(3)}`
    );
    record.stats = rule0(record.rounds.filter((x) => !x.error));
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  }
  const s = rule0(record.rounds.filter((x) => !x.error));
  record.stats = s;
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  console.log(
    `\n${args.scenario} [${args.compare}] after ${s.n} round(s): wins ${s.wins}/${s.n}, median ${s.median?.toFixed(2)}, Q3 ${s.q3?.toFixed(2)}, max ${s.max?.toFixed(2)} → ${s.verdict}` +
      (s.reasons.length ? `\n  ${s.reasons.join('\n  ')}` : '')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

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
//      touching the shared connect policy; see hookPostureHome in lib/agentRun.mjs)
//   node run_agent.mjs --scenario s --compare gateway --kinds observation_mask --hook-posture-b logRead=on
//     (--hook-posture-b <name>=<on|off>, repeatable: pin connect's fleetHookPolicy.<name> on
//      arm B alone, the way --read-trim-b pins readTrim; --hook-posture <name>=<on|off> pins it
//      on every Anyray arm. --read-trim(-b) is the readTrim=on spelling. The round fails if a
//      pinned switch is not what the session's profile ended with)
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
//     (--provider bedrock: direct = Claude Code's own Bedrock client on an AWS profile,
//      small/fast model Bedrock Haiku 5.5 (ANYRAY_BEDROCK_SMALL_MODEL); anyray = connect's
//      org lane, the gateway routing to Bedrock; see lib/bedrock.mjs)
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
//   ANYRAY_BENCH_SHARED_HEADERS='x-anyray-tool-defer: off' node run_agent.mjs --compare gateway …
//     (headers every Anyray arm sends, for a setting both arms must share)
//   node run_agent.mjs --scenario s --compare gateway --kinds observation_mask --experiment-b my-exp-b
//   node run_agent.mjs --scenario s --compare gateway --kinds command_digest --experiment-b planner-off --treatment a
//     (--treatment a: B carries the switch-off, so the DEFAULT in A is under test; the verdict
//     reads every ratio as A/B and refuses to score a treatment that applied nothing)
//     (--experiment-b <name>: arm B alone sends experiment=<name> in x-anyray-metadata, so a
//      gateway rule keyed on it (`bench-rule params <name> --params …`) is the treatment: same
//      strategies in both arms, the rule's params on B only. Each round records the rule as
//      it stood before and after, and which kind the gateway's session gate held out of each arm)
//   ANYRAY_CONNECT_BIN=/abs/main/anyray-connect node run_agent.mjs --scenario s --compare gateway \
//     --kinds observation_mask --connect-bin-b /abs/pr/anyray-connect --label my-connect-change
//     (--connect-bin-b <abs path>: anyray-connect configures arm B from that build, so B's
//      hooks and MCP server run it, while A runs ANYRAY_CONNECT_BIN: a pair that isolates
//      one connect change. Each arm's setup records its build's sha256 prefix, never the
//      path; refused when both builds are the same. The file must be called anyray-connect,
//      the command name the arm's checks expect. Keep both outside the temp dir:
//      connect installs no hooks or MCP server from a binary it finds there. With a pinned
//      build every Anyray arm starts from a no-app profile, so an installed Connect app
//      cannot take the configure over, and fails unless its hooks and MCP server run that
//      build: lib/agentRun.mjs armSeeds, lib/connectChecks.mjs checkConnectBinary)
//   node run_agent.mjs --scenario pyrepo-docs --rounds 4 --kinds observation_mask \
//     --claude-bin ~/.local/share/claude/versions/2.1.286
//     (--claude-bin <abs path>, or ANYRAY_CLAUDE_BIN (the flag wins): the Claude Code binary
//      BOTH arms spawn, for the task session and the warm-up: a `claude` executable, or a
//      directory holding one. Without it `claude` comes from PATH, which auto-update moves
//      between rounds. The run header prints the version; each arm's setup records it
//      (`client`, `claudeVersion`, `claudeBinSource`, never the path), per round too)
//   node run_agent.mjs --client codex --scenario gin-long-session --compare gateway \
//     --kinds relevance_filter --codex-hooks-b --rounds 8
//     (--client codex: both arms run `codex exec` on this machine's ChatGPT seat instead of
//      Claude Code; see runCodexComparison and lib/codexAgent.mjs. --codex-model / --codex-effort
//      pin the model and reasoning effort for both arms; --keep-codex-threads keeps the threads)
//   node run_agent.mjs --client codex --scenario gin-long-session --compare gateway \
//     --kinds relevance_filter --codex-config-b model_auto_compact_token_limit=150000 --rounds 8
//     (--codex-config-b: arm B alone runs with that Codex config, here the auto-compact threshold
//      connect writes from the gateway's codexAutoCompact policy; a round counts B as acting
//      only when it compacted more often than A, so a run that never reaches it is INSUFFICIENT)
//   node run_agent.mjs --client codex --scenario gin-long-session --compare gateway \
//     --kinds relevance_filter --codex-hooks-b [--connect-bin-b /abs/pr/anyray-connect] --rounds 8
//     (--codex-hooks-b: arm B alone runs connect's Codex PreToolUse source trim, the hook
//      anyray-connect installed in B's own home, declared and trusted as session config; A
//      keeps hooks off. A round counts B as acting only when B's connect wrapped a command,
//      and leaves the stats if a hook wrapped anything on A or B's wrap came from another
//      connect. --connect-bin-b: B's home configured by that build, A's by ANYRAY_CONNECT_BIN)
// Each arm's round line also shows its subagent load: `N subagents · M sub-req (M/N per
//   agent) · K main-req` (totals.subagentRequests, requestsPerSubagent, mainRequests); the
//   end-of-run summary pools it per arm (`subagentLoad`) and lists the Claude Code versions
//   the rounds ran on (`claudeVersions`), warning when a block mixed them.
// Output: results/agent/<scenario>--<compare>[--<label>].json (resumes; adds rounds), then
//   `npm run agent:report`.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { load as parseYaml } from 'js-yaml';
import { loadConfig } from './lib/loadConfig.mjs';
import { runAgent, describeSetup, describeRepo, prepareRepo, benchExtraHeaders, benchSharedHeaders, binDigest, answerText, runCheck, checkCitations, sessionDirParent, armSeeds, seedArmHome, sharedOutsideWrites } from './lib/agentRun.mjs';
import { runCodexAgent, configureCodexArmHome, deleteCodexThread, makeArmHome, removeArmHome, traceResults, codexHookSpec, realCodexHookKeys, wrappedCommandEnv, shellRunEnvFor } from './lib/codexAgent.mjs';
import { checkConnectBinary } from './lib/connectChecks.mjs';
import { ANYRAY_BIN, CONNECT_BIN_PINNED } from './lib/connectArm.mjs';
import { costOfAnthropicUsage } from './lib/cost.mjs';
import { bandPosition, differingNames, kindDifference, noiseBand, rule0, solvedPairVerdict } from './lib/stats.mjs';
import { benchVerdict, exclusionReasons, formatVerdictBlock } from './lib/benchVerdict.mjs';
import { countCacheBreaks } from './lib/cacheBreaks.mjs';
import { addGatewayPings, connectPolicy, gatewayReplicaStarts, optimizerConfig, restartedDuring, sessionGatewaySpend, sessionTraces } from './lib/traces.mjs';
import { savingsCheck, savingsCheckNote, savingsCheckSummary } from './lib/savingsCheck.mjs';
import { rmSync } from 'node:fs';
import { parseArmEnv, assertArmEnvSafe } from './lib/armEnv.mjs';
import { SHADOW_HEADER, parseKinds, tallyKinds, formatKindTally, otherKindsThatActed, heldOutKinds } from './lib/optimizationKinds.mjs';
import { experimentRules, sameRules, validExperimentName } from './lib/benchRule.mjs';
import { resolveBenchKey, benchTenantSetup } from './lib/benchKey.mjs';
import { bedrockOptions, bedrockSmallModel, probeGatewayRoute, assertBedrockRoute, modelMismatch } from './lib/bedrock.mjs';
import { formatChecks } from './lib/connectChecks.mjs';
import { runSdkAgent } from './lib/sdkAgent.mjs';
import { runFrameworkAgent } from './lib/frameworkAgent.mjs';
import { createBenchLevel, LEVELS, redactLevelError } from './lib/benchLevel.mjs';
import { claudeBinRequest, resolveClaudeBin, claudeVersion, describeClaudeBin } from './lib/claudeBin.mjs';

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

function parseTimeoutMin(v) {
  if (!/^[0-9]+$/.test(v ?? '') || Number(v) < 1) throw new Error(`--timeout-min needs a positive integer (minutes), got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  return Number(v);
}

function parseRetryInvalid(v) {
  if (!/^[0-9]+$/.test(v ?? '')) throw new Error(`--retry-invalid needs a whole number (how many extra rounds), got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  return Number(v);
}

function parseRedraw(v) {
  if (!/^[0-9]+$/.test(v ?? '') || Number(v) < 1) throw new Error(`--redraw-holdout needs a positive integer (how many restarts), got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
  return Number(v);
}

/**
 * Run a pair of sessions, and run it again when one of them reports that the gateway drew
 * it into a holdout (its control arm: the session runs without one strategy). The gateway
 * draws per session, so the two sessions of a pair are drawn separately; a pair where one
 * is held out compares two different strategy sets. Each attempt gets its own stop signal:
 * the arm that sees a holdout on one of its first responses reports it, which stops both.
 * `startPair(redraw)` returns `{ settled, … }`; the result is the last attempt's, plus the
 * draws that were thrown away. With `maxRedraws` 0 nothing is watched.
 */
export async function runPairWithRedraw(startPair, maxRedraws, onRedraw = () => {}) {
  const redraws = [];
  for (;;) {
    const controller = maxRedraws ? new AbortController() : null;
    const drawn = {};
    const report = (slot) => (held) => {
      drawn[slot] = held;
      controller.abort();
    };
    const result = await startPair(controller ? { signal: controller.signal, report } : null);
    if (controller?.signal.aborted && redraws.length < maxRedraws) {
      redraws.push(drawn);
      onRedraw(drawn, redraws.length);
      continue;
    }
    return { ...result, redraws };
  }
}

/**
 * `--hook-posture[-b] logRead=on` → ['logRead', 'on']. The name is one of connect's
 * camelCase fleetHookPolicy switches; the harness does not know which ones a build reads.
 */
export function parseHookPosture(flag, spec) {
  const m = /^([a-z][A-Za-z0-9]*)=(on|off)$/.exec(String(spec ?? ''));
  if (!m) throw new Error(`${flag} takes name=on|off, the name a plain identifier like logRead (got ${JSON.stringify(spec ?? null)})`);
  return [m[1], m[2]];
}

/** One flag's switches as {name: on|off}; a switch given both ways for the arm is refused. */
function postureOf(pairs, arm) {
  const out = {};
  for (const [name, value] of pairs) {
    if (Object.hasOwn(out, name) && out[name] !== value) throw new Error(`${name} is set both on and off for ${arm}`);
    out[name] = value;
  }
  return out;
}

/**
 * `--seed-home .anyray/hook-digest-routers.json=/abs/file` → { path, file, sha256 }: a file
 * placed in every Anyray arm's HOME before anyray-connect configures it (lib/agentRun.mjs
 * seedArmHome). The path is relative and stays inside the HOME; the file must exist.
 */
/** --mcp-catalog <n>: a positive integer count of synthetic MCP tools. */
export function parseMcpCatalog(value) {
  const n = Number(value);
  if (!/^\d+$/.test(String(value ?? '')) || !Number.isInteger(n) || n <= 0) throw new Error('--mcp-catalog needs a positive integer tool count');
  return n;
}

export function parseSeedHome(spec) {
  const at = String(spec ?? '').indexOf('=');
  const path = at > 0 ? String(spec).slice(0, at) : '';
  const file = at > 0 ? String(spec).slice(at + 1) : '';
  if (!path || path === '.' || isAbsolute(path) || normalize(path) !== path || path.split('/').includes('..')) throw new Error(`--seed-home takes <relative path in the arm HOME>=<absolute file>, got ${JSON.stringify(spec ?? null)}`);
  if (!isAbsolute(file) || !existsSync(file)) throw new Error(`--seed-home ${path}: the file must be an absolute path that exists`);
  return { path, file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) };
}

/** Scenarios whose arms are an in-process agent (no Claude Code), paired direct Bedrock vs gateway. */
export const SDK_SCENARIOS = ['sdk-docs', 'framework-docs'];
// Scenarios another runner drives (run_sdk_app.mjs): an Agent SDK app with no Claude Code
// hooks, so no connect work mode either. This harness refuses them.
export const APP_SCENARIOS = ['sdk-app-scanner', 'sdk-app-code-scan'];

/**
 * anyray-connect turns its main-agent read hint and Explore-subagent decline off when
 * the Claude Code session runs under `--max-turns` below this (WORK_MODE_MIN_TURN_CAP in
 * the monorepo's connect/src/util/readBatchNudge.ts). It reads the cap off the process
 * Claude Code names in CLAUDE_PID, which is the session this harness spawns, so a
 * scenario capped lower measures connect without the mode production sessions (no cap)
 * get. Keep the two in step.
 */
export const CONNECT_WORK_MODE_MIN_TURNS = 80;

/** Whether connect's work mode is on for a Claude Code scenario as run; null for an SDK scenario. */
export const connectWorkMode = (name, scenario) =>
  SDK_SCENARIOS.includes(name) ? null : (scenario.maxTurns ?? 40) >= CONNECT_WORK_MODE_MIN_TURNS ? 'on' : 'off_turn_cap';

export function parseArgs(argv, env = process.env) {
  const a = { scenario: null, rounds: 1, compare: 'anyray', label: null, strategy: null, readTrim: false, armEnv: [], kinds: null, kindsSource: null, noSubagents: false, experiment: null, experimentB: null, treatment: 'b', kindsB: null, readTrimB: false, hookPosture: {}, hookPostureB: {}, redrawHoldout: 0, maxTurns: null, withControl: false, parallel: 2, provider: 'anthropic', integrationLevel: null, interTurnDelaySec: null };
  const pins = { all: [], b: [] }; // --hook-posture / --hook-posture-b, in order
  let claudeBinFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scenario') a.scenario = argv[++i];
    else if (argv[i] === '--claude-bin') claudeBinFlag = argv[++i] ?? ''; // the Claude Code binary both arms spawn (wins over ANYRAY_CLAUDE_BIN)
    else if (argv[i] === '--rounds') a.rounds = Number(argv[++i]);
    else if (argv[i] === '--compare') a.compare = argv[++i];
    else if (argv[i] === '--label') a.label = argv[++i]; // keeps e.g. a single-strategy run apart
    else if (argv[i] === '--strategy') a.strategy = argv[++i]; // experiment=<kind> in the metadata header
    else if (argv[i] === '--read-trim') pins.all.push(['readTrim', 'on']); // Anyray arm: hooks.readTrim on for this session only
    else if (argv[i] === '--read-trim-b') pins.b.push(['readTrim', 'on']); // the same, on arm B only (--compare gateway)
    else if (argv[i] === '--hook-posture') pins.all.push(parseHookPosture('--hook-posture', argv[++i])); // name=on|off, repeatable: a connect hook switch on every Anyray arm
    else if (argv[i] === '--hook-posture-b') pins.b.push(parseHookPosture('--hook-posture-b', argv[++i])); // the same, on arm B only (--compare gateway)
    else if (argv[i] === '--integration-level') a.integrationLevel = argv[++i] ?? '';
    else if (argv[i] === '--arm-env') a.armEnv.push(argv[++i]); // [a:|b:]KEY=VALUE[,…]: extra session env
    else if (argv[i] === '--kinds') [a.kinds, a.kindsSource] = [parseKinds(argv[++i]), '--kinds']; // x-anyray-optimization-kinds
    else if (argv[i] === '--kinds-b') a.kindsB = parseKinds(argv[++i]); // arm B's own kinds (--compare gateway)
    else if (argv[i] === '--connect-bin-b') a.connectBinB = argv[++i] ?? ''; // arm B configured by another anyray-connect build (--compare gateway)
    else if (argv[i] === '--client-tool-policy') a.clientToolPolicies = { ...(a.clientToolPolicies ?? {}), ...parseClientToolPolicy(argv[++i]) }; // name=true|false, repeatable: connect's MCP tool switches on the Anyray arm
    else if (argv[i] === '--client-tool-policy-b') a.clientToolPoliciesB = { ...(a.clientToolPoliciesB ?? {}), ...parseClientToolPolicy(argv[++i]) }; // the same, on arm B only (--compare gateway)
    else if (argv[i] === '--warm-up') a.warmUp = true; // both arms: a throwaway one-turn session first, so each starts with a warm prefix
    else if (argv[i] === '--no-subagents') a.noSubagents = true; // both arms: --disallowed-tools Task Workflow
    else if (argv[i] === '--mcp-catalog') a.mcpCatalog = parseMcpCatalog(argv[++i]); // both arms: a stub MCP server listing N synthetic tools (catalog weight)
    else if (argv[i] === '--experiment') a.experiment = argv[++i]; // experiment=<name> in x-anyray-metadata, for a gateway rule
    else if (argv[i] === '--experiment-b') a.experimentB = argv[++i] ?? ''; // the same, on arm B only (--compare gateway)
    else if (argv[i] === '--treatment') a.treatment = parseTreatment(argv[++i]); // which arm is under test: b (default) or a; the verdict reads the ratio as treatment ÷ control
    else if (argv[i] === '--redraw-holdout') a.redrawHoldout = parseRedraw(argv[++i]); // restart a pair the gateway drew into a holdout, up to N times
    else if (argv[i] === '--retry-invalid') a.retryInvalid = parseRetryInvalid(argv[++i]); // run a round the verdict would drop again, up to N extra rounds
    else if (argv[i] === '--max-turns') a.maxTurns = parseMaxTurns(argv[++i]); // both arms: overrides scenario.maxTurns
    else if (argv[i] === '--timeout-min') a.timeoutMin = parseTimeoutMin(argv[++i]); // both arms: overrides scenario.timeoutMin (the session's wall-clock cap)
    else if (argv[i] === '--inter-turn-delay-sec') a.interTurnDelaySec = Number(argv[++i]);
    else if (argv[i] === '--with-control') a.withControl = true; // also run direct vs direct, in parallel: the noise band
    else if (argv[i] === '--parallel') a.parallel = parseParallel(argv[++i]); // rounds in flight, shared with --with-control
    else if (argv[i] === '--provider') a.provider = argv[++i]; // anthropic (seat) | bedrock (AWS direct vs the gateway's Bedrock route)
    else if (argv[i] === '--bare') a.bare = true; // Anyray arm = base URL + headers only: no anyray-connect, optimization off
    else if (argv[i] === '--persist-session') a.persistSession = true; // the default: both arms keep their transcript, as Claude Code does outside the bench
    else if (argv[i] === '--no-persist-session') a.persistSession = false; // both arms run --no-session-persistence, as every run did before 2026-10-12
    else if (argv[i] === '--client') a.client = argv[++i]; // claude-code (default) | codex: the agent both arms run
    else if (argv[i] === '--codex-model') a.codexModel = argv[++i] ?? ''; // --client codex: the model both arms run (default: Codex's own)
    else if (argv[i] === '--codex-effort') a.codexEffort = argv[++i] ?? ''; // --client codex: model_reasoning_effort for both arms (default: the model's own)
    else if (argv[i] === '--codex-config-b') (a.codexConfigB ??= []).push(parseCodexConfig(argv[++i])); // --client codex: a Codex config key=value arm B alone runs with (repeatable)
    else if (argv[i] === '--keep-codex-threads') a.keepCodexThreads = true; // --client codex: leave the sessions' threads in ~/.codex (default: deleted after reading)
    else if (argv[i] === '--codex-hooks-b') a.codexHooksB = true; // --client codex: arm B alone runs connect's Codex PreToolUse hook (the source trim)
    else if (argv[i] === '--seed-home') a.seedHome = [...(a.seedHome ?? []), parseSeedHome(argv[++i])]; // <path>=<file>, repeatable: placed in every Anyray arm's HOME before connect configures it
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.scenario) throw new Error('--scenario <name> is required');
  if (APP_SCENARIOS.includes(a.scenario)) throw new Error(`${a.scenario} runs with run_sdk_app.mjs, not this harness`);
  a.client ??= 'claude-code';
  if (!['claude-code', 'codex'].includes(a.client)) throw new Error('--client claude-code|codex');
  if (a.client !== 'codex' && (a.codexModel !== undefined || a.codexEffort !== undefined || a.keepCodexThreads || a.codexConfigB || a.codexHooksB)) throw new Error('--codex-model, --codex-effort, --codex-config-b, --codex-hooks-b and --keep-codex-threads need --client codex');
  // --read-trim(-b) is readTrim=on: one posture, so both spellings reach every check below.
  a.hookPosture = postureOf(pins.all, 'every Anyray arm');
  postureOf([...pins.all, ...pins.b], 'arm B'); // --hook-posture reaches B too
  a.hookPostureB = postureOf(pins.b, 'arm B');
  a.readTrim = a.hookPosture.readTrim === 'on';
  a.readTrimB = a.hookPostureB.readTrim === 'on';
  const pinsHooks = Object.keys(a.hookPosture).length + Object.keys(a.hookPostureB).length > 0;
  if (a.interTurnDelaySec !== null && (!Number.isFinite(a.interTurnDelaySec) || a.interTurnDelaySec < 0)) throw new Error('--inter-turn-delay-sec needs a nonnegative number');
  // --claude-bin / ANYRAY_CLAUDE_BIN: what was asked for; resolveClaudeBin checks it exists
  // and runs when the comparison starts. An empty flag value is refused here, not ignored.
  if (claudeBinFlag === '') throw new Error('--claude-bin takes an absolute path to a claude executable (or a directory holding one)');
  a.claudeBin = claudeBinRequest({ flag: claudeBinFlag, env });
  if (a.claudeBin.path && !isAbsolute(a.claudeBin.path)) throw new Error(`${a.claudeBin.source} takes an absolute path to a claude executable (or a directory holding one), got ${JSON.stringify(a.claudeBin.path)}`);
  if (SDK_SCENARIOS.includes(a.scenario)) {
    if (a.provider !== 'bedrock' || a.compare !== 'anyray') throw new Error(`${a.scenario} needs --provider bedrock and --compare anyray`);
    if (a.withControl || a.bare || a.warmUp || pinsHooks || a.integrationLevel || a.clientToolPolicies || a.clientToolPoliciesB || a.armEnv.length || a.strategy || a.experiment || a.experimentB || a.redrawHoldout || a.noSubagents || a.mcpCatalog || a.persistSession !== undefined || claudeBinFlag) throw new Error(`${a.scenario} supports the paired SDK comparison, --kinds, --max-turns, --inter-turn-delay-sec and --retry-invalid`);
  } else if (a.interTurnDelaySec !== null) throw new Error(`--inter-turn-delay-sec is for ${SDK_SCENARIOS.join(' and ')}`);
  if (!COMPARES.includes(a.compare)) throw new Error('--compare anyray|control|gateway');
  if (!['anthropic', 'bedrock'].includes(a.provider)) throw new Error('--provider anthropic|bedrock');
  const gateway = a.compare !== 'control';
  for (const [flag, on] of [['--strategy', a.strategy], ['--read-trim', a.readTrim], ['--hook-posture', Object.keys(a.hookPosture).length], ['--kinds', a.kinds], ['--experiment', a.experiment], ['--integration-level', a.integrationLevel], ['--redraw-holdout', a.redrawHoldout]]) {
    if (on && !gateway) throw new Error(`${flag} needs --compare anyray or gateway`);
  }
  if (a.integrationLevel !== null && !LEVELS.includes(a.integrationLevel)) throw new Error(`--integration-level must be ${LEVELS.join('|')}`);
  if (a.readTrim && a.integrationLevel && a.integrationLevel !== 'gateway_hooks_mcp') throw new Error('--read-trim needs --integration-level gateway_hooks_mcp: lower levels cannot retrieve');
  if (a.withControl && a.compare === 'control') throw new Error('--with-control adds a direct-vs-direct control; --compare control already is one');
  if (a.experiment && a.strategy) throw new Error('--experiment and --strategy both set the experiment tag: use one');
  if (a.treatment !== 'b' && a.compare !== 'gateway') throw new Error('--treatment a needs --compare gateway: only two gateway arms can have A under test');
  if (a.experimentB !== null) {
    if (a.compare !== 'gateway') throw new Error('--experiment-b needs --compare gateway: it tags arm B of two gateway arms');
    if (!validExperimentName(a.experimentB)) throw new Error(`--experiment-b must be a plain name (letters, digits, ".", "_", "-"), got ${JSON.stringify(a.experimentB)}`);
    if (a.strategy) throw new Error('--experiment-b and --strategy both set the experiment tag: use --kinds with --experiment-b');
    if (a.experimentB === a.experiment) throw new Error('--experiment-b must differ from --experiment: a rule keyed on it would match both arms');
  }
  // --kinds-b / --read-trim-b: arm B alone differs, so the pair isolates that one change.
  if (a.kindsB !== null) {
    if (a.compare !== 'gateway') throw new Error('--kinds-b needs --compare gateway: it sets arm B of two gateway arms');
    if (!a.kinds && !a.strategy) throw new Error('--kinds-b needs --kinds: arm A requests its own strategies too');
    if (a.kinds && a.kinds.join(',') === a.kindsB.join(',')) throw new Error('--kinds-b must differ from --kinds: otherwise A and B are the same arm');
  }
  // --connect-bin-b: arm B alone runs another connect build; A runs ANYRAY_CONNECT_BIN.
  if (a.connectBinB !== undefined) {
    if (a.compare !== 'gateway') throw new Error('--connect-bin-b needs --compare gateway: it sets arm B of two gateway arms');
    if (!isAbsolute(a.connectBinB)) throw new Error('--connect-bin-b takes an absolute path to an anyray-connect binary');
    // connect writes its own path into the hooks and MCP server, and the arm's checks (like
    // a real install) expect that command to be anyray-connect: name the file so.
    if (basename(a.connectBinB) !== 'anyray-connect') throw new Error(`--connect-bin-b must name a file called anyray-connect (put the build at <dir>/anyray-connect), got ${basename(a.connectBinB)}`);
    if (a.bare) throw new Error('--bare runs without anyray-connect, which --connect-bin-b replaces on arm B');
  }
  if (a.readTrimB) {
    if (a.compare !== 'gateway') throw new Error('--read-trim-b needs --compare gateway: it sets arm B of two gateway arms');
    if (a.readTrim) throw new Error('--read-trim already turns it on for both arms: use one of --read-trim and --read-trim-b');
    if (a.integrationLevel && a.integrationLevel !== 'gateway_hooks_mcp') throw new Error('--read-trim-b needs --integration-level gateway_hooks_mcp: lower levels cannot retrieve');
  }
  if (Object.keys(a.hookPostureB).length) {
    if (a.compare !== 'gateway') throw new Error('--hook-posture-b needs --compare gateway: it sets arm B of two gateway arms');
    const same = Object.keys(a.hookPostureB).find((name) => Object.hasOwn(a.hookPosture, name)); // same value: both ways is refused above
    if (same) throw new Error(`--hook-posture already sets ${same}=${a.hookPosture[same]} on both arms: use one of --hook-posture and --hook-posture-b`);
  }
  if (a.clientToolPoliciesB) {
    if (a.compare !== 'gateway') throw new Error('--client-tool-policy-b needs --compare gateway: it sets arm B of two gateway arms');
    const same = Object.keys(a.clientToolPoliciesB).find((name) => Object.hasOwn(a.clientToolPolicies ?? {}, name));
    if (same) throw new Error(`--client-tool-policy already sets ${same}=${a.clientToolPolicies[same]} on both arms: use one of --client-tool-policy and --client-tool-policy-b`);
  }
  if (pinsHooks && a.integrationLevel === 'gateway') throw new Error("--hook-posture needs connect's hooks: --integration-level gateway installs none");
  // The Anyray arm always names the strategies it measures: the tenant's defaults drift
  // (admin changes, regret-guard verdicts), so a run that inherits them is not reproducible.
  if (a.strategy && a.kinds && !a.kinds.includes(a.strategy)) throw new Error(`--strategy ${a.strategy} must be one of --kinds`);
  if (a.strategy && !a.kinds) [a.kinds, a.kindsSource] = [parseKinds(a.strategy), '--strategy'];
  // --bare measures the seat that changed only its base URL: nothing client-side, nothing optimized.
  if (a.bare && !gateway) throw new Error('--bare needs --compare anyray or gateway');
  if (a.bare && (a.clientToolPolicies || a.clientToolPoliciesB)) throw new Error('--bare runs without anyray-connect, which is what reads --client-tool-policy');
  if (a.bare && a.integrationLevel) throw new Error('--bare runs without anyray-connect, which is what applies --integration-level: use one or the other');
  if (a.bare && (a.kinds || a.readTrim || a.provider === 'bedrock')) throw new Error('--bare runs with optimization off on the seat lane: it takes no --kinds, --strategy, --read-trim or --provider bedrock');
  if (a.bare && pinsHooks) throw new Error('--bare runs without anyray-connect, whose hooks --hook-posture sets');
  if (a.seedHome?.length && (!gateway || a.bare || SDK_SCENARIOS.includes(a.scenario))) throw new Error('--seed-home needs an anyray-connect arm: --compare anyray or gateway, not --bare');
  if (a.client === 'codex') assertCodexArgs(a, { claudeBinFlag, pinsHooks });
  if (gateway && !a.kinds && !a.bare && !SDK_SCENARIOS.includes(a.scenario)) {
    throw new Error(`--compare ${a.compare} needs --kinds <k1,k2> (or --strategy <kind>): the Anyray arm requests its strategies explicitly, never the gateway defaults`);
  }
  a.label ??= a.strategy;
  if (a.provider === 'bedrock') a.label ??= 'bedrock'; // never mixed into a seat run's file
  if (a.bare) a.label = a.label ? `bare-${a.label}` : 'bare'; // never mixed into a connect-configured run's file
  if (a.client === 'codex') a.label = a.label ? `codex-${a.label}` : 'codex'; // never mixed into a Claude Code run's file
  a.env = parseArmEnv(a.armEnv);
  assertArmEnvSafe(a.env.a);
  assertArmEnvSafe(a.env.b);
  return a;
}

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const CODEX_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * --client codex runs `codex exec` in both arms (lib/codexAgent.mjs). Claude Code's own
 * switches have no Codex counterpart, so they are refused rather than ignored.
 */
function assertCodexArgs(a, { claudeBinFlag, pinsHooks }) {
  if (SDK_SCENARIOS.includes(a.scenario)) throw new Error(`${a.scenario} runs its own SDK agent, not Codex`);
  if (a.provider !== 'anthropic') throw new Error('--client codex runs on the ChatGPT seat: --provider does not apply');
  const claudeOnly = [['--claude-bin', claudeBinFlag], ['--read-trim / --hook-posture', pinsHooks], ['--integration-level', a.integrationLevel], ['--client-tool-policy', a.clientToolPolicies], ['--client-tool-policy-b', a.clientToolPoliciesB], ['--warm-up', a.warmUp], ['--no-subagents', a.noSubagents], ['--mcp-catalog', a.mcpCatalog], ['--(no-)persist-session', a.persistSession !== undefined], ['--arm-env', a.armEnv.length], ['--bare', a.bare], ['--seed-home', a.seedHome?.length], ['--redraw-holdout', a.redrawHoldout], ['--max-turns', a.maxTurns]];
  const used = claudeOnly.filter(([, on]) => on).map(([flag]) => flag);
  if (used.length) throw new Error(`--client codex does not take ${used.join(', ')}: ${used.includes('--max-turns') ? 'Codex has no turn cap (use --timeout-min); ' : ''}those are Claude Code switches`);
  if (a.codexModel !== undefined && !CODEX_MODEL.test(a.codexModel)) throw new Error(`--codex-model takes a model id, got ${JSON.stringify(a.codexModel)}`);
  if (a.codexEffort !== undefined && !CODEX_EFFORTS.includes(a.codexEffort)) throw new Error(`--codex-effort must be ${CODEX_EFFORTS.join('|')}`);
  if (a.codexConfigB) {
    // Both arms on one route, so the config is the only difference; B carries it.
    if (!['gateway', 'control'].includes(a.compare)) throw new Error('--codex-config-b needs --compare gateway or control: both arms on one route, B alone differing');
    if (a.treatment !== 'b') throw new Error('--codex-config-b is the treatment on B: use treatment b');
    const hookKey = a.codexConfigB.find(([key]) => key === 'hooks' || key.startsWith('hooks.') || key === 'features.hooks');
    if (hookKey) throw new Error(`--codex-config-b cannot set ${hookKey[0]}: the harness owns Codex's hooks on both arms (--codex-hooks-b)`);
  }
  if (a.codexHooksB) {
    // Two gateway arms, each with its own connect home; only B's hook runs.
    if (a.compare !== 'gateway') throw new Error("--codex-hooks-b needs --compare gateway: both arms through the gateway, B alone running connect's hook");
    if (a.treatment !== 'b') throw new Error('--codex-hooks-b is the treatment on B: use treatment b');
  }
}

const CODEX_CONFIG_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const CODEX_CONFIG_VALUE = /^(\d{1,9}|true|false)$/;
/** `--codex-config-b key=value`: a dotted Codex config key and an integer or boolean. */
function parseCodexConfig(raw) {
  const at = String(raw ?? '').indexOf('=');
  const key = at > 0 ? raw.slice(0, at) : '';
  const value = at > 0 ? raw.slice(at + 1) : '';
  if (!CODEX_CONFIG_KEY.test(key) || !CODEX_CONFIG_VALUE.test(value)) throw new Error(`--codex-config-b takes key=value (a dotted Codex config key, an integer or boolean), got ${JSON.stringify(raw ?? '')}`);
  return [key, value];
}

/**
 * A scenario's `pastes` filled in: `pastes: { ciLog: ci-log.txt }` reads that file (beside
 * scenario.yaml) and puts its text wherever `{{ciLog}}` stands in `task` or a follow-up, so
 * a block the user pastes into several turns is kept once and sent byte for byte the same.
 * `read` maps a file name to its text; a placeholder with no paste, or a paste no turn
 * uses, is an error.
 */
export function fillPastes(scenario, read) {
  if (!scenario.pastes) return scenario;
  for (const file of Object.values(scenario.pastes)) if (!/^[\w.-]+$/.test(String(file))) throw new Error(`paste file ${JSON.stringify(file)} must be a file name beside scenario.yaml`);
  const text = Object.fromEntries(Object.entries(scenario.pastes).map(([name, file]) => [name, read(file).replace(/\n$/, '')]));
  const used = new Set();
  const fill = (turn) => (typeof turn !== 'string' ? turn : turn.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in text)) throw new Error(`scenario turn names {{${name}}}, which is not in pastes`);
    used.add(name);
    return text[name];
  }));
  const filled = { ...scenario, task: fill(scenario.task), ...(scenario.followups ? { followups: scenario.followups.map(fill) } : {}) };
  const unused = Object.keys(text).filter((name) => !used.has(name));
  if (unused.length) throw new Error(`pastes ${unused.join(', ')} appear in no turn`);
  return filled;
}

/** scenarios/<name>/scenario.yaml, its pastes filled in. */
export const readScenarioFile = (dir) => fillPastes(parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8')), (file) => readFileSync(join(dir, file), 'utf8'));

/** The scenario as both arms run it: --max-turns replaces its turn cap. */
export const effectiveScenario = (scenario, args) =>
  args.maxTurns || args.timeoutMin || args.interTurnDelaySec !== null && args.interTurnDelaySec !== undefined
    ? { ...scenario, ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}), ...(args.timeoutMin ? { timeoutMin: args.timeoutMin } : {}), ...(args.interTurnDelaySec !== null && args.interTurnDelaySec !== undefined ? { interTurnDelaySec: args.interTurnDelaySec } : {}) }
    : scenario;

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
  experimentB: null,
  kindsB: null,
  readTrimB: false,
  clientToolPoliciesB: null,
  connectBinB: undefined,
  connectBinBDigest: undefined,
  codexHooksB: false, // a direct arm has no connect hook to run
  seedHome: undefined, // no Anyray arm to seed
  redrawHoldout: 0,
  readTrim: false,
  hookPosture: {},
  hookPostureB: {},
  integrationLevel: null,
  armEnv: [],
  env: { a: {}, b: {} },
  extraHeaders: [],
  withControl: false,
  bare: false,
});

/**
 * The connect hook switches a slot's session pins: `--hook-posture` on every Anyray arm,
 * `--hook-posture-b` on slot B of a gateway pair (parseArgs refused any overlap).
 */
export const armHookPosture = (args, arm, slot) =>
  arm === 'anyray' ? { ...(args.hookPosture ?? {}), ...(slot === 'b' ? args.hookPostureB ?? {} : {}) } : {};

/** `--read-trim` applies to the Anyray arm only; `--read-trim-b` to slot B of a gateway pair. */
export const armReadTrim = (args, arm, slot) => armHookPosture(args, arm, slot).readTrim === 'on';

/** readTrim=on keeps its own spelling (`readTrim` in slotOptions, `read-trim` in the label), as before --hook-posture. */
const isReadTrimOn = ([name, value]) => name === 'readTrim' && value === 'on';

/** slotOptions' `hookPosture`: present only when the slot pins more than readTrim=on. */
const postureOption = (posture) => (Object.entries(posture).some((e) => !isReadTrimOn(e)) ? { hookPosture: posture } : {});

/** A slot's connect client-tool switches: `--client-tool-policy`, then `--client-tool-policy-b` on slot B (parseArgs refused any overlap). */
const slotClientToolPolicies = (args, slot) => {
  const own = slot === 'b' ? args.clientToolPoliciesB ?? null : null;
  return args.clientToolPolicies || own ? { ...(args.clientToolPolicies ?? {}), ...(own ?? {}) } : null;
};

/** The kinds a slot requests: `--kinds-b` replaces `--kinds` on slot B. */
const slotKinds = (args, slot) => (slot === 'b' && args.kindsB ? [args.kindsB, '--kinds-b'] : [args.kinds ?? null, args.kindsSource ?? null]);

/**
 * Under --kinds-b, the kinds the arms differ by, which both Anyray arms ask the gateway to
 * evaluate in shadow: the verdict then scores only the pairs where they would act in both.
 */
const shadowKindsOf = (args) => {
  const d = args.kindsB ? kindDifference(slotKinds(args, 'a')[0], args.kindsB) : null;
  return d ? [...d.a, ...d.b] : [];
};

/** How a gateway pair's verdict reads it: the arm under test and, under --kinds-b, the kinds the arms differ by. */
export const verdictOptions = (args) => ({
  treatment: args.treatment ?? 'b',
  differingKinds: args.kindsB ? kindDifference(slotKinds(args, 'a')[0], args.kindsB) : null,
  ...(args.clientToolPoliciesB ? { clientToolTreatment: true } : {}), // --client-tool-policy-b: the treatment acts through client-tool calls
});

/**
 * One slot's runAgent options beyond the shared ones. --read-trim follows the ARM (anyray),
 * --arm-env follows the SLOT (a/b): under --compare control both slots are 'direct'.
 */
export const slotOptions = (args, arms, slot) => ({
  arm: arms[slot],
  readTrim: armReadTrim(args, arms[slot], slot),
  ...postureOption(armHookPosture(args, arms[slot], slot)),
  env: args.env?.[slot] ?? {},
  kinds: arms[slot] === 'anyray' ? slotKinds(args, slot)[0] : null,
  kindsSource: arms[slot] === 'anyray' ? slotKinds(args, slot)[1] : null,
  // ANYRAY_BENCH_SHARED_HEADERS on every Anyray arm, then the treatment on B.
  extraHeaders: [
    ...(arms[slot] === 'anyray' ? args.sharedHeaders ?? [] : []),
    ...(carriesExtraHeaders(arms, slot) ? args.extraHeaders ?? [] : []),
    ...(arms[slot] === 'anyray' && shadowKindsOf(args).length ? [`${SHADOW_HEADER}: ${shadowKindsOf(args).join(',')}`] : []),
  ],
  ...(arms[slot] === 'anyray' && shadowKindsOf(args).length ? { shadowKinds: shadowKindsOf(args) } : {}),
  noSubagents: !!args.noSubagents, // both slots, so the pair stays like for like
  ...(args.mcpCatalog ? { mcpCatalog: args.mcpCatalog } : {}), // both slots: the same synthetic catalog on either arm
  provider: args.provider ?? 'anthropic',
  bedrock: args.bedrock ?? null,
  ...(arms[slot] === 'anyray' && args.integrationLevel ? { integrationLevel: args.integrationLevel } : {}),
  ...(arms[slot] === 'anyray' && slotClientToolPolicies(args, slot) ? { clientToolPolicies: slotClientToolPolicies(args, slot) } : {}),
  ...(slot === 'b' && arms[slot] === 'anyray' && args.connectBinB ? { connectBin: args.connectBinB } : {}), // --connect-bin-b
  // --connect-bin-b: A's build (ANYRAY_CONNECT_BIN) is pinned as much as B's, so both arms
  // start from the same no-app profile and must run exactly their build.
  ...(arms[slot] === 'anyray' && args.connectBinB ? { connectBinPinned: true } : {}),
  ...(arms[slot] === 'anyray' && args.seedHome?.length ? { seedHome: args.seedHome } : {}), // --seed-home: every Anyray arm, identically
  bare: !!args.bare && arms[slot] === 'anyray',
  warmUp: !!args.warmUp, // both slots, so the pair stays like for like
  ...(args.persistSession === false ? { persistSession: false } : {}), // --no-persist-session: both slots, so the pair stays like for like
  ...(args.claude ? { claude: args.claude } : {}), // the resolved Claude Code binary, both slots (--claude-bin / ANYRAY_CLAUDE_BIN / PATH)
});

/** What the run asked of the arms beyond --kinds / --read-trim, as recorded (header names only). */
export const requestRecord = (args) => ({
  noSubagents: !!args.noSubagents,
  ...(args.timeoutMin ? { timeoutMin: args.timeoutMin } : {}), // the session cap both arms ran under
  ...(args.mcpCatalog ? { mcpCatalog: args.mcpCatalog } : {}), // synthetic MCP tools both arms carried
  bare: !!args.bare,
  warmUp: !!args.warmUp,
  experiment: args.experiment ?? null,
  ...(args.experimentB ? { experimentB: args.experimentB } : {}), // arm B's own tag
  ...(args.kindsB ? { kindsB: args.kindsB } : {}), // arm B's own kinds
  ...(shadowKindsOf(args).length ? { shadowKinds: shadowKindsOf(args) } : {}), // evaluated in shadow on both Anyray arms
  ...(args.codexConfigB ? { codexConfigB: Object.fromEntries(args.codexConfigB) } : {}), // arm B's own Codex config
  ...(args.codexHooksB ? { codexHooksB: true } : {}), // arm B alone runs connect's Codex PreToolUse hook
  ...(args.connectBinB ? { connectBinB: args.connectBinBDigest ?? null } : {}), // arm B's connect build (sha256 prefix, never the path)
  ...(args.claude?.pinned ? { claudeBin: { source: args.claude.source, version: args.claude.version ?? null } } : {}), // both arms' pinned Claude Code build (never the path)
  ...(args.readTrimB ? { readTrimB: true } : {}), // arm B alone trims nested Reads
  ...(Object.keys(args.hookPosture ?? {}).length ? { hookPosture: args.hookPosture } : {}), // connect hook switches every Anyray arm pins
  ...(Object.keys(args.hookPostureB ?? {}).length ? { hookPostureB: args.hookPostureB } : {}), // the switches arm B alone pins
  ...(args.redrawHoldout ? { redrawHoldout: args.redrawHoldout } : {}),
  ...(args.retryInvalid ? { retryInvalid: args.retryInvalid } : {}),
  persistSession: args.persistSession !== false, // false: --no-persist-session (and every record written before this field)
  extraHeaders: (args.extraHeaders ?? []).map((h) => h.slice(0, h.indexOf(':')).trim()),
  extraHeadersOn: (args.extraHeaders ?? []).length ? ['a', 'b'].filter((slot) => carriesExtraHeaders(armsFor(args.compare), slot)) : [],
  ...((args.sharedHeaders ?? []).length ? { sharedHeaders: args.sharedHeaders.map((h) => h.slice(0, h.indexOf(':')).trim()) } : {}),
  ...(args.integrationLevel ? { integrationLevel: args.integrationLevel } : {}),
  ...(args.clientToolPolicies ? { clientToolPolicies: args.clientToolPolicies } : {}),
  ...(args.clientToolPoliciesB ? { clientToolPoliciesB: args.clientToolPoliciesB } : {}), // the switches arm B alone sets
  ...(args.seedHome?.length ? { seedHome: args.seedHome.map(({ path, sha256 }) => ({ path, sha256 })) } : {}), // never the source path
});

/** results/agent/<scenario>--<compare>[--<label>].json */
export const resultFileName = (args) => `${args.scenario}--${args.compare}${args.label ? `--${args.label}` : ''}.json`;

/**
 * B ÷ A cost. An arm that ended without a result event (timed out, killed) has no
 * cost: the round is an error, never a ratio of 0 or ∞.
 */
export function roundRatio(a, b) {
  const missing = [['A', a], ['B', b]].filter(([, s]) => s.totals.costUsd == null);
  if (!missing.length) return { ratio: a.totals.costUsd ? b.totals.costUsd / a.totals.costUsd : null };
  const plain = missing.filter(([, s]) => !s.totals.timedOutAfterAnswer).map(([n]) => n);
  const cut = missing.filter(([, s]) => s.totals.timedOutAfterAnswer).map(([n]) => n);
  const why = [
    ...(plain.length ? [`${plain.join(' and ')} ended without a result (no cost)`] : []),
    ...(cut.length ? [`${cut.join(' and ')} answered, then timed out before Claude Code reported a cost`] : []),
  ];
  return { ratio: null, error: why.join('; ') };
}

/** The rounds Rule 0 scores: not failed, and no gateway restart under them. */
export const scoredRounds = (rounds) => rounds.filter((x) => !x.error && !x.gatewayRestarted && !x.hookLeak);

/** `--treatment a|b`: the arm the Rule 0 verdict is for. B by construction (`--experiment-b`,
 * `--kinds-b` change B alone); `a` when the default is under test and B carries the switch-off. */
function parseTreatment(value) {
  if (value !== 'a' && value !== 'b') throw new Error(`--treatment must be a or b, got ${JSON.stringify(value ?? '')}`);
  return value;
}

/** Main-agent requests that issued more than one tool call (Claude Code's parallel tool use). */
export const parallelToolTurns = (requests) =>
  requests.filter((r) => r.agent === 'main' && r.blocks.filter((b) => b.type === 'tool_use').length > 1).length;

/**
 * How the session's model requests split between the main agent and its subagents, and
 * the load per subagent (requests whose `agent` is not `main`, over the Task calls that
 * spawned subagents; null with no subagents). This is what moves between Claude Code
 * versions, and what the cost per round follows: say it on every round line.
 */
export function subagentLoad(requests, subagents) {
  const subagentRequests = requests.filter((r) => r.agent !== 'main').length;
  const n = subagents?.length ?? 0;
  return { mainRequests: requests.length - subagentRequests, subagentRequests, requestsPerSubagent: n ? subagentRequests / n : null };
}

/** The round line's subagent part: ` · 4 subagents · 68 sub-req (17.0/agent) · 20 main-req`. */
export const subagentNote = (t) =>
  ` · ${t.subagents} subagents · ${t.subagentRequests ?? 0} sub-req${t.requestsPerSubagent == null ? '' : ` (${t.requestsPerSubagent.toFixed(1)}/agent)`} · ${t.mainRequests ?? 0} main-req`;

/**
 * The run's subagent load per arm, pooled over the rounds that have a session (failed
 * rounds have none): Σ subagent requests ÷ Σ subagents (null when no round spawned one),
 * with the per-round ratios beside it. Written to the record as `subagentLoad`.
 */
export function subagentLoadSummary(rounds) {
  const arm = (slot) => {
    const totals = rounds.map((r) => r.sessions?.[slot]?.totals).filter((t) => t && t.subagentRequests != null);
    const sum = (key) => totals.reduce((n, t) => n + (t[key] ?? 0), 0);
    const subagents = sum('subagents');
    const subagentRequests = sum('subagentRequests');
    return { rounds: totals.length, subagents, subagentRequests, mainRequests: sum('mainRequests'), requestsPerSubagent: subagents ? subagentRequests / subagents : null };
  };
  return {
    a: arm('a'),
    b: arm('b'),
    perRound: rounds.filter((r) => r.sessions).map((r) => ({ round: r.round, a: r.sessions.a?.totals?.requestsPerSubagent ?? null, b: r.sessions.b?.totals?.requestsPerSubagent ?? null })),
  };
}

/**
 * Which Claude Code version each arm's sessions ran, counted over the rounds (from each
 * session's `setup.claudeVersion`; 'unknown' when a round recorded none), and whether
 * the block mixed versions: across its rounds, or between its arms.
 */
export function claudeVersions(rounds) {
  const count = (slot) => {
    const out = {};
    for (const r of rounds) {
      if (!r.sessions?.[slot]) continue;
      const v = r.sessions[slot].setup?.claudeVersion ?? 'unknown';
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };
  const a = count('a');
  const b = count('b');
  const seen = new Set([...Object.keys(a), ...Object.keys(b)]);
  return { a, b, mixed: seen.size > 1 };
}

/** `2.1.286 ×3, 2.1.292 ×1`, or 'n/a' with no sessions. */
const versionList = (counts) => (Object.keys(counts).length ? Object.entries(counts).map(([v, n]) => `${v} ×${n}`).join(', ') : 'n/a');

/**
 * Each slot's x-anyray-metadata tag. Under --compare gateway both slots are gateway
 * arms, so each gets its own session id (suffix -a / -b): otherwise their traces,
 * spend and optimizer session state would merge. Other compares share one tag.
 */
export function roundTags(args, round, now = Date.now()) {
  const tag = roundTag(args, round, now);
  if (args.compare !== 'gateway') return { a: tag, b: tag };
  // --experiment-b: B alone carries that tag, so a gateway rule keyed on it reaches B only.
  const b = args.experimentB ? { ...tag, experiment: args.experimentB } : tag;
  return { a: { ...tag, sessionId: `${tag.sessionId}-a` }, b: { ...b, sessionId: `${tag.sessionId}-b` } };
}

/**
 * Which requested kinds a gateway holdout withheld from each arm (from the arms' feedback
 * tallies), and whether the arms differ. The gateway draws its control per session, so the
 * two sessions of a round are drawn separately: a round where they differ compares two
 * different strategy sets and should be discarded.
 */
export function heldOutRecord(tallies) {
  const out = Object.fromEntries(Object.entries(tallies).map(([slot, t]) => [slot, heldOutKinds(t)]));
  const lists = Object.values(out).map((k) => k.join(','));
  return { ...out, differs: lists.length > 1 && new Set(lists).size > 1 };
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
  const one = (slot) => ({ ...describe(slot), ...(args.integrationLevel ? { integrationLevel: arms[slot] === 'anyray' ? args.integrationLevel : null } : {}), maxTurnsSource: args.maxTurns ? '--max-turns' : 'scenario', parallel: args.parallel ?? 1 });
  return { a: one('a'), b: one('b') };
}

/** What each arm was actually configured with this round (the Anyray arm by anyray-connect) over the planned setup. */
export const withSessionSetups = (setup, sessions) =>
  Object.fromEntries(Object.entries(setup).map(([slot, planned]) => [slot, sessions[slot]?.setup ? { ...planned, ...sessions[slot].setup } : planned]));

/**
 * What each agent's FIRST request read from the provider cache and wrote to it, summed
 * over the main agent and every subagent. A session whose prefix was already cached
 * (by a run minutes earlier) reads it; one whose setup changed writes it cold, at a
 * higher price: this shows how much of a cost gap is that and not the session's work.
 */
export function startTokens(requests) {
  const first = new Map();
  for (const r of requests) if (!first.has(r.agent)) first.set(r.agent, r.usage ?? {});
  let read = 0;
  let written = 0;
  for (const u of first.values()) {
    read += u.cache_read_input_tokens ?? 0;
    written += u.cache_creation_input_tokens ?? 0;
  }
  return { agents: first.size, read, written };
}

/** `readBatchRanges=true` → {readBatchRanges: true}. Names are connect's camelCase switches. */
export function parseClientToolPolicy(spec) {
  const m = /^([a-z][A-Za-z0-9]*)=(true|false)$/.exec(String(spec ?? ''));
  if (!m) throw new Error(`--client-tool-policy takes name=true|false (got "${spec}")`);
  return { [m[1]]: m[2] === 'true' };
}

/** ` (reason 12, other 3)` for a rewrite's stand-aside reasons, most frequent first; '' when there are none. */
export const whyNot = (reasons) => {
  const list = Object.entries(reasons ?? {}).sort((x, y) => y[1] - x[1]);
  return list.length ? ` (${list.map(([r, n]) => `${r} ${n}`).join(', ')})` : '';
};

/** Session totals. Claude Code's result record is the billed truth (main + subagents). */
export function summarize(session, pricing) {
  const t = { requests: session.requests.length, subagents: session.subagents.length, toolCalls: 0, hookTrimmed: 0, retrieveCalls: 0, retrieveOk: 0, readBatchCalls: 0, readBatchOk: 0, searchContextCalls: 0, searchContextOk: 0 };
  let mainIn = 0;
  let subIn = 0;
  // Direct sessions break ~0 times; a gateway that edits history unevenly shows up here.
  t.cacheBreaks = countCacheBreaks(session.requests);
  t.start = startTokens(session.requests);
  t.outsideCheckout = session.outsideCheckout?.count ?? 0;
  t.parallelToolTurns = parallelToolTurns(session.requests);
  t.resultSubtype = session.result?.subtype ?? null; // e.g. error_max_turns
  t.compactions = session.compactions?.length ?? 0;
  Object.assign(t, subagentLoad(session.requests, session.subagents)); // mainRequests, subagentRequests, requestsPerSubagent
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
      if (b.name === 'mcp__anyray__anyray_read_batch') {
        t.readBatchCalls++; // adoption: the tool's description is paid every turn, recovered only here
        if (b.result && !b.result.isError) t.readBatchOk++;
      }
      if (b.name === 'mcp__anyray__anyray_search_context') {
        t.searchContextCalls++; // Symbol context: identifiers with their complete TS/JS declarations
        if (b.result && !b.result.isError) t.searchContextOk++;
      }
    }
  }
  const mu = Object.values(session.result?.modelUsage ?? {});
  t.input = mu.reduce((a, m) => a + (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0), 0);
  t.cacheRead = mu.reduce((a, m) => a + (m.cacheReadInputTokens ?? 0), 0);
  t.cacheWrite = mu.reduce((a, m) => a + (m.cacheCreationInputTokens ?? 0), 0);
  t.output = mu.reduce((a, m) => a + (m.outputTokens ?? 0), 0);
  t.costUsd = session.result?.costUsd ?? null;
  if (session.timedOutAfterAnswer) {
    // Killed at the timeout after answering, with no result event (lib/agentRun.mjs
    // parseSession): graded on that answer, but with no cost. Claude Code never reported
    // its billed total, a background agent was still running (that is why the result was
    // held back), and stream-json cannot rebuild the bill: subagent requests carry no final
    // usage and not all of them reach the stream.
    t.timedOutAfterAnswer = true;
    t.agentsRunningAtEnd = session.agentsRunningAtEnd ?? 0;
  }
  t.endReason = session.end?.reason ?? null; // exited | answered | timeout | aborted
  t.answeredAtMs = session.answeredAtMs ?? null; // ms from session start to its final answer
  if (session.reportedFindings) t.reportedFindings = session.reportedFindings.length; // graded with the answer text
  t.subagentInputShare = mainIn + subIn ? subIn / (mainIn + subIn) : 0;
  t.turns = session.result?.numTurns ?? null;
  t.wallMs = session.wallMs;
  t.models = Object.keys(session.result?.modelUsage ?? {});
  return t;
}

/** How the round printout names a slot's arm; under gateway, B names its extra headers. */
export const armLabel = (args, arms, slot) => {
  if (args.compare !== 'gateway') return arms[slot];
  const added = args.kindsB ? args.kindsB.filter((k) => !(args.kinds ?? []).includes(k)) : [];
  const dropped = args.kindsB ? (args.kinds ?? []).filter((k) => !args.kindsB.includes(k)) : [];
  const treatment = slot === 'b' ? [
    ...requestRecord(args).extraHeaders,
    ...(args.experimentB ? [`experiment=${args.experimentB}`] : []),
    ...(added.length ? [`kinds+${added.join(',')}`] : []),
    ...(dropped.length ? [`kinds-${dropped.join(',')}`] : []),
    ...(args.readTrimB ? ['read-trim'] : []),
    ...(args.connectBinB ? ['connect-bin-b'] : []),
    ...Object.entries(args.hookPostureB ?? {}).filter((e) => !isReadTrimOn(e)).map(([k, v]) => (v === 'on' ? `hook:${k}` : `hook:${k}=off`)),
    ...Object.entries(args.clientToolPoliciesB ?? {}).map(([k, v]) => `policy:${k}=${v}`),
  ] : [];
  return `anyray${treatment.length ? ` + ${treatment.join(' + ')}` : ' (baseline)'}`;
};

/** The round line's note on how a session ended: answered time, and a timeout if it hit one. */
export const endNote = (t) =>
  (t.answeredAtMs != null ? ` · answered at ${Math.round(t.answeredAtMs / 1000)}s` : '') +
  (t.timedOutAfterAnswer ? ` · TIMED OUT after answering (${t.agentsRunningAtEnd} agent(s) still running; no cost)` : t.endReason === 'timeout' ? ' · TIMED OUT' : '');

/** The ratio line's note on a file both arms wrote outside their checkouts: the first, and how many more. */
export const sharedFileNote = (r) => {
  const shared = r.sharedOutsideWrites ?? [];
  return shared.length ? ` · SHARED FILE with the other arm: ${shared[0]}${shared.length > 1 ? ` (+${shared.length - 1})` : ''}` : '';
};

/** The round line's gateway-ping part: '' for a direct arm, 'n/a' when unreadable. */
export const pingNote = (t) =>
  t.gatewayPingCount === undefined ? ''
    : t.gatewayPingCount === null ? ' · pings n/a'
    : ` · ${t.gatewayPingCount} pings $${t.gatewayPingCostUsd.toFixed(3)} (client $${t.clientCostUsd?.toFixed(3)})`;

/** The citation rule: at least `min` citations resolve, and at least `resolveRate` of them all. */
export const citationsPass = (rule, c) => c.resolved >= rule.min && c.resolved / Math.max(1, c.total) >= (rule.resolveRate ?? 0.9);

export function solved(scenario, session) {
  if (scenario.check) return !!session.check?.passed;
  if (scenario.citations) return citationsPass(scenario.citations, session.citations ?? { total: 0, resolved: 0 });
  const text = answerText(session);
  return (scenario.keyFacts ?? []).every((f) => text.includes(f));
}

/**
 * A citation-graded session that was not solved but wrote a doc file to its checkout that
 * would pass the citation rule (lib/agentRun.mjs writtenDocs): `{ path, resolved, total }`
 * for the passing file with the most resolved citations, else null. Reported only: the
 * session stays unsolved, since the final answer is what is graded.
 */
export function answeredViaFile(scenario, session) {
  if (scenario.check || !scenario.citations || solved(scenario, session)) return null;
  const passing = (session.writtenDocs ?? []).filter((d) => d.citations && citationsPass(scenario.citations, d.citations));
  if (!passing.length) return null;
  const best = passing.reduce((x, y) => (y.citations.resolved > x.citations.resolved ? y : x));
  return { path: best.path, resolved: best.citations.resolved, total: best.citations.total };
}

/**
 * The round line's written-docs part: the doc file the session wrote (the one it answered
 * in, else the one with the most resolved citations), and whether it answered via that
 * file. '' when it wrote none.
 */
export function writtenDocsNote(session) {
  if (session.writtenDocs === null) return session.writtenDocsError ? ' · written docs n/a' : '';
  const docs = session.writtenDocs ?? [];
  if (!docs.length) return '';
  const via = session.answeredViaFile ?? null;
  const ahead = (x, y) => (y.citations?.resolved ?? -1) - (x.citations?.resolved ?? -1) || y.bytes - x.bytes; // > 0: y ranks first
  const shown = (via && docs.find((d) => d.path === via.path)) ?? docs.reduce((x, y) => (ahead(x, y) > 0 ? y : x));
  const what = shown.citations ? `${shown.citations.resolved}/${shown.citations.total} citations` : shown.notGraded ? `${shown.bytes} bytes, not graded` : `${shown.bytes} bytes`;
  const more = docs.length - 1 + (session.writtenDocsOmitted ?? 0);
  return ` · wrote ${shown.path} (${what})${more ? ` +${more} more` : ''}${via ? ' · answered via file (not solved)' : ''}`;
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
export function formatVerdict({ scenario, compare, rounds, controlRounds, treatment = 'b', differingKinds = null, clientToolTreatment = false }) {
  const kept = rounds.filter((x) => !x.gatewayRestarted);
  const v = solvedPairVerdict(kept, { treatment, differingKinds, clientToolTreatment });
  const p = v.stats;
  const under = treatment === 'a' ? ' · treatment A (ratio A/B)' : '';
  const out = [
    `\n${scenario} [${compare}] ${v.offShapePairs ? `on-shape pairs ${v.k}/${v.solved}` : `solved pairs ${v.k}/${v.n}`}: wins ${p.wins}/${v.k}, median ${x2(p.median)}, Q3 ${x2(p.q3)}, max ${x2(p.max)}${under} → ${v.verdict}`,
  ];
  if (v.offShapePairs) {
    out.push(`  on-shape pairs ${v.k}/${v.solved} (${differingNames(differingKinds)} would act in both arms)${v.offShapePairs.length ? `; off-shape, not scored: round(s) ${v.offShapePairs.join(', ')}` : ''}`);
  } else if (v.shapeNote) out.push(`  ${v.shapeNote}`);
  if (v.treatmentEdits != null) {
    const what = clientToolTreatment && !differingKinds ? `treatment ${treatment.toUpperCase()} made connect client-tool calls the control arm did not` : differingKinds ? `${differingNames(differingKinds)} (the kinds A and B differ by) applied` : `treatment ${treatment.toUpperCase()} applied an optimization`;
    out.push(`  ${what} in ${v.treatmentEdits}/${v.k} solved pair(s)${v.idlePairs?.length && v.treatmentEdits ? `; idle in round(s) ${v.idlePairs.join(', ')}` : ''}`);
  }
  if (v.insufficient) out.push(`  verdict insufficient: ${v.reasons[0]}`);
  out.push(...v.reasons.slice(v.insufficient ? 1 : 0).map((x) => `  ${x}`));
  if (v.qualityEvents.length) out.push(`  quality events (one arm solved): ${v.qualityEvents.map((e) => `round ${e.round} ${e.solvedBy.toUpperCase()} only`).join(', ')}`);
  if (v.neither.length) out.push(`  neither arm solved: round(s) ${v.neither.join(', ')}`);
  if (v.noCost.length) out.push(`  no cost (timeout/crash), excluded: ${v.noCost.map((e) => `round ${e.round} (${e.reason})`).join(', ')}`);
  // Subagent load per arm and the Claude Code versions the rounds ran on: the two things
  // an auto-update between rounds moves, which the cost ratio alone never shows.
  const load = subagentLoadSummary(rounds);
  const perArm = (slot) => `${slot.toUpperCase()} ${load[slot].requestsPerSubagent == null ? 'n/a' : load[slot].requestsPerSubagent.toFixed(1)}/agent (${load[slot].subagentRequests} sub-req over ${load[slot].subagents} subagents, ${load[slot].mainRequests} main-req, ${load[slot].rounds} rounds)`;
  if (load.a.rounds || load.b.rounds) {
    out.push(`  subagent load: ${perArm('a')} · ${perArm('b')}`);
    out.push(`  per round (A / B per agent): ${load.perRound.map((p) => `r${p.round} ${x2(p.a)}/${x2(p.b)}`).join(', ')}`);
  }
  const versions = claudeVersions(rounds);
  if (Object.keys(versions.a).length || Object.keys(versions.b).length) {
    out.push(`  Claude Code: A ${versionList(versions.a)} · B ${versionList(versions.b)}` + (versions.mixed ? ' → WARNING: this block mixed Claude Code versions; pin one with --claude-bin' : ''));
  }
  if (controlRounds) {
    const band = noiseBand(solvedPairVerdict(controlRounds.filter((x) => !x.gatewayRestarted)));
    if (!band) out.push('  noise band (control): n/a, no solved pairs');
    else {
      out.push(`  noise band (control, ${band.k} solved pairs): median ${x2(band.median)}, range ${x2(band.min)}–${x2(band.max)}`);
      const pos = bandPosition(p.median, band);
      out.push(`  median ${x2(p.median)} ${pos ? BAND_SAYS[pos] : 'n/a: no solved pairs to compare'}`);
    }
  }
  const s = rule0(scoredRounds(rounds), { treatment });
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

/** The policy assignment covers the whole comparison and is restored on every exit. */
export async function withIntegrationLevel(requested, work, { level, signal = process } = {}) {
  if (!requested) return work();
  let interruptedRun = false;
  const setting = level.set(requested);
  let cleaned;
  const cleanup = () => (cleaned ??= setting.then((change) => level.clear(change), () => undefined));
  const interrupted = () => {
    interruptedRun = true;
    cleanup().then(() => { signal.exit?.(130); }, (error) => {
      console.error(`integration-level cleanup failed: ${redactLevelError(error)}`);
      signal.exit?.(130);
    });
  };
  signal.once?.('SIGINT', interrupted);
  try {
    await setting;
    if (interruptedRun) throw new Error('integration-level run interrupted');
    return await work();
  } finally {
    signal.off?.('SIGINT', interrupted);
    await cleanup();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const level = args.integrationLevel ? createBenchLevel({ gatewayUrl: cfg.run.gatewayUrl, adminKey: process.env.ANYRAY_ADMIN_KEY, clientKey: resolveBenchKey(process.env, () => {}).key, agent: process.env.ANYRAY_BENCH_AGENT_ID, user: process.env.ANYRAY_BENCH_USER_ID }) : null;
  const { main, control } = await withIntegrationLevel(args.integrationLevel, () => runAll(args, cfg), { level });
  if (main.status === 'rejected') throw main.reason;
  if (control?.status === 'rejected') console.log(`control run failed: ${control.reason?.message ?? control.reason}`);
  const { record, file, viaGateway } = main.value;
  const controlRecord = control?.status === 'fulfilled' ? control.value.record : null;
  if (controlRecord) console.log(`${formatVerdict({ scenario: args.scenario, compare: 'control', rounds: controlRecord.rounds })}\n${formatVerdictBlock(controlRecord.verdict)}`.replace(/\n(?!$)/g, '\n[control] '));
  if (controlRecord) {
    record.control = { file: resultFileName(controlArgs(args)) };
    record.noiseBand = noiseBand(solvedPairVerdict(controlRecord.rounds.filter((x) => !x.gatewayRestarted)));
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  }
  console.log(`${formatVerdict({ scenario: args.scenario, compare: args.compare, rounds: record.rounds, controlRounds: controlRecord?.rounds, ...verdictOptions(args) })}\n${formatVerdictBlock(record.verdict)}`);
  for (const slot of viaGateway) {
    const feedback = record.rounds.flatMap((x) => x.sessions?.[slot]?.optimization?.results ?? []);
    const kinds = slotKinds(args, slot)[0];
    if (kinds && feedback.length) console.log(`  all rounds${viaGateway.length > 1 ? `, ${slot.toUpperCase()}` : ''}, ${formatKindTally(tallyKinds(feedback, kinds))}`);
  }
}

/**
 * --provider bedrock: the direct arm's AWS profile and region, and the Bedrock model id
 * both arms end up on. Unless ANYRAY_BEDROCK_MODEL pins it, the id is read back from one
 * 1-token request through the gateway's org lane, which must be served by Bedrock.
 */
export async function resolveBedrock(run, { env = process.env, probe = probeGatewayRoute } = {}) {
  const opts = bedrockOptions(env);
  // The direct arm's small/fast model (lib/bedrock.mjs): what the gateway arm's Claude Code picks itself.
  const withSmall = (b) => ({ ...b, ...bedrockSmallModel(b.model, opts.smallModel) });
  if (!run.gatewayUrl) {
    if (!opts.model) throw new Error('--provider bedrock without a gateway needs ANYRAY_BEDROCK_MODEL (the Bedrock model id)');
    return withSmall({ ...opts, modelSource: 'ANYRAY_BEDROCK_MODEL' });
  }
  const route = await probe({ gatewayUrl: run.gatewayUrl, clientKey: resolveBenchKey(env, () => {}).key, model: run.model });
  const served = assertBedrockRoute(route, { pinned: opts.model });
  return withSmall({ ...opts, model: opts.model ?? served, modelSource: opts.model ? 'ANYRAY_BEDROCK_MODEL' : 'gateway route probe', gatewayServedAs: served ?? route.model });
}

/** What runComparison reaches outside the process through; tests stub them. */
const LIVE = { runAgent, prepareRepo, describeRepo, write: writeFileSync, log: console.log, resolveBedrock, readOptimizerConfig: optimizerConfig, resolveClaudeBin, claudeVersion };

/** Each SDK scenario's agent and the transport each arm records; framework-docs runs a graph agent on the framework's chat model. */
const SDK_AGENTS = {
  'sdk-docs': { run: runSdkAgent, transport: { a: 'bedrock-invoke-model', b: 'anyray-messages' } },
  'framework-docs': { run: runFrameworkAgent, transport: { a: 'framework-anthropic-bedrock', b: 'framework-anthropic-gateway' }, framework: 'graph-agent' },
};

/** Paired pay-per-token SDK scenario; its record shape is accepted by bench-verdict. */
export async function runSdkComparison(args, cfg, { prefix = '', schedule = createPool(args.parallel ?? 1).lane(), deps = {} } = {}) {
  const name = args.scenario;
  const agent = SDK_AGENTS[name];
  const runSdk = deps.runSdkAgent ?? agent.run;
  const checkout = deps.prepareRepo ?? prepareRepo;
  const describe = deps.describeRepo ?? describeRepo;
  const write = deps.write ?? writeFileSync;
  const log = (s) => (deps.log ?? console.log)(prefix + s);
  const { run, pricing } = cfg;
  if (!run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const clientKey = deps.clientKey ?? resolveBenchKey().key;
  if (!clientKey) throw new Error(`${name} needs ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY`);
  const dir = join(cfg.root, 'scenarios', name);
  const scenarioFile = readScenarioFile(dir);
  const scenario = effectiveScenario(scenarioFile, args);
  if (name === 'sdk-docs') {
    if (scenario.maxTurns < 8 || scenario.maxTurns > 30) throw new Error('sdk-docs maxTurns must be 8–30');
    if (scenario.minTurns < 8 || scenario.minTurns > scenario.maxTurns) throw new Error('sdk-docs minTurns must be at least 8 and no more than maxTurns');
  } else if (scenario.maxTurns < 2 || scenario.maxTurns > 80) throw new Error(`${name} maxTurns must be 2–80: one turn to research, the last to answer`);
  const out = join(cfg.root, 'results', 'agent');
  const workParent = join(out, 'sdk-work');
  const cacheDir = join(out, 'sdk-repo-cache');
  mkdirSync(workParent, { recursive: true });
  const repoOptions = { workParent, cacheDir };
  const file = join(out, resultFileName(args));
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  const save = recordSaver(file, record, write);
  const probe = checkout(scenario, dir, repoOptions);
  try { record.scenario = { name, ...scenarioFile, repoInfo: describe(probe, scenario) }; }
  finally { rmSync(probe, { recursive: true, force: true }); }
  const bedrock = args.bedrock ?? await (deps.resolveBedrock ?? resolveBedrock)(run);
  args.bedrock = bedrock;
  Object.assign(record, { compare: 'anyray', label: args.label, gateway: run.gatewayUrl, provider: 'bedrock', bedrock, arms: { a: 'direct', b: 'anyray' }, kinds: args.kinds, request: { interTurnDelaySec: scenario.interTurnDelaySec ?? 0, minTurns: scenario.minTurns, maxTurns: scenario.maxTurns, noCacheMarkers: true, ...(agent.framework ? { framework: agent.framework } : {}), ...(args.retryInvalid ? { retryInvalid: args.retryInvalid } : {}) }, setup: { a: { transport: agent.transport.a, model: bedrock.model, maxTurns: scenario.maxTurns }, b: { transport: agent.transport.b, model: run.model, maxTurns: scenario.maxTurns } } });
  const first = Math.max(record.rounds.length, ...record.rounds.map((x) => x.round ?? 0)) + 1;
  log(`${name} [anyray] rounds ${first}–${first + args.rounds - 1}, parallel ${args.parallel ?? 1}`);
  const runRound = async (round) => {
    const tags = roundTags(args, round);
    const startedAt = new Date().toISOString();
    const runArm = async (slot) => {
      const work = checkout(scenario, dir, repoOptions);
      try {
        return await runSdk({ arm: slot === 'a' ? 'direct' : 'anyray', scenario, work, model: run.model, gatewayUrl: run.gatewayUrl, clientKey, bedrock, pricing, kinds: args.kinds, sessionId: tags[slot].sessionId, scratchDir: workParent });
      } finally { rmSync(work, { recursive: true, force: true }); }
    };
    const [sa, sb] = await Promise.allSettled([runArm('a'), runArm('b')]);
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      // Name each arm that failed, so a round lost to one lane's transport says which lane.
      const error = [['direct', sa], ['anyray', sb]].filter(([, s]) => s.status === 'rejected').map(([arm, s]) => `${arm}: ${s.reason?.message ?? 'SDK arm failed'}`).join('; ');
      const r = { round, error };
      insertRound(record.rounds, r);
      log(`  round ${round} failed: ${error}`);
      await save();
      return r;
    }
    const sessions = { a: sa.value, b: sb.value };
    const r = { round, runTag: tags.b, startedAt, endedAt: new Date().toISOString(), sessions, ...roundRatio(sessions.a, sessions.b), quality: { a: solved(scenario, sessions.a), b: solved(scenario, sessions.b) } };
    insertRound(record.rounds, r);
    const line = (slot) => {
      const t = sessions[slot].totals;
      const share = t.input ? (100 * t.cacheRead / t.input).toFixed(1) : '0.0';
      return `  round ${round} ${slot.toUpperCase()} ${slot === 'a' ? 'direct' : 'anyray'}: $${t.costUsd?.toFixed(3)} · ${t.turns} turns · ${t.subagents ?? 0} subagents · ${t.parallelToolTurns ?? 0} parallel-tool turns · ${t.cacheBreaks ?? 0} cache breaks · start ${t.start?.read ?? 0} read / ${t.start?.written ?? 0} written · ${share}% cache-read share · ${r.quality[slot] ? 'solved' : 'NOT solved'}`;
    };
    log(`${line('a')}\n${line('b')}\n  round ${round} ratio B/A ${r.ratio?.toFixed(3)}`);
    record.stats = rule0(scoredRounds(record.rounds));
    record.rule0Verdict = solvedPairVerdict(record.rounds);
    record.verdict = benchVerdict(record.rounds);
    await save();
    return r;
  };
  // --retry-invalid N, as in runComparison: a round the verdict would drop (an arm that
  // failed, ran out of answer tokens or answered nothing is 'not solved') runs again
  // under the next free number, at most N extra rounds in all.
  let nextRound = first + args.rounds;
  let retriesLeft = args.retryInvalid ?? 0;
  const attempt = async (round) => {
    const r = await schedule(() => runRound(round));
    const why = exclusionReasons(r);
    if (!why.length || retriesLeft <= 0) return r;
    retriesLeft--;
    const again = nextRound++;
    (record.retries ??= []).push({ round, reasons: why, retriedAs: again });
    log(`  round ${round} is not usable (${why.join(', ')}); running round ${again} in its place (retry ${args.retryInvalid - retriesLeft}/${args.retryInvalid})`);
    return attempt(again);
  };
  const settled = await Promise.allSettled(Array.from({ length: args.rounds }, (_, i) => attempt(first + i)));
  const failed = settled.find((x) => x.status === 'rejected');
  if (failed) { await save(); throw failed.reason; }
  record.stats = rule0(scoredRounds(record.rounds));
  record.rule0Verdict = solvedPairVerdict(record.rounds);
  record.verdict = benchVerdict(record.rounds);
  await save();
  return { record, file, viaGateway: [] };
}

/** What runCodexComparison reaches outside the process through; tests stub them. */
const CODEX_LIVE = {
  runCodexAgent, configureCodexArmHome, prepareRepo, describeRepo, write: writeFileSync, log: console.log,
  sessionTraces, gatewayReplicaStarts, readOptimizerConfig: optimizerConfig, connectPolicy,
  deleteThread: deleteCodexThread(), armHomeParent: () => sessionDirParent(),
  realHookKeys: () => realCodexHookKeys(), wrappedCommandEnv: () => wrappedCommandEnv(), binDigest,
  seedNoAppProfile: (home) => seedArmHome(home, armSeeds([], true)), checkArmBinary: checkConnectBinary,
  connectBinPinned: CONNECT_BIN_PINNED,
};

/** --connect-bin-b: B's build, recorded by its digest; the build A already runs is no treatment. */
function digestConnectBinB(args, digest = binDigest) {
  if (!existsSync(args.connectBinB)) throw new Error(`--connect-bin-b: no anyray-connect at ${args.connectBinB}`);
  args.connectBinBDigest = digest(args.connectBinB);
  if (args.connectBinBDigest.sha256 === digest(ANYRAY_BIN).sha256) throw new Error('--connect-bin-b is the same build arm A runs (ANYRAY_CONNECT_BIN): A and B would be the same arm');
}

/** A hook tally in tallyKinds' shape: the treatment acted when B's own connect wrapped a command. */
const hookTally = (wrapped) => ({ requests: 0, unconfirmed: 0, byKind: {}, otherApplied: { codex_hooks_b: wrapped > 0 ? 1 : 0 }, preserved: {} });

/**
 * Paired Codex CLI sessions (--client codex). The same pairing, verdict and result file
 * as Claude Code; each arm is `codex exec` on the ChatGPT seat (lib/codexAgent.mjs):
 *   anyray   A = Codex direct (its built-in provider), B = the seat route through the gateway
 *   control  both direct: the noise floor
 *   gateway  both through the gateway, B with the treatment (--experiment-b with a
 *            `bench-rule params` rule, ANYRAY_BENCH_EXTRA_HEADERS, --kinds-b, --codex-config-b,
 *            --codex-hooks-b or --connect-bin-b)
 * Cost is Codex's own per-response usage priced from config.yaml; what the gateway did
 * comes from its traces, read by each gateway arm's session id.
 */
export async function runCodexComparison(args, cfg, { prefix = '', schedule = createPool(args.parallel ?? 1).lane(), deps = {} } = {}) {
  const d = { ...CODEX_LIVE, ...deps };
  const log = (msg) => d.log(prefix ? msg.split('\n').map((l) => (l ? prefix + l : l)).join('\n') : msg);
  const arms = armsFor(args.compare);
  const viaGateway = gatewaySlots(arms);
  const { run, pricing } = cfg;
  if (viaGateway.length && !run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const clientKey = viaGateway.length ? (deps.clientKey ?? resolveBenchKey().key) : null;
  if (viaGateway.length && !clientKey) throw new Error('the gateway arm needs ANYRAY_BENCH_CLIENT_KEY (or ANYRAY_CLIENT_KEY): a key on the bench gateway');
  args.extraHeaders = viaGateway.length ? benchExtraHeaders() : [];
  args.sharedHeaders = viaGateway.length ? benchSharedHeaders() : [];
  if (args.compare === 'gateway' && !args.extraHeaders.length && !args.experimentB && !args.kindsB && !args.codexConfigB && !args.codexHooksB && !args.connectBinB) {
    console.warn('--compare gateway without a treatment (--experiment-b, --kinds-b, --codex-config-b, --codex-hooks-b, --connect-bin-b or ANYRAY_BENCH_EXTRA_HEADERS): A and B are the same arm (a gateway noise floor)');
  }
  if (args.connectBinB) digestConnectBinB(args, d.binDigest);
  // --codex-hooks-b: read once per run. What the real ~/.codex/hooks.json holds (each handler
  // is switched off on B), and where the wrapped command's toolchains keep their caches.
  const userHookKeys = args.codexHooksB ? d.realHookKeys() : [];
  const hookEnv = args.codexHooksB ? d.wrappedCommandEnv() : {};
  const dir = join(cfg.root, 'scenarios', args.scenario);
  const scenarioFile = readScenarioFile(dir);
  const scenario = effectiveScenario(scenarioFile, args);
  const out = join(cfg.root, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const file = join(out, resultFileName(args));
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  const save = recordSaver(file, record, d.write);
  const probe = d.prepareRepo(scenario, dir);
  try { record.scenario = { name: args.scenario, ...scenarioFile, repoInfo: d.describeRepo(probe, scenario) }; }
  finally { rmSync(probe, { recursive: true, force: true }); }
  const tenant = viaGateway.length ? benchTenantSetup(resolveBenchKey(process.env, () => {})) : null;
  const configOf = (slot) => (slot === 'b' ? args.codexConfigB ?? [] : []);
  const binOf = (slot) => (slot === 'b' && args.connectBinB ? args.connectBinB : ANYRAY_BIN);
  // A named build (ANYRAY_CONNECT_BIN, --connect-bin-b) is the one each arm must run.
  const pinsBuild = Boolean(args.connectBinB || d.connectBinPinned);
  const armSetup = (slot) => ({
    client: 'codex', arm: arms[slot], model: args.codexModel ?? null, effort: args.codexEffort ?? null, kinds: arms[slot] === 'anyray' ? slotKinds(args, slot)[0] : null, timeoutMin: scenario.timeoutMin ?? 6,
    ...(configOf(slot).length ? { codexConfig: Object.fromEntries(configOf(slot)) } : {}),
    // Which anyray-connect build configured the arm (sha256 prefix, never the path).
    ...(args.connectBinB && arms[slot] === 'anyray' ? { connectBin: slot === 'b' ? args.connectBinBDigest : d.binDigest(ANYRAY_BIN) } : {}),
    ...(slot === 'b' && args.codexHooksB ? { codexHooks: {
      hook: "connect's Codex PreToolUse hook (matcher Bash) from this arm's home, run through the bench shim; declared as session config and trusted by its own hooks.state entry (no --dangerously-bypass-hook-trust)",
      userHooksSwitchedOff: userHookKeys.length,
      wrappedCommandEnv: Object.keys(shellRunEnvFor('', hookEnv)), // names only
    } } : {}),
  });
  Object.assign(record, {
    client: 'codex', compare: args.compare, label: args.label, gateway: run.gatewayUrl, provider: 'chatgpt-seat', arms, kinds: args.kinds, tenant,
    request: { ...requestRecord(args), client: 'codex', codexModel: args.codexModel ?? null, codexEffort: args.codexEffort ?? null },
    setup: { a: armSetup('a'), b: armSetup('b') },
  });
  if (viaGateway.length) record.anyray = { connectPolicy: await d.connectPolicy(run.gatewayUrl), optimizerConfig: await d.readOptimizerConfig(run.gatewayUrl) };
  if (args.experimentB) {
    const rules = experimentRules(record.anyray?.optimizerConfig, args.experimentB);
    if (rules === null) log(`WARNING: cannot read the gateway's optimizer config, so cannot confirm a rule matches experiment=${args.experimentB}`);
    else if (!rules.length) log(`WARNING: no gateway rule matches experiment=${args.experimentB}: A and B are the same arm. Add one with \`bench-rule params ${args.experimentB} --params …\``);
    else log(`arm B (experiment=${args.experimentB}) matches: ${rules.map((r) => `${r.label}${r.params ? ` params ${JSON.stringify(r.params)}` : ''}`).join('; ')}`);
  }
  const first = Math.max(record.rounds.length, ...record.rounds.map((x) => x.round ?? 0)) + 1;
  log(`${args.scenario} [${args.compare}] codex rounds ${first}–${first + args.rounds - 1}, parallel ${args.parallel ?? 1} · model ${args.codexModel ?? "Codex's default"}`);

  const runRound = async (round) => {
    const tags = roundTags(args, round);
    const replicasBefore = viaGateway.length ? await d.gatewayReplicaStarts(run.gatewayUrl) : null;
    const ruleBefore = args.experimentB ? experimentRules(await d.readOptimizerConfig(run.gatewayUrl), args.experimentB) : undefined;
    const startedAt = new Date().toISOString();
    const runArm = async (slot) => {
      const work = d.prepareRepo(scenario, dir);
      const home = arms[slot] === 'anyray' ? makeArmHome(d.armHomeParent()) : null;
      try {
        const bin = binOf(slot);
        // A pinned build configures from a no-app profile on both arms, so an installed Connect
        // app cannot take the configure over and run its own build (agentRun armSeeds).
        if (home && pinsBuild) d.seedNoAppProfile(home);
        const armHome = home ? d.configureCodexArmHome({ home, gatewayUrl: run.gatewayUrl, clientKey, bin }) : null;
        if (armHome && !armHome.configured) throw new Error(`anyray-connect did not set up the Codex seat route: ${armHome.reasons.join('; ')}`);
        if (armHome && pinsBuild) {
          const hooks = armHome.codexHook ? { PreToolUse: [{ hooks: [{ command: armHome.codexHook.command }] }] } : {};
          const bad = d.checkArmBinary({ settings: { hooks }, mcpServers: { anyray: { command: armHome.mcpCommand } }, bin, home, required: true }).filter((x) => !x.ok);
          if (bad.length) throw new Error(`arm ${slot.toUpperCase()} does not run the requested anyray-connect build: ${bad.map((x) => `${x.name}: ${x.detail}`).join('; ')}`);
        }
        const hook = slot === 'b' && args.codexHooksB ? codexHookSpec({ armHome, wrappedEnv: hookEnv, disableKeys: userHookKeys }) : null;
        const session = await d.runCodexAgent({
          arm: arms[slot], scenario, work, model: args.codexModel, effort: args.codexEffort, gatewayUrl: run.gatewayUrl, clientKey,
          runTag: tags[slot], sharedHeaders: args.sharedHeaders,
          extraHeaders: carriesExtraHeaders(arms, slot) ? args.extraHeaders : [], armHome, pricing, configOverrides: configOf(slot),
          ...(hook ? { hook } : {}),
          keepThreads: !!args.keepCodexThreads, deleteThread: d.deleteThread,
          check: scenario.check ? (w) => runCheck(scenario.check, w) : null,
          citations: scenario.citations ? (text, w) => checkCitations(text, w) : null,
        });
        // The build the hook ran (its launcher resolved), read before the home goes.
        if (hook) session.setup = { ...session.setup, codexHook: { ...session.setup?.codexHook, connectBin: d.binDigest(hook.connectExe) } };
        return session;
      } finally {
        rmSync(work, { recursive: true, force: true });
        if (home) removeArmHome(home);
      }
    };
    const [sa, sb] = await Promise.allSettled([runArm('a'), runArm('b')]);
    const endedAt = new Date().toISOString();
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      const error = [['A', sa], ['B', sb]].filter(([, s]) => s.status === 'rejected').map(([n, s]) => `${n}: ${s.reason?.message ?? 'codex arm failed'}`).join('; ');
      log(`  round ${round} failed: ${error}`);
      const failed = { round, error };
      insertRound(record.rounds, failed);
      await save();
      return failed;
    }
    const sessions = { a: sa.value, b: sb.value };
    // What the gateway did, per gateway arm, from its own trace rows (Codex never sees its response headers).
    const tallies = {};
    for (const slot of viaGateway) {
      const t = await d.sessionTraces(run.gatewayUrl, tags[slot].sessionId);
      sessions[slot].traces = t.traces ?? null;
      if (t.unavailable) {
        sessions[slot].tracesUnavailable = t.unavailable;
        log(`  round ${round} ${slot.toUpperCase()} warning: gateway traces unavailable (${t.unavailable})`);
      }
      const kinds = slotKinds(args, slot)[0];
      if (kinds && t.traces) tallies[slot] = tallyKinds(traceResults(t.traces), kinds);
    }
    // A client-config treatment edits nothing on the gateway: what B did is compact more
    // often than A. Scored as B's tally so a run where it never fired reads INSUFFICIENT.
    const compactions = { a: sessions.a.totals?.compactions ?? 0, b: sessions.b.totals?.compactions ?? 0 };
    if (args.codexConfigB) {
      tallies.b ??= { requests: 0, unconfirmed: 0, byKind: {}, otherApplied: {}, preserved: {} };
      tallies.b.otherApplied = { ...tallies.b.otherApplied, codex_config_b: compactions.b > compactions.a ? 1 : 0 };
    }
    // --codex-hooks-b, a client-side treatment: the gateway edits both arms alike (same kinds),
    // so B acted only if its own connect wrapped a command; the trace tallies are kept apart.
    // A wrap on A, or one on B by any connect but the one B's hook names, is a hook that should not have run.
    let gatewayOptimization = null;
    let hookLeak = null;
    if (args.codexHooksB) {
      const t = { a: sessions.a.totals ?? {}, b: sessions.b.totals ?? {} };
      gatewayOptimization = { a: tallies.a ?? null, b: tallies.b ?? null };
      tallies.a = hookTally(t.a.hookWraps ?? 0);
      tallies.b = hookTally((t.b.hookWraps ?? 0) - (t.b.hookWrapsOther ?? 0));
      if (t.a.hookWraps || t.b.hookWrapsOther) {
        hookLeak = { a: t.a.hookWraps ?? 0, bOther: t.b.hookWrapsOther ?? 0 };
        log(`  round ${round} WARNING: a hook wrapped commands where none should run (A ${hookLeak.a}, B by another connect ${hookLeak.bOther}); it is left out of the Rule 0 stats`);
      }
    }
    const r = {
      round, runTag: tags.b, ...(args.compare === 'gateway' ? { runTags: tags } : {}), startedAt, endedAt, sessions,
      ...roundRatio(sessions.a, sessions.b),
      quality: { a: solved(scenario, sessions.a), b: solved(scenario, sessions.b) },
      compactions,
      ...(tallies.b ? { optimization: tallies.b } : {}),
      ...(tallies.a && args.compare === 'gateway' ? { optimizationA: tallies.a } : {}),
      ...(gatewayOptimization ? { gatewayOptimization } : {}),
      ...(hookLeak ? { hookLeak } : {}),
    };
    if (viaGateway.length) {
      const after = await d.gatewayReplicaStarts(run.gatewayUrl);
      const restarted = restartedDuring(replicasBefore, after);
      if (restarted) {
        r.gatewayRestarted = true;
        log(`  round ${round} WARNING: a gateway replica (re)started during the round; it is left out of the Rule 0 stats`);
      }
    }
    if (args.experimentB) {
      const ruleAfter = experimentRules(await d.readOptimizerConfig(run.gatewayUrl), args.experimentB);
      r.experimentRule = { before: ruleBefore, after: ruleAfter, stable: !!ruleBefore?.length && sameRules(ruleBefore, ruleAfter) };
      if (!r.experimentRule.stable) log(`  round ${round} WARNING: the experiment=${args.experimentB} rule was missing or changed during the round: drop it`);
    }
    insertRound(record.rounds, r);
    const line = (slot) => {
      const t = sessions[slot].totals;
      const share = t.input ? (100 * t.cacheRead / t.input).toFixed(1) : '0.0';
      const tally = r.gatewayOptimization ? r.gatewayOptimization[slot] : slot === 'b' ? r.optimization : r.optimizationA;
      const hook = args.codexHooksB ? ` · hook ${t.hookWraps ?? 0} wrapped${t.hookWrapsOther ? ` (${t.hookWrapsOther} by another connect)` : ''}, ${t.hookDigests ?? 0} digest footer(s)` : '';
      return `  round ${round} ${slot.toUpperCase()} ${arms[slot]}: $${t.costUsd?.toFixed(3) ?? 'n/a'} · ${t.turns} requests (+${t.subagentRequests} in ${t.subagents} subagents) · ${t.uncachedInput} uncached / ${t.cacheRead} read / ${t.cacheWrite} written · ${share}% cache-read share · ${t.retrievalCalls} retrieval calls · median ${t.latencyMs?.median ?? 'n/a'} ms/request · ${t.compactions ?? 0} compaction(s), peak ${t.peakInput ?? 'n/a'} input${hook} · ${r.quality[slot] ? 'solved' : 'NOT solved'}${sessions[slot].error ? ` (${sessions[slot].error})` : ''}` +
        (tally ? `\n  round ${round} ${slot.toUpperCase()} ${formatKindTally(tally)}` : '');
    };
    log(`${line('a')}\n${line('b')}\n  round ${round} ratio B/A ${r.ratio?.toFixed(3) ?? `n/a (${r.error})`}`);
    record.stats = rule0(scoredRounds(record.rounds), { treatment: args.treatment });
    record.rule0Verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted && !x.hookLeak), verdictOptions(args));
    record.verdict = benchVerdict(record.rounds);
    await save();
    return r;
  };
  let nextRound = first + args.rounds;
  let retriesLeft = args.retryInvalid ?? 0;
  const attempt = async (round) => {
    const r = await schedule(() => runRound(round));
    const why = exclusionReasons(r);
    if (!why.length || retriesLeft <= 0) return r;
    retriesLeft--;
    const again = nextRound++;
    (record.retries ??= []).push({ round, reasons: why, retriedAs: again });
    log(`  round ${round} is not usable (${why.join(', ')}); running round ${again} in its place (retry ${args.retryInvalid - retriesLeft}/${args.retryInvalid})`);
    return attempt(again);
  };
  const settled = await Promise.allSettled(Array.from({ length: args.rounds }, (_, i) => attempt(first + i)));
  const failed = settled.find((x) => x.status === 'rejected');
  if (failed) { await save(); throw failed.reason; }
  record.stats = rule0(scoredRounds(record.rounds), { treatment: args.treatment });
  record.rule0Verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted && !x.hookLeak), verdictOptions(args));
  record.verdict = benchVerdict(record.rounds);
  await save();
  return { record, file, viaGateway: [] };
}

/**
 * One comparison's rounds, into its own result file. Returns the record. Up to
 * --parallel rounds run at once through `schedule` (a pool lane; runAll shares one
 * pool with the control); each is saved as it finishes, in round order.
 */
export async function runComparison(args, cfg, { prefix = '', schedule = createPool(args.parallel ?? 1).lane(), deps } = {}) {
  if (SDK_SCENARIOS.includes(args.scenario)) return runSdkComparison(args, cfg, { prefix, schedule, deps });
  if (args.client === 'codex') return runCodexComparison(args, cfg, { prefix, schedule, deps });
  const { runAgent, prepareRepo, describeRepo, write, log: print, resolveBedrock, readOptimizerConfig, resolveClaudeBin, claudeVersion } = { ...LIVE, ...deps };
  const log = (msg) => print(prefix ? msg.split('\n').map((l) => (l ? prefix + l : l)).join('\n') : msg);
  const arms = armsFor(args.compare);
  // The Claude Code binary both arms spawn (--claude-bin / ANYRAY_CLAUDE_BIN, else PATH),
  // checked now so a bad path fails before any session, and read once for the header.
  if (!args.claude) {
    const claude = resolveClaudeBin(args.claudeBin ?? claudeBinRequest({ env: process.env }));
    args.claude = { ...claude, version: claudeVersion(claude.bin) };
  }
  const viaGateway = gatewaySlots(arms); // slots whose spend, traces and feedback the gateway holds
  args.extraHeaders = viaGateway.length ? benchExtraHeaders() : [];
  args.sharedHeaders = viaGateway.length ? benchSharedHeaders() : [];
  if (args.connectBinB) digestConnectBinB(args);
  if (args.compare === 'gateway' && !args.extraHeaders.length && !args.experimentB && !args.kindsB && !args.connectBinB && !Object.keys(args.hookPostureB ?? {}).length && !args.clientToolPoliciesB) {
    console.warn('--compare gateway without ANYRAY_BENCH_EXTRA_HEADERS: A and B are the same arm (a gateway noise floor)');
  }
  const { run, pricing } = cfg;
  if (viaGateway.length && !run.gatewayUrl) throw new Error('set ANYRAY_GATEWAY_URL');
  const dir = join(cfg.root, 'scenarios', args.scenario);
  const scenarioFile = readScenarioFile(dir);
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
  // A cap below connect's floor measures connect without the mode a production session has.
  record.connectWorkMode = connectWorkMode(args.scenario, scenario);
  if (record.connectWorkMode === 'off_turn_cap') {
    console.warn(`turn cap ${scenario.maxTurns ?? 40} is below ${CONNECT_WORK_MODE_MIN_TURNS}: anyray-connect's read hint and Explore decline are off for this run (production sessions have no cap)`);
  }
  record.gateway = run.gatewayUrl;
  record.readTrim = args.readTrim;
  record.kinds = args.kinds; // what the Anyray arm requested (x-anyray-optimization-kinds)
  record.arms = arms;
  record.provider = args.provider ?? 'anthropic';
  if (args.provider === 'bedrock') {
    args.bedrock ??= await resolveBedrock(run);
    record.bedrock = args.bedrock;
    log(`provider bedrock: direct arm on AWS profile "${args.bedrock.profile}" (${args.bedrock.region}) as ${args.bedrock.model}, small/fast model ${args.bedrock.smallModel ?? "Claude Code's own"}` + (args.bedrock.gatewayServedAs ? `; the gateway serves ${run.model} as ${args.bedrock.gatewayServedAs}` : ''));
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
  // --experiment-b is only a treatment if a gateway rule is keyed on the tag: say so before
  // the sessions start, not after.
  if (args.experimentB) {
    const rules = experimentRules(record.anyray?.optimizerConfig, args.experimentB);
    if (rules === null) log(`WARNING: cannot read the gateway's optimizer config, so cannot confirm a rule matches experiment=${args.experimentB}`);
    else if (!rules.length) log(`WARNING: no gateway rule matches experiment=${args.experimentB}: A and B are the same arm. Add one with \`bench-rule params ${args.experimentB} --params …\``);
    else log(`arm B (experiment=${args.experimentB}) matches: ${rules.map((r) => `${r.label}${r.params ? ` params ${JSON.stringify(r.params)}` : ''}`).join('; ')}`);
  }

  // Round numbers are fixed up front (after any rounds already in the file), so they
  // and each round's session id stay unique however the rounds overlap.
  const first = Math.max(record.rounds.length, ...record.rounds.map((x) => x.round ?? 0)) + 1;
  const numbers = Array.from({ length: args.rounds }, (_, k) => first + k);
  // The header names the Claude Code build both arms spawn, beside the provider line above.
  log(`${args.scenario} [${args.compare}] rounds ${first}–${first + args.rounds - 1}, parallel ${args.parallel ?? 1} (up to ${args.parallel ?? 1} round(s) at once, each A ‖ B) · ${describeClaudeBin(args.claude)}`);

  const runRound = async (round) => {
    log(`${args.scenario} [${args.compare}] round ${round}: ${armLabel(args, arms, 'a')} ‖ ${armLabel(args, arms, 'b')} (concurrent)…`);
    // One attempt at the pair. --redraw-holdout starts it again (fresh sessions, so fresh
    // draws) when the gateway held a kind out of either session.
    const startPair = async (redraw) => {
      const runTags = roundTags(args, round); // a new session id per attempt
      const run1 = (slot) => runAgent({
        ...slotOptions(args, arms, slot), scenario, scenarioDir: dir, model: run.model, gatewayUrl: run.gatewayUrl, runTag: runTags[slot],
        redraw: redraw && arms[slot] === 'anyray' ? { signal: redraw.signal, report: redraw.report(slot) } : redraw && { signal: redraw.signal, report: () => {} },
      });
      // Replica start times around the round: a gateway restart under it spoils the pair.
      const replicasBefore = viaGateway.length ? await gatewayReplicaStarts(run.gatewayUrl) : null;
      const ruleBefore = args.experimentB ? experimentRules(await readOptimizerConfig(run.gatewayUrl), args.experimentB) : undefined;
      const startedAt = new Date().toISOString();
      const settled = await Promise.allSettled([run1('a'), run1('b')]);
      return { settled, runTags, replicasBefore, ruleBefore, startedAt };
    };
    const { settled: [sa, sb], runTags, replicasBefore, ruleBefore, startedAt, redraws } = await runPairWithRedraw(
      startPair,
      viaGateway.length ? args.redrawHoldout ?? 0 : 0,
      (drawn, n) => log(`  round ${round}: the gateway's session gate held out ${Object.entries(drawn).map(([slot, k]) => `${k.join(', ')} on ${slot.toUpperCase()}`).join('; ')}; starting the pair again (redraw ${n}/${args.redrawHoldout})`)
    );
    const endedAt = new Date().toISOString();
    if (sa.status === 'rejected' || sb.status === 'rejected') {
      const err = (sa.reason ?? sb.reason)?.message;
      log(`  round ${round} failed: ${err}`);
      const failed = { round, error: err };
      insertRound(record.rounds, failed);
      await save();
      return failed;
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
    // A file both arms wrote outside their checkouts (the same /tmp log name, say): running at
    // once, either can overwrite or read the other's, so the pair is not like for like.
    const shared = sharedOutsideWrites(sessions.a, sessions.b);
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
      ...(shared.length ? { sharedOutsideWrites: shared } : {}),
    };
    // A doc the session wrote to a file instead of its answer: reported, never solved.
    for (const slot of ['a', 'b']) {
      const via = answeredViaFile(scenario, sessions[slot]);
      if (via) sessions[slot].answeredViaFile = via;
    }
    // A model family the arms ran on different models (say Haiku for Claude Code's side
    // calls) is a client difference that would read as a gateway one.
    const modelsDiffer = modelMismatch(sessions.a.totals.models, sessions.b.totals.models);
    if (Object.keys(modelsDiffer).length) {
      r.modelsDiffer = modelsDiffer;
      log(`  round ${round} WARNING: the arms ran different models (${Object.entries(modelsDiffer).map(([f, m]) => `${f}: A ${m.a.join(', ')} vs B ${m.b.join(', ')}`).join('; ')})`);
    }
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
      // What the gateway booked as saved against what the pair actually cost (direct arm only).
      if (args.compare === 'anyray') {
        const check = savingsCheck({ directUsd: sessions.a.totals.costUsd, anyrayUsd: sessions.b.totals.costUsd, traces: r.traces });
        if (check) r.savingsCheck = check;
      }
      if (args.compare === 'gateway') {
        r.tracesA = traces.a ?? null;
        r.optimizationA = sessions.a.optimization?.tally ?? null;
      }
      // The gateway's session gate draws a control per session: which kind (if any) each
      // arm ran without, and whether that makes the two arms different strategy sets.
      r.heldOut = heldOutRecord(Object.fromEntries(viaGateway.map((slot) => [slot, sessions[slot].optimization?.tally ?? null])));
      if (redraws.length) r.redraws = redraws; // pairs thrown away because a session drew a holdout
      if (r.heldOut.differs) {
        log(`  round ${round} WARNING: the gateway held out different kinds per arm (${viaGateway.map((slot) => `${slot.toUpperCase()}: ${r.heldOut[slot].join(', ') || 'none'}`).join('; ')}); the arms ran different strategy sets: drop this round`);
      }
      if (args.experimentB) {
        // Arm B's treatment is a rule in a shared config: it must be the same rule at both ends of the round.
        const after = experimentRules(r.optimizerConfig, args.experimentB);
        r.experimentRule = { before: ruleBefore ?? null, after, stable: ruleBefore == null || after == null ? null : ruleBefore.length > 0 && sameRules(ruleBefore, after) };
        if (r.experimentRule.stable === false) log(`  round ${round} WARNING: the rule for experiment=${args.experimentB} was missing or changed during the round; drop it`);
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
      `  round ${round} ${slot.toUpperCase()} ${armLabel(args, arms, slot)}: $${t.costUsd?.toFixed(3)} · ${t.turns} turns${subagentNote(t)} · ${t.parallelToolTurns} parallel-tool turns · ${t.cacheBreaks} cache breaks` +
      ` · start ${t.start.read} read / ${t.start.written} written` +
      (t.outsideCheckout ? ` · ${t.outsideCheckout} OUTSIDE CHECKOUT` : '') +
      endNote(t) +
      (arms[slot] === 'anyray' ? ` · ${t.hookTrimmed} hook-trimmed · ${t.readBatchCalls ?? 0} batch reads · ${t.searchContextCalls ?? 0} symbol searches` : '') +
      (sessions[slot].budgetNotice ? ` · notice applied ${sessions[slot].budgetNotice.applied}/${Object.values(sessions[slot].budgetNotice).reduce((x, y) => x + y, 0)}` : '') +
      whyNot(sessions[slot].budgetNoticeReasons) +
      (sessions[slot].toolDefer && sessions[slot].toolDefer.applied + sessions[slot].toolDefer.notApplied > 0 ? ` · tool defer applied ${sessions[slot].toolDefer.applied}/${Object.values(sessions[slot].toolDefer).reduce((x, y) => x + y, 0)}${whyNot(sessions[slot].toolDeferReasons)}` : '') +
      `${pingNote(t)}${writtenDocsNote(sessions[slot])} · ${r.quality[slot] ? 'solved' : 'NOT solved'}${t.resultSubtype && t.resultSubtype !== 'success' ? ` (${t.resultSubtype})` : ''}`;
    log(
      `${line('a', ta)}\n${line('b', tb)}\n` +
        `  round ${round} ratio B/A ${r.ratio?.toFixed(3)}${sharedFileNote(r)}` +
        (r.heldOut && viaGateway.some((slot) => r.heldOut[slot].length) ? `\n  round ${round} held out by the gateway's session gate: ${viaGateway.map((slot) => `${slot.toUpperCase()} ${r.heldOut[slot].join(', ') || 'none'}`).join(' · ')}` : '') +
        (r.optimizationA ? `\n  round ${round} A ${formatKindTally(r.optimizationA)}` : '') +
        (r.optimization ? `\n  round ${round} ${args.compare === 'gateway' ? 'B ' : ''}${formatKindTally(r.optimization)}` : '') +
        (r.savingsCheck ? `\n${savingsCheckNote(round, r.savingsCheck)}` : '')
    );
    record.stats = rule0(scoredRounds(record.rounds), { treatment: args.treatment });
    record.rule0Verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted), verdictOptions(args));
    record.verdict = benchVerdict(record.rounds);
    record.subagentLoad = subagentLoadSummary(record.rounds); // per arm: requestsPerSubagent, pooled, and per round
    record.claudeVersions = claudeVersions(record.rounds); // per arm: which Claude Code versions the rounds ran, `mixed` when not one
    await save();
    return r;
  };

  // --retry-invalid N: a round the verdict would drop (exclusionReasons: not solved, failed,
  // outside the checkout, a file both arms wrote outside their checkouts, a gateway restart)
  // runs again under the next free number, at most N extra rounds in all, so a one-round test
  // still ends with a usable pair. The dropped round stays in the file and the verdict as
  // before; `record.retries` names each one.
  let nextRound = first + args.rounds;
  let retriesLeft = args.retryInvalid ?? 0;
  const attempt = async (round) => {
    const r = await schedule(() => runRound(round));
    const why = exclusionReasons(r);
    if (!why.length || retriesLeft <= 0) return r;
    retriesLeft--;
    const again = nextRound++;
    (record.retries ??= []).push({ round, reasons: why, retriedAs: again });
    log(`  round ${round} is not usable (${why.join(', ')}); running round ${again} in its place (retry ${args.retryInvalid - retriesLeft}/${args.retryInvalid})`);
    return attempt(again);
  };

  // Every round is queued at once; the pool lets --parallel of them run. All settle
  // (and are saved) before the first unexpected error, if any, is rethrown.
  const settled = await Promise.allSettled(numbers.map(attempt));
  const failed = settled.find((x) => x.status === 'rejected');
  if (failed) {
    await save();
    throw failed.reason;
  }
  record.stats = rule0(scoredRounds(record.rounds), { treatment: args.treatment }); // all rounds, read for the arm under test like each round's save (the report reads it)
  record.rule0Verdict = solvedPairVerdict(record.rounds.filter((x) => !x.gatewayRestarted), verdictOptions(args)); // the printed verdict's, as saved
  record.verdict = benchVerdict(record.rounds);
  record.subagentLoad = subagentLoadSummary(record.rounds);
  record.claudeVersions = claudeVersions(record.rounds);
  const booked = savingsCheckSummary(record.rounds);
  if (booked.rounds) {
    record.savingsCheck = booked;
    log(`gateway booked $${booked.bookedUsd.toFixed(3)} saved vs measured $${booked.measuredUsd.toFixed(3)} over ${booked.rounds} round(s)` +
      (booked.lostButBooked ? `; WARNING: ${booked.lostButBooked} round(s) booked a saving while Anyray cost more` : '') +
      (booked.overclaim > booked.lostButBooked ? `; ${booked.overclaim - booked.lostButBooked} more booked more than they saved` : ''));
  }
  await save();
  return { record, file, viaGateway };
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(redactLevelError(e));
  process.exit(1);
});

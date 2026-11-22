// Runner for the Claude Agent SDK app lanes. Each round runs the selected arms concurrently
// as a Claude Agent SDK application, every arm on the same gateway, route and model but on
// its OWN key — A (x-anyray-harness-retrieval off), B (on), C (the optimize-off baseline
// bypass, no /mcp read path), D (B plus anyray-connect's local stdio MCP server, offering
// anyray_read_batch) — and records per session: cost, turns, subagent spawns and whether
// they went out in parallel, tool calls by name, findings recall, and the D4 evidence: the
// growth of the arm key's /connect/self-check report across the session (classified
// sdk-agent requests by evidence class, fresh handles minted). Compare with
// tools/compare-sdk-app.mjs.
//
// Three lanes (--scenario):
//   sdk-app-scanner       (default; arms A,B,C) a security scanner over synthetic recorded
//                         traffic and a local fixture server (ANY-1093).
//   sdk-app-scanner-long  (arms A,B,C) the same scanner at Novee's session length: its own
//                         task list, a reflect-and-repeat loop, a 150-turn cap (ANY-1105).
//   sdk-app-code-scan     (arms A,B,C,D,E,P,S,S2; default A,D) the same app shape auditing a
//                         pinned checkout of a large Python codebase with nine seeded
//                         vulnerabilities, each arm in its own fresh checkout. Arm D enrolls
//                         anyray-connect once per run in a private HOME (the agent-host flow,
//                         D's service key in its env) and mounts only connect's MCP server into
//                         the app; the run first probes that server and refuses D unless it
//                         advertises anyray_read_batch.
//
// On both scanner lanes, K and R pin the strategy set per request (x-anyray-optimization-kinds; R = K plus
// repeat_factor, ANY-1154). For the kinds some selected arm runs and another does not, each
// session also records what that kind did, from the gateway's trace METADATA (decisions,
// folds, tokens, declines, a session-gate holdout); that read needs --admin-token-file, a
// 0600 file holding an admin credential with traces:read, and never touches bodies.
//
// Keys come from 0600 files named <arm>.key in --keys-dir; a key is never on argv and never
// printed. Arm D's key must be a service (agent) key: connect's non-interactive enrollment
// takes one. --budget (default $120) is a hard cap: a round never starts if the costliest
// round so far would push the total past it, and the run aborts when the first three rounds
// project past it.
//
//   node run_sdk_app.mjs --gateway <url> --keys-dir <dir with A.key B.key C.key> \
//     --model claude-sonnet-5-5 --rounds 20 --budget 120 --label <label>
//   node run_sdk_app.mjs --scenario sdk-app-scanner-long --arms K,R --keys-dir <dir with K.key R.key> \
//     --admin-token-file <0600 file> --model claude-opus-4-6 --rounds 8 --budget 140 --label <label>
//   node run_sdk_app.mjs --scenario sdk-app-code-scan --arms A,D --gateway <url> \
//     --keys-dir <dir with A.key D.key> --model claude-sonnet-5-5 --rounds 8 --budget 40 --label <label>

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { load as parseYaml } from 'js-yaml';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './lib/loadConfig.mjs';
import { ARMS, runSdkAppAgent, readSelfCheckRetrieval, evidenceDelta, budgetDecision, shortProfile, watchedKinds } from './lib/agentSdkApp.mjs';
import { readSessionKindEvidence } from './lib/kindEvidence.mjs';
import { longProfile } from './lib/scannerLong.mjs';
import { runCodeScanAgent } from './lib/sdkAppCodeScan.mjs';
import { prepareRepo, repoCacheDir, binDigest } from './lib/agentRun.mjs';
import { CONNECT_MCP_SERVER, connectSourceOf, instructionsExpectedFor, connectMcpServerConfig, connectArmTools, probeMcpTools, prepareConnectHome, preflightReadBatchCall, checkPreflightRead } from './lib/connectMcp.mjs';
import { buildTrafficDb } from './tools/traffic-fixture/generate.mjs';
import { startFixtureServer } from './tools/traffic-fixture/fixtureServer.mjs';
import { VULNERABILITIES, httpVulnerabilities } from './tools/traffic-fixture/vulnerabilities.mjs';
import { buildScannerTarget, customerFiles, DEFAULT_ROWS, DEFAULT_SEED } from './tools/scanner-target/target.mjs';
import { startScannerTargetServer } from './tools/scanner-target/server.mjs';
import { SCANNER_VULNERABILITIES } from './tools/scanner-target/vulnerabilities.mjs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
export const DEFAULT_BUDGET_USD = 120;
// The self-check is served from a 15 s evidence cache and the last spend rows land just
// after the response, so the "after" read waits past both and repeats until it is stable.
const SELF_CHECK_SETTLE_MS = 20_000;
const SELF_CHECK_MAX_READS = 4;

/**
 * The app lanes this runner drives, by scenario directory. `prepare` builds the scenario's
 * synthetic data under `dir`, starts its live service, and returns the profile every arm
 * runs, the fixture facts the result file records, and the service's `close`.
 */
export const SCENARIO_PROFILES = {
  'sdk-app-scanner': {
    prepare: async ({ scenarioFile, dir }) => {
      const rows = scenarioFile.fixture?.rows ?? 24;
      const seed = scenarioFile.fixture?.seed ?? 1337;
      const dbPath = join(dir, 'traffic.sqlite');
      const planted = buildTrafficDb(dbPath, { seed, rows });
      const fixture = await startFixtureServer();
      const endpoints = [...new Set(httpVulnerabilities().map((v) => v.path)), '/', '/health'];
      return {
        fixture: { rows, seed, markers: VULNERABILITIES.length, planted: planted.planted },
        profile: shortProfile({ dbPath, fixtureUrl: fixture.url, rows, endpoints }),
        close: fixture.close,
      };
    },
  },
  'sdk-app-scanner-long': {
    prepare: async ({ scenarioFile, dir }) => {
      const rows = scenarioFile.fixture?.rows ?? DEFAULT_ROWS;
      const seed = scenarioFile.fixture?.seed ?? DEFAULT_SEED;
      const target = buildScannerTarget(dir, { seed, rows });
      const server = await startScannerTargetServer({ seed });
      return {
        fixture: { rows, seed, markers: SCANNER_VULNERABILITIES.length, planted: target.planted, files: [...customerFiles({ seed }).keys()] },
        profile: longProfile({ dbPath: target.dbPath, filesDir: target.filesDir, fixtureUrl: server.url, rows, files: [...customerFiles({ seed }).keys()] }),
        close: server.close,
      };
    },
  },
};

/** Which arms each lane can run, and which it runs by default. D, E, P, S and S2 need a
 *  lane whose agents read files; the scanners' read a database and a server. K and R pin
 *  their kinds through the result proxy, which only the scanner app runs behind. */
export const SCENARIOS = {
  'sdk-app-scanner': { arms: ['A', 'B', 'C', 'K', 'R'], defaultArms: ['A', 'B', 'C'] },
  'sdk-app-scanner-long': { arms: ['A', 'B', 'C', 'K', 'R'], defaultArms: ['A', 'B', 'C'] },
  'sdk-app-code-scan': { arms: ['A', 'B', 'C', 'D', 'E', 'P', 'S', 'S2'], defaultArms: ['A', 'D'] },
};

export function parseArgs(argv, env = process.env) {
  const a = { scenario: 'sdk-app-scanner', arms: null, rounds: 1, model: env.ANYRAY_LIVE_MODEL || 'claude-haiku-4-5', label: null, budget: DEFAULT_BUDGET_USD, gateway: null, keysDir: null, adminTokenFile: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--scenario') a.scenario = argv[++i];
    else if (v === '--arms') a.arms = String(argv[++i] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (v === '--rounds') a.rounds = Number(argv[++i]);
    else if (v === '--model') a.model = argv[++i];
    else if (v === '--label') a.label = argv[++i];
    else if (v === '--budget') a.budget = Number(argv[++i]);
    else if (v === '--gateway') a.gateway = argv[++i];
    else if (v === '--keys-dir') a.keysDir = argv[++i];
    else if (v === '--admin-token-file') a.adminTokenFile = argv[++i];
    else throw new Error(`unknown flag ${v}`);
  }
  const lane = Object.hasOwn(SCENARIOS, a.scenario) ? SCENARIOS[a.scenario] : null;
  if (!lane) throw new Error(`--scenario takes one of ${Object.keys(SCENARIOS).join(', ')}`);
  a.arms ??= lane.defaultArms;
  if (!a.arms.length || a.arms.some((x) => !Object.hasOwn(ARMS, x))) throw new Error(`--arms takes a comma list of ${Object.keys(ARMS).join(', ')}`);
  const unsupported = a.arms.filter((x) => !lane.arms.includes(x));
  if (unsupported.length) throw new Error(`${a.scenario} runs arms ${lane.arms.join(', ')}, not ${unsupported.join(', ')}${unsupported.some((x) => ARMS[x]?.localReadBatch) ? " (arms D, E, P, S and S2 mount connect's file-read tools; only a lane whose agents read files can use them)" : ''}`);
  a.arms = [...new Set(a.arms)].sort();
  if (!Number.isInteger(a.rounds) || a.rounds < 1) throw new Error('--rounds must be a positive integer');
  if (!(a.budget > 0) || !Number.isFinite(a.budget)) throw new Error('--budget must be a positive number of dollars');
  if (!a.keysDir) throw new Error('--keys-dir is required: a directory with one 0600 <arm>.key file per arm');
  return a;
}

/** A credential from a file only its owner can read. Refuses a file group or others can
 *  read, and an empty one. The value is never printed. */
export function readSecretFile(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} is mode ${mode.toString(8)}; chmod 600 it`);
  const secret = readFileSync(file, 'utf8').trim();
  if (!secret) throw new Error(`${file} is empty`);
  return secret;
}

/** One key per arm from `<dir>/<arm>.key` (each a readSecretFile), refusing two arms
 *  sharing a key (the per-session evidence is read per key). */
export function readArmKeys(dir, arms) {
  const keys = {};
  for (const arm of arms) keys[arm] = readSecretFile(join(dir, `${arm}.key`));
  if (new Set(Object.values(keys)).size !== arms.length) throw new Error('each arm needs its own key');
  return keys;
}

const readAll = async (gatewayUrl, keys, arms) => {
  const out = {};
  for (const arm of arms) out[arm] = await readSelfCheckRetrieval(gatewayUrl, keys[arm]);
  return out;
};

/** The "after" reads: wait out the evidence cache, then re-read until two consecutive
 *  reads agree for every arm (the last rows have landed) or the read budget runs out. */
const settledReads = async (gatewayUrl, keys, arms) => {
  let prev = null;
  let cur = null;
  for (let n = 0; n < SELF_CHECK_MAX_READS; n++) {
    await sleep(SELF_CHECK_SETTLE_MS);
    cur = await readAll(gatewayUrl, keys, arms);
    if (prev && arms.every((arm) => JSON.stringify(prev[arm]) === JSON.stringify(cur[arm]))) break;
    prev = cur;
  }
  return cur;
};

/** A session's dollars for the budget: the larger of the priced usage and the SDK's own
 *  figure (which matches the gateway's bill; the priced usage can miss subagent output),
 *  so the hard cap never undercounts. */
export const sessionCost = (s) => {
  const xs = [s?.totals?.costUsd, s?.totals?.sdkCostUsd].filter(Number.isFinite);
  return xs.length ? Math.max(...xs) : 0;
};

const evidenceLine = (ev) => {
  if (!ev) return 'evidence unread';
  const classes = Object.entries(ev.evidence).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  return `evidence ${ev.requests} req (${classes}), fresh handles ${ev.freshEmitted ?? 'unknown'}`;
};

/** One watched kind's session evidence as a line: counts and reasons only. */
export const kindLine = (e) => {
  const n = (x) => (x == null ? 'unknown' : String(x));
  const reasons = (o) => Object.entries(o ?? {}).map(([k, x]) => `${k} ${x}`).join(', ') || 'none';
  return `decided on ${e.requestsWithKind}/${e.requests} requests · fresh folds ${n(e.freshFolds)} (${n(e.blocksFactored)} blocks, ${n(e.freshTokens)} tokens) · replays ${n(e.replays)} (${n(e.replayTokens)} tokens) · declines ${reasons(e.declines)} · suppressed ${reasons(e.suppressed)}${e.holdout ? ' · HOLDOUT' : ''}`;
};

/** How many times the agents called the batch read, and how many of those calls errored. */
const readBatchLine = (t) => (t?.readBatch ? ` · read_batch ${t.readBatch.calls} call(s)${t.readBatch.errors ? ` (${t.readBatch.errors} errored)` : ''}` : '');

/** A scanner lane: its SCENARIO_PROFILES entry builds the data and starts the service once;
 *  every arm runs that profile in one shared work dir. */
const profileLane = (name) => async ({ scenarioFile, args, gatewayUrl, keys, pricing }) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sdk-app-fixture-'));
  const workDir = mkdtempSync(join(tmpdir(), 'sdk-app-work-'));
  let prepared;
  try {
    prepared = await SCENARIO_PROFILES[name].prepare({ scenarioFile, dir: fixtureDir });
  } catch (e) {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
  return {
    total: prepared.fixture.markers,
    record: { fixture: prepared.fixture, maxTurns: scenarioFile.maxTurns ?? null },
    prepare: () => null,
    release: () => {},
    runArm: (arm, sessionId) =>
      runSdkAppAgent({
        arm,
        scenario: { ...scenarioFile, cwd: workDir },
        model: args.model,
        gatewayUrl,
        clientKey: keys[arm],
        sessionId,
        profile: prepared.profile,
        pricing,
        timeoutMs: (scenarioFile.timeoutMin ?? 10) * 60000,
        deps: { query, createSdkMcpServer, tool },
      }),
    close: async () => {
      await prepared.close();
      rmSync(fixtureDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
};

/**
 * A connect arm's mount (D, E), once per run: enroll connect in a private HOME with the
 * arm's key, then probe its stdio server (initialize + tools/list) in a fresh checkout,
 * started with the arm's source the way the SDK will start it. Throws, before any paid
 * round, when connect cannot enroll, its server does not offer the batch read, the batch
 * read does not serve absolute in-checkout paths (what the SDK's tools hand the model), or
 * (E) it sends no initialize instructions for the arm's source.
 */
async function connectMount({ arm, dir, scenarioFile, gatewayUrl, clientKey }) {
  const home = prepareConnectHome({ gatewayUrl, clientKey });
  if (!home.configured) {
    rmSync(home.dir, { recursive: true, force: true });
    throw new Error(`arm ${arm}: anyray-connect did not enroll: ${home.reason}`);
  }
  const source = connectSourceOf(arm);
  const server = connectMcpServerConfig({ home: home.home, source });
  const probeWork = prepareRepo(scenarioFile, dir);
  let probe;
  try {
    probe = await probeMcpTools({ command: server.command, args: server.args, env: server.env, cwd: probeWork, call: preflightReadBatchCall(scenarioFile, probeWork) });
  } finally {
    rmSync(probeWork, { recursive: true, force: true });
  }
  if (probe.error) {
    rmSync(home.dir, { recursive: true, force: true });
    throw new Error(`arm ${arm}: anyray-connect's MCP server did not answer tools/list: ${probe.error}`);
  }
  let tools;
  try {
    tools = connectArmTools(probe.tools, CONNECT_MCP_SERVER, { instructionsExpected: instructionsExpectedFor(arm), instructions: probe.instructions, exposeAll: ARMS[arm].connectTools === 'all' });
    checkPreflightRead(arm, probe.call);
  } catch (e) {
    rmSync(home.dir, { recursive: true, force: true });
    throw e;
  }
  return {
    mount: { name: CONNECT_MCP_SERVER, server, tools },
    dir: home.dir,
    // For the result: what the arm mounts, never a key, the HOME path or the instructions text.
    record: {
      server: CONNECT_MCP_SERVER,
      source,
      instructions: probe.instructions,
      absolutePathRead: { served: true, header: probe.call.header },
      command: basename(server.command),
      args: server.args,
      envKeys: Object.keys(server.env),
      alwaysLoad: server.alwaysLoad,
      connectBinary: binDigest(server.command),
      advertised: probe.tools,
      allowed: tools.allowed,
      disallowed: tools.disallowed,
      connect: { ...home.setup, seeded: home.seeded },
    },
  };
}

/** The code-scan lane: each arm audits its own fresh checkout; D and E mount connect's server. */
async function codeScanLane({ dir, scenarioFile, args, gatewayUrl, keys, pricing }) {
  const mounts = {};
  try {
    for (const arm of args.arms.filter((a) => ARMS[a].localReadBatch)) mounts[arm] = await connectMount({ arm, dir, scenarioFile, gatewayUrl, clientKey: keys[arm] });
  } catch (e) {
    for (const m of Object.values(mounts)) rmSync(m.dir, { recursive: true, force: true });
    throw e;
  }
  return {
    total: scenarioFile.keyFacts.length,
    record: {
      repo: { git: scenarioFile.repo.git, ref: scenarioFile.repo.ref, patch: scenarioFile.patch, hidePatch: Boolean(scenarioFile.hidePatch) },
      slices: scenarioFile.slices.map((s) => ({ name: s.name, audit: s.audit })),
      keyFacts: scenarioFile.keyFacts.length,
      ...(Object.keys(mounts).length && { connectMcp: Object.fromEntries(Object.entries(mounts).map(([arm, m]) => [arm, m.record])) }),
    },
    // Every checkout of a round is made before any session starts, so the arms start together.
    prepare: () => prepareRepo(scenarioFile, dir, { cacheDir: repoCacheDir() }),
    release: (work) => rmSync(work, { recursive: true, force: true }),
    runArm: (arm, sessionId, work) =>
      runCodeScanAgent({
        arm,
        scenario: scenarioFile,
        work,
        model: args.model,
        gatewayUrl,
        clientKey: keys[arm],
        sessionId,
        pricing,
        connect: mounts[arm]?.mount ?? null,
        timeoutMs: (scenarioFile.timeoutMin ?? 15) * 60000,
        deps: { query },
      }),
    close: async () => {
      for (const m of Object.values(mounts)) rmSync(m.dir, { recursive: true, force: true });
    },
  };
}

const LANES = { 'sdk-app-scanner': profileLane('sdk-app-scanner'), 'sdk-app-scanner-long': profileLane('sdk-app-scanner-long'), 'sdk-app-code-scan': codeScanLane };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // loadConfig applies config.yaml's blocked_gateways to the flag as well as the env.
  const cfg = loadConfig({ env: { ...process.env, ...(args.gateway && { ANYRAY_GATEWAY_URL: args.gateway }) } });
  const gatewayUrl = cfg.run.gatewayUrl;
  if (!gatewayUrl) throw new Error('every arm runs through the gateway: pass --gateway or set ANYRAY_GATEWAY_URL');
  const keys = readArmKeys(args.keysDir, args.arms);
  const watched = watchedKinds(args.arms);
  const adminToken = args.adminTokenFile ? readSecretFile(args.adminTokenFile) : null;
  if (watched.length && !adminToken) console.log(`  note: no --admin-token-file, so what ${watched.join(', ')} did per session is not read`);

  const dir = join(ROOT, 'scenarios', args.scenario);
  const scenarioFile = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));
  const lane = await LANES[args.scenario]({ dir, scenarioFile, args, gatewayUrl, keys, pricing: cfg.pricing });

  const out = join(ROOT, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${args.scenario}--${args.label ?? 'anyray'}.json`);
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  Object.assign(record, {
    scenario: args.scenario,
    model: args.model,
    arms: args.arms,
    armSpecs: Object.fromEntries(args.arms.map((arm) => [arm, ARMS[arm]])),
    gateway: gatewayUrl,
    ...lane.record,
    budgetUsd: args.budget,
    watchedKinds: watched,
  });
  const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
  save();

  const stamp = Date.now();
  const first = Math.max(0, ...record.rounds.map((r) => r.round ?? 0)) + 1;
  console.log(`${args.scenario} [${args.arms.join(',')}] rounds ${first}–${first + args.rounds - 1}, model ${args.model}, budget $${args.budget}`);
  for (const [arm, m] of Object.entries(record.connectMcp ?? {})) {
    console.log(`  arm ${arm} mounts ${m.server}: ${m.command} ${m.args.join(' ')} · instructions ${m.instructions?.present ? `yes (${m.instructions.sha256})` : 'no'} · offers ${m.allowed.join(', ')} · hides ${m.disallowed.join(', ') || 'nothing'}`);
  }
  const roundCosts = [];
  try {
    for (let k = 0; k < args.rounds; k++) {
      const round = first + k;
      const budget = budgetDecision({ roundCosts, rounds: args.rounds, budget: args.budget });
      if (budget.stop) {
        record.budgetStop = { ...budget, beforeRound: round };
        save();
        console.log(`  budget stop before round ${round}: ${JSON.stringify(budget)}`);
        break;
      }
      const startedAt = new Date().toISOString();
      const works = {};
      const sessionIds = Object.fromEntries(args.arms.map((arm) => [arm, `${args.scenario}-${arm}-r${round}-${stamp}`]));
      let settled;
      let before;
      try {
        for (const arm of args.arms) works[arm] = lane.prepare(arm);
        before = await readAll(gatewayUrl, keys, args.arms);
        settled = await Promise.allSettled(args.arms.map((arm) => lane.runArm(arm, sessionIds[arm], works[arm])));
      } finally {
        for (const arm of args.arms) if (works[arm]) lane.release(works[arm]);
      }
      const after = await settledReads(gatewayUrl, keys, args.arms);
      // What each watched kind did per session, from trace metadata (after the settle, so
      // the last rows have landed). Read for every arm, so the control shows it never ran.
      const kindEvidence = {};
      if (watched.length) for (const arm of args.arms) kindEvidence[arm] = await readSessionKindEvidence(gatewayUrl, adminToken, sessionIds[arm], watched);
      const sessions = {};
      const quality = {};
      const recall = {};
      for (const [i, s] of settled.entries()) {
        const arm = args.arms[i];
        const retrieval = evidenceDelta(before[arm], after[arm]);
        const reads = { before: before[arm]?.state ?? 'unavailable', after: after[arm]?.state ?? 'unavailable' };
        if (s.status === 'rejected') {
          sessions[arm] = { arm, error: String(s.reason?.name ?? 'error').slice(0, 80), retrieval, selfCheck: reads, ...(watched.length && { kindEvidence: kindEvidence[arm] }) };
          quality[arm] = false;
          recall[arm] = 0;
          continue;
        }
        const v = s.value;
        sessions[arm] = { arm, ...ARMS[arm], totals: v.totals, recall: v.recall, recallTotal: v.recallTotal, found: v.found, missed: v.missed, solved: v.solved, completed: v.completed, endedBy: v.endedBy, toolsSeen: v.toolsSeen, modelFallbacks: v.modelFallbacks ?? [], wallMs: v.wallMs, ...(v.error && { error: v.error }), ...(v.init && { init: v.init }), sessionId: v.sessionId, retrieval, selfCheck: reads, ...(v.optimization && { optimization: v.optimization }), ...(watched.length && { kindEvidence: kindEvidence[arm] }) };
        quality[arm] = v.completed;
        recall[arm] = v.recall;
      }
      const roundCost = args.arms.reduce((n, arm) => n + sessionCost(sessions[arm]), 0);
      roundCosts.push(roundCost);
      record.rounds.push({ round, startedAt, endedAt: new Date().toISOString(), costUsd: roundCost, sessions, quality, recall });
      save();
      for (const arm of args.arms) {
        const s = sessions[arm];
        if (!s.totals) { console.log(`  round ${round} ${arm}: error ${s.error} · ${evidenceLine(s.retrieval)}`); continue; }
        const t = s.totals;
        const label = ARMS[arm].optimize ? `optimize ${ARMS[arm].optimize}` : `harness ${ARMS[arm].harnessRetrieval}${ARMS[arm].localReadBatch ? ' + connect' : ''}${ARMS[arm].kinds ? `, ${ARMS[arm].kinds.length} kinds` : ''}`;
        console.log(`  round ${round} ${arm} (${label}): $${t.costUsd?.toFixed(4) ?? 'n/a'} (sdk $${t.sdkCostUsd?.toFixed(4) ?? 'n/a'}) · ${t.turns} turns · ${t.requests} req (main ${t.mainTurns}, subagents ${JSON.stringify(t.subagentTurns)}) · ${t.subagentSpawns} spawns (${t.subagentsObserved} observed, ${t.parallelSpawnMessages} parallel launches, max ${t.maxParallelSpawn})${readBatchLine(t)} · recall ${s.recall}/${lane.total} · ${s.completed ? 'completed' : 'NOT completed'}${s.endedBy ? ` (${s.endedBy})` : ''}${s.error ? ` [${s.error}]` : ''} · ${evidenceLine(s.retrieval)}`);
        for (const f of s.modelFallbacks ?? []) console.log(`    ${arm}: the CLI switched model (${f.subtype}) ${f.from} -> ${f.to} after request ${f.afterRequest}`);
        if (s.optimization?.heldOut?.length) console.log(`    ${arm}: held out by the session gate: ${s.optimization.heldOut.join(', ')}`);
        for (const [kind, e] of Object.entries(s.kindEvidence?.kinds ?? {})) console.log(`    ${arm} ${kind}: ${kindLine(e)}`);
        if (s.kindEvidence?.unavailable) console.log(`    ${arm}: kind evidence unavailable (${s.kindEvidence.unavailable})`);
      }
      console.log(`  round ${round} $${roundCost.toFixed(3)}; spent so far $${roundCosts.reduce((a, b) => a + b, 0).toFixed(3)}`);
    }
  } finally {
    await lane.close();
  }
  console.log(`\nwrote ${file}; total spend $${roundCosts.reduce((a, b) => a + b, 0).toFixed(3)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}


// Runner for the sdk-app-scanner lane (ANY-1093). Each round runs the selected arms
// concurrently as a Claude Agent SDK application, every arm on the same gateway, route and
// model but on its OWN key — A (x-anyray-harness-retrieval off), B (on), C (the
// optimize-off baseline bypass, no /mcp read path) — and records per session: cost, turns,
// subagent spawns and whether they went out in parallel, findings recall, and the D4
// evidence: the growth of the arm key's /connect/self-check report across the session
// (classified sdk-agent requests by evidence class, fresh handles minted). Compare with
// tools/compare-sdk-app.mjs.
//
// K and R pin the strategy set per request (x-anyray-optimization-kinds; R = K plus
// repeat_factor, ANY-1154). For the kinds some selected arm runs and another does not, each
// session also records what that kind did, from the gateway's trace METADATA (decisions,
// folds, tokens, declines, a session-gate holdout); that read needs --admin-token-file, a
// 0600 file holding an admin credential with traces:read, and never touches bodies.
//
// Keys come from 0600 files named <arm>.key in --keys-dir; a key is never on argv and never
// printed. --budget (default $120) is a hard cap: a round never starts if the costliest
// round so far would push the total past it, and the run aborts when the first three rounds
// project past it. Synthetic fixtures only.
//
//   node run_sdk_app.mjs --gateway <url> --keys-dir <dir with A.key B.key C.key> \
//     --model claude-sonnet-5-5 --rounds 20 --budget 120 --label <label>
//   node run_sdk_app.mjs --scenario sdk-app-scanner-long --arms K,R --keys-dir <dir with K.key R.key> \
//     --admin-token-file <0600 file> --model claude-opus-4-6 --rounds 8 --budget 140 --label <label>

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { load as parseYaml } from 'js-yaml';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './lib/loadConfig.mjs';
import { ARMS, DEFAULT_ARMS, runSdkAppAgent, readSelfCheckRetrieval, evidenceDelta, budgetDecision, shortProfile, watchedKinds } from './lib/agentSdkApp.mjs';
import { readSessionKindEvidence } from './lib/kindEvidence.mjs';
import { longProfile } from './lib/scannerLong.mjs';
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

export function parseArgs(argv, env = process.env) {
  const a = { scenario: 'sdk-app-scanner', arms: [...DEFAULT_ARMS], rounds: 1, model: env.ANYRAY_LIVE_MODEL || 'claude-haiku-4-5', label: null, budget: DEFAULT_BUDGET_USD, gateway: null, keysDir: null, adminTokenFile: null };
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
  if (!Object.hasOwn(SCENARIO_PROFILES, a.scenario)) throw new Error(`--scenario takes one of ${Object.keys(SCENARIO_PROFILES).join(', ')}`);
  if (!a.arms.length || a.arms.some((x) => !Object.hasOwn(ARMS, x))) throw new Error(`--arms takes a comma list of ${Object.keys(ARMS).join(', ')}`);
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

  const out = join(ROOT, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sdk-app-fixture-'));
  const prepared = await SCENARIO_PROFILES[args.scenario].prepare({ scenarioFile, dir: fixtureDir });
  const markers = prepared.fixture.markers;
  const workDir = mkdtempSync(join(tmpdir(), 'sdk-app-work-'));

  const file = join(out, `${args.scenario}--${args.label ?? 'anyray'}.json`);
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  Object.assign(record, {
    scenario: args.scenario,
    model: args.model,
    arms: args.arms,
    armSpecs: Object.fromEntries(args.arms.map((arm) => [arm, ARMS[arm]])),
    gateway: gatewayUrl,
    fixture: prepared.fixture,
    maxTurns: scenarioFile.maxTurns ?? null,
    budgetUsd: args.budget,
    watchedKinds: watched,
  });
  const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
  save();

  const stamp = Date.now();
  const first = Math.max(0, ...record.rounds.map((r) => r.round ?? 0)) + 1;
  console.log(`${args.scenario} [${args.arms.join(',')}] rounds ${first}–${first + args.rounds - 1}, model ${args.model}, budget $${args.budget}`);
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
      const before = await readAll(gatewayUrl, keys, args.arms);
      const sessionIds = Object.fromEntries(args.arms.map((arm) => [arm, `${args.scenario}-${arm}-r${round}-${stamp}`]));
      const runArm = (arm) =>
        runSdkAppAgent({
          arm,
          scenario: { ...scenarioFile, cwd: workDir },
          model: args.model,
          gatewayUrl,
          clientKey: keys[arm],
          sessionId: sessionIds[arm],
          profile: prepared.profile,
          pricing: cfg.pricing,
          timeoutMs: (scenarioFile.timeoutMin ?? 10) * 60000,
          deps: { query, createSdkMcpServer, tool },
        });
      const settled = await Promise.allSettled(args.arms.map(runArm));
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
        sessions[arm] = { arm, ...ARMS[arm], totals: v.totals, recall: v.recall, recallTotal: v.recallTotal, found: v.found, missed: v.missed, solved: v.solved, completed: v.completed, endedBy: v.endedBy, toolsSeen: v.toolsSeen, modelFallbacks: v.modelFallbacks ?? [], wallMs: v.wallMs, ...(v.error && { error: v.error }), sessionId: v.sessionId, retrieval, selfCheck: reads, ...(v.optimization && { optimization: v.optimization }), ...(watched.length && { kindEvidence: kindEvidence[arm] }) };
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
        const label = ARMS[arm].optimize ? `optimize ${ARMS[arm].optimize}` : `harness ${ARMS[arm].harnessRetrieval}${ARMS[arm].kinds ? `, ${ARMS[arm].kinds.length} kinds` : ''}`;
        console.log(`  round ${round} ${arm} (${label}): $${t.costUsd?.toFixed(4) ?? 'n/a'} (sdk $${t.sdkCostUsd?.toFixed(4) ?? 'n/a'}) · ${t.turns} turns (main ${t.mainTurns}, subagents ${JSON.stringify(t.subagentTurns)}) · ${t.subagentSpawns} spawns (${t.subagentsObserved} observed, ${t.parallelSpawnMessages} parallel launches, max ${t.maxParallelSpawn}) · recall ${s.recall}/${markers} · ${s.completed ? `completed (${s.endedBy})` : `NOT completed (${s.endedBy})`}${s.error ? ` [${s.error}]` : ''} · ${evidenceLine(s.retrieval)}`);
        for (const f of s.modelFallbacks ?? []) console.log(`    ${arm}: the CLI switched model (${f.subtype}) ${f.from} -> ${f.to} after request ${f.afterRequest}`);
        if (s.optimization?.heldOut?.length) console.log(`    ${arm}: held out by the session gate: ${s.optimization.heldOut.join(', ')}`);
        for (const [kind, e] of Object.entries(s.kindEvidence?.kinds ?? {})) console.log(`    ${arm} ${kind}: ${kindLine(e)}`);
        if (s.kindEvidence?.unavailable) console.log(`    ${arm}: kind evidence unavailable (${s.kindEvidence.unavailable})`);
      }
      console.log(`  round ${round} $${roundCost.toFixed(3)}; spent so far $${roundCosts.reduce((a, b) => a + b, 0).toFixed(3)}`);
    }
  } finally {
    await prepared.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
  console.log(`\nwrote ${file}; total spend $${roundCosts.reduce((a, b) => a + b, 0).toFixed(3)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}


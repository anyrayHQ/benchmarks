// Runner for the sdk-app-scanner lane (ANY-1093). Each round runs the selected arms —
// A (gateway, x-anyray-harness-retrieval off), B (gateway, on), C (direct Bedrock) — as a
// Claude Agent SDK application, and records per session: cost, turns, subagent spawns and
// whether they went out in parallel, findings recall, and (gateway arms) the key's
// retrieval evidence (evidenceClass counts + fresh handles) for the D4 mint precondition.
// Compare the ratios with tools/compare-sdk-app.mjs.
//
// It never prints a key, bounds spend with --budget, and aborts a hung session rather than
// leaving a child to be pkill'd. Synthetic fixtures only.
//
//   node run_sdk_app.mjs --arms A,C --rounds 2 --model claude-haiku-4-5 \
//     --gateway <url> --client-key <ark_…> --key-id <id> --admin-key <aak_…|token> \
//     --budget 15 --label dryrun
//
// Flags may instead come from the environment: ANYRAY_GATEWAY_URL, ANYRAY_BENCH_CLIENT_KEY
// (or ANYRAY_CLIENT_KEY), ANYRAY_ADMIN_KEY, ANYRAY_SDK_APP_KEY_ID, plus the ANYRAY_BEDROCK_*
// options the shared bedrock helper reads.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from './lib/loadConfig.mjs';
import { bedrockOptions, bedrockSmallModel, probeGatewayRoute, assertBedrockRoute } from './lib/bedrock.mjs';
import { resolveBenchKey } from './lib/benchKey.mjs';
import { runSdkAppAgent } from './lib/agentSdkApp.mjs';
import { buildTrafficDb } from './tools/traffic-fixture/generate.mjs';
import { startFixtureServer } from './tools/traffic-fixture/fixtureServer.mjs';
import { VULNERABILITIES, httpVulnerabilities } from './tools/traffic-fixture/vulnerabilities.mjs';

const ROOT = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const ARMS = new Set(['A', 'B', 'C']);
const HARNESS = { A: 'off', B: 'on', C: null };

export function parseArgs(argv, env = process.env) {
  const a = { arms: ['A', 'B', 'C'], rounds: 1, model: env.ANYRAY_LIVE_MODEL || 'claude-haiku-4-5', label: null, budget: Infinity, keyId: env.ANYRAY_SDK_APP_KEY_ID || null, adminKey: env.ANYRAY_ADMIN_KEY || null, gateway: null, clientKey: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--arms') a.arms = String(argv[++i] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (v === '--rounds') a.rounds = Number(argv[++i]);
    else if (v === '--model') a.model = argv[++i];
    else if (v === '--label') a.label = argv[++i];
    else if (v === '--budget') a.budget = Number(argv[++i]);
    else if (v === '--key-id') a.keyId = argv[++i];
    else if (v === '--admin-key') a.adminKey = argv[++i];
    else if (v === '--gateway') a.gateway = argv[++i];
    else if (v === '--client-key') a.clientKey = argv[++i];
    else throw new Error(`unknown flag ${v}`);
  }
  if (!a.arms.length || a.arms.some((x) => !ARMS.has(x))) throw new Error('--arms takes a comma list of A, B, C');
  a.arms = [...new Set(a.arms)].sort();
  if (!Number.isInteger(a.rounds) || a.rounds < 1) throw new Error('--rounds must be a positive integer');
  if (!(a.budget > 0)) throw new Error('--budget must be a positive number of dollars');
  return a;
}

/**
 * The direct arm's Bedrock model id and small/fast model, mirroring run_agent.mjs's
 * resolveBedrock: ANYRAY_BEDROCK_MODEL pins it, else one 1-token request through the
 * gateway's org lane reads back the id the gateway serves (which must be Bedrock).
 */
export async function resolveBedrock({ gatewayUrl, model, clientKey, env = process.env, probe = probeGatewayRoute } = {}) {
  const opts = bedrockOptions(env);
  const withSmall = (b) => ({ ...b, ...bedrockSmallModel(b.model, opts.smallModel) });
  if (!gatewayUrl) {
    if (!opts.model) throw new Error('arm C without a gateway needs ANYRAY_BEDROCK_MODEL (the Bedrock model id)');
    return withSmall({ ...opts, modelSource: 'ANYRAY_BEDROCK_MODEL' });
  }
  const route = await probe({ gatewayUrl, clientKey, model });
  const served = assertBedrockRoute(route, { pinned: opts.model });
  return withSmall({ ...opts, model: opts.model ?? served, modelSource: opts.model ? 'ANYRAY_BEDROCK_MODEL' : 'gateway route probe', gatewayServedAs: served ?? route.model });
}

/** The key's retrieval evidence for the sdk-agent runtime, from GET /admin/v1/keys/:id
 *  (the console's own read): evidenceClass counts and fresh handles minted. Never throws. */
export async function readKeyRetrieval(gatewayUrl, adminKey, keyId, { fetchImpl = fetch } = {}) {
  if (!gatewayUrl || !adminKey || !keyId) return { unavailable: 'need gateway, admin key and key id' };
  try {
    const res = await fetchImpl(`${gatewayUrl}/admin/v1/keys/${encodeURIComponent(keyId)}`, { headers: { authorization: `Bearer ${adminKey}` } });
    if (!res.ok) return { unavailable: `GET /admin/v1/keys/:id ${res.status}` };
    const body = await res.json();
    const rr = body.record?.retrievalRuntimes ?? body.retrievalRuntimes;
    if (!rr || rr.state !== 'measured') return { state: rr?.state ?? 'unknown', windowHours: rr?.windowHours };
    // The store may label a runtime by its user-agent, not the x-anyray-metadata tool,
    // so surface every runtime's evidence and the sdk-agent match if one exists; the D4
    // precondition is read off evidenceClass + fresh handles whichever label carried it.
    const sdk = (rr.runtimes ?? []).find((r) => r.clientTool === 'sdk-agent');
    const readBack = (rr.readBack ?? []).find((r) => r.clientTool === 'sdk-agent');
    return {
      state: 'measured',
      windowHours: rr.windowHours,
      runtimes: (rr.runtimes ?? []).map((r) => ({ clientTool: r.clientTool, verdict: r.verdict, requests: r.requests, evidence: r.evidence })),
      readBack: (rr.readBack ?? []).map((r) => ({ clientTool: r.clientTool, emitted: r.emitted ?? null, retrieved: r.retrieved, missed: r.missed })),
      sdkAgent: sdk ? { verdict: sdk.verdict, requests: sdk.requests, evidence: sdk.evidence, freshEmitted: readBack?.emitted ?? null } : null,
    };
  } catch (e) {
    return { unavailable: String(e?.name ?? e).slice(0, 80) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const gatewayUrl = (args.gateway || cfg.run.gatewayUrl || '').replace(/\/$/, '');
  const clientKey = args.clientKey || resolveBenchKey(process.env, () => {}).key;
  const needsGateway = args.arms.some((x) => x !== 'C');
  if (needsGateway && (!gatewayUrl || !clientKey)) throw new Error('gateway arms need --gateway and --client-key (or ANYRAY_GATEWAY_URL / ANYRAY_BENCH_CLIENT_KEY)');

  const dir = join(ROOT, 'scenarios', 'sdk-app-scanner');
  const scenarioFile = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));
  const rows = scenarioFile.fixture?.rows ?? 24;
  const seed = scenarioFile.fixture?.seed ?? 1337;

  // Direct arm (C) model: the Bedrock id, read back through the gateway's route when one
  // is available. Resolve only when needed.
  const bedrock = args.arms.includes('C') ? await resolveBedrock({ gatewayUrl, model: args.model, clientKey }).catch((e) => { throw new Error(`cannot resolve Bedrock for arm C: ${e.message}`); }) : null;

  const out = join(ROOT, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  const fixtureDir = mkdtempSync(join(tmpdir(), 'sdk-app-fixture-'));
  const dbPath = join(fixtureDir, 'traffic.sqlite');
  const planted = buildTrafficDb(dbPath, { seed, rows });
  const fixture = await startFixtureServer();
  const workDir = mkdtempSync(join(tmpdir(), 'sdk-app-work-'));
  const endpoints = [...new Set(httpVulnerabilities().map((v) => v.path)), '/', '/health'];

  const file = join(out, `sdk-app-scanner--${args.label ?? 'anyray'}.json`);
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { rounds: [] };
  Object.assign(record, {
    scenario: 'sdk-app-scanner',
    model: args.model,
    provider: 'bedrock',
    arms: args.arms,
    gateway: gatewayUrl || null,
    ...(bedrock && { bedrock: { model: bedrock.model, region: bedrock.region, smallModel: bedrock.smallModel } }),
    fixture: { rows, seed, markers: VULNERABILITIES.length, planted: planted.planted },
    budgetUsd: args.budget === Infinity ? null : args.budget,
  });
  const save = () => writeFileSync(file, JSON.stringify(record, null, 2));
  save();

  const stamp = Date.now();
  const first = Math.max(0, ...record.rounds.map((r) => r.round ?? 0)) + 1;
  console.log(`sdk-app-scanner [${args.arms.join(',')}] rounds ${first}–${first + args.rounds - 1}, model ${args.model}${bedrock ? `, direct ${bedrock.model}` : ''}`);
  let spent = 0;
  try {
    for (let k = 0; k < args.rounds; k++) {
      const round = first + k;
      if (spent >= args.budget) { console.log(`  budget $${args.budget} reached ($${spent.toFixed(3)}); stopping before round ${round}`); break; }
      const startedAt = new Date().toISOString();
      const runArm = (arm) =>
        runSdkAppAgent({
          arm: arm === 'C' ? 'direct' : 'anyray-' + arm.toLowerCase(),
          scenario: { ...scenarioFile, cwd: workDir },
          model: args.model,
          gatewayUrl,
          clientKey,
          bedrock,
          harnessRetrieval: HARNESS[arm],
          sessionId: `sdk-app-scanner-${arm}-r${round}-${stamp}`,
          dbPath,
          fixtureUrl: fixture.url,
          endpoints,
          rows,
          pricing: cfg.pricing,
          timeoutMs: (scenarioFile.timeoutMin ?? 10) * 60000,
          deps: { query, createSdkMcpServer, tool },
        }).then((s) => ({ ...s, arm }));
      const settled = await Promise.allSettled(args.arms.map(runArm));
      const sessions = {};
      const quality = {};
      const recall = {};
      for (const [i, s] of settled.entries()) {
        const arm = args.arms[i];
        if (s.status === 'rejected') {
          sessions[arm] = { error: String(s.reason?.message ?? s.reason).slice(0, 160) };
          quality[arm] = false;
          recall[arm] = 0;
          continue;
        }
        const v = s.value;
        sessions[arm] = { arm, harnessRetrieval: HARNESS[arm], totals: v.totals, recall: v.recall, found: v.found, missed: v.missed, solved: v.solved, wallMs: v.wallMs, ...(v.error && { error: v.error }), sessionId: v.sessionId };
        quality[arm] = v.solved;
        recall[arm] = v.recall;
        if (Number.isFinite(v.totals?.costUsd)) spent += v.totals.costUsd;
      }
      const r = { round, startedAt, endedAt: new Date().toISOString(), sessions, quality, recall };
      record.rounds.push(r);
      save();
      for (const arm of args.arms) {
        const s = sessions[arm];
        if (s.error && !s.totals) { console.log(`  round ${round} ${arm}: error ${s.error}`); continue; }
        const t = s.totals;
        console.log(`  round ${round} ${arm} (${HARNESS[arm] ?? 'direct'}): $${t.costUsd?.toFixed(4) ?? 'n/a'} · ${t.turns} turns · ${t.subagentSpawns} spawns (${t.subagentsObserved} observed, parallel ${t.spawnedInParallel}) · recall ${s.recall}/${VULNERABILITIES.length} · ${s.solved ? 'solved' : 'NOT solved'}${s.error ? ` [${s.error}]` : ''}`);
      }
      console.log(`  round ${round} spent so far $${spent.toFixed(3)}`);
    }
  } finally {
    await fixture.close();
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }

  // D4: the key's retrieval evidence for the gateway arms (shared key, so read once).
  if (needsGateway && args.adminKey && args.keyId) {
    const ev = await readKeyRetrieval(gatewayUrl, args.adminKey, args.keyId);
    record.retrievalEvidence = { key: ev };
    save();
    console.log(`  retrieval evidence (key ${args.keyId.slice(0, 6)}…): ${JSON.stringify(ev)}`);
  }
  console.log(`\nwrote ${file}; total spend $${spent.toFixed(3)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

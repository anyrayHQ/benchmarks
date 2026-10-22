#!/usr/bin/env node
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from '../lib/claudeBin.mjs';
import { PlanError, freezePlan, verifyPlan, resolveScenariosDir, runDefaults, gatewayHost, planAnswer, printPlanAnswer, validatedScenarios, benchmarksCommit } from '../lib/planLock.mjs';
import { loadCatalog, classify, budgetPlan, formatPlan } from '../lib/planner.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/loadConfig.mjs';
import { frozenClaude, executionGate, gatewayVersion } from '../lib/kitExecution.mjs';
import { readKitRecords, kitVerdict } from '../lib/kitResults.mjs';
import { clientTestBody, formatKitReport } from '../lib/clientTestBody.mjs';
import { DEFAULT_MIN_ROUNDS, exclusionReasons, pairsNeeded } from '../lib/benchVerdict.mjs';
import { writeNoise, assertPlanPin } from '../lib/planLock.mjs';
import { sessionGateState, adminToken } from '../lib/traces.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0] ?? 'freeze';
const usage = () => { throw new PlanError('usage', {}, 'Expected a kit command, --scenarios-dir <path> and valid flags'); };

function parseArgs() {
  if (!['plan', 'freeze', 'verify', 'noise', 'run', 'verdict', 'report', 'publish-result'].includes(command)) usage();
  const options = {};
  const values = command === 'freeze'
    ? ['scenarios-dir', 'model', 'provider', 'client', 'client-version', 'gateway', 'claude-bin']
    : command === 'plan' ? ['scenarios-dir', 'budget-usd', 'session-cost-usd', 'client', 'gateway', 'tenant'] : ['noise', 'run'].includes(command) ? ['scenarios-dir', 'rounds', 'claude-bin', ...(command === 'run' ? ['redraw-holdout'] : [])]
    : command === 'publish-result' ? ['scenarios-dir', 'gateway'] : ['scenarios-dir'];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') continue;
    if (flag === '--redact' && command === 'report') { options.redact = true; continue; }
    if (flag === '--replace' && command === 'freeze') { options.replace = true; continue; }
    if (!flag.startsWith('--') || !values.includes(flag.slice(2))) usage();
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage();
    options[flag.slice(2)] = value;
  }
  if (!options['scenarios-dir']) usage();
  if (options.provider && !['anthropic', 'bedrock'].includes(options.provider)) usage();
  if (options.client && !['claude-code', 'codex'].includes(options.client)) usage();
  if (command === 'plan') {
    for (const key of ['budget-usd', 'session-cost-usd']) {
      const n = Number(options[key]);
      if (!Number.isFinite(n) || n <= 0) usage();
      options[key] = n;
    }
    if (options.tenant !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.tenant)) usage();
  }
  if (command === 'report' && !options.redact) usage();
  if (['noise', 'run'].includes(command)) {
    for (const [key, fallback, min] of [['rounds', command === 'noise' ? 6 : DEFAULT_MIN_ROUNDS, command === 'noise' ? 6 : 1], ...(command === 'run' ? [['redraw-holdout', 2, 0]] : [])]) {
      const value = options[key] ?? String(fallback);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) usage();
      options[key] = Number(value);
    }
  }
  return options;
}

try {
  const options = parseArgs();
  const dir = resolveScenariosDir(options['scenarios-dir']);
  let answer;
  if (command === 'verify') answer = planAnswer(command, verifyPlan(dir));
  else if (command === 'plan') {
    const gateway = options.gateway || runDefaults().gateway;
    if (!gatewayHost(gateway)) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
    const bundles = validatedScenarios(dir);
    const catalog = loadCatalog();
    const client = options.client || 'claude-code';
    const scenarios = bundles.map(({ id, source, scenario }) => ({ id, source, ...classify(scenario, client, catalog) }));
    const commit = benchmarksCommit();
    const gate = await sessionGateState(gateway, { tenant: options.tenant });
    if (gate.reason) throw new PlanError('plan_tenant_unreadable', { reason: gate.reason, ...(gate.status === undefined ? {} : { status: gate.status }) }, 'Unable to read the tenant session gate');
    if (gate.allShadow) throw new PlanError('plan_tenant_shadow', { tenant: gate.tenant, kinds: gate.kinds }, 'This tenant applies nothing yet; the test would measure pass-through');
    answer = { ok: true, command, benchmarksCommit: commit, client, tenant: { id: gate.tenant, kinds: gate.kinds },
      ...budgetPlan(scenarios, { budgetUsd: options['budget-usd'], sessionCostUsd: options['session-cost-usd'] }) };
  }
  else if (command === 'freeze') {
    const defaults = runDefaults();
    let version = options['client-version'];
    if (!version) {
      try { version = claudeVersion(resolveClaudeBin(claudeBinRequest({ flag: options['claude-bin'], env: process.env })).bin); }
      catch { version = null; }
    }
    const pins = {
      model: options.model || defaults.model,
      provider: options.provider || 'anthropic',
      client: options.client || 'claude-code',
      clientVersion: version,
      gatewayHost: gatewayHost(options.gateway || defaults.gateway),
    };
    for (const [pin, value] of Object.entries(pins)) {
      if (typeof value !== 'string' || !value.trim()) throw new PlanError('pin_missing', { pin });
    }
    answer = freezePlan(dir, pins, options.replace);
  }
  else {
    const lock = verifyPlan(dir);
    if (['noise', 'run'].includes(command)) {
      const compare = command === 'noise' ? 'control' : 'anyray';
      executionGate(lock, compare);
      const claude = frozenClaude(lock, options['claude-bin']);
      // Redirect before importing the harness: even log functions captured at import use stderr.
      const stdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr);
      try {
        const { parseArgs: runArgs, runComparison } = await import('../run_agent.mjs');
        const cfg = loadConfig();
        const version = compare === 'anyray' ? await gatewayVersion(cfg.run.gatewayUrl) : undefined;
        // One pair at a time, round k of every scenario before round k+1 of any.
        for (let k = 0; k < options.rounds; k++) {
          for (const { id } of lock.scenarios) {
            const args = runArgs(['--scenario', id, '--scenarios-dir', dir, '--compare', compare, '--rounds', '1', '--parallel', '1']);
            Object.assign(args, { planLock: lock, claude, gatewayVersion: version, redrawHoldout: options['redraw-holdout'] ?? 0 });
            const { record } = await runComparison(args, cfg);
            const failed = record.rounds.at(-1);
            if (failed?.error) throw Object.assign(new Error('Run failed'), { name: failed.error });
          }
        }
      } catch (error) {
        let name = 'unknown';
        try { if (typeof error?.name === 'string') name = error.name; } catch { /* No thrown content. */ }
        throw new PlanError('run_failed', { error: name }, 'Run failed');
      } finally { process.stdout.write = stdout; }
      const records = readKitRecords(dir, lock, compare);
      if (command === 'run') answer = { ok: true, command, planHash: lock.planHash, scenarios: lock.scenarios.map(({ id }, i) => ({ id, rounds: records[i]?.rounds.length ?? 0 })) };
      else {
        let ss = 0, df = 0;
        const byScenario = lock.scenarios.map(({ id }, i) => {
          const logs = (records[i]?.rounds ?? []).filter((r) => exclusionReasons(r).length === 0).map((r) => Math.log(r.ratio));
          const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
          const sum = logs.reduce((a, x) => a + (x - mean) ** 2, 0);
          if (logs.length >= 2) { ss += sum; df += logs.length - 1; }
          return { id, n: logs.length, sd: logs.length < 2 ? null : Math.sqrt(sum / (logs.length - 1)) };
        });
        const sd = df ? Math.sqrt(ss / df) : null;
        if (!(sd > 0)) throw new PlanError('noise_insufficient');
        const rounds = byScenario.reduce((n, s) => n + s.n, 0);
        writeNoise(dir, lock, { sd, rounds, byScenario });
        answer = { ok: true, command, planHash: lock.planHash, sd: { value: sd, source: 'measured', rounds }, alpha: 0.05, power: 0.8,
          scenarios: lock.scenarios.map(({ id, source }, i) => {
            const { shapeId, prediction } = lock.predictions[i];
            const target = prediction.status === 'band' ? (prediction.lo + prediction.hi) / 2 : null;
            return { id, source, n: byScenario[i].n, sd: byScenario[i].sd, shapeId, prediction, target, pairsNeeded: target === null ? null : pairsNeeded(target, sd) };
          }) };
      }
    } else {
      if (command === 'publish-result') {
        const gateway = options.gateway || runDefaults().gateway;
        if (!gatewayHost(gateway)) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
        assertPlanPin(lock, 'gatewayHost', gatewayHost(gateway));
        if (!adminToken(process.env)) throw new PlanError('admin_key_missing');
      }
      const records = readKitRecords(dir, lock);
      const verdict = kitVerdict(lock, records);
      if (command === 'verdict') answer = verdict;
      else {
        const version = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
        const body = clientTestBody(lock, records, version);
        if (command === 'report') {
          process.stdout.write(json ? JSON.stringify(body) + '\n' : formatKitReport(verdict, body));
        } else {
          const gateway = options.gateway || runDefaults().gateway;
          let status = null, id;
          try {
            const response = await fetch(new URL('/admin/v1/client-tests', gateway), {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken(process.env)}` },
              body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
            });
            status = response.status;
            if (status === 201) {
              const result = await response.json();
              if (typeof result?.result?.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(result.result.id)) id = result.result.id;
            }
          } catch { /* A response body or network message is never diagnostic output. */ }
          if (!id) throw new PlanError('publish_failed', { status });
          process.stdout.write(json ? JSON.stringify({ ok: true, command, id }) + '\n' : id + '\n');
        }
      }
    }
  }
  if (['report', 'publish-result'].includes(command)) { /* Already printed the validated body or id. */ }
  else if (command === 'noise' && !json) process.stdout.write(answer.scenarios.map((s) => `${s.id}: pairs needed ${s.pairsNeeded ?? 'none'}`).join('\n') + `\nMeasured SD: ${answer.sd.value}\n`);
  else if (command === 'verdict' && !json) process.stdout.write(answer.scenarios.map((s) => `${s.id}: ${s.verdict}; Rule 0 ${s.rule0}`).join('\n') + `\nPooled Rule 0: ${answer.rule0Verdict}\n`);
  else if (command === 'plan' && !json) process.stdout.write(formatPlan(answer));
  else printPlanAnswer(answer, json);
} catch (error) {
  if (error instanceof PlanError) {
    printPlanAnswer(planAnswer(command, error), json);
    process.exitCode = error.exitCode;
  } else {
    let name = 'unknown';
    try { if (typeof error?.name === 'string') name = error.name; } catch { /* A thrown value may have a throwing getter. */ }
    printPlanAnswer({ ok: false, command, code: 'kit_failed', message: 'Unable to process plan', error: name }, json);
    process.exitCode = 1;
  }
}

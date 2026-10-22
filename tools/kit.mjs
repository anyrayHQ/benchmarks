#!/usr/bin/env node
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from '../lib/claudeBin.mjs';
import { PlanError, freezePlan, verifyPlan, resolveScenariosDir, runDefaults, gatewayHost, planAnswer, printPlanAnswer, validatedScenarios, benchmarksCommit } from '../lib/planLock.mjs';
import { loadCatalog, classify, predictedHitRate, budgetPlan, formatPlan } from '../lib/planner.mjs';
import { calibrate } from '../lib/calibration.mjs';
import { frozenClaude, executionGate, executePlan } from '../lib/kitExecution.mjs';
import { readKitRecords, kitVerdict } from '../lib/kitResults.mjs';
import { clientTestBody, formatKitReport } from '../lib/clientTestBody.mjs';
import { DEFAULT_MIN_ROUNDS } from '../lib/benchVerdict.mjs';
import { sessionGateState } from '../lib/traces.mjs';
import { kitVersion, releaseGateway, requireAdmin, releaseCheck, publishResult, runTwins } from '../lib/kitRelease.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0] ?? 'freeze';
const usage = () => { throw new PlanError('usage', {}, 'Expected a kit command, --scenarios-dir <path> and valid flags'); };

function parseArgs() {
  if (!['calibrate', 'plan', 'freeze', 'verify', 'noise', 'run', 'verdict', 'report', 'publish-result', 'release-check', 'twins'].includes(command)) usage();
  const options = {};
  const values = command === 'calibrate' ? ['from'] : command === 'twins' ? ['release', 'gateway', 'rounds', 'provider', 'claude-bin'] : command === 'freeze'
    ? ['scenarios-dir', 'model', 'provider', 'client', 'client-version', 'gateway', 'claude-bin']
    : command === 'plan' ? ['scenarios-dir', 'budget-usd', 'session-cost-usd', 'client', 'gateway', 'tenant'] : ['noise', 'run'].includes(command) ? ['scenarios-dir', 'rounds', 'claude-bin', ...(command === 'run' ? ['redraw-holdout'] : [])]
    : ['publish-result', 'release-check'].includes(command) ? ['scenarios-dir', 'gateway'] : ['scenarios-dir'];
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
  if (command === 'twins') {
    if (!/^[A-Za-z0-9][\w.:-]{0,63}$/.test(options.release ?? '')) usage();
  } else if (command === 'calibrate') {
    if (!options.from) usage();
  } else if (!options['scenarios-dir']) usage();
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
  if (['noise', 'run', 'twins'].includes(command)) {
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
  const dir = ['calibrate', 'twins'].includes(command) ? null : resolveScenariosDir(options['scenarios-dir']);
  let answer;
  let catalog;
  if (command === 'calibrate') answer = calibrate(options.from);
  else if (command === 'twins') answer = await runTwins(options);
  else if (command === 'release-check') answer = await releaseCheck(dir, options);
  else if (command === 'verify') answer = planAnswer(command, verifyPlan(dir));
  else if (command === 'plan') {
    const gateway = options.gateway || runDefaults().gateway;
    if (!gatewayHost(gateway)) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
    const bundles = validatedScenarios(dir);
    catalog = loadCatalog();
    const client = options.client || 'claude-code';
    const scenarios = bundles.map(({ id, source, scenario }) => {
      const classified = classify(scenario, client, catalog);
      const shape = catalog.shapes.find((s) => s.id === classified.shapeId);
      return { id, source, ...classified, predictedHitRate: predictedHitRate(shape, classified.prediction) };
    });
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
      answer = await executePlan(command, dir, lock, options, claude);
    } else {
      if (command === 'publish-result') {
        releaseGateway(options, lock);
        requireAdmin();
      }
      const records = readKitRecords(dir, lock);
      const verdict = kitVerdict(lock, records);
      if (command === 'verdict') answer = verdict;
      else {
        const body = clientTestBody(lock, records, kitVersion(), { scenarios: validatedScenarios(dir) });
        if (command === 'report') {
          process.stdout.write(json ? JSON.stringify(body) + '\n' : formatKitReport(verdict, body));
        } else {
          const id = await publishResult(releaseGateway(options, lock), body);
          process.stdout.write(json ? JSON.stringify({ ok: true, command, id }) + '\n' : id + '\n');
        }
      }
    }
  }
  if (['report', 'publish-result'].includes(command)) { /* Already printed the validated body or id. */ }
  else if (command === 'release-check' && !json) process.stdout.write(`changed=${answer.changed}\n`);
  else if (command === 'twins' && !json) process.stdout.write(answer.id + '\n');
  else if (command === 'noise' && !json) process.stdout.write(answer.scenarios.map((s) => `${s.id}: pairs needed ${s.pairsNeeded ?? 'none'}`).join('\n') + `\nMeasured SD: ${answer.sd.value}\n`);
  else if (command === 'verdict' && !json) process.stdout.write(answer.scenarios.map((s) => `${s.id}: ${s.verdict}; Rule 0 ${s.rule0}`).join('\n') + `\nPooled Rule 0: ${answer.rule0Verdict}\n`);
  else if (command === 'plan' && !json) process.stdout.write(formatPlan(answer, catalog));
  else if (command === 'calibrate' && !json) process.stdout.write([...answer.updated.map((id) => `Updated ${id}`), ...answer.unknown.map((id) => `Unknown shape ${id}`)].join('\n') + '\n');
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

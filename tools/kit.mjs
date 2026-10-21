#!/usr/bin/env node
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from '../lib/claudeBin.mjs';
import { PlanError, freezePlan, verifyPlan, resolveScenariosDir, runDefaults, gatewayHost, planAnswer, printPlanAnswer, validatedScenarios, benchmarksCommit } from '../lib/planLock.mjs';
import { loadCatalog, classify, budgetPlan, formatPlan } from '../lib/planner.mjs';
import { sessionGateState } from '../lib/traces.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0] ?? 'freeze';
const usage = () => { throw new PlanError('usage', {}, 'Expected plan|freeze|verify --scenarios-dir <path> and valid flags'); };

function parseArgs() {
  if (!['plan', 'freeze', 'verify'].includes(command)) usage();
  const options = {};
  const values = command === 'freeze'
    ? ['scenarios-dir', 'model', 'provider', 'client', 'client-version', 'gateway', 'claude-bin']
    : command === 'plan' ? ['scenarios-dir', 'budget-usd', 'session-cost-usd', 'client', 'gateway', 'tenant'] : ['scenarios-dir'];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') continue;
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
  else {
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
  if (command === 'plan' && !json) process.stdout.write(formatPlan(answer));
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

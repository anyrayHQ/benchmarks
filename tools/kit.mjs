#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReportHtml } from '../lib/reportHtml.mjs';
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from '../lib/claudeBin.mjs';
import { KINDS_PIN, PlanError, assertGatewayAllowed, freezePlan, verifyPlan, resolveScenariosDir, runDefaults, gatewayHost, planAnswer, printPlanAnswer, validatedScenarios, expectedOf, benchmarksCommit } from '../lib/planLock.mjs';
import { NOISE_ROUNDS, loadCatalog, classify, predictedHitRate, budgetPlan, formatPlan } from '../lib/planner.mjs';
import { calibrate } from '../lib/calibration.mjs';
import { frozenClaude, executionGate, executePlan } from '../lib/kitExecution.mjs';
import { readKitRecords, kitVerdict, formatKitVerdict, formatNoise, formatStopped, kitSpend, meanRoundMs } from '../lib/kitResults.mjs';
import { clientTestBody, formatKitReport } from '../lib/clientTestBody.mjs';
import { DEFAULT_MIN_ROUNDS } from '../lib/benchVerdict.mjs';
import { adminToken, sessionGateState } from '../lib/traces.mjs';
import { kitVersion, releaseGateway, releaseCheck, publishResult, runTwins } from '../lib/kitRelease.mjs';
import { kitAccess, kitEnvironment } from '../lib/kitCredentials.mjs';
import { doctor, formatDoctor } from '../lib/kitDoctor.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0] ?? 'freeze';
const usage = () => { throw new PlanError('usage', {}, 'Expected a kit command, --scenarios-dir <path> and valid flags'); };

function parseArgs() {
  if (!['calibrate', 'plan', 'freeze', 'verify', 'noise', 'run', 'verdict', 'report', 'publish-result', 'release-check', 'twins', 'doctor'].includes(command)) usage();
  const options = {};
  const values = command === 'doctor' ? [] : command === 'calibrate' ? ['from'] : command === 'twins' ? ['release', 'gateway', 'rounds', 'provider', 'claude-bin'] : command === 'freeze'
    ? ['scenarios-dir', 'model', 'provider', 'client', 'client-version', 'gateway', 'claude-bin', 'kinds']
    : command === 'plan' ? ['scenarios-dir', 'budget-usd', 'session-cost-usd', 'client', 'gateway', 'tenant'] : ['noise', 'run'].includes(command) ? ['scenarios-dir', 'rounds', 'budget-usd', 'claude-bin', ...(command === 'run' ? ['redraw-holdout'] : [])]
    : ['publish-result', 'release-check'].includes(command) ? ['scenarios-dir', 'gateway'] : ['scenarios-dir'];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') continue;
    if (flag === '--redact' && command === 'report') { options.redact = true; continue; }
    if (flag === '--html' && command === 'report') { options.html = true; continue; }
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
  } else if (command !== 'doctor' && !options['scenarios-dir']) usage();
  if (options.kinds !== undefined && options.kinds !== 'auto') {
    // Kind ids are catalogue names; the registry itself is the gateway's, so only the shape is checked here.
    const ids = [...new Set(options.kinds.split(','))].sort();
    if (ids.length > 32 || !ids.every((id) => /^[a-z][a-z0-9_]{0,63}$/.test(id))) usage();
    options.kinds = ids.join(',');
  }
  if (options.provider && !['anthropic', 'bedrock'].includes(options.provider)) usage();
  if (options.client && !['claude-code', 'codex'].includes(options.client)) usage();
  if (command === 'plan') {
    if (options['budget-usd'] === undefined) usage();
    if (options.tenant !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.tenant)) usage();
  }
  if (['plan', 'noise', 'run'].includes(command)) {
    for (const key of ['budget-usd', ...(command === 'plan' ? ['session-cost-usd'] : [])]) {
      if (options[key] === undefined) continue;
      const n = Number(options[key]);
      if (!Number.isFinite(n) || n <= 0) usage();
      options[key] = n;
    }
  }
  if (command === 'report' && !options.redact) usage();
  if (['noise', 'run', 'twins'].includes(command)) {
    for (const [key, fallback, min] of [['rounds', command === 'noise' ? NOISE_ROUNDS : DEFAULT_MIN_ROUNDS, command === 'noise' ? NOISE_ROUNDS : 1], ...(command === 'run' ? [['redraw-holdout', 2, 0]] : [])]) {
      if (command === 'run' && key === 'rounds' && options.rounds === undefined && options['budget-usd'] !== undefined) continue;
      const value = options[key] ?? String(fallback);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min) usage();
      options[key] = Number(value);
    }
  }
  return options;
}

try {
  const options = parseArgs();
  // The harness also reads process.env in its isolated arms. Give every layer the same
  // Connect credentials, without printing or sourcing the credential file.
  if (['plan', 'freeze', 'noise', 'run', 'publish-result', 'release-check'].includes(command)) Object.assign(process.env, kitEnvironment());
  const dir = ['calibrate', 'twins', 'doctor'].includes(command) ? null : resolveScenariosDir(options['scenarios-dir']);
  let answer;
  let catalog;
  let noisePairs = null;
  let noiseRoundMs = null;
  if (command === 'doctor') {
    answer = await doctor();
    if (!answer.ok) process.exitCode = 2;
  }
  else if (command === 'calibrate') answer = calibrate(options.from);
  else if (command === 'twins') answer = await runTwins(options);
  else if (command === 'release-check') answer = await releaseCheck(dir, options);
  else if (command === 'verify') answer = planAnswer(command, verifyPlan(dir));
  else if (command === 'plan') {
    const gateway = options.gateway || runDefaults().gateway;
    if (!gatewayHost(gateway)) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
    assertGatewayAllowed(gateway);
    const bundles = validatedScenarios(dir);
    catalog = loadCatalog();
    const client = options.client || 'claude-code';
    const scenarios = bundles.map(({ id, source, scenario }) => {
      const classified = classify(scenario, client, catalog);
      const shape = catalog.shapes.find((s) => s.id === classified.shapeId);
      return { id, source, ...classified, predictedHitRate: predictedHitRate(shape, classified.prediction) };
    });
    const budget = budgetPlan(scenarios, { budgetUsd: options['budget-usd'], sessionCostUsd: options['session-cost-usd'] });
    if (budget.pairsAffordable !== null && budget.pairsAffordable < 1) {
      throw new PlanError('plan_budget_too_small', { budgetUsd: budget.budgetUsd, noiseCostUsd: budget.noiseCostUsd, minimumBudgetUsd: budget.minimumBudgetUsd },
        'The budget does not cover the noise rounds plus one pair per scenario');
    }
    const commit = benchmarksCommit();
    kitAccess();
    const gate = await sessionGateState(gateway, { tenant: options.tenant });
    if (gate.reason) throw new PlanError('plan_tenant_unreadable', { reason: gate.reason, ...(gate.status === undefined ? {} : { status: gate.status }) }, 'Unable to read the tenant session gate');
    if (gate.allShadow) throw new PlanError('plan_tenant_shadow', { tenant: gate.tenant, kinds: gate.kinds }, 'This tenant applies nothing yet; the test would measure pass-through');
    answer = { ok: true, command, benchmarksCommit: commit, client, tenant: { id: gate.tenant, kinds: gate.kinds,
      ...(gate.evaluationCohort === true ? { evaluationCohort: true, kindsEvaluated: gate.kindsEvaluated } : {}) }, ...budget };
  }
  else if (command === 'freeze') {
    const defaults = runDefaults();
    if (options.kinds === 'auto') {
      // The tenant's own applying kinds, read once and pinned: the plan then measures what they would get.
      if (!adminToken(process.env)) throw new PlanError('kinds_auto_needs_admin', {}, "--kinds auto reads the tenant's enabled kinds with an admin key: set ANYRAY_ADMIN_KEY");
      const freezeGateway = options.gateway || defaults.gateway;
      if (!gatewayHost(freezeGateway)) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
      assertGatewayAllowed(freezeGateway);
      const gate = await sessionGateState(freezeGateway, {});
      if (gate.reason) throw new PlanError('plan_tenant_unreadable', { reason: gate.reason, ...(gate.status === undefined ? {} : { status: gate.status }) }, 'Unable to read the tenant session gate');
      const joined = (gate.kindsOn ?? []).join(',');
      if (!KINDS_PIN.test(joined)) throw new PlanError('plan_kinds_empty', { tenant: gate.tenant }, 'No kind is on for this tenant, so there is nothing to pin');
      options.kinds = joined;
    }
    let version = options['client-version'];
    if (!version) {
      try { version = claudeVersion(resolveClaudeBin(claudeBinRequest({ flag: options['claude-bin'], env: process.env })).bin); }
      catch { version = null; }
    }
    assertGatewayAllowed(options.gateway || defaults.gateway);
    const pins = {
      model: options.model || defaults.model,
      provider: options.provider || 'anthropic',
      client: options.client || 'claude-code',
      clientVersion: version,
      gatewayHost: gatewayHost(options.gateway || defaults.gateway),
      ...(options.kinds ? { kinds: options.kinds } : {}),
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
      if (command === 'noise' && options['budget-usd'] !== undefined) {
        // Pairs the rest of the budget still buys, at the control rounds' own mean cost.
        const { spentUsd, meanRoundUsd } = kitSpend(dir, lock);
        if (meanRoundUsd > 0) noisePairs = Math.max(0, Math.floor((options['budget-usd'] - spentUsd) / meanRoundUsd));
      }
      if (command === 'noise') noiseRoundMs = meanRoundMs(readKitRecords(dir, lock, 'control').flatMap((r) => r?.rounds ?? []));
    } else {
      if (command === 'publish-result') {
        releaseGateway(options, lock);
        kitAccess();
      }
      const records = readKitRecords(dir, lock);
      const frozen = validatedScenarios(dir);
      const verdict = kitVerdict(lock, records, command === 'verdict' ? readKitRecords(dir, lock, 'control') : null);
      verdict.scenarios = verdict.scenarios.map((s) => ({ ...s, expect: expectedOf(frozen.find(({ id }) => id === s.id)?.scenario) }));
      if (command === 'verdict') answer = verdict;
      else {
        const body = clientTestBody(lock, records, kitVersion(), { scenarios: frozen });
        if (command === 'report' && options.html) {
          const file = join(dir, 'report.html');
          writeFileSync(file, renderReportHtml({ body, verdict, records, lock }));
          process.stdout.write(json ? JSON.stringify({ ok: true, command, file }) + '\n' : `${file}\n`);
        } else if (command === 'report') {
          process.stdout.write(json ? JSON.stringify(body) + '\n' : formatKitReport(verdict, body));
        } else {
          const published = await publishResult(releaseGateway(options, lock), body);
          process.stdout.write(json ? JSON.stringify({ ok: true, command, ...published }) + '\n' : published.id + '\n');
          if (!json) for (const warning of published.warnings ?? []) process.stderr.write(`${warning.code}: ${warning.message}\n`);
          if (!json) process.stderr.write('Published. It shows under Measurement on the Optimizer page of your console.\n');
        }
      }
    }
  }
  // The words a person reads, carried in the JSON too so the skill can copy them as printed.
  if (command === 'noise' && !answer.stopped) answer.summary = formatNoise(answer, { pairsPlanned: noisePairs, roundMs: noiseRoundMs });
  if (['report', 'publish-result'].includes(command)) { /* Already printed the validated body or id. */ }
  else if (['noise', 'run'].includes(command) && !json && answer.stopped === 'budget_reached') process.stdout.write(formatStopped(answer));
  else if (command === 'doctor' && !json) process.stdout.write(formatDoctor(answer));
  else if (command === 'release-check' && !json) process.stdout.write(`changed=${answer.changed}\n`);
  else if (command === 'twins' && !json) {
    process.stdout.write(answer.id + '\n');
    for (const warning of answer.warnings ?? []) process.stderr.write(`${warning.code}: ${warning.message}\n`);
  }
  else if (command === 'noise' && !json && !answer.stopped) process.stdout.write(answer.summary);
  else if (command === 'verdict' && !json) process.stdout.write(formatKitVerdict(answer));
  else if (command === 'plan' && !json) process.stdout.write(formatPlan(answer, catalog) + (answer.tenant.evaluationCohort ? `${answer.tenant.kindsEvaluated} kinds will be evaluated on test sessions only.\n` : ''));
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

#!/usr/bin/env node
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from '../lib/claudeBin.mjs';
import { PlanError, freezePlan, verifyPlan, resolveScenariosDir, runDefaults, gatewayHost, planAnswer, printPlanAnswer } from '../lib/planLock.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const command = argv[0] ?? 'freeze';
const usage = () => { throw new PlanError('usage', {}, 'Expected freeze|verify --scenarios-dir <path> and valid flags'); };

function parseArgs() {
  if (!['freeze', 'verify'].includes(command)) usage();
  const options = {};
  const values = command === 'freeze'
    ? ['scenarios-dir', 'model', 'provider', 'client', 'client-version', 'gateway', 'claude-bin']
    : ['scenarios-dir'];
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
  return options;
}

try {
  const options = parseArgs();
  const dir = resolveScenariosDir(options['scenarios-dir']);
  let answer;
  if (command === 'verify') answer = planAnswer(command, verifyPlan(dir));
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
  printPlanAnswer(answer, json);
} catch (error) {
  const refusal = error instanceof PlanError ? error : new PlanError('usage', {}, 'Unable to process plan');
  printPlanAnswer(planAnswer(command, refusal), json);
  process.exitCode = refusal.exitCode;
}

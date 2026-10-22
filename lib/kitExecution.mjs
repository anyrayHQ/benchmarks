// The kit's gates finish before credentials, network reads, clones or sessions begin.
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from './claudeBin.mjs';
import { PlanError, assertGatewayAllowed, assertPlanPin, runDefaults, gatewayHost, writeNoise } from './planLock.mjs';
import { adminToken } from './traces.mjs';
import { loadConfig } from './loadConfig.mjs';
import { readKitRecords } from './kitResults.mjs';
import { exclusionReasons, pairsNeeded } from './benchVerdict.mjs';

export function resolveKitClaude(flag, env = process.env) {
  const requested = claudeBinRequest({ flag, env });
  let claude = resolveClaudeBin(requested);
  if (!claude.pinned) {
    let bin;
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      const candidate = resolve(dir, 'claude');
      try { accessSync(candidate, constants.X_OK); bin = realpathSync(candidate); break; } catch { /* Next PATH entry. */ }
    }
    if (!bin) throw new PlanError('pin_missing', { pin: 'clientVersion' });
    claude = { bin, source: 'PATH', pinned: true };
  } else claude = { ...claude, bin: realpathSync(claude.bin) };
  const version = claudeVersion(claude.bin);
  return { ...claude, version };
}

export function frozenClaude(lock, flag, env = process.env) {
  const claude = resolveKitClaude(flag, env);
  assertPlanPin(lock, 'clientVersion', claude.version);
  return claude;
}

export function executionGate(lock, compare, env = process.env) {
  const defaults = runDefaults(env);
  assertGatewayAllowed(defaults.gateway);
  if (compare === 'anyray' && !lock.noise) throw new PlanError('plan_noise_missing');
  assertPlanPin(lock, 'client', 'claude-code');
  if (!['anthropic', 'bedrock'].includes(lock.pins.provider)) throw new PlanError('plan_pin_mismatch', { pin: 'provider' });
  assertPlanPin(lock, 'model', defaults.model);
  if (compare !== 'control') {
    assertPlanPin(lock, 'gatewayHost', gatewayHost(defaults.gateway));
    executionCredentialsGate(env);
  }
}

export async function gatewayVersion(gateway, env = process.env) {
  try {
    const response = await fetch(new URL('/admin/v1/settings/updates', gateway), {
      headers: { authorization: `Bearer ${adminToken(env)}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.version === 'string' && /^[0-9A-Za-z][\w.+-]{0,63}$/.test(body.version) ? body.version : null;
  } catch { return null; }
}

export function executionCredentialsGate(env = process.env) {
  for (const variable of ['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS']) {
    if (env[variable]) throw new PlanError('env_refused', { variable });
  }
  if (!env.ANYRAY_BENCH_CLIENT_KEY?.trim()) throw new PlanError('bench_key_missing');
  if (!adminToken(env)) throw new PlanError('admin_key_missing');
}

/** Tell a client up front when their rounds cannot resolve their predicted band at their own noise. */
function warnUnderpowered(command, lock, rounds, write) {
  if (command !== 'run' || !lock.noise) return;
  lock.scenarios.forEach(({ id }, i) => {
    const { prediction } = lock.predictions[i];
    const sd = lock.noise.byScenario?.find((s) => s.id === id)?.sd ?? lock.noise.sd;
    if (prediction.status !== 'band' || !(sd > 0)) return;
    const needed = pairsNeeded((prediction.lo + prediction.hi) / 2, sd);
    if (needed !== null && rounds < needed) write(`${id}: ${rounds} rounds is under the ${needed} this scenario needs at your measured noise; the verdict may come back inconclusive.\n`);
  });
}

/** Execute the same interleaved rounds for a frozen client plan or a temporary public twin. */
export async function executePlan(command, dir, lock, options, claude, env = process.env) {
  const compare = command === 'noise' ? 'control' : 'anyray';
  // Redirect before importing the harness: even log functions captured at import use stderr.
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = stderr;
  try {
    const { parseArgs: runArgs, runComparison } = await import('../run_agent.mjs');
    const cfg = loadConfig({ env });
    const version = compare === 'anyray' ? await gatewayVersion(cfg.run.gatewayUrl) : undefined;
    // --rounds is the total a scenario ends with, not how many more to add: a re-run (an
    // interrupted run, or a second try after a verdict) tops up what the plan already has.
    const existing = readKitRecords(dir, lock, compare);
    if (compare === 'anyray' && version) {
      const other = existing.find((r) => typeof r?.gatewayVersion === 'string' && r.gatewayVersion !== version);
      if (other) throw new PlanError('run_results_other_release', { recorded: other.gatewayVersion, running: version }, 'The recorded rounds ran on another gateway release; run from a fresh checkout of the plan');
    }
    const done = existing.map((r) => r?.rounds.length ?? 0);
    const todo = done.reduce((n, d) => n + Math.max(0, options.rounds - d), 0);
    warnUnderpowered(command, lock, options.rounds, stderr);
    let finished = 0, spent = 0;
    // One pair at a time, round k of every scenario before round k+1 of any.
    for (let k = 0; k < options.rounds; k++) {
      for (const [i, { id }] of lock.scenarios.entries()) {
        if (done[i] > k) continue;
        const args = runArgs(['--scenario', id, '--scenarios-dir', dir, '--compare', compare, '--rounds', '1', '--parallel', '1', '--provider', lock.pins.provider]);
        args.label = null;
        Object.assign(args, { planLock: lock, claude, gatewayVersion: version, redrawHoldout: options['redraw-holdout'] ?? 0 });
        const { record } = await runComparison(args, cfg);
        const failed = record.rounds.at(-1);
        if (failed?.error) throw Object.assign(new Error('Run failed'), { name: failed.error });
        finished++;
        spent += ['a', 'b'].reduce((n, slot) => n + (failed?.sessions?.[slot]?.totals?.costUsd ?? 0), 0);
        stderr(`${id}: round ${k + 1}/${options.rounds} done (${finished}/${todo} this run); ratio ${typeof failed?.ratio === 'number' ? failed.ratio.toFixed(2) : 'n/a'}; spent so far $${spent.toFixed(2)}\n`);
      }
    }
    if (!todo) stderr(`Nothing to run: every scenario already has ${options.rounds} or more rounds. --rounds is the total, so pass a higher number to add pairs.\n`);
  } catch (error) {
    if (error instanceof PlanError) throw error;
    let name = 'unknown';
    try { if (typeof error?.name === 'string') name = error.name; } catch { /* No thrown content. */ }
    throw new PlanError('run_failed', { error: name }, 'Run failed');
  } finally { process.stdout.write = stdout; }
  const records = readKitRecords(dir, lock, compare);
  if (command === 'run') return { ok: true, command, planHash: lock.planHash, scenarios: lock.scenarios.map(({ id }, i) => ({ id, rounds: records[i]?.rounds.length ?? 0 })) };
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
    return { ok: true, command, planHash: lock.planHash, sd: { value: sd, source: 'measured', rounds }, alpha: 0.05, power: 0.8,
      scenarios: lock.scenarios.map(({ id, source }, i) => {
        const { shapeId, prediction } = lock.predictions[i];
        const target = prediction.status === 'band' ? (prediction.lo + prediction.hi) / 2 : null;
        return { id, source, n: byScenario[i].n, sd: byScenario[i].sd, shapeId, prediction, target, pairsNeeded: target === null ? null : pairsNeeded(target, sd) };
      }) };
  }
}

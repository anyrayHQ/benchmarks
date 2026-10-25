// The kit's gates finish before credentials, network reads, clones or sessions begin.
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from './claudeBin.mjs';
import { PlanError, assertGatewayAllowed, assertPlanPin, runDefaults, gatewayHost, writeNoise } from './planLock.mjs';
import { adminToken } from './traces.mjs';
import { kitAccess } from './kitCredentials.mjs';
import { loadConfig } from './loadConfig.mjs';
import { readKitRecords, kitSpend, mostShadowKinds } from './kitResults.mjs';
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

async function gatewayContext(gateway, env = process.env, readKinds = false) {
  const access = kitAccess(env);
  try {
    const response = await fetch(new URL(access.admin ? '/admin/v1/settings/updates' : '/connect/test/context', gateway), {
      headers: access.headers, signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    if (!response.ok) return {};
    const body = await response.json();
    const version = access.admin ? body.version : body.gatewayVersion;
    return { gatewayVersion: typeof version === 'string' && /^[0-9A-Za-z][\w.+-]{0,63}$/.test(version) ? version : null,
      ...(!access.admin && readKinds && body.evaluationCohort === true ? { evaluatedKinds: mostShadowKinds([body.sessionGate]) } : {}) };
  } catch { return {}; }
}

export async function gatewayVersion(gateway, env = process.env) {
  return (await gatewayContext(gateway, env)).gatewayVersion ?? null;
}

export function executionCredentialsGate(env = process.env, { requireAdmin = false } = {}) {
  for (const variable of ['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS']) {
    if (env[variable]) throw new PlanError('env_refused', { variable });
  }
  if (requireAdmin || adminToken(env)) {
    if (!env.ANYRAY_BENCH_CLIENT_KEY?.trim()) throw new PlanError('bench_key_missing');
    if (!adminToken(env)) throw new PlanError('admin_key_missing');
  } else kitAccess(env);
}

/** Execute the same interleaved rounds for a frozen client plan or a temporary public twin. */
export async function executePlan(command, dir, lock, options, claude, env = process.env) {
  const compare = command === 'noise' ? 'control' : 'anyray';
  const budgetUsd = options['budget-usd'];
  let spend = kitSpend(dir, lock);
  let completed = 0, consecutive = 0;
  const started = Date.now();
  const budgetReached = () => ({ ok: true, command, stopped: 'budget_reached', spentUsd: spend.spentUsd, budgetUsd, rounds: completed });
  // Only a plan with no recorded round may start without an estimate. Equality at
  // the ceiling refuses another round; equality of spend plus estimate may run.
  const refusesRound = () => budgetUsd !== undefined && (spend.spentUsd >= budgetUsd
    || spend.rounds > 0 && spend.spentUsd + spend.maxRoundUsd > budgetUsd);
  if (refusesRound()) return budgetReached();
  const sized = command === 'run' && options.rounds === undefined && budgetUsd !== undefined;
  const affordable = sized && spend.meanRoundUsd > 0
    ? Math.max(0, Math.floor((budgetUsd - spend.spentUsd) / spend.meanRoundUsd)) : 0;
  const planned = lock.scenarios.map((_, i) => {
    if (!sized) return options.rounds;
    const prediction = lock.predictions[i].prediction;
    const needed = prediction.status === 'band' ? pairsNeeded((prediction.lo + prediction.hi) / 2, lock.noise.sd) : null;
    return needed === null ? affordable : Math.min(affordable, needed);
  });
  if (sized && planned.every((n) => n === 0)) return budgetReached();
  // Redirect before importing the harness: even log functions captured at import use stderr.
  const stdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  try {
    const { parseArgs: runArgs, runComparison } = await import('../run_agent.mjs');
    const cfg = loadConfig({ env });
    const context = compare === 'anyray' ? await gatewayContext(cfg.run.gatewayUrl, env, !lock.pins.kinds) : {};
    // One pair at a time, round k of every scenario before round k+1 of any.
    for (let k = 0; k < Math.max(...planned); k++) {
      for (const [i, { id }] of lock.scenarios.entries()) {
        if (k >= planned[i]) continue;
        if (refusesRound()) return budgetReached();
        const args = runArgs(['--scenario', id, '--scenarios-dir', dir, '--compare', compare, '--rounds', '1', '--parallel', '1', '--provider', lock.pins.provider,
          // Pinned kinds ride the Anyray arm only; the direct arm never sends an Anyray header.
          ...(compare === 'anyray' && lock.pins.kinds ? ['--kinds', lock.pins.kinds] : [])]);
        args.label = null;
        Object.assign(args, { planLock: lock, claude, gatewayVersion: context.gatewayVersion, ...(context.evaluatedKinds ? { evaluatedKinds: context.evaluatedKinds } : {}), redrawHoldout: options['redraw-holdout'] ?? 0 });
        const { record } = await runComparison(args, cfg);
        const round = record.rounds.at(-1);
        completed++;
        spend = kitSpend(dir, lock);
        const cost = (slot) => {
          const value = round.sessions?.[slot]?.totals?.costUsd;
          return Number.isFinite(value) ? `$${value.toFixed(3)}` : 'n/a';
        };
        const ratio = Number.isFinite(round.ratio) ? round.ratio.toFixed(3) : 'n/a';
        const remaining = planned.reduce((sum, n) => sum + n, 0) - completed;
        const minutes = Math.ceil((Date.now() - started) / completed * remaining / 60000);
        process.stderr.write(`${id} round ${k + 1}/${planned[i]}: direct ${cost('a')}, ${compare === 'control' ? 'direct' : 'anyray'} ${cost('b')}, ratio ${ratio} · spent $${spend.spentUsd.toFixed(3)}${budgetUsd === undefined ? '' : ` of $${budgetUsd.toFixed(3)}`} · ~${minutes} min left\n`);
        const failure = round.failure;
        consecutive = failure ? consecutive + 1 : 0;
        if (failure === 'auth_error' || consecutive >= 2) throw new PlanError('run_failed', { reason: failure, consecutive: failure === 'auth_error' ? 1 : consecutive }, 'Run failed');
      }
    }
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

// The kit's gates finish before credentials, network reads, clones or sessions begin.
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { claudeBinRequest, resolveClaudeBin, claudeVersion } from './claudeBin.mjs';
import { PlanError, assertPlanPin, runDefaults, gatewayHost } from './planLock.mjs';
import { adminToken } from './traces.mjs';

export function frozenClaude(lock, flag, env = process.env) {
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
  assertPlanPin(lock, 'clientVersion', version);
  return { ...claude, version };
}

export function executionGate(lock, compare, env = process.env) {
  if (compare === 'anyray' && !lock.noise) throw new PlanError('plan_noise_missing');
  const defaults = runDefaults(env);
  assertPlanPin(lock, 'client', 'claude-code');
  assertPlanPin(lock, 'provider', 'anthropic');
  assertPlanPin(lock, 'model', defaults.model);
  if (compare !== 'control') {
    assertPlanPin(lock, 'gatewayHost', gatewayHost(defaults.gateway));
    for (const variable of ['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS']) {
      if (env[variable]) throw new PlanError('env_refused', { variable });
    }
    if (!env.ANYRAY_BENCH_CLIENT_KEY?.trim()) throw new PlanError('bench_key_missing');
    if (!adminToken(env)) throw new PlanError('admin_key_missing');
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

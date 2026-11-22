// Connect owns the credential file. Parse only its three data fields, never shell code.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PlanError } from './planLock.mjs';

export const adminToken = (env = process.env) => env.ANYRAY_TRACE_TOKEN || env.ANYRAY_TRACE_KEY || env.ANYRAY_ADMIN_KEY;
const FIELDS = ['ANYRAY_GATEWAY_URL', 'ANYRAY_BENCH_CLIENT_KEY', 'ANYRAY_TEST_KEY_EXPIRES_AT'];
const MINT_FIX = 'Run anyray-connect test-key to get a fresh test key.';

export function kitEnvironment(env = process.env) {
  if (env.ANYRAY_GATEWAY_URL && env.ANYRAY_BENCH_CLIENT_KEY) return { ...env };
  const file = join(env.HOME || homedir(), '.anyray', 'test-kit.env');
  let fd;
  try { fd = openSync(file, 'r'); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...env };
    throw new PlanError('test_kit_env_mode', { fix: 'Make ~/.anyray/test-kit.env readable only by its owner with mode 0600.' });
  }
  try {
    if ((fstatSync(fd).mode & 0o7777) !== 0o600) {
      throw new PlanError('test_kit_env_mode', { fix: 'Run chmod 600 ~/.anyray/test-kit.env, then retry.' });
    }
    const values = {};
    for (const line of readFileSync(fd, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      const key = line.slice(0, at);
      if (at > 0 && FIELDS.includes(key)) values[key] = line.slice(at + 1).trim();
    }
    return { ...env, ...Object.fromEntries(FIELDS.filter((key) => !env[key] && values[key]).map((key) => [key, values[key]])) };
  } finally { closeSync(fd); }
}

export function requireTestKey(env = process.env) {
  const resolved = kitEnvironment(env);
  const key = resolved.ANYRAY_BENCH_CLIENT_KEY?.trim();
  if (!key) throw new PlanError('test_key_missing', { fix: MINT_FIX });
  const expiry = resolved.ANYRAY_TEST_KEY_EXPIRES_AT;
  if (expiry && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
    throw new PlanError('test_key_expired', { fix: MINT_FIX });
  }
  return key;
}

/** Hours until the test key expires; null when it carries no expiry. A warning threshold, not a gate. */
export function testKeyHoursLeft(env = process.env) {
  const expiry = Date.parse(kitEnvironment(env).ANYRAY_TEST_KEY_EXPIRES_AT);
  return Number.isFinite(expiry) ? (expiry - Date.now()) / 3_600_000 : null;
}

/** Route selection and auth travel together, so client requests cannot reach admin routes. */
export function kitAccess(env = process.env) {
  const token = adminToken(env);
  return token ? { admin: true, headers: { authorization: `Bearer ${token}` } }
    : { admin: false, headers: { 'x-anyray-api-key': requireTestKey(env) } };
}

export async function testContext(gateway, { env = process.env, fetchImpl = fetch } = {}) {
  const key = requireTestKey(env);
  const response = await fetchImpl(new URL('/connect/test/context', gateway), {
    headers: { 'x-anyray-api-key': key }, signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  return response;
}

// Preflight reports only check outcomes, versions and timings. Credentials stay in memory.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { authHeaders, resolveAuth, withClaudeIdentitySystem } from './auth.mjs';
import { parseVersionOutput } from './claudeBin.mjs';
import { resolveKitClaude } from './kitExecution.mjs';
import { kitEnvironment, requireTestKey, testContext } from './kitCredentials.mjs';
import { runDefaults } from './planLock.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const run = (bin, args, env) => spawnSync(bin, args, {
  cwd: ROOT, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
});
const failure = (id, code, fix) => ({ id, ok: false, code, fix });

function connectBinary(env) {
  const candidates = env.ANYRAY_CONNECT_BIN ? [env.ANYRAY_CONNECT_BIN]
    : [join(env.HOME || homedir(), '.anyray', 'bin', 'anyray-connect'),
      ...(env.PATH ?? '').split(delimiter).map((dir) => resolve(dir, 'anyray-connect'))];
  for (const bin of candidates) {
    try {
      accessSync(bin, constants.X_OK);
      const real = realpathSync(bin);
      const result = run(real, ['--version'], env);
      const version = parseVersionOutput(result.stdout);
      if (result.status === 0 && version) return { id: 'connect', ok: true, path: real, version };
    } catch { /* Try the next executable, without exposing command output. */ }
  }
  return failure('connect', 'connect_missing', 'Install Anyray Connect or set ANYRAY_CONNECT_BIN to its absolute path.');
}

export async function doctor(env = process.env) {
  const checks = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push(major > 22 || (major === 22 && minor >= 13) ? { id: 'node', ok: true, version: process.versions.node }
    : failure('node', 'node_version', 'Install Node.js 22.13 or newer.'));
  checks.push(run('git', ['--version'], env).status === 0 ? { id: 'git', ok: true }
    : failure('git', 'git_missing', 'Install git and put it on PATH.'));
  const status = run('git', ['status', '--porcelain'], env);
  checks.push(status.status === 0 && status.stdout.trim() === '' ? { id: 'kit_clean', ok: true }
    : failure('kit_clean', 'kit_dirty', 'Use a clean kit checkout at the pinned release.'));
  try {
    const claude = resolveKitClaude(undefined, env);
    checks.push(claude.version ? { id: 'claude', ok: true, path: claude.bin, version: claude.version }
      : failure('claude', 'claude_unavailable', 'Install Claude Code and check claude --version.'));
  } catch { checks.push(failure('claude', 'claude_unavailable', 'Install Claude Code or set ANYRAY_CLAUDE_BIN to its absolute path.')); }
  checks.push(connectBinary(env));

  let resolved, key;
  try {
    resolved = kitEnvironment(env);
    key = requireTestKey(resolved);
    checks.push({ id: 'test_key', ok: true });
  } catch (error) {
    checks.push(failure('test_key', error.code || 'test_key_missing', error.fields?.fix || 'Run anyray-connect test-key.'));
  }
  const auth = resolveAuth({ ...env, ANYRAY_AUTH_MODE: 'passthrough' });
  const upstream = Boolean(auth.upstreamToken);
  const headersAllowed = !['ANYRAY_BENCH_EXTRA_HEADERS', 'ANYRAY_BENCH_SHARED_HEADERS'].some((name) => env[name]);
  const gateway = resolved && runDefaults(resolved).gateway;
  let contextOk = false;
  let start = performance.now();
  try {
    if (!key || !gateway) throw new Error('context_unavailable');
    const response = await testContext(gateway, { env: resolved });
    if (!response.ok) { await response.body?.cancel(); throw new Error('context_unavailable'); }
    const body = await response.json();
    if (typeof body?.gatewayVersion !== 'string' || typeof body?.tenant !== 'string') throw new Error('context_unavailable');
    contextOk = true;
    checks.push({ id: 'gateway_context', ok: true, latencyMs: performance.now() - start });
  } catch { checks.push(failure('gateway_context', 'gateway_unreachable', 'Check your gateway connection, then run anyray-connect test-key.')); }

  start = performance.now();
  try {
    if (!contextOk || !upstream || !headersAllowed) throw new Error('probe_unavailable');
    const response = await fetch(new URL('/v1/messages', gateway), {
      method: 'POST',
      headers: { ...authHeaders({ ...auth, mode: 'passthrough', clientKey: key }), 'content-type': 'application/json',
        'x-anyray-metadata': JSON.stringify({ tool: 'anyray-bench' }) },
      body: JSON.stringify({ model: runDefaults(resolved).model, max_tokens: 1,
        system: withClaudeIdentitySystem('', { ...auth, mode: 'passthrough' }), messages: [{ role: 'user', content: 'Hi' }] }),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    // fetch resolves when headers arrive, before the response body is consumed.
    const latencyMs = performance.now() - start;
    await response.body?.cancel();
    if (!response.ok) throw new Error('probe_unavailable');
    checks.push({ id: 'gateway_probe', ok: true, latencyMs,
      ...(latencyMs > 10000 ? { code: 'gateway_slow', fix: 'Check gateway latency before starting long test rounds.' } : {}) });
  } catch { checks.push(failure('gateway_probe', 'gateway_unreachable', 'Fix the gateway, test key, upstream credential and header checks, then retry doctor.')); }
  checks.push(upstream ? { id: 'upstream_credential', ok: true }
    : failure('upstream_credential', 'upstream_credential_missing', 'Sign in to Claude Code or set ANYRAY_UPSTREAM_TOKEN.'));
  checks.push(headersAllowed ? { id: 'header_envs', ok: true }
    : failure('header_envs', 'env_refused', 'Unset ANYRAY_BENCH_EXTRA_HEADERS and ANYRAY_BENCH_SHARED_HEADERS.'));
  return { ok: checks.every((check) => check.ok), command: 'doctor', checks };
}

export function formatDoctor(answer) {
  return answer.checks.map((check) => `${check.id}: ${check.ok ? 'ok' : 'failed'}${check.code ? ` (${check.code})` : ''}${check.latencyMs === undefined ? '' : ` ${Math.round(check.latencyMs)} ms`}${check.fix ? `\nFix: ${check.fix}` : ''}`).join('\n') + '\n';
}

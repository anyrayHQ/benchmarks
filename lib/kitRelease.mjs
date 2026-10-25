// Release reruns exchange only plan identities and validated aggregate reports.
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { PlanError, assertPlanPin, freezePlan, gatewayHost, runDefaults, validatedScenarios, verifyPlan } from './planLock.mjs';
import { adminToken } from './traces.mjs';
import { kitAccess } from './kitCredentials.mjs';
import { executePlan, executionCredentialsGate, executionGate, resolveKitClaude } from './kitExecution.mjs';
import { clientTestBody } from './clientTestBody.mjs';
import { readKitRecords } from './kitResults.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const kitVersion = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

export function releaseGateway(options, lock) {
  const gateway = options.gateway || runDefaults().gateway;
  const host = gatewayHost(gateway);
  if (!host) throw new PlanError('pin_missing', { pin: 'gatewayHost' });
  if (lock) assertPlanPin(lock, 'gatewayHost', host);
  return gateway;
}

export function requireAdmin() {
  const token = adminToken(process.env);
  if (!token) throw new PlanError('admin_key_missing');
  return token;
}

async function releaseRead(gateway, path, read, valid, access, field = read) {
  let status = null;
  try {
    const response = await fetch(new URL(path, gateway), {
      headers: access.headers,
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    status = response.status;
    if (response.ok) {
      const body = await response.json();
      if (valid(body?.[field])) return body[field];
    }
  } catch { /* Never include server bodies or network messages in a refusal. */ }
  throw new PlanError('gateway_unreadable', { read, status });
}

export async function releaseCheck(dir, options) {
  const lock = verifyPlan(dir);
  const gateway = releaseGateway(options, lock);
  const access = kitAccess();
  const version = await releaseRead(gateway, access.admin ? '/admin/v1/settings/updates' : '/connect/test/context', 'version', (v) => typeof v === 'string' && v.trim().length > 0, access, access.admin ? 'version' : 'gatewayVersion');
  const results = await releaseRead(gateway, `${access.admin ? '/admin/v1/client-tests' : '/connect/test/results'}?latest=plan&limit=200`, 'results', Array.isArray, access);
  const newest = results.filter((r) => r?.planHash === lock.planHash)
    .reduce((latest, r) => latest === null || Date.parse(r.receivedAt) > Date.parse(latest.receivedAt) ? r : latest, null);
  const published = newest === null ? null : {
    gatewayVersion: newest.gatewayVersion, releaseTag: newest.releaseTag, receivedAt: newest.receivedAt,
  };
  return { ok: true, command: 'release-check', planHash: lock.planHash, gatewayVersion: version,
    published, changed: published === null || published.gatewayVersion !== version };
}

export async function publishResult(gateway, body) {
  const access = kitAccess();
  let status = null, id;
  try {
    const response = await fetch(new URL(access.admin ? '/admin/v1/client-tests' : '/connect/test/results', gateway), {
      method: 'POST', headers: { 'content-type': 'application/json', ...access.headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    status = response.status;
    if (status === 201) {
      const result = await response.json();
      if (typeof result?.result?.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(result.result.id)) id = result.result.id;
    }
  } catch { /* A response body or network message is never diagnostic output. */ }
  if (!id) throw new PlanError('publish_failed', { status });
  return id;
}

// A twin on the API-key lane (`lane: api-key`) is for the Rule 0 parity check, run with
// --upstream api-key. This rerun is the seat lane and needs no extra toolchain, so it leaves those out.
const onApiKeyLane = (dir) => {
  try {
    return parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'))?.lane === 'api-key';
  } catch {
    return false; // no readable scenario.yaml: copy it, and let the freeze refuse it loudly
  }
};

/** Copy the kit's twins for the release rerun: every twin except the API-key lane's. */
export const copyReleaseTwins = (from, to) =>
  cpSync(from, to, { recursive: true, filter: (src) => !(statSync(src).isDirectory() && onApiKeyLane(src)) });

export async function runTwins(options) {
  const gateway = releaseGateway(options);
  executionCredentialsGate(process.env, { requireAdmin: true });
  const claude = resolveKitClaude(options['claude-bin']);
  if (!claude.version) throw new PlanError('pin_missing', { pin: 'clientVersion' });
  const env = { ...process.env, ANYRAY_GATEWAY_URL: gateway };
  const pins = { model: runDefaults(env).model, provider: options.provider || 'anthropic', client: 'claude-code',
    clientVersion: claude.version, gatewayHost: gatewayHost(gateway) };
  const temp = mkdtempSync(join(tmpdir(), 'anyray-twins-'));
  try {
    const dir = join(temp, 'twins');
    copyReleaseTwins(join(ROOT, 'twins'), dir);
    freezePlan(dir, pins);
    let lock = verifyPlan(dir);
    executionGate(lock, 'control', env);
    await executePlan('noise', dir, lock, { rounds: 6 }, claude, env);
    lock = verifyPlan(dir);
    executionGate(lock, 'anyray', env);
    await executePlan('run', dir, lock, { rounds: options.rounds, 'redraw-holdout': 2 }, claude, env);
    lock = verifyPlan(dir);
    const body = clientTestBody(lock, readKitRecords(dir, lock), kitVersion(), {
      scenarios: validatedScenarios(dir), releaseTag: options.release,
    });
    const id = await publishResult(gateway, body);
    return { ok: true, command: 'twins', releaseTag: body.releaseTag, planHash: lock.planHash, gatewayVersion: body.gatewayVersion, id };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

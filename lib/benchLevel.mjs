// Scope an integration-level assignment to the benchmark's client key. The gateway
// does not report a key's policy id on /connect/policy, so the id is given
// explicitly (--agent / --user, or ANYRAY_BENCH_AGENT_ID / ANYRAY_BENCH_USER_ID).
// The tool never reads any key's secret to find it.
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

export const LEVELS = ['gateway', 'gateway_hooks', 'gateway_hooks_mcp'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = 'integration-level.before.json';
const credential = /(?:ark_|aak_|sk-ant)[A-Za-z0-9_-]*/g;
const scrub = (s) => String(s).replace(credential, '<redacted>');

export function createBenchLevel({ gatewayUrl, adminKey, clientKey, agent, user, fetchImpl = fetch, root = ROOT } = {}) {
  const gw = String(gatewayUrl ?? '').replace(/\/$/, '');
  if (!gw) throw new Error('set ANYRAY_GATEWAY_URL');
  const config = parseYaml(readFileSync(join(root, 'config.yaml'), 'utf8'));
  if ((config.run?.blocked_gateways ?? []).map((s) => s.replace(/\/$/, '')).includes(gw)) throw new Error('gateway is blocked in config.yaml run.blocked_gateways');
  if (!adminKey) throw new Error('set ANYRAY_ADMIN_KEY');
  if (!clientKey) throw new Error('set ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY');
  if (agent && user) throw new Error('choose --agent or --user');
  if ([agent, user].some((id) => id && (/(?:ark_|aak_|sk-ant)/.test(id) || /[\r\n]/.test(id)))) throw new Error('the explicit id must be a policy id, not a credential');
  const backupFile = join(root, 'results', BACKUP);

  async function call(path, { method = 'GET', client = false, body } = {}) {
    const res = await fetchImpl(`${gw}${path}`, {
      method,
      headers: client ? { 'x-anyray-api-key': clientKey } : { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const error = new Error(`${method} ${path} failed (${res.status})${res.status === 409 ? ': policy revision conflict; reload before retrying' : ''}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  async function target() {
    // Also validates the caller's key and confirms the gateway serves levels.
    const policy = await call('/connect/policy', { client: true });
    if (!policy.integrationLevel?.level) throw new Error('gateway /connect/policy did not report an integration level');
    if (agent) return { scope: 'agents', id: agent };
    if (user) return { scope: 'users', id: user };
    throw new Error('name the benchmark key: pass --agent <id> (a service key) or --user <id>, or set ANYRAY_BENCH_AGENT_ID / ANYRAY_BENCH_USER_ID');
  }

  async function show() {
    const t = await target();
    const current = await call('/admin/v1/policies/teams');
    return { target: t, assigned: current.integrationLevel?.[t.scope]?.[t.id] ?? null, effective: (await call('/connect/policy', { client: true })).integrationLevel };
  }

  async function set(level) {
    if (!LEVELS.includes(level)) throw new Error(`integration level must be ${LEVELS.join('|')}`);
    if (existsSync(backupFile)) throw new Error(`previous integration-level backup exists at ${backupFile}; clear it before setting another level`);
    const t = await target();
    const current = await call('/admin/v1/policies/teams');
    if (typeof current.revision !== 'string' || !Array.isArray(current.skills)) throw new Error('team policy response lacks revision or skills');
    const previous = current.integrationLevel?.[t.scope]?.[t.id];
    const backup = { target: t, previous: previous ?? null, hadPrevious: previous !== undefined, requestedLevel: level, revision: current.revision, gatewayUrl: gw };
    mkdirSync(dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
    const integrationLevel = { ...(current.integrationLevel ?? {}), [t.scope]: { ...(current.integrationLevel?.[t.scope] ?? {}), [t.id]: level } };
    try {
      const saved = await call('/admin/v1/policies/teams', { method: 'PUT', body: { skills: current.skills, integrationLevel, expectedRevision: current.revision } });
      if (typeof saved.revision !== 'string') throw new Error('team policy PUT response lacks revision');
      backup.appliedRevision = saved.revision;
      backup.appliedLevel = level;
      writeFileSync(backupFile, JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
      return backup;
    } catch (error) {
      if (error.status === 409) unlinkSync(backupFile);
      else {
        try { await clear(backup); } catch { /* Keep the backup for a later clear. */ }
      }
      throw error;
    }
  }

  async function clear(change) {
    change ??= JSON.parse(readFileSync(backupFile, 'utf8'));
    if (change.gatewayUrl !== gw) throw new Error('saved integration-level gateway differs from current gateway');
    const { scope, id } = change.target;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await call('/admin/v1/policies/teams');
      if (typeof current.revision !== 'string' || !Array.isArray(current.skills)) throw new Error('team policy response lacks revision or skills');
      const assigned = current.integrationLevel?.[scope]?.[id];
      if (!change.appliedRevision && assigned === change.previous) {
        if (existsSync(backupFile)) unlinkSync(backupFile);
        return;
      }
      if (assigned !== (change.appliedLevel ?? change.requestedLevel)) throw new Error('the benchmark key assignment changed during the run; refusing to overwrite another edit');
      const entries = { ...(current.integrationLevel?.[scope] ?? {}) };
      if (change.hadPrevious) entries[id] = change.previous;
      else delete entries[id];
      const integrationLevel = { ...(current.integrationLevel ?? {}), [scope]: entries };
      try {
        await call('/admin/v1/policies/teams', { method: 'PUT', body: { skills: current.skills, integrationLevel, expectedRevision: current.revision } });
        if (existsSync(backupFile)) unlinkSync(backupFile);
        return;
      } catch (error) {
        if (error.status !== 409 || attempt === 2) throw error;
      }
    }
  }

  return { show, set, clear, backupFile };
}

export const redactLevelError = (error) => scrub(error?.message ?? error);

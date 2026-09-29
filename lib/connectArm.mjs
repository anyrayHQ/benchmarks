// The Anyray arm, configured the way a real user gets it: by anyray-connect itself.
// connect runs non-interactively with HOME set to the arm's private temp home, so
// everything it writes (Claude Code settings + hooks, MCP servers, synced skills, its
// own profile) lands there and never in this machine's real ~/.anyray or ~/.claude.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const ANYRAY_BIN = join(homedir(), '.anyray', 'bin', 'anyray-connect');

const canonical = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Throws unless `home` is a private directory: not the real HOME and not any parent
 * of it (connect writes <home>/.anyray and <home>/.claude).
 */
export function assertIsolatedHome(home, realHome = homedir()) {
  const h = canonical(home);
  const real = canonical(realHome);
  if (h === real || (real + sep).startsWith(h.endsWith(sep) ? h : h + sep)) {
    throw new Error(`refusing to run anyray-connect against the real HOME (${home})`);
  }
}

/**
 * Enroll + apply connect for Claude Code into `home` against `gatewayUrl`, using the
 * given client (service) key.
 */
export function configureWithConnect({ home, gatewayUrl, clientKey, bin = ANYRAY_BIN, realHome = homedir() }) {
  assertIsolatedHome(home, realHome);
  const env = { PATH: process.env.PATH, HOME: home, ANYRAY_CLIENT_KEY: clientKey };
  const args = ['--gateway', gatewayUrl, '--tools', 'claude-code', '--subscription', '--yes', '--json'];
  if (!clientKey) return { configured: false, reason: 'no ANYRAY_CLIENT_KEY: connect would need an interactive SSO/enrollment step' };
  if (!existsSync(bin)) return { configured: false, reason: `anyray-connect not found at ${bin}` };
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 180000 });
  const events = String(r.stdout ?? '').split('\n').map(parseJsonLine).filter(Boolean);
  const applied = events.find((e) => e.event === 'applied');
  if (r.status !== 0 || !applied?.connected?.includes('claude-code')) {
    const error = events.find((e) => e.event === 'error');
    const why = error?.message ?? error?.reason ?? (r.error?.message || String(r.stderr ?? '').trim().split('\n').slice(-3).join(' '));
    return { configured: false, reason: scrub(`anyray-connect exited ${r.status ?? r.signal}: ${why || 'did not configure claude-code'}`) };
  }
  const settings = readJson(join(home, '.claude', 'settings.json')) ?? {};
  const mcpServers = readJson(join(home, '.claude.json'))?.mcpServers ?? {};
  const status = parseJsonLine(spawnSync(bin, ['status', '--json'], { env, encoding: 'utf8', timeout: 60000 }).stdout);
  return { configured: true, settings, mcpServers, setup: describeConnectConfig({ home, settings, mcpServers, status }) };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const parseJsonLine = (out) => {
  for (const l of String(out ?? '').trim().split('\n').reverse()) {
    try {
      return JSON.parse(l);
    } catch {}
  }
  return null;
};

const SECRET_NAME = /key|token|secret|password|auth|headers/i;
const REDACTED = '<redacted>';
/** Belt and braces: any Anyray credential that slipped into a recorded string. */
const scrub = (v) => (typeof v === 'string' ? v.replace(/\b(ark|aak|sk-ant)[-_][\w-]+/g, REDACTED) : v);
const redactMap = (m) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, SECRET_NAME.test(k) ? REDACTED : scrub(v)]));
const bare = (cmd) => String(cmd ?? '').replace(/^\S*\//, '');

/** What connect configured, for the report: names and shapes, never credentials. */
export function describeConnectConfig({ home, settings, mcpServers, status }) {
  let skills = [];
  try {
    skills = readdirSync(join(home, '.claude', 'skills')).sort();
  } catch {}
  return {
    env: redactMap(settings.env),
    headers: String(settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? '')
      .split('\n')
      .map((h) => h.split(':')[0].trim())
      .filter(Boolean),
    hooks: Object.fromEntries(
      Object.entries(settings.hooks ?? {}).map(([event, groups]) => [event, groups.flatMap((g) => (g.hooks ?? []).map((h) => bare(h.command)))])
    ),
    permissions: settings.permissions?.allow ?? [],
    hookPolicy: status?.hookPolicies ?? null,
    clientTools: status?.clientTools ?? null,
    skills,
    mcpServers: Object.fromEntries(
      Object.entries(mcpServers).map(([name, s]) => [
        name,
        { type: s.type, ...(s.command ? { command: [bare(s.command), ...(s.args ?? [])].join(' ') } : {}), ...(s.url ? { url: scrub(s.url) } : {}), ...(s.headers ? { headers: redactMap(s.headers) } : {}) },
      ])
    ),
    connectVersion: status?.connectVersion ?? null,
    keyKind: status?.keyKind ?? null,
  };
}

const list = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/**
 * What connect's hooks left in the arm HOME after the session: the fleet hook policy
 * they cached (SessionStart refresh writes it to connect.json; the PostToolUse hook
 * reads it), whether that refresh ran, and how many tool outputs the hook teed (one
 * file per digested/trimmed output). Evidence that the client side ran, even when
 * nothing in the transcript was big enough to trim.
 */
export function connectActivity(home) {
  const dir = join(home, '.anyray');
  return {
    fleetHookPolicy: readJson(join(dir, 'connect.json'))?.fleetHookPolicy ?? null,
    refreshed: existsSync(join(dir, 'refresh-state.json')),
    hookTeeFiles: list(join(dir, 'hook-tee')).length,
    anyrayFiles: list(dir),
  };
}

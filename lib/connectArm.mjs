// The Anyray arm, configured the way a real user gets it: by anyray-connect itself.
// connect runs non-interactively with HOME set to the arm's private temp home, so
// everything it writes (Claude Code settings + hooks, MCP servers, synced skills, its
// own profile) lands there and never in this machine's real ~/.anyray or ~/.claude.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep, basename, isAbsolute } from 'node:path';
import { checkConnectConfig, checkConnectBinary } from './connectChecks.mjs';

export const ANYRAY_BIN = (() => {
  const override = process.env.ANYRAY_CONNECT_BIN;
  if (override && !isAbsolute(override)) throw new Error('ANYRAY_CONNECT_BIN must be an absolute path');
  return override || join(homedir(), '.anyray', 'bin', 'anyray-connect');
})();

/** ANYRAY_CONNECT_BIN names the build: the arm must run exactly it (see checkArmBinary). */
export const CONNECT_BIN_PINNED = Boolean(process.env.ANYRAY_CONNECT_BIN);

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

/** connect's billing-lane flag: the seat's own token, or the org's provider account. */
const LANE_FLAG = { subscription: '--subscription', org: '--org' };

/**
 * Enroll + apply connect for Claude Code into `home` against `gatewayUrl`, using the
 * given client (service) key, on the given billing `lane`. Returns what connect wrote
 * and `checks`: whether that is a correctly connected client (lib/connectChecks.mjs).
 */
export function configureWithConnect({ home, gatewayUrl, clientKey, lane = 'subscription', bin = ANYRAY_BIN, realHome = homedir(), integrationLevel = null, binPinned = false }) {
  assertIsolatedHome(home, realHome);
  const env = { PATH: process.env.PATH, HOME: home, ANYRAY_CLIENT_KEY: clientKey };
  const args = ['--gateway', gatewayUrl, '--tools', 'claude-code', LANE_FLAG[lane] ?? LANE_FLAG.subscription, '--yes', '--json'];
  if (!clientKey) return { configured: false, reason: 'no ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY: connect would need an interactive SSO/enrollment step' };
  if (!existsSync(bin)) return { configured: false, reason: `anyray-connect not found (${basename(bin)})` };
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
  // The org lane's credential is the apiKeyHelper connect installed: run it as Claude Code would.
  const helperPrintsKey = settings.apiKeyHelper
    ? /^ark_/.test(String(spawnSync('sh', ['-c', settings.apiKeyHelper], { env, encoding: 'utf8', timeout: 30000 }).stdout ?? '').trim())
    : null;
  const appliedIntegrationLevel = status?.appliedIntegrationLevel ?? null;
  const checks = [
    ...checkConnectConfig({ settings, mcpServers, skills: list(join(home, '.claude', 'skills')), gatewayUrl, lane, helperPrintsKey, integrationLevel, appliedIntegrationLevel }),
    // A pinned build (ANYRAY_CONNECT_BIN, --connect-bin-b) must be what the hooks and MCP
    // server run; otherwise the check is reported only.
    ...checkConnectBinary({ settings, mcpServers, bin, home, required: binPinned }),
  ];
  return { configured: true, settings, mcpServers, checks, setup: { lane, connectBinary: basename(bin), appliedIntegrationLevel, ...describeConnectConfig({ home, settings, mcpServers, status }) } };
}

/**
 * checkConnectBinary on what the arm HOME holds NOW (connect's refresh re-applies its
 * config and may re-point the launcher mid-session): read before the HOME goes.
 */
export function checkArmBinary({ home, bin, required = true, prefix = '' }) {
  const settings = readJson(join(home, '.claude', 'settings.json')) ?? {};
  const mcpServers = readJson(join(home, '.claude.json'))?.mcpServers ?? {};
  return checkConnectBinary({ settings, mcpServers, bin, home, required, prefix });
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
    apiKeyHelper: Boolean(settings.apiKeyHelper),
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
    hookLogRead: logReadCounts(readJson(join(dir, 'hook-log-reads.json'))),
    hookDigestRouters: digestRouterCounts(readJson(join(dir, 'hook-digest-routers.json'))),
    hookTeeDigest: teeDigestCounts(readJson(join(dir, 'hook-tee-ledger.json'))),
  };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
/** connect's router names (test-run, grep, log-dedup, gh-run-log): a label, never text. */
const ROUTER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The digest cost gate's evidence as the session left it (hooks.digestEconomics): per
 * router and rendering version, digests emitted and read back. Counts only, never the
 * labels (hashed session and tee ids). A row that is not a router name and three counts
 * is skipped, so a file another build wrote can neither fail the round nor leak text.
 */
function digestRouterCounts(state) {
  if (!Array.isArray(state?.routers)) return null;
  return state.routers.flatMap((row) => {
    const { router, version, emits, rereads } = row ?? {};
    return typeof router === 'string' && ROUTER_NAME.test(router) && [version, emits, rereads].every(isCount) ? [{ router, version, emits, rereads }] : [];
  });
}

/** The tee ledger's pooled digest counts (the gate's prior). Counts only: anything else reads null. */
function teeDigestCounts(ledger) {
  if (!ledger || typeof ledger !== 'object') return null;
  const count = (n) => (isCount(n) ? n : null);
  return { digestEmits: count(ledger.digestEmits), digestRereads: count(ledger.digestRereads), teeRereads: count(ledger.teeRereads) };
}

/**
 * The test-log Read lane's counts (hooks.logRead): logs recorded, digests
 * emitted, read-backs, declines by reason, and how many records were live.
 * Counts only: a record's key hashes the session and the log's path. Read
 * before the arm HOME goes, so a Read the lane left whole can be explained.
 */
function logReadCounts(store) {
  const counts = store?.counts;
  if (!counts || typeof counts !== 'object') return null;
  const { recorded, emits, rangedRereads, fullRereads, declined } = counts;
  return { recorded, emits, rangedRereads, fullRereads, declined, records: Array.isArray(store.records) ? store.records.length : 0 };
}

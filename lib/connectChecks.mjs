// Is the Anyray arm set up the way anyray-connect sets up a real user? Two looks:
//   checkConnectConfig   what connect wrote to the arm HOME, before the session starts
//                        (env, headers, hooks, MCP servers, permissions, skills);
//   checkConnectSession  what Claude Code actually loaded, from the session's init event
//                        and the hook activity left in the arm HOME.
//   checkConnectBinary   which anyray-connect build the hooks, MCP server and key helper
//                        connect wrote actually run (symlinks followed), against the one
//                        the run asked for.
// Each check is { name, ok, required, detail }. A failed required check stops the arm:
// a round on a half-configured client measures something no customer runs. Details name
// shapes only, never a credential.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path';

const trimUrl = (u) => String(u ?? '').replace(/\/$/, '');
const bare = (cmd) => String(cmd ?? '').replace(/^\S*\//, '');
const check = (name, ok, detail, required = true) => ({ name, ok: Boolean(ok), required, detail });

/** Switches that send Claude Code straight to a cloud provider, past the gateway. */
const DIRECT_CLOUD = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** `ANTHROPIC_CUSTOM_HEADERS` (newline-separated "name: value") as a lowercased-name map. */
export function customHeaders(env = {}) {
  const out = {};
  for (const line of String(env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

const hookCommands = (settings, event) => (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => bare(h.command)));

/**
 * What connect wrote. `lane` is the billing lane connect was asked for:
 *   subscription  the seat's OAuth token passes through to Anthropic (provider pinned);
 *   org           the gateway key authenticates and the gateway's own routing picks the
 *                 provider (e.g. Bedrock), so nothing may pin one. connect supplies the
 *                 key through an apiKeyHelper (ANTHROPIC_AUTH_TOKEN is left empty);
 *                 `helperPrintsKey` is whether running that helper printed a gateway key.
 */
export function checkConnectConfig({ settings = {}, mcpServers = {}, skills = [], gatewayUrl, lane, helperPrintsKey = null, integrationLevel = null, appliedIntegrationLevel = null }) {
  const env = settings.env ?? {};
  const headers = customHeaders(env);
  const gw = trimUrl(gatewayUrl);
  const checks = [
    check('env.ANTHROPIC_BASE_URL is the gateway', trimUrl(env.ANTHROPIC_BASE_URL) === gw, env.ANTHROPIC_BASE_URL ?? 'unset'),
    check('env: no direct-cloud switch', !DIRECT_CLOUD.some((k) => env[k]), DIRECT_CLOUD.filter((k) => env[k]).join(', ') || 'none set'),
    check('header x-anyray-metadata is JSON', (() => {
      try {
        return typeof JSON.parse(headers['x-anyray-metadata']) === 'object';
      } catch {
        return false;
      }
    })(), headers['x-anyray-metadata'] ? 'present' : 'missing'),
  ];
  if (integrationLevel) checks.push(check('applied integration level matches requested level', appliedIntegrationLevel === integrationLevel, appliedIntegrationLevel ?? 'not reported'));
  if (lane === 'org') {
    checks.push(
      check(
        'auth: the gateway key reaches Claude Code (apiKeyHelper or ANTHROPIC_AUTH_TOKEN)',
        /^ark_/.test(env.ANTHROPIC_AUTH_TOKEN ?? '') || (Boolean(settings.apiKeyHelper) && helperPrintsKey === true),
        settings.apiKeyHelper ? `apiKeyHelper ${helperPrintsKey === true ? 'prints a gateway key' : helperPrintsKey === false ? 'did not print a gateway key' : 'not run'}` : env.ANTHROPIC_AUTH_TOKEN ? 'token set, not a gateway key' : 'no apiKeyHelper, no token'
      ),
      check('header: no x-anyray-provider pin', !headers['x-anyray-provider'], headers['x-anyray-provider'] ?? 'none (gateway routing decides)'),
      check('header: no passthrough auth mode', headers['x-anyray-auth-mode'] !== 'passthrough', headers['x-anyray-auth-mode'] ?? 'none')
    );
  } else {
    checks.push(
      check('env.ANTHROPIC_AUTH_TOKEN unset (seat token rides through)', !env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset'),
      check('header x-anyray-auth-mode: passthrough', headers['x-anyray-auth-mode'] === 'passthrough', headers['x-anyray-auth-mode'] ?? 'missing'),
      check('header x-anyray-provider: anthropic', headers['x-anyray-provider'] === 'anthropic', headers['x-anyray-provider'] ?? 'missing'),
      check('header x-anyray-api-key present', Boolean(headers['x-anyray-api-key']), headers['x-anyray-api-key'] ? 'present' : 'missing')
    );
  }
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    const cmds = hookCommands(settings, event);
    const present = cmds.some((c) => /^anyray-connect __anyray-hook\b/.test(c));
    checks.push(check(`hook ${event}: anyray-connect __anyray-hook${integrationLevel === 'gateway' ? ' absent' : ''}`, integrationLevel === 'gateway' ? !present : present, cmds.join(' | ') || 'none'));
  }
  if (integrationLevel === 'gateway') {
    // connect keeps its content-free session-lifecycle pair at every level (claudeCode.ts,
    // "Keep only the content-free lifecycle pair even at gateway level"); anything else is a leak.
    const ownHooks = Object.keys(settings.hooks ?? {}).flatMap((event) => hookCommands(settings, event))
      .filter((cmd) => /^anyray-connect\b/.test(cmd) && !/^anyray-connect __anyray-hook-lifecycle\b/.test(cmd));
    checks.push(check('hooks: no anyray-connect commands but the lifecycle pair', ownHooks.length === 0, ownHooks.join(' | ') || 'none'));
  }
  const mcp = mcpServers.anyray;
  const withMcp = !integrationLevel || integrationLevel === 'gateway_hooks_mcp';
  checks.push(
    check(`mcp anyray: ${withMcp ? 'stdio anyray-connect __anyray-mcp-server' : 'absent'}`, withMcp ? mcp?.type === 'stdio' && bare(mcp.command) === 'anyray-connect' && mcp.args?.[0] === '__anyray-mcp-server' : !mcp, mcp ? `${mcp.type} ${bare(mcp.command)} ${(mcp.args ?? []).join(' ')}` : 'missing'),
    check('mcp anyray-connectors: http at the gateway', mcpServers['anyray-connectors']?.type === 'http' && trimUrl(mcpServers['anyray-connectors'].url).startsWith(`${gw}/`), mcpServers['anyray-connectors'] ? mcpServers['anyray-connectors'].type : 'missing', false),
    check(`permission mcp__anyray__anyray_retrieve ${withMcp ? 'allowed' : 'absent'}`, withMcp ? (settings.permissions?.allow ?? []).includes('mcp__anyray__anyray_retrieve') : !(settings.permissions?.allow ?? []).some((p) => p.startsWith('mcp__anyray__')), (settings.permissions?.allow ?? []).join(', ') || 'none'),
    check(`skill anyray ${withMcp ? 'installed' : 'absent'}`, withMcp ? skills.includes('anyray') : !skills.includes('anyray'), skills.join(', ') || 'none'),
    check('env.ENABLE_TOOL_SEARCH set', Boolean(env.ENABLE_TOOL_SEARCH), env.ENABLE_TOOL_SEARCH ?? 'unset', false),
    check('env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = 1', env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === '1', env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL ?? 'unset', false)
  );
  return checks;
}

/**
 * What the session loaded. `init` is the parsed stream-json init event (tools,
 * mcpServers, skills); `activity` is connectActivity() of the arm HOME after the run.
 */
export function checkConnectSession({ init, activity, level = null, appliedIntegrationLevel = null, refreshDisabled = false, expectRefreshDisabled = false }) {
  const server = (init?.mcpServers ?? []).find((s) => s.name === 'anyray');
  const tools = init?.tools ?? [];
  const skills = init?.skills ?? null;
  const withMcp = !level || level === 'gateway_hooks_mcp';
  return [
    ...(level ? [check('session: applied integration level matches requested level', appliedIntegrationLevel === level, appliedIntegrationLevel ?? 'not reported')] : []),
    check(`session: mcp anyray ${withMcp ? 'connected' : 'absent'}`, withMcp ? server?.status === 'connected' : !server, server?.status ?? 'not listed'),
    check(`session: tool mcp__anyray__${withMcp ? 'anyray_retrieve available' : ' tools absent'}`, withMcp ? tools.includes('mcp__anyray__anyray_retrieve') : !tools.some((t) => t.startsWith('mcp__anyray__')), `${tools.filter((t) => t.startsWith('mcp__anyray__')).length} anyray tool(s)`),
    ...(level ? [check('session: Connect refresh setting matches harness options', refreshDisabled === expectRefreshDisabled, refreshDisabled ? 'disabled' : 'enabled')] : []),
    check(`session: skill anyray ${withMcp ? 'loaded' : 'absent'}`, skills ? (withMcp ? skills.includes('anyray') : !skills.includes('anyray')) : false, skills ? skills.join(', ') || 'none' : 'not reported by this Claude Code', false),
    check('session: connect profile present after the run', Boolean(activity?.anyrayFiles?.includes('connect.json')), (activity?.anyrayFiles ?? []).join(', ') || 'none', false),
  ];
}

export const failedChecks = (checks) => checks.filter((c) => c.required && !c.ok);

/** Throws naming every failed required check. */
export function assertChecks(checks, what) {
  const bad = failedChecks(checks);
  if (bad.length) throw new Error(`${what}: ${bad.map((c) => `${c.name} (${c.detail})`).join('; ')}`);
}

/** One line per check, for the run log. */
export const formatChecks = (checks) =>
  checks.map((c) => `    ${c.ok ? '✓' : c.required ? '✗' : '!'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`).join('\n');

// ---- which anyray-connect build the arm runs ----

const CONNECT_EXE = /^anyray-connect(\.exe)?$/;
const shaCache = new Map();

/** A file's full sha256 (hex), symlinks followed; null when it does not exist. Cached by real path, size and mtime. */
export function fileSha256(file) {
  if (!file) return null;
  try {
    const real = realpathSync(file);
    const st = statSync(real);
    const key = `${real}\0${st.size}\0${st.mtimeMs}`;
    if (!shaCache.has(key)) shaCache.set(key, createHash('sha256').update(readFileSync(real)).digest('hex'));
    return shaCache.get(key);
  } catch {
    return null;
  }
}

/** The executable a shell command line runs: its first word (unquoted), after any VAR=value prefixes. */
export function commandExecutable(line) {
  let rest = String(line ?? '').trim();
  for (;;) {
    const m = /^(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(rest);
    if (!m) return null;
    const word = m[1] ?? m[2] ?? m[3];
    if (m[3] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      rest = rest.slice(m[0].length);
      continue;
    }
    return word;
  }
}

/** Where `word` runs from for a session under `home` with this PATH: a path, or null when nothing resolves. */
function resolveExecutable(word, { home, path }) {
  const w = String(word ?? '').replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home);
  if (!w) return null;
  if (w.includes('/')) return isAbsolute(w) ? w : null; // relative to the session's cwd: not knowable here
  for (const dir of String(path ?? '').split(delimiter).filter(Boolean)) {
    try {
      if (statSync(join(dir, w)).isFile()) return join(dir, w);
    } catch {}
  }
  return null;
}

/** A resolved file named for a check detail without its absolute path: under the arm HOME, an app bundle, or neither. */
function place(real, home) {
  const h = (() => {
    try {
      return realpathSync(home);
    } catch {
      return home;
    }
  })();
  if (real.startsWith(h + sep)) return `$HOME/${relative(h, real)}`;
  const app = /\/([^/]+\.app)\//.exec(real)?.[1];
  return app ? `inside ${app}` : `${basename(real)} outside the arm HOME`;
}

/**
 * Does every command connect wrote for Claude Code (hooks, the stdio MCP server, the
 * apiKeyHelper) run `bin`, the build the run asked for? Each command's executable is
 * resolved as the session would (PATH for a bare name, the arm HOME for `~`), symlinks
 * followed, and compared by real path, else by content (a launcher may hold a copy).
 * A launcher under <HOME>/.anyray/bin that links to an installed Connect app's binary
 * fails here even though its name is right, which is all checkConnectConfig compares.
 * `required`: whether a mismatch stops the arm (a pinned build) or is only reported.
 */
export function checkConnectBinary({ settings = {}, mcpServers = {}, bin, home, path = process.env.PATH, required = true, prefix = '' }) {
  const realOf = (p) => {
    try {
      return p ? realpathSync(p) : null;
    } catch {
      return null;
    }
  };
  const wantReal = realOf(bin);
  const short = (sha) => (sha ? sha.slice(0, 16) : 'none');
  /** One executable's verdict: why it is not the requested build, or null when it is. */
  const mismatch = (exe) => {
    const real = realOf(resolveExecutable(exe, { home, path }));
    if (!real) return 'resolves to no file';
    if (!wantReal) return 'the requested build does not exist';
    if (real === wantReal) return null;
    const [got, wanted] = [fileSha256(real), fileSha256(wantReal)];
    return got && got === wanted ? null : `runs sha256 ${short(got)} (${place(real, home)}), not the requested ${short(wanted)}`;
  };
  const groups = [
    ['hooks run', Object.entries(settings.hooks ?? {}).flatMap(([event, gs]) => (gs ?? []).flatMap((g) => (g.hooks ?? []).map((h) => ({ label: event, exe: commandExecutable(h.command) }))))],
    // A stdio MCP server's command is the executable itself, never a shell line.
    ['MCP servers run', Object.entries(mcpServers).filter(([, s]) => s?.command).map(([name, s]) => ({ label: `mcp ${name}`, exe: s.command }))],
    ['apiKeyHelper runs', settings.apiKeyHelper ? [{ label: 'apiKeyHelper', exe: commandExecutable(settings.apiKeyHelper) }] : []],
  ];
  const checks = [];
  for (const [verb, all] of groups) {
    const items = all.filter((i) => CONNECT_EXE.test(basename(String(i.exe ?? ''))));
    if (!items.length) continue; // connect wrote no such command (e.g. no MCP server at a lower level)
    const verdicts = new Map(items.map((i) => i.exe).map((exe) => [exe, mismatch(exe)]));
    const byWhy = new Map(); // one line per verdict, naming the commands it covers
    for (const i of items) if (verdicts.get(i.exe)) byWhy.set(verdicts.get(i.exe), [...new Set([...(byWhy.get(verdicts.get(i.exe)) ?? []), i.label])]);
    const bad = [...byWhy].map(([why, labels]) => `${labels.join(', ')}: ${why}`);
    const detail = bad.length ? bad.join('; ') : `${items.length} command(s), sha256 ${short(fileSha256(wantReal))}`;
    checks.push(check(`${prefix}${verb} the requested anyray-connect build`, bad.length === 0, detail, required));
  }
  return checks;
}

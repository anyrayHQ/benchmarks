// Is the Anyray arm set up the way anyray-connect sets up a real user? Two looks:
//   checkConnectConfig   what connect wrote to the arm HOME, before the session starts
//                        (env, headers, hooks, MCP servers, permissions, skills);
//   checkConnectSession  what Claude Code actually loaded, from the session's init event
//                        and the hook activity left in the arm HOME.
// Each check is { name, ok, required, detail }. A failed required check stops the arm:
// a round on a half-configured client measures something no customer runs. Details name
// shapes only, never a credential.

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
export function checkConnectConfig({ settings = {}, mcpServers = {}, skills = [], gatewayUrl, lane, helperPrintsKey = null }) {
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
    checks.push(check(`hook ${event}: anyray-connect __anyray-hook`, cmds.some((c) => /^anyray-connect __anyray-hook\b/.test(c)), cmds.join(' | ') || 'none'));
  }
  const mcp = mcpServers.anyray;
  checks.push(
    check('mcp anyray: stdio anyray-connect __anyray-mcp-server', mcp?.type === 'stdio' && bare(mcp.command) === 'anyray-connect' && mcp.args?.[0] === '__anyray-mcp-server', mcp ? `${mcp.type} ${bare(mcp.command)} ${(mcp.args ?? []).join(' ')}` : 'missing'),
    check('mcp anyray-connectors: http at the gateway', mcpServers['anyray-connectors']?.type === 'http' && trimUrl(mcpServers['anyray-connectors'].url).startsWith(`${gw}/`), mcpServers['anyray-connectors'] ? mcpServers['anyray-connectors'].type : 'missing', false),
    check('permission mcp__anyray__anyray_retrieve allowed', (settings.permissions?.allow ?? []).includes('mcp__anyray__anyray_retrieve'), (settings.permissions?.allow ?? []).join(', ') || 'none'),
    check('skill anyray installed', skills.includes('anyray'), skills.join(', ') || 'none'),
    check('env.ENABLE_TOOL_SEARCH set', Boolean(env.ENABLE_TOOL_SEARCH), env.ENABLE_TOOL_SEARCH ?? 'unset', false),
    check('env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = 1', env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === '1', env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL ?? 'unset', false)
  );
  return checks;
}

/**
 * What the session loaded. `init` is the parsed stream-json init event (tools,
 * mcpServers, skills); `activity` is connectActivity() of the arm HOME after the run.
 */
export function checkConnectSession({ init, activity }) {
  const server = (init?.mcpServers ?? []).find((s) => s.name === 'anyray');
  const tools = init?.tools ?? [];
  const skills = init?.skills ?? null;
  return [
    check('session: mcp anyray connected', server?.status === 'connected', server?.status ?? 'not listed'),
    check('session: tool mcp__anyray__anyray_retrieve available', tools.includes('mcp__anyray__anyray_retrieve'), `${tools.filter((t) => t.startsWith('mcp__anyray__')).length} anyray tool(s)`),
    check('session: skill anyray loaded', skills ? skills.includes('anyray') : false, skills ? skills.join(', ') || 'none' : 'not reported by this Claude Code', false),
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

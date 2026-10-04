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

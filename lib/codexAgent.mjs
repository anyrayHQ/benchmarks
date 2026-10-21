// The Codex CLI arm: one `codex exec` session per arm, on the ChatGPT seat, for the
// Codex seat lane's paired Rule 0 bench. The lane relays byte-identical, so what B can
// differ by is connect's client-side hook (`--codex-hooks-b`).
//
// Two routes, the same Codex otherwise:
//   direct  Codex's built-in OpenAI provider: its own WebSocket straight to chatgpt.com.
//   anyray  the seat route anyray-connect writes (`[model_providers.anyray]`, connect's
//           src/tools/codex.ts codexBlockLines): pass-through auth re-targeted at the
//           ChatGPT Codex backend through the gateway, WebSocket mode when the gateway
//           serves it, and connect's MCP server with its tools pre-approved.
//
// Credentials. The seat's ChatGPT login stays in the REAL ~/.codex: it is never copied
// (its refresh token rotates, so two homes holding one token diverge on the first
// refresh). Every run therefore uses the real CODEX_HOME with `--ignore-user-config`
// and `-c` overrides, and deletes its threads afterwards (`codex delete --force`). The
// client key never reaches argv: the provider names an env var for it
// (`env_http_headers`), set on the codex process only.
//
// Isolation. `--ignore-user-config` drops this machine's own MCP servers, hooks trust
// and model defaults, and `--disable hooks` keeps connect's Codex PreToolUse source trim
// (routed by this machine's real ~/.anyray, i.e. not the bench gateway) out of both arms,
// except arm B under --codex-hooks-b, which runs the arm home's own hook (see codexHook
// below). The anyray arm's MCP server runs with HOME set to the arm's private home, where
// anyray-connect was applied against the bench gateway, so retrieval resolves there and
// its approval lease is the bench key's.
//
// Cost is Codex's own per-response usage (`token_usage_record` in the thread's rollout),
// priced from config.yaml: uncached input, cache reads and cache writes (GPT-5.6+
// report and bill writes at 1.25x) and output. Both arms are priced the same way. The
// seat bills in usage limits, not dollars; the dollar figure is list-price equivalent,
// as the gateway's spend rows price a seat.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf } from './cost.mjs';
import { assertIsolatedHome } from './connectArm.mjs';
import { commandExecutable } from './connectChecks.mjs';

/** Mirrors connect's CHATGPT_CODEX_BACKEND / SUBSCRIPTION_FORWARD_HEADERS (src/tools/codex.ts). */
export const CODEX_SEAT_BACKEND = 'https://chatgpt.com/backend-api/codex';
export const CODEX_FORWARD_HEADERS = 'chatgpt-account-id,originator,session_id,user-agent,x-codex-turn-metadata,x-codex-window-id,x-client-request-id';

/** The provider id the anyray arm's threads are created under: never connect's own `anyray`. */
export const BENCH_PROVIDER_ID = 'anyraybench';
/** The env var the anyray arm's codex process carries the client key in. */
export const KEY_ENV = 'ANYRAY_BENCH_CODEX_KEY';
/** The MCP server's name in the arm's config, as connect writes it. */
const MCP_SERVER = 'anyray';

/** A TOML basic string. JSON's escapes are all valid TOML escapes. */
export const tomlString = (s) => JSON.stringify(String(s));

/** A TOML inline table of string values, keys quoted. */
export const tomlInlineTable = (obj) =>
  `{ ${Object.entries(obj).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`;

const c = (key, value) => ['-c', `${key}=${value}`];

/** "name: value" header lines (ANYRAY_BENCH_EXTRA/SHARED_HEADERS) → { name: value }. */
export const headerObject = (lines = []) =>
  Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));

/**
 * The gateway headers the anyray arm's provider sends: connect's seat set, the run tag in
 * place of connect's attribution metadata, then shared and extra headers (both already
 * refused for any header the harness owns). No client key here.
 *
 * No `x-anyray-optimization-kinds`, unlike the Claude Code arm. The gateway accepts it
 * only on an inference POST and answers anything else carrying it with 400; Codex's
 * WebSocket upgrade is a GET, so the socket would never open and the turn would fail.
 * The seat lane needs no selection anyway: the optimizer runs only `relevance_filter`
 * and `content_census` there. `--kinds` names what the trace tally reads.
 */
export function anyrayHeaders({ runTag, sharedHeaders = [], extraHeaders = [] }) {
  return {
    ...headerObject(sharedHeaders),
    ...headerObject(extraHeaders),
    // Last, so neither list can re-target the route.
    'x-anyray-auth-mode': 'passthrough',
    'x-anyray-custom-host': CODEX_SEAT_BACKEND,
    'x-anyray-forward-headers': CODEX_FORWARD_HEADERS,
    'x-anyray-metadata': JSON.stringify(runTag),
    'x-anyray-provider': 'openai',
  };
}

/**
 * argv for one `codex exec` (or `codex exec resume <thread>`) on either arm. Pure.
 * `armHome` describes what anyray-connect wrote into the arm's private home
 * (readArmHome); required on the anyray arm.
 */
export function codexArgv({ arm, prompt, model, effort = null, resumeThreadId = null, gatewayUrl = null, headers = {}, armHome = null, configOverrides = [], hook = null }) {
  if (arm !== 'direct' && arm !== 'anyray') throw new Error(`codex arm must be direct or anyray, got ${arm}`);
  if (hook && arm !== 'anyray') throw new Error("only an anyray codex arm carries connect's hook: the direct arm has no connect");
  const argv = ['exec', ...(resumeThreadId ? ['resume'] : []),
    '--json', '--ignore-user-config', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    // Hooks stay off unless this arm carries connect's (--codex-hooks-b): then exactly that one runs.
    ...(hook ? ['--enable', 'hooks'] : ['--disable', 'hooks']),
    ...(model ? ['-m', model] : []),
    ...(effort ? c('model_reasoning_effort', tomlString(effort)) : []),
  ];
  if (arm === 'direct') {
    argv.push(...c('model_provider', tomlString('openai')));
  } else {
    if (!gatewayUrl) throw new Error('the anyray codex arm needs a gateway URL');
    if (!armHome?.configured) throw new Error('the anyray codex arm needs a home anyray-connect configured');
    const p = `model_providers.${BENCH_PROVIDER_ID}`;
    argv.push(
      ...c('model_provider', tomlString(BENCH_PROVIDER_ID)),
      ...c(`${p}.name`, tomlString(armHome.providerName)),
      ...c(`${p}.base_url`, tomlString(`${gatewayUrl.replace(/\/$/, '')}/v1`)),
      ...c(`${p}.wire_api`, tomlString('responses')),
      ...c(`${p}.requires_openai_auth`, 'true'),
      ...(armHome.websockets ? c(`${p}.supports_websockets`, 'true') : []),
      ...c(`${p}.http_headers`, tomlInlineTable(headers)),
      ...c(`${p}.env_http_headers`, tomlInlineTable({ 'x-anyray-api-key': KEY_ENV })),
      // The server exactly as connect registered it in the arm's home.
      ...c(`mcp_servers.${MCP_SERVER}.command`, tomlString(armHome.mcpCommand)),
      ...c(`mcp_servers.${MCP_SERVER}.args`, `[${armHome.mcpArgs.map(tomlString).join(', ')}]`),
      // Codex hands a stdio server only a fixed env allowlist; an explicit env table does reach it.
      ...c(`mcp_servers.${MCP_SERVER}.env`, tomlInlineTable({ HOME: armHome.home })),
      ...armHome.approvedTools.flatMap((tool) => c(`mcp_servers.${MCP_SERVER}.tools.${tool}.approval_mode`, tomlString('approve'))),
    );
  }
  if (hook) argv.push(...codexHookOverrides(hook));
  // This arm's own Codex settings (--codex-config-b), e.g. the auto-compact threshold
  // connect writes: the one thing that differs between the arms.
  for (const [key, value] of configOverrides) argv.push(...c(key, value));
  if (resumeThreadId) argv.push(resumeThreadId);
  argv.push(prompt);
  return argv;
}

/** One `[table]`'s text in a config.toml (to the next header), or null. */
const tableBlock = (toml, header) => {
  const at = toml.split('\n').findIndex((line) => line.trim() === `[${header}]`);
  if (at < 0) return null;
  const rest = toml.split('\n').slice(at);
  const end = rest.findIndex((line, i) => i > 0 && /^\[/.test(line));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
};
const providerBlock = (toml) => tableBlock(toml, 'model_providers.anyray');

/** A TOML array of basic strings (`["a", "b"]`) as JSON reads it, or null. */
const stringArray = (raw) => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
};

/**
 * What anyray-connect wrote into a private home's ~/.codex/config.toml, as the arm needs
 * it: the seat provider's name and WebSocket flag (connect decides both from the
 * gateway's /connect/policy capabilities) and the MCP tools it pre-approved. Pure.
 */
export function readArmHomeConfig(toml, home) {
  const block = providerBlock(String(toml ?? ''));
  const reasons = [];
  if (!block) reasons.push('no [model_providers.anyray] table');
  else {
    if (!/^requires_openai_auth = true$/m.test(block)) reasons.push('the provider is not the seat lane (no requires_openai_auth)');
    if (!/"x-anyray-auth-mode" = "passthrough"/.test(block)) reasons.push('the provider does not pass the seat login through');
  }
  const approvedTools = [...String(toml ?? '').matchAll(/^\[mcp_servers\.anyray\.tools\.([A-Za-z0-9_]+)\]\s*\n\s*approval_mode = "approve"/gm)].map((m) => m[1]);
  if (!approvedTools.includes('anyray_retrieve')) reasons.push('anyray_retrieve is not pre-approved');
  const server = tableBlock(String(toml ?? ''), 'mcp_servers.anyray');
  const mcpCommand = /^command = "([^"]+)"$/m.exec(server ?? '')?.[1] ?? null;
  const mcpArgs = stringArray(/^args = (\[.*\])$/m.exec(server ?? '')?.[1] ?? '');
  if (!mcpCommand || !mcpArgs) reasons.push('no [mcp_servers.anyray] command and args');
  const name = /^name = "([^"]*)"$/m.exec(block ?? '')?.[1] ?? null;
  return {
    configured: reasons.length === 0,
    reasons,
    home,
    providerName: name,
    websockets: /^supports_websockets = true$/m.test(block ?? ''),
    approvedTools,
    mcpCommand,
    mcpArgs,
  };
}

/**
 * anyray-connect, applied for Codex on the seat lane into `home` against the bench gateway,
 * then read back. connect gets HOME = the private home, so nothing touches the real
 * ~/.codex or ~/.anyray.
 */
export function configureCodexArmHome({ home, gatewayUrl, clientKey, bin, realHome = homedir(), spawnImpl = spawnSync }) {
  assertIsolatedHome(home, realHome);
  if (!clientKey) return { configured: false, reasons: ['no ANYRAY_BENCH_CLIENT_KEY or ANYRAY_CLIENT_KEY'] };
  if (!existsSync(bin)) return { configured: false, reasons: [`anyray-connect not found (${basename(bin)})`] };
  const env = { PATH: process.env.PATH, HOME: home, ANYRAY_CLIENT_KEY: clientKey };
  // connect configures Codex only where it finds Codex installed, which it reads as
  // ~/.codex existing (detect() in its src/tools/codex.ts). An empty dir: no login in it.
  mkdirSync(join(home, '.codex'), { recursive: true });
  const r = spawnImpl(bin, ['--gateway', gatewayUrl, '--tools', 'codex', '--subscription', '--yes', '--json'], { env, encoding: 'utf8', timeout: 180000 });
  const config = join(home, '.codex', 'config.toml');
  if (r.status !== 0 || !existsSync(config)) {
    const tail = String(r.stderr ?? '').trim().split('\n').slice(-2).join(' ').replace(/(ark|adt|enl)_[A-Za-z0-9_-]+/g, '$1_<redacted>');
    return { configured: false, reasons: [`anyray-connect exited ${r.status ?? r.signal}${tail ? `: ${tail}` : ''}`] };
  }
  const hooks = join(home, '.codex', 'hooks.json');
  return { ...readArmHomeConfig(readFileSync(config, 'utf8'), home), codexHook: existsSync(hooks) ? readArmHomeHook(readFileSync(hooks, 'utf8')) : null };
}

// ── --codex-hooks-b: connect's Codex PreToolUse source trim on arm B ──────────────────
//
// Arm B runs exactly one hook, declared as session config (`-c hooks.PreToolUse=…`) and
// trusted by its own `hooks.state` entry: the trust hash Codex computes for it. Never
// --dangerously-bypass-hook-trust, which trusts every hook Codex discovers. The others
// stay off: the real ~/.codex/hooks.json still loads under --ignore-user-config (Codex
// keeps the user layer, empty), but its trust went with the ignored config.toml, and
// each of its handlers is switched off by key as well (hooksJsonKeys).
//
// The declared command is a bench shim (codexHookShim.mjs), not connect itself. connect's
// hook answers with a rewrite to `<connect> __anyray-shell-run …`, which Codex runs as the
// command, in Codex's environment: under the real HOME, the trim would read and tee into
// the real ~/.anyray. The shim runs connect's hook under the arm HOME, then puts the arm
// HOME in front of that shell-run and nothing else. The wrapped command inherits it, so
// the toolchain caches it would find under the real HOME go with it (wrappedCommandEnv).

/** Where Codex files hook state, `<source>:<event>:<group>:<handler>` (hooks/src/lib.rs hook_key). */
const EVENT_KEYS = {
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use', PreCompact: 'pre_compact',
  PostCompact: 'post_compact', SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'stop', Interrupt: 'interrupt',
};
const hookKey = (source, event, group, handler) => `${source}:${EVENT_KEYS[event]}:${group}:${handler}`;
/** The source Codex names a `-c hooks.…` hook by (discovery.rs config_toml_source_path, SessionFlags). */
export const SESSION_HOOK_SOURCE = '/<session-flags>/config.toml';
/** Codex's default timeout for a PreToolUse command hook (discovery.rs normalize_command_hook). */
const DEFAULT_HOOK_TIMEOUT_SEC = 600;
const CONNECT_CODEX_HOOK = ' __anyray-codex-hook';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

/**
 * The hash Codex pins a PreToolUse command hook's trust to: sha256 over the sorted-key JSON
 * of its normalized identity (hooks/src/engine/discovery.rs hook_hash; config fingerprint.rs
 * version_for_toml). A stored hash that differs reads as "modified" and the hook does not
 * run. Checked against `codex app-server` hooks/list (the tests carry its goldens). Pure.
 */
export function codexHookTrustHash({ matcher, command, timeoutSec }) {
  const identity = { event_name: 'pre_tool_use', matcher, hooks: [{ type: 'command', command, timeout: timeoutSec, async: false }] };
  return `sha256:${createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex')}`;
}

const parseJson = (text) => {
  try {
    return JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
};

/** Every handler's state key in a hooks.json at `path` (all events), so each can be switched off. Pure. */
export function hooksJsonKeys(text, path) {
  const events = parseJson(text)?.hooks;
  if (!events || typeof events !== 'object') return [];
  return Object.entries(events).filter(([event, groups]) => EVENT_KEYS[event] && Array.isArray(groups))
    .flatMap(([event, groups]) => groups.flatMap((g, i) => (Array.isArray(g?.hooks) ? g.hooks : []).map((_, j) => hookKey(path, event, i, j))));
}

/** connect's Codex PreToolUse hook (matcher Bash) as it wrote it into a hooks.json, or null. Pure. */
export function readArmHomeHook(text) {
  const groups = parseJson(text)?.hooks?.PreToolUse;
  for (const g of Array.isArray(groups) ? groups : []) {
    if (g?.matcher !== 'Bash' || !Array.isArray(g.hooks)) continue;
    const h = g.hooks.find((x) => x?.type === 'command' && typeof x.command === 'string' && x.command.endsWith(CONNECT_CODEX_HOOK));
    if (h) return { command: h.command, timeoutSec: Number.isSafeInteger(h.timeout) && h.timeout > 0 ? h.timeout : null };
  }
  return null;
}

/** The real ~/.codex/hooks.json's handler keys, by the canonical path Codex files them under. */
export function realCodexHookKeys(codexHome = join(homedir(), '.codex')) {
  const file = join(codexHome, 'hooks.json');
  if (!existsSync(file)) return [];
  return hooksJsonKeys(readFileSync(file, 'utf8'), realpathSync(file));
}

/** `-c` flags declaring the arm's one hook and its trust, and switching the given keys off. */
function codexHookOverrides({ command, timeoutSec, disableKeys = [] }) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('a codex hook needs a command');
  if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1) throw new Error(`a codex hook timeout is whole seconds, got ${timeoutSec}`);
  const trusted = codexHookTrustHash({ matcher: 'Bash', command, timeoutSec });
  // One table with every key quoted: Codex splits a -c key on each dot, and these keys are paths.
  const state = [[hookKey(SESSION_HOOK_SOURCE, 'PreToolUse', 0, 0), `{ trusted_hash = ${tomlString(trusted)} }`], ...disableKeys.map((k) => [k, '{ enabled = false }'])];
  return [
    ...c('hooks.PreToolUse', `[{ matcher = "Bash", hooks = [{ type = "command", command = ${tomlString(command)}, timeout = ${timeoutSec} }] }]`),
    ...c('hooks.state', `{ ${state.map(([k, v]) => `${tomlString(k)} = ${v}`).join(', ')} }`),
  ];
}

const SHIM_PATH = fileURLToPath(new URL('./codexHookShim.mjs', import.meta.url));
/** The bench's own files in an arm home, apart from connect's ~/.anyray. */
const BENCH_DIR = '.anyray-bench';
const SHIM_LOG = 'codex-hook-shim.log';
/** A POSIX shell single-quoted word. */
export const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * The env in front of connect's shell-run: the arm HOME (so the trim reads and tees there),
 * key refresh off (as the Claude Code arm's hooks run), and `wrappedEnv`, what the wrapped
 * command must keep from the real HOME (wrappedCommandEnv). Pure.
 */
export const shellRunEnvFor = (home, wrappedEnv = {}) => ({
  HOME: home,
  ANYRAY_REFRESH_DISABLE: 'true',
  ...Object.fromEntries(Object.entries(wrappedEnv).filter(([k]) => k !== 'HOME' && k !== 'ANYRAY_REFRESH_DISABLE')),
});

/**
 * Arm B's hook: the shim's config, written into the arm home, and the command that runs it.
 * `wrappedEnv` is what the wrapped command must keep from the real HOME (wrappedCommandEnv).
 */
export function codexHookSpec({ armHome, wrappedEnv = {}, disableKeys = [], node = process.execPath, shim = SHIM_PATH }) {
  const hook = armHome?.codexHook;
  if (!hook?.command?.endsWith(CONNECT_CODEX_HOOK)) throw new Error("anyray-connect installed no Codex PreToolUse hook in the arm's home (~/.codex/hooks.json)");
  const dir = join(armHome.home, BENCH_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, 'codex-hook.json');
  const shellRunEnv = shellRunEnvFor(armHome.home, wrappedEnv);
  writeFileSync(config, JSON.stringify({ home: armHome.home, connectHook: hook.command, exe: hook.command.slice(0, -CONNECT_CODEX_HOOK.length), shellRunEnv, log: join(dir, SHIM_LOG) }), { mode: 0o600 });
  return {
    command: [node, shim, config].map(shellQuote).join(' '),
    timeoutSec: hook.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC,
    disableKeys,
    connectExe: commandExecutable(hook.command),
    wrappedCommandEnv: Object.keys(shellRunEnv),
  };
}

/** What the shim did this session, from its log in the arm home (one outcome per hook call). */
export function readShimLog(home) {
  let text = '';
  try {
    text = readFileSync(join(home, BENCH_DIR, SHIM_LOG), 'utf8');
  } catch {}
  const lines = text.split('\n').filter(Boolean);
  const n = (outcome) => lines.filter((l) => l === outcome).length;
  return { calls: lines.length, rewrites: n('rewrite'), passthrough: n('passthrough'), standAside: n('stand-aside'), errors: n('error') };
}

/**
 * Where the toolchains a wrapped command runs would find their caches and config under the
 * real HOME: Go's (`go env`) and git's global config. The wrapped command runs under the arm
 * HOME (it inherits the shell-run's), and without these a `go test` there starts from an
 * empty module and build cache, which arm A never does.
 */
export function wrappedCommandEnv({ env = process.env, home = homedir(), spawnImpl = spawnSync } = {}) {
  const out = {};
  const go = spawnImpl('go', ['env', '-json', 'GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOENV'], { env, encoding: 'utf8', timeout: 20000 });
  if (go?.status === 0) {
    for (const [k, v] of Object.entries(parseJson(go.stdout) ?? {})) if (typeof v === 'string' && isAbsolute(v)) out[k] = v;
  }
  const gitconfig = env.GIT_CONFIG_GLOBAL || join(home, '.gitconfig');
  if (existsSync(gitconfig)) out.GIT_CONFIG_GLOBAL = gitconfig;
  return out;
}

// ── Codex's own records ───────────────────────────────────────────────────────

const parseLines = (text) => String(text ?? '').split('\n').flatMap((l) => {
  if (!l.trim()) return [];
  try {
    return [JSON.parse(l)];
  } catch {
    return [];
  }
});

/** `codex exec --json` stdout → thread id, the final agent message, and whether the turn failed. Pure. */
export function parseExecEvents(stdout) {
  let threadId = null;
  let answer = '';
  let failure = null;
  let reconnects = 0;
  for (const e of parseLines(stdout)) {
    if (e.type === 'thread.started' && typeof e.thread_id === 'string') threadId = e.thread_id;
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') answer = e.item.text;
    else if (e.type === 'turn.failed') failure = e.error?.message ?? 'turn failed';
    // Codex reports each socket retry as an `error` event and keeps going (then falls
    // back to HTTPS): a notice, not a failure. Counted, since the fallback re-sends the
    // transcript every turn. Read as fatal, it cut 4 sessions that finished (10-13).
    else if (e.type === 'error' && RECONNECT_NOTICE.test(String(e.message ?? ''))) reconnects++;
    else if (e.type === 'error' && !failure) failure = e.message ?? 'error';
  }
  return { threadId, answer, failure, reconnects };
}
const RECONNECT_NOTICE = /^Reconnecting\.\.\. \d+\/\d+/;

const RETRIEVAL_TOOLS = 'anyray_(?:retrieve|read_batch|read|recall|search|history)';
/** A function call's name: the tool itself, or Codex's MCP-qualified spelling of it. */
const RETRIEVAL_NAME = new RegExp(`^(?:mcp__anyray__)?(${RETRIEVAL_TOOLS})$`);
/** An `exec` script naming the tool's code-mode binding (`tools.mcp__anyray__anyray_retrieve`). */
const RETRIEVAL_BINDING = new RegExp(`\\bmcp__anyray__(${RETRIEVAL_TOOLS})\\b`, 'g');

/** The retrieval tools one call ran: by name, or each binding its script names (once per script). */
const retrievalToolsOf = (item) =>
  item.type === 'function_call'
    ? [RETRIEVAL_NAME.exec(String(item.name ?? ''))?.[1]].filter(Boolean)
    : [...new Set([...String(item.input ?? '').matchAll(RETRIEVAL_BINDING)].map((m) => m[1]))];

/** The binary each `<connect> __anyray-shell-run` in a command runs (connect's Codex hook rewrite). */
const SHELL_RUN = /(?:'([^']*)'|"([^"]*)"|([^\s'"]+))\s+__anyray-shell-run(?=\s|$)/g;
const shellRunExes = (command) =>
  [].concat(command ?? []).filter((x) => typeof x === 'string').flatMap((s) => [...s.matchAll(SHELL_RUN)].map((m) => m[1] ?? m[2] ?? m[3]));

/**
 * connect's digest footer where it opens a line of tool output (a real newline, or an escaped
 * one when an exec script JSON-encodes what it prints) and closes on the same line: the shape
 * connect emits (util/commandTrim.ts digestMarkerFor), with or without its pointer. Mid-line
 * or backquoted, it is a quote of the shape (a grep hit, the skill's text), not a footer.
 */
const DIGEST_FOOTER = /(?:^|\n|\\n)…\[anyray-hook digest — [^\n]*?\]…/g;
const stringsIn = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : []);
const digestFooters = (output) => stringsIn(output).reduce((n, s) => n + (s.match(DIGEST_FOOTER)?.length ?? 0), 0);

/**
 * One thread's rollout file (JSONL) → per-response usage, its model and reasoning effort,
 * its parent thread (a subagent's), tool-call and retrieval-tool counts, the seat's
 * usage-limit reading, and what connect's Codex hook did: the commands it wrapped (by the
 * connect binary that runs each) and the digest footers the model was shown. Retrieval
 * calls are counted by tool name only: from a function_call's name, or from the tool names
 * an `exec` script calls (code mode runs MCP tools inside the script). Nothing else of the
 * content is kept. Pure.
 */
export function readRollout(text) {
  const out = { threadId: null, parentThreadId: null, model: null, effort: null, requests: [], toolCalls: 0, retrievals: {}, usedPercent: [], compactions: 0, hookWrapExes: {}, hookDigests: 0 };
  let readyAt = null;
  for (const e of parseLines(text)) {
    const p = e.payload ?? {};
    const at = Date.parse(e.timestamp ?? '');
    if (e.type === 'session_meta') {
      out.threadId = p.id ?? p.session_id ?? null;
      out.parentThreadId = p.source?.subagent?.thread_spawn?.parent_thread_id ?? null;
    } else if (e.type === 'turn_context') {
      out.model ??= p.model ?? null;
      out.effort ??= p.effort ?? null;
      readyAt = at;
    } else if (e.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p.type)) {
      out.toolCalls++;
      for (const tool of retrievalToolsOf(p)) out.retrievals[tool] = (out.retrievals[tool] ?? 0) + 1;
    } else if (e.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      readyAt = at;
      out.hookDigests += digestFooters(p.output);
    } else if (e.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
      // The command as it ran, after any PreToolUse rewrite.
      for (const exe of shellRunExes(p.item.command)) out.hookWrapExes[exe] = (out.hookWrapExes[exe] ?? 0) + 1;
    } else if (e.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      readyAt = at;
    } else if (e.type === 'compacted') {
      // Codex replaced the history with its summary: the mechanism an auto-compact
      // treatment changes, counted so a verdict can see whether it fired.
      out.compactions++;
    } else if (e.type === 'token_usage_record' && p.usage) {
      const u = p.usage;
      out.requests.push({
        responseId: p.response_id ?? null,
        usage: { input: u.input_tokens ?? 0, cacheRead: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0 },
        // From the request's input being complete (turn start, a tool output) to its usage.
        latencyMs: Number.isFinite(readyAt) && Number.isFinite(at) ? Math.max(0, at - readyAt) : null,
      });
      readyAt = at;
    } else if (e.type === 'event_msg' && p.type === 'token_count') {
      const used = p.rate_limits?.primary?.used_percent;
      if (Number.isFinite(used)) out.usedPercent.push(used);
    }
  }
  return out;
}

/**
 * A session's threads (main first, then subagents) → totals in the harness's shape.
 * `connectExe`: the connect binary the arm's own hook names (one or more spellings of it),
 * so a wrap by any other binary (the machine's own hook) counts apart, in hookWrapsOther;
 * an arm without a hook has none of its own. Pure.
 */
export function codexTotals(threads, pricing, { wallMs = null, connectExe = null } = {}) {
  const requests = threads.flatMap((t) => t.requests.map((r) => ({ ...r, model: t.model, thread: t.threadId, subagent: t.parentThreadId !== null })));
  const sum = (k) => requests.reduce((n, r) => n + r.usage[k], 0);
  const costs = requests.map((r) => costOf(pricing, r.model, r.usage));
  const main = requests.filter((r) => !r.subagent);
  const retrievals = {};
  for (const t of threads) for (const [k, n] of Object.entries(t.retrievals)) retrievals[k] = (retrievals[k] ?? 0) + n;
  const latencies = requests.map((r) => r.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const used = threads.flatMap((t) => t.usedPercent);
  const wraps = threads.flatMap((t) => Object.entries(t.hookWrapExes ?? {}));
  const own = new Set([].concat(connectExe ?? []));
  const ours = (exe) => own.has(exe);
  return {
    requests: requests.length,
    turns: main.length,
    mainRequests: main.length,
    subagentRequests: requests.length - main.length,
    subagents: threads.filter((t) => t.parentThreadId !== null).length,
    input: sum('input'),
    cacheRead: sum('cacheRead'),
    cacheWrite: sum('cacheWrite'),
    uncachedInput: Math.max(0, sum('input') - sum('cacheRead') - sum('cacheWrite')),
    output: sum('output'),
    reasoning: sum('reasoning'),
    costUsd: requests.length && costs.every((x) => x !== null) ? costs.reduce((a, b) => a + b, 0) : null,
    unpricedModels: [...new Set(requests.filter((_, i) => costs[i] === null).map((r) => r.model ?? 'unknown'))],
    models: Object.fromEntries([...new Set(requests.map((r) => r.model ?? 'unknown'))].map((m) => [m, requests.filter((r) => (r.model ?? 'unknown') === m).length])),
    toolCalls: threads.reduce((n, t) => n + t.toolCalls, 0),
    compactions: threads.reduce((n, t) => n + (t.compactions ?? 0), 0),
    peakInput: requests.reduce((n, r) => Math.max(n, r.usage.input), 0),
    retrievals,
    retrievalCalls: Object.values(retrievals).reduce((a, b) => a + b, 0),
    latencyMs: latencies.length ? { median: latencies[Math.floor((latencies.length - 1) / 2)], max: latencies.at(-1) } : null,
    seatUsedPercent: used.length ? { first: used[0], last: used.at(-1) } : null,
    hookWraps: wraps.reduce((n, [, k]) => n + k, 0),
    hookWrapsOther: wraps.reduce((n, [exe, k]) => n + (ours(exe) ? 0 : k), 0),
    hookDigests: threads.reduce((n, t) => n + (t.hookDigests ?? 0), 0),
    start: { read: main[0]?.usage.cacheRead ?? 0, written: main[0]?.usage.cacheWrite ?? 0 },
    wallMs,
    outsideCheckout: 0,
  };
}

/** Every rollout under `sessionsDir` written since `sinceMs`, as { path, meta }. */
function recentRollouts(sessionsDir, sinceMs) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name) && statSync(path).mtimeMs >= sinceMs) found.push(path);
    }
  };
  walk(sessionsDir, 0);
  return found;
}

/**
 * The session's threads: the main thread and every subagent descended from it, each read
 * from its rollout. Rollouts are found by the thread id in their file name and, for
 * subagents, by the parent id in their session_meta.
 */
export function sessionThreads(threadId, { sinceMs, sessionsDir = join(homedir(), '.codex', 'sessions') }) {
  const read = recentRollouts(sessionsDir, sinceMs - 60_000).map((path) => readRollout(readFileSync(path, 'utf8')));
  const byId = new Map(read.filter((t) => t.threadId).map((t) => [t.threadId, t]));
  const main = byId.get(threadId);
  if (!main) return [];
  const threads = [main];
  for (let i = 0; i < threads.length; i++) {
    for (const t of byId.values()) if (t.parentThreadId === threads[i].threadId && !threads.includes(t)) threads.push(t);
  }
  return threads;
}

// ── One session ───────────────────────────────────────────────────────────────

/** Run one codex process to exit (or its timeout), stdin closed; kills its process group on timeout. */
export function runCodexProcess(bin, argv, { cwd, env, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const child = spawnImpl(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, pid: child.pid });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const countFiles = (dir) => {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
};

const realPathOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * One Codex session for one arm: the task, then each follow-up as `codex exec resume`
 * (a new process, so the gateway sees it re-send the whole history on a fresh socket).
 * Returns the harness's session shape. Deletes the session's threads unless `keepThreads`.
 */
export async function runCodexAgent({
  arm, scenario, work, model, effort = null, gatewayUrl = null, clientKey = null, runTag,
  sharedHeaders = [], extraHeaders = [], armHome = null, pricing, configOverrides = [], hook = null,
  codexBin = 'codex', keepThreads = false, sessionsDir = join(homedir(), '.codex', 'sessions'),
  runProcess = runCodexProcess, readThreads = sessionThreads, deleteThread = null, check = null, citations = null,
}) {
  const startedMs = Date.now();
  const timeoutMs = (scenario.timeoutMin ?? 6) * 60_000;
  const headers = arm === 'anyray' ? anyrayHeaders({ runTag, sharedHeaders, extraHeaders }) : {};
  const env = { ...process.env, ...(arm === 'anyray' ? { [KEY_ENV]: clientKey } : {}) };
  delete env.CODEX_HOME; // the real ~/.codex: the seat login lives there
  const prompts = [scenario.task, ...(scenario.followups ?? [])];
  const delays = [].concat(scenario.followupDelaySec ?? 0);
  let threadId = null;
  let answer = '';
  let failure = null;
  let timedOut = false;
  const processes = [];
  for (let i = 0; i < prompts.length; i++) {
    if (i > 0) {
      if (!threadId) break;
      const delay = delays[Math.min(i - 1, delays.length - 1)] ?? 0;
      if (delay) await sleep(delay * 1000);
    }
    const remaining = timeoutMs - (Date.now() - startedMs);
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const argv = codexArgv({ arm, prompt: prompts[i], model, effort, resumeThreadId: i > 0 ? threadId : null, gatewayUrl, headers, armHome, configOverrides, hook });
    const p = await runProcess(codexBin, argv, { cwd: work, env, timeoutMs: remaining });
    const ev = parseExecEvents(p.stdout);
    threadId ??= ev.threadId;
    if (ev.answer) answer = ev.answer;
    // The last stderr line, keys redacted: why a process ended, for the round's record.
    const stderrTail = String(p.stderr ?? '').trim().split('\n').at(-1)?.replace(/(ark|aak|adt|enl)_[A-Za-z0-9_-]+/g, '$1_<redacted>').slice(0, 300) || null;
    processes.push({ code: p.code, signal: p.signal, timedOut: p.timedOut, failure: ev.failure, reconnects: ev.reconnects, stderrTail });
    if (p.timedOut) {
      timedOut = true;
      break;
    }
    if (p.code !== 0 || ev.failure) {
      failure = ev.failure || `codex exited ${p.code ?? p.signal}${stderrTail ? `: ${stderrTail}` : ''}`;
      break;
    }
  }
  const wallMs = Date.now() - startedMs;
  // Rollouts are written as the session runs; the last line can land just after exit.
  await sleep(500);
  const threads = threadId ? readThreads(threadId, { sinceMs: startedMs, sessionsDir }) : [];
  const totals = codexTotals(threads, pricing, { wallMs, connectExe: hook?.connectExe ? [hook.connectExe, realPathOr(hook.connectExe)] : null });
  // A session that never finished reports no cost: the round is excluded, never a ratio.
  if (timedOut || failure) totals.costUsd = null;
  const session = {
    codex: true,
    threadId,
    threads: threads.map((t) => ({ threadId: t.threadId, parentThreadId: t.parentThreadId, model: t.model, effort: t.effort, requests: t.requests.length })),
    requests: threads.flatMap((t) => t.requests.map((r) => ({ thread: t.threadId, ...r }))),
    totals,
    processes,
    result: { text: answer, subtype: timedOut ? 'error_timeout' : failure ? 'error_during_execution' : answer.trim() ? 'success' : 'error_no_answer' },
    ...(failure ? { error: failure } : {}),
    check: check ? check(work) : null,
    citations: citations ? citations(answer, work) : null,
    setup: {
      client: 'codex',
      route: arm === 'direct' ? 'codex built-in OpenAI provider (WebSocket to chatgpt.com)' : 'anyray-connect seat route through the gateway',
      model: threads[0]?.model ?? model ?? null,
      effort: threads[0]?.effort ?? effort ?? null,
      ...(configOverrides.length ? { codexConfig: Object.fromEntries(configOverrides) } : {}),
      ...(arm === 'anyray' ? { providerName: armHome?.providerName ?? null, websockets: armHome?.websockets ?? null, approvedTools: armHome?.approvedTools ?? [] } : {}),
      // --codex-hooks-b: what the shim did with each Bash call, and the outputs connect's
      // trim teed into this arm's own ~/.anyray (counts only).
      ...(hook ? { codexHook: { shim: readShimLog(armHome.home), teeFiles: countFiles(join(armHome.home, '.anyray', 'hook-tee')) } } : {}),
    },
  };
  if (!keepThreads && deleteThread) for (const t of threads) deleteThread(t.threadId);
  return session;
}

const KIND = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The gateway's trace rows for one Codex session (lib/traces.mjs traceRecord) as the
 * per-response results `tallyKinds` reads: Codex never shows us the gateway's response
 * headers, so the trace store is where its feedback comes from. A row with no recorded
 * outcome is `unconfirmed`; a seat turn the lane relayed untouched is `skipped` with
 * nothing applied. Pure.
 */
export function traceResults(traces = []) {
  return traces.map((t) => {
    if (typeof t.optimizationStatus !== 'string') return { status: 'unconfirmed', why: 'missing' };
    const applied = [...new Set([...(Array.isArray(t.optimizationKinds) ? t.optimizationKinds : []), ...(t.decisions ?? []).map((d) => d?.kind)])].filter((k) => typeof k === 'string' && KIND.test(k));
    const skipped = (Array.isArray(t.suppressed) ? t.suppressed : [])
      .filter((s) => typeof s?.kind === 'string' && KIND.test(s.kind) && typeof s.reason === 'string' && KIND.test(s.reason))
      .map((s) => ({ kind: s.kind, reason: 'safety_gate', guard: s.reason }));
    return { status: KIND.test(t.optimizationStatus) ? t.optimizationStatus : 'unknown', applied, skipped, preserved: [] };
  });
}

/** `codex delete --force <id>`, best effort: a leftover thread is clutter, not a wrong result. */
export const deleteCodexThread = (codexBin = 'codex') => (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) return;
  spawnSync(codexBin, ['delete', '--force', id], { stdio: 'ignore', timeout: 30000 });
};

/** A fresh private home for one anyray arm, under the bench's session dir; the caller removes it. */
export const makeArmHome = (parent) => {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'anyray-bench-codex-home-'));
};
export const removeArmHome = (home) => rmSync(home, { recursive: true, force: true });


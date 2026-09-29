// Run one scenario as a real, free-running agent session: headless Claude Code
// (`claude -p`) on a fresh checkout of a real repo, with Claude Code's full default
// toolset — including Task, so it can split work into subagents the way it does for
// customers. Nothing is scripted: the model chooses every step.
//
// An ARM is how the session reaches the model:
//   direct   plain Claude Code straight to Anthropic. No Anyray hooks, MCP or gateway.
//   anyray   Claude Code wired the way anyray-connect wires it on this machine: base
//            URL = the gateway, client key + metadata headers, Anyray's client hooks,
//            and the `anyray` MCP server.
// Both arms: same model, task, turn cap, upstream credential (subscription OAuth), and
// NO user/project settings (--setting-sources ""), so nothing personal leaks in.
//
// Every model request is recorded from the stream-json transcript, attributed to the
// main agent or to a subagent via parent_tool_use_id.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withArmEnv, assertArmEnvSafe } from './armEnv.mjs';
import { configureWithConnect, connectActivity } from './connectArm.mjs';
import { KINDS_HEADER, RESULT_HEADER, withKindsHeader, tallyKinds } from './optimizationKinds.mjs';
import { startResultProxy } from './resultProxy.mjs';

const ANYRAY_BIN = join(homedir(), '.anyray', 'bin', 'anyray-connect');
// Hook output: a digest/tee footer, an omitted-lines marker, or a Read trim's
// `… [N lines · retrieve ctx_…]` elision.
const HOOK_FOOTER = /\[anyray-hook[^\]]*\]|omitted by anyray|\[\d+ lines · retrieve ctx_/;
const CACHE = join(tmpdir(), 'anyray-bench-repos');

/** Refuse an escaped or redirected arm HOME before writing any Claude config. */
function privateArmHome(cfgDir) {
  const home = join(cfgDir, 'home');
  const sessionDir = realpathSync(cfgDir);
  mkdirSync(home, { recursive: true });
  if (realpathSync(home) !== join(sessionDir, 'home')) {
    throw new Error('arm HOME must stay inside its session directory');
  }
  return home;
}

function oauthToken() {
  if (process.env.ANYRAY_UPSTREAM_TOKEN) return process.env.ANYRAY_UPSTREAM_TOKEN;
  const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
  return JSON.parse(out).claudeAiOauth.accessToken;
}

/** Anyray hooks exactly as installed in ~/.claude/settings.json (anyray-connect entries only). */
function anyrayHooks() {
  let s;
  try {
    s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
  const hooks = {};
  for (const [event, groups] of Object.entries(s.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command?.includes('anyray-connect')) }))
      .filter((g) => g.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  return hooks;
}

const connect = () => JSON.parse(readFileSync(join(homedir(), '.anyray', 'connect.json'), 'utf8'));
const clientKey = () => process.env.ANYRAY_CLIENT_KEY || connect().clientKey;
const trimUrl = (u) => String(u ?? '').replace(/\/$/, '');

/**
 * This machine's anyray-connect hooks and MCP server are enrolled against one gateway
 * (~/.anyray/connect.json). Against any other deployment they would retrieve from the
 * wrong store, so the anyray arm is gateway-only there.
 */
export const clientSideApplies = (gatewayUrl) => {
  try {
    return trimUrl(connect().gateway) === trimUrl(gatewayUrl);
  } catch {
    return false;
  }
};
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * A fresh working copy of the scenario's repo at its pinned ref, with the scenario's
 * patch applied. The clone is cached; each session gets its own `git worktree`-free
 * copy via a local clone, so the two arms never share files.
 */
export function prepareRepo(scenario, scenarioDir) {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, scenario.repo.git.replace(/[^a-z0-9]+/gi, '_'));
  if (!existsSync(cached)) execFileSync('git', ['clone', '-q', scenario.repo.git, cached]);
  try {
    git(['cat-file', '-e', `${scenario.repo.ref}^{commit}`], cached);
  } catch {
    git(['fetch', '-q', 'origin'], cached);
  }
  const work = mkdtempSync(join(tmpdir(), 'anyray-bench-work-'));
  execFileSync('git', ['clone', '-q', '--no-hardlinks', cached, work]);
  git(['checkout', '-q', scenario.repo.ref], work);
  if (scenario.patch) git(['apply', join(scenarioDir, scenario.patch)], work);
  if (scenario.hidePatch) {
    // Re-import as one commit so neither `git diff` nor `git log -p` points at the bug.
    rmSync(join(work, '.git'), { recursive: true, force: true });
    git(['init', '-q'], work);
    git(['add', '-A'], work);
    git(['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', 'import'], work);
  }
  return work;
}

/** Repo facts for the report: files, lines, languages — what the agent can reach. */
export function describeRepo(work, scenario) {
  const files = git(['ls-files'], work).split('\n').filter(Boolean);
  const byExt = {};
  let lines = 0;
  for (const f of files) {
    const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '(none)';
    let n = 0;
    try {
      n = readFileSync(join(work, f), 'utf8').split('\n').length;
    } catch {}
    lines += n;
    byExt[ext] = byExt[ext] ?? { files: 0, lines: 0 };
    byExt[ext].files++;
    byExt[ext].lines += n;
  }
  return {
    git: scenario.repo.git,
    ref: scenario.repo.ref,
    patch: scenario.patch ?? null,
    files: files.length,
    lines,
    byExt: Object.entries(byExt).sort((a, b) => b[1].lines - a[1].lines).slice(0, 8),
    tree: files.slice(0, 400),
  };
}

/**
 * `--read-trim`: turn on anyray-connect's nested-Read trim for THIS session only.
 *
 * The hook takes the switch from the fleet posture cached in $HOME/.anyray/connect.json
 * (`fleetHookPolicy.readTrim`); there is no env var or flag for it, and the gateway's
 * connect policy is shared. So the hooks and the MCP server run under a private HOME:
 *   .anyray/connect.json   this machine's profile, fleetHookPolicy.readTrim = on. On a
 *                          gateway this machine is not enrolled on, the arm otherwise has
 *                          no hooks, so digest is off too: the only change is Read trim.
 *   .claude/settings.json  the arm's env (gateway + headers: where hook and MCP send) and
 *                          the anyray_* approvals.
 *   .claude.json           the MCP registration the hook checks before minting handles.
 * Key refresh is off there, so no policy sync rewrites the copy mid-session. The hook
 * only trims a Read once the main transcript shows a successful anyray_retrieve, so this
 * arm keeps session persistence on and deletes its transcript afterwards.
 */
function readTrimHome(cfgDir, env, enrolled, { connect: readProfile, bin }) {
  const home = privateArmHome(cfgDir);
  mkdirSync(join(home, '.anyray'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const profile = readProfile();
  profile.fleetHookPolicy = enrolled ? { ...(profile.fleetHookPolicy ?? {}), readTrim: 'on' } : { digest: 'off', readTrim: 'on' };
  delete profile.hookPolicies;
  const secret = (f, body) => {
    writeFileSync(f, JSON.stringify(body, null, 2));
    chmodSync(f, 0o600); // client key
  };
  secret(join(home, '.anyray', 'connect.json'), profile);
  const allow = ['anyray_retrieve', 'anyray_recall', 'anyray_read_batch', 'anyray_history'].map((t) => `mcp__anyray__${t}`);
  secret(join(home, '.claude', 'settings.json'), { env, permissions: { allow } });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { anyray: { type: 'stdio', command: bin, args: ['__anyray-mcp-server', 'claude'] } },
  }));
  return { home, posture: profile.fleetHookPolicy, env: { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' } };
}

/** The PostToolUse hooks only (no SessionStart refresh). */
const postToolHooks = (hooks) => {
  const out = {};
  for (const [e, g] of Object.entries(hooks)) {
    const kept = g.map((x) => ({ ...x, hooks: x.hooks.filter((h) => h.command.includes('__anyray-hook')) })).filter((x) => x.hooks.length);
    if (kept.length) out[e] = kept;
  }
  return out;
};

/** Prefix each anyray-connect hook command with the private-HOME env. */
const withEnv = (hooks, env) => {
  const prefix = Object.entries(env).map(([k, v]) => `${k}='${v}'`).join(' ');
  return Object.fromEntries(Object.entries(hooks).map(([e, groups]) => [
    e, groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => ({ ...h, command: `${prefix} ${h.command}` })) })),
  ]));
};

/** The readTrim posture the session's profile copy ended with (policy sync could rewrite it). */
const readTrimAtEnd = (home) => {
  try {
    return JSON.parse(readFileSync(join(home, '.anyray', 'connect.json'), 'utf8')).fleetHookPolicy?.readTrim ?? 'off';
  } catch {
    return 'unreadable';
  }
};

/** Delete a persisted session transcript (and its subagent dir) by session id. */
function removeTranscript(sessionId) {
  if (!sessionId) return;
  const root = join(homedir(), '.claude', 'projects');
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    if (!existsSync(join(root, d, `${sessionId}.jsonl`))) continue;
    rmSync(join(root, d, `${sessionId}.jsonl`), { force: true });
    rmSync(join(root, d, sessionId), { recursive: true, force: true });
    try {
      if (!readdirSync(join(root, d)).length) rmSync(join(root, d), { recursive: true });
    } catch {
      /* already gone */
    }
  }
}

const LIVE = {
  connect,
  clientKey,
  anyrayHooks,
  binExists: () => existsSync(ANYRAY_BIN),
  bin: ANYRAY_BIN,
  configureArm: configureWithConnect, // anyray-connect configures the arm in its private HOME
  serviceKey: () => process.env.ANYRAY_CLIENT_KEY, // non-interactive enrollment needs one
};

const NO_CONNECT = () => ({ configured: false, reason: 'anyray-connect not used' });

/**
 * `--read-trim` on the connect-configured arm: the session already runs under the HOME
 * anyray-connect enrolled, so the switch goes into THAT profile (fleetHookPolicy.readTrim
 * = on over the posture connect cached, hookPolicies dropped), with key refresh off so no
 * policy sync rewrites it mid-session. Same posture as readTrimHome on an enrolled gateway.
 */
function connectReadTrim(home) {
  const f = join(home, '.anyray', 'connect.json');
  let profile;
  try {
    profile = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new Error('--read-trim: anyray-connect wrote no profile to the arm HOME');
  }
  profile.fleetHookPolicy = { ...(profile.fleetHookPolicy ?? {}), readTrim: 'on' };
  delete profile.hookPolicies;
  writeFileSync(f, JSON.stringify(profile, null, 2));
  chmodSync(f, 0o600); // client key
  return { home, posture: profile.fleetHookPolicy, env: { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' } };
}

/**
 * The arm's Claude Code settings and MCP config (written by the caller), the setting
 * sources and HOME the session runs under (`home` null = the real one), extra process env
 * (`procEnv`) and what to record in setup. `deps` reads this machine's anyray-connect
 * install; tests inject their own. With `readTrim` (Anyray arm only) the session must
 * persist its transcript: `persistSession`.
 *
 * The Anyray arm is configured by anyray-connect itself, the way an enrolled user gets it,
 * in a private HOME the session then runs under. If connect can't (no service key, no
 * binary, it fails), the arm falls back to the harness config and records why.
 */
export function armConfig({ arm, gatewayUrl, runTag, readTrim = false, cfgDir, env: armEnv = {}, kinds = null, deps = LIVE }) {
  assertArmEnvSafe(armEnv);
  const anyray = arm === 'anyray';
  const settings = { env: {} };
  const mcp = { mcpServers: {} };
  let trimHome = null;
  // --arm-env goes into the SESSION's settings.env only, on top of the gateway env. The
  // private HOME (read trim / retrieval MCP) keeps just the gateway env its hooks and MCP need.
  const real = { settingSources: '', home: null, procEnv: {} }; // the harness config's session
  if (!anyray) return { settings: withArmEnv(settings, armEnv), mcp, trimHome, persistSession: false, ...real, setup: null };
  if (readTrim && !deps.binExists()) throw new Error('--read-trim needs anyray-connect installed');

  // The product path. The HOME is confined to the session dir before connect writes to it.
  const connectHome = privateArmHome(cfgDir);
  mkdirSync(join(connectHome, '.claude'), { recursive: true }); // connect configures Claude Code only where it is installed
  const c = (deps.configureArm ?? NO_CONNECT)({ home: connectHome, gatewayUrl, clientKey: deps.serviceKey?.() });
  if (c.configured) {
    const { env: connectEnv, ...connectSetup } = c.setup; // `env` in setup is --arm-env's
    // The session reads connect's user settings (env, hooks, permissions, skills) under
    // that HOME; --settings repeats connect's env with the run's metadata tag, so the
    // gateway's traces are attributable per round.
    const headers = String(c.settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? '')
      .split('\n')
      .filter((h) => h && !/^x-anyray-metadata:/i.test(h));
    settings.env = { ...c.settings.env, ANTHROPIC_CUSTOM_HEADERS: withKindsHeader([...headers, `x-anyray-metadata: ${JSON.stringify(runTag)}`].join('\n'), kinds) };
    if (readTrim) trimHome = connectReadTrim(connectHome);
    return {
      settings: withArmEnv(settings, armEnv),
      mcp: { mcpServers: c.mcpServers },
      trimHome,
      persistSession: Boolean(trimHome),
      settingSources: 'user',
      home: connectHome,
      procEnv: trimHome ? { ANYRAY_REFRESH_DISABLE: 'true' } : {}, // hooks + MCP inherit it
      setup: {
        configuredBy: 'anyray-connect',
        clientSide: 'anyray-connect hooks, MCP and skills, enrolled on this gateway with the client key in a private HOME',
        settingSources: 'user (what connect wrote to the private HOME)',
        readTrim: trimHome
          ? 'on for this session only: fleetHookPolicy.readTrim = on in the profile anyray-connect wrote to the arm HOME (key refresh off); session persistence on so the hook can read the transcript'
          : 'fleet policy (as anyray-connect cached it in the arm HOME)',
        ...connectSetup,
        connectEnv,
      },
    };
  }
  const enrolled = (() => {
    try {
      return trimUrl(deps.connect().gateway) === trimUrl(gatewayUrl);
    } catch {
      return false;
    }
  })();
  const server = (env) => ({ type: 'stdio', command: deps.bin, args: ['__anyray-mcp-server', 'claude'], ...(env ? { env } : {}) });
  settings.env = {
    ANTHROPIC_BASE_URL: gatewayUrl,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    ANTHROPIC_CUSTOM_HEADERS: withKindsHeader([
      'x-anyray-provider: anthropic',
      'x-anyray-auth-mode: passthrough',
      `x-anyray-api-key: ${deps.clientKey()}`,
      `x-anyray-metadata: ${JSON.stringify(runTag)}`,
    ].join('\n'), kinds),
  };
  if (readTrim) {
    trimHome = readTrimHome(cfgDir, settings.env, enrolled, deps);
    settings.hooks = withEnv(postToolHooks(deps.anyrayHooks()), trimHome.env);
    mcp.mcpServers.anyray = server(trimHome.env);
  } else if (enrolled) {
    settings.hooks = deps.anyrayHooks();
    mcp.mcpServers.anyray = server();
  } else if (deps.binExists()) {
    // Enrolled elsewhere: still give the session the retrieval MCP server, pointed at
    // THIS gateway through a private HOME. Without anyray_retrieve on the wire the
    // gateway treats the client as unable to retrieve and suppresses every
    // handle-based strategy (relevance_filter, …). No client hooks: gateway-only.
    const home = privateArmHome(cfgDir);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: settings.env }));
    mcp.mcpServers.anyray = server({ HOME: home });
  }
  return {
    settings: withArmEnv(settings, armEnv), mcp, trimHome, persistSession: Boolean(trimHome), ...real,
    setup: { configuredBy: 'harness (fallback)', fallbackReason: c.reason },
  };
}

/**
 * The session's own model traffic goes through the local result proxy (which forwards to
 * the gateway); hooks and MCP keep the gateway URL they were configured with.
 */
export const routeViaProxy = (settings, proxyUrl) => ({ ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: proxyUrl } });

/** The arm's setup, minus secrets — recorded in the report. */
export function describeSetup({ arm, model, gatewayUrl, runTag, maxTurns, readTrim = false, enrolled, env = {}, kinds = null, kindsSource = null }) {
  const anyray = arm === 'anyray';
  readTrim = anyray && readTrim;
  const onGateway = enrolled ?? (anyray && clientSideApplies(gatewayUrl));
  let client;
  try {
    client = `Claude Code ${execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()} (headless, claude -p)`;
  } catch {
    client = 'Claude Code (headless, claude -p)';
  }
  return {
    arm,
    client,
    model,
    endpoint: anyray ? `${gatewayUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages',
    auth: anyray ? `passthrough: subscription OAuth upstream + Anyray ${process.env.ANYRAY_CLIENT_KEY ? 'service' : 'client'} key` : 'subscription OAuth',
    headers: anyray
      ? { 'x-anyray-provider': 'anthropic', 'x-anyray-auth-mode': 'passthrough', 'x-anyray-api-key': '<client key>', 'x-anyray-metadata': runTag, ...(kinds?.length ? { [KINDS_HEADER]: kinds.join(',') } : {}) }
      : {},
    optimizationKinds: anyray && kinds?.length
      ? { requested: kinds, source: kindsSource, header: KINDS_HEADER, feedback: `${RESULT_HEADER}, read per request by a local pass-through proxy` }
      : null,
    hooks: anyray && readTrim
      ? { PostToolUse: ['anyray-connect __anyray-hook'], PostToolUseFailure: ['anyray-connect __anyray-hook'] }
      : anyray && onGateway
      ? Object.fromEntries(Object.entries(anyrayHooks()).map(([e, g]) => [e, g.flatMap((x) => x.hooks.map((h) => h.command.replace(/^.*\//, '')))]))
      : {},
    clientSide: anyray ? (onGateway ? 'anyray-connect hooks + MCP (this machine is enrolled on this gateway)' : 'retrieval MCP only, pointed at this gateway; no client hooks (this machine is enrolled on a different gateway)') : null,
    mcpServers: anyray ? { anyray: { type: 'stdio', command: 'anyray-connect __anyray-mcp-server claude' } } : {},
    tools: 'Claude Code defaults (incl. Task → subagents), permissions bypassed',
    maxTurns,
    settingSources: 'none (user/project settings ignored)',
    readTrim: !anyray ? null
      : readTrim
        ? `on for this session only: hooks + MCP under a private HOME whose profile copy has fleetHookPolicy ${onGateway ? '= cached posture + readTrim on' : '{digest: off, readTrim: on}'} (key refresh off); session persistence on so the hook can read the transcript`
        : onGateway ? 'fleet policy (as cached in ~/.anyray/connect.json)' : 'off (no client hooks)',
    ...(Object.keys(env).length ? { env } : {}), // --arm-env: extra Claude Code env on this arm
  };
}

/** Run a shell check (e.g. `go test ./...`) in the workdir; exit 0 = solved. */
function runCheck(cmd, cwd) {
  try {
    const out = execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    return { passed: true, output: out.slice(-1500) };
  } catch (e) {
    return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-1500) };
  }
}

/**
 * Resolve every `path/to/file.ext:123` citation in an answer against the checkout:
 * the file must exist and have that line. Grades audit-style tasks: findings must
 * point at real code.
 */
export function checkCitations(text, work) {
  const seen = new Map();
  for (const m of text.matchAll(/([\w./-]+\.(?:go|md|mod|ts|js|py|ya?ml|json)):(\d+)/g)) {
    const [ref, file, line] = m;
    if (seen.has(ref)) continue;
    let ok = false;
    try {
      ok = readFileSync(join(work, file.replace(/^\.\//, '')), 'utf8').split('\n').length >= Number(line);
    } catch {}
    seen.set(ref, ok);
  }
  const total = seen.size;
  const resolved = [...seen.values()].filter(Boolean).length;
  return { total, resolved, unresolved: [...seen].filter(([, ok]) => !ok).map(([r]) => r).slice(0, 20) };
}

/**
 * Run the scenario on one arm. Returns the parsed session: every model request with
 * its usage and agent (main / subagent), tool calls and results, the final result,
 * the check outcome and the diff the agent left behind.
 */
export async function runAgent({ arm, scenario, scenarioDir, model, gatewayUrl, runTag, readTrim = false, env: armEnv, kinds = null, timeoutMs = (scenario.timeoutMin ?? 6) * 60000 }) {
  const work = prepareRepo(scenario, scenarioDir);
  const cfgDir = mkdtempSync(join(tmpdir(), 'anyray-bench-cfg-'));
  const { settings, mcp, trimHome, persistSession, settingSources, home, procEnv, setup } = armConfig({ arm, gatewayUrl, runTag, readTrim, cfgDir, env: armEnv, kinds });
  // Requested kinds: read each response's feedback header through a local pass-through.
  const proxy = arm === 'anyray' && kinds?.length ? await startResultProxy({ upstream: settings.env.ANTHROPIC_BASE_URL ?? gatewayUrl }) : null;
  const settingsFile = join(cfgDir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(proxy ? routeViaProxy(settings, proxy.url) : settings));
  chmodSync(settingsFile, 0o600); // holds the client key on the anyray arm
  const mcpFile = join(cfgDir, 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify(mcp));

  // `followups`: more user turns, each sent when the previous one finishes, so the
  // session has closed user loops and old tool output (what history trims act on).
  const followups = scenario.followups ?? [];
  const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  const args = [
    '-p', ...(followups.length ? ['--input-format', 'stream-json'] : [scenario.task]),
    '--model', model,
    '--setting-sources', settingSources,
    '--settings', settingsFile,
    '--strict-mcp-config', '--mcp-config', mcpFile,
    '--dangerously-skip-permissions',
    '--max-turns', String(scenario.maxTurns ?? 40),
    '--output-format', 'stream-json', '--verbose',
    ...(persistSession ? [] : ['--no-session-persistence']),
  ];
  const env = { PATH: process.env.PATH, HOME: home ?? homedir(), CLAUDE_CODE_OAUTH_TOKEN: oauthToken(), GOFLAGS: '-mod=mod', ...procEnv };
  // A private HOME must not also mean a cold Go module/build cache on one arm only.
  if (home) Object.assign(env, { GOPATH: join(homedir(), 'go'), GOCACHE: join(homedir(), 'Library', 'Caches', 'go-build') });

  const started = Date.now();
  const { lines, stderr, code } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: work, env, stdio: [followups.length ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const pending = [...followups];
    if (followups.length) child.stdin.write(userLine(scenario.task));
    let seen = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (!followups.length) return;
      const results = (out.match(/"type":"result"/g) ?? []).length;
      for (; seen < results; seen++) {
        if (pending.length) child.stdin.write(userLine(pending.shift()));
        else child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (c) => {
      clearTimeout(timer);
      if (Date.now() - started >= timeoutMs) err = `timed out after ${timeoutMs / 60000} min\n${err}`;
      resolve({ lines: out.trim().split('\n').filter(Boolean), stderr: err, code: c });
    });
  });
  if (proxy) await proxy.close();
  const readTrimPosture = trimHome ? { set: trimHome.posture, readTrimAtEnd: readTrimAtEnd(trimHome.home) } : null;
  const activity = home ? connectActivity(home) : null; // read before the private HOME goes
  rmSync(cfgDir, { recursive: true, force: true }); // a connect-HOME transcript goes with it
  if (trimHome && !home) {
    const id = lines.map((l) => l.match(/"session_id":"([^"]+)"/)?.[1]).find(Boolean);
    removeTranscript(id);
  }
  if (!lines.length) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`);
  }
  const session = parseSession(lines);
  if (trimHome) session.hookPosture = readTrimPosture;
  session.setup = activity ? { ...setup, activity } : setup;
  session.wallMs = Date.now() - started;
  if (proxy) session.optimization = { requested: kinds, results: proxy.results, tally: tallyKinds(proxy.results, kinds), selectionHeadersStripped: proxy.stripped };
  session.check = scenario.check ? runCheck(scenario.check, work) : null;
  session.citations = scenario.citations ? checkCitations(session.result?.text ?? '', work) : null;
  session.diff = git(['diff', '--stat'], work);
  session.diffPatch = git(['diff'], work).slice(0, 20000);
  rmSync(work, { recursive: true, force: true });
  return session;
}

/**
 * stream-json → session. One assistant event is emitted per content block, all sharing
 * the message id, so requests are grouped by message id. parent_tool_use_id marks a
 * subagent's traffic; the Task call that spawned it names the subagent.
 */
export function parseSession(lines) {
  const requests = [];
  const byId = new Map();
  const toolResults = new Map();
  const taskCalls = new Map();
  const compactions = [];
  let init = null;
  let result = null;
  for (const l of lines) {
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    if (j.type === 'system' && j.subtype === 'init') {
      init = { model: j.model, tools: j.tools, mcpServers: j.mcp_servers };
    } else if (j.type === 'system' && j.subtype === 'compact_boundary') {
      compactions.push({ trigger: j.compact_metadata?.trigger, preTokens: j.compact_metadata?.pre_tokens });
    } else if (j.type === 'assistant') {
      const m = j.message;
      let r = byId.get(m.id);
      if (!r) {
        r = { id: m.id, model: m.model, usage: m.usage, agent: j.parent_tool_use_id ?? 'main', blocks: [] };
        byId.set(m.id, r);
        requests.push(r);
      }
      for (const b of m.content ?? []) {
        if (b.type === 'text') r.blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking') r.blocks.push({ type: 'thinking', chars: (b.thinking ?? '').length });
        else if (b.type === 'tool_use') {
          r.blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
          if (b.name === 'Task' || b.name === 'Agent') taskCalls.set(b.id, b.input?.description ?? b.input?.subagent_type ?? 'subagent');
        }
      }
    } else if (j.type === 'user') {
      for (const b of j.message?.content ?? []) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('');
        toolResults.set(b.tool_use_id, {
          chars: text.length,
          lines: text.split('\n').length,
          isError: !!b.is_error,
          trimmedByAnyrayHook: HOOK_FOOTER.test(text),
          preview: text.length > 1500 ? `${text.slice(0, 1000)}\n…\n${text.slice(-400)}` : text,
        });
      }
    } else if (j.type === 'result') {
      // Multi-turn sessions emit one result per user turn: cost and modelUsage are
      // already session totals, turns and answer text accumulate.
      result = {
        subtype: j.subtype,
        text: [result?.text, j.result ?? ''].filter(Boolean).join('\n\n'),
        userTurns: (result?.userTurns ?? 0) + 1,
        numTurns: (result?.numTurns ?? 0) + (j.num_turns ?? 0),
        costUsd: j.total_cost_usd,
        durationMs: j.duration_ms,
        usage: j.usage,
        modelUsage: j.modelUsage,
      };
    }
  }
  for (const r of requests) {
    if (r.agent !== 'main') r.agentLabel = taskCalls.get(r.agent) ?? 'subagent';
    for (const b of r.blocks) if (b.type === 'tool_use') b.result = toolResults.get(b.id) ?? null;
  }
  return { init, requests, result, compactions, subagents: [...taskCalls.entries()].map(([id, label]) => ({ id, label })) };
}

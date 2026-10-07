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
import { createHash } from 'node:crypto';
import { withArmEnv, assertArmEnvSafe, UNSET } from './armEnv.mjs';
import { configureWithConnect, connectActivity, ANYRAY_BIN } from './connectArm.mjs';
import { KINDS_HEADER, RESULT_HEADER, withKindsHeader, tallyKinds, earlyHoldout } from './optimizationKinds.mjs';
import { startResultProxy } from './resultProxy.mjs';
import { resolveBenchKey } from './benchKey.mjs';
import { bedrockDirectEnv } from './bedrock.mjs';
import { checkConnectSession, assertChecks } from './connectChecks.mjs';

// Hook output: a digest/tee footer, an omitted-lines marker, or a Read trim's
// `… [N lines · retrieve ctx_…]` elision.
const HOOK_FOOTER = /\[anyray-hook[^\]]*\]|omitted by anyray|\[\d+ lines · retrieve ctx_/;
/**
 * Where each scenario's repo is cloned once and reused. Not the OS temp dir: it prunes
 * old files there, which leaves a clone without its HEAD and every later run failing.
 */
export const repoCacheDir = (env = process.env) =>
  env.ANYRAY_BENCH_REPO_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'anyray-bench-repos');

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

const keychainOauth = () =>
  JSON.parse(execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' })).claudeAiOauth;

function oauthToken() {
  if (process.env.ANYRAY_UPSTREAM_TOKEN) return process.env.ANYRAY_UPSTREAM_TOKEN;
  return keychainOauth().accessToken;
}

/** When the seat token the arms are handed expires (ms), or null when that is not known here. */
function seatTokenExpiresAt() {
  if (process.env.ANYRAY_UPSTREAM_TOKEN) return null; // the caller's own token: its lifetime is theirs to know
  try {
    const at = keychainOauth().expiresAt;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The idle time a scenario plans between its user turns: the sum of its follow-up delays. */
export function pauseBudgetMs(scenario) {
  return (scenario.followups ?? []).reduce((sum, _, i) => sum + followupDelayMs(scenario, i), 0);
}

const WORK_ALLOWANCE_MS = 15 * 60000;

/**
 * A session is handed the seat's access token once and cannot refresh it. A scenario that
 * idles for hours outlives a token with less than that left, and the arm then fails at a
 * late turn with the pauses already spent. So: the token must last the pauses plus 15
 * minutes of work. Nothing to check without pauses or without a readable expiry.
 */
export function tokenOutlastsPauses(scenario, { expiresAtMs, nowMs = Date.now() }) {
  const pause = pauseBudgetMs(scenario);
  if (!pause || expiresAtMs == null) return { ok: true };
  const left = expiresAtMs - nowMs;
  if (left >= pause + WORK_ALLOWANCE_MS) return { ok: true };
  const min = (ms) => Math.floor(ms / 60000);
  return {
    ok: false,
    why:
      `the Claude seat token expires in ${min(left)} min, before this scenario's pauses (${min(pause)} min) and its work are over; ` +
      'the session cannot refresh it. Start again once Claude Code has renewed the token, or set ANYRAY_UPSTREAM_TOKEN to a long-lived one (claude setup-token)',
  };
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

/**
 * The Anyray arm's key getters: ANYRAY_BENCH_CLIENT_KEY (its own tenant), else
 * ANYRAY_CLIENT_KEY. connect's non-interactive enrollment needs one of them; the harness
 * header falls back to this machine's enrolled key. (run_agent warns once on fallback.)
 */
export const liveKeys = (env = process.env, profile = connect) => {
  const key = () => resolveBenchKey(env, () => {}).key ?? undefined;
  return { serviceKey: key, clientKey: () => key() || profile().clientKey };
};
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

/** `dir` is the top of its own git repository (not merely inside someone else's). */
const isRepoRoot = (dir) => {
  try {
    return realpathSync(git(['rev-parse', '--show-toplevel'], dir)) === realpathSync(dir);
  } catch {
    return false;
  }
};

/**
 * A fresh working copy of the scenario's repo at its pinned ref, with the scenario's
 * patch applied. The clone is cached; each session gets its own `git worktree`-free
 * copy via a local clone, so the two arms never share files.
 */
export function prepareRepo(scenario, scenarioDir, { cacheDir = repoCacheDir(), workParent = tmpdir() } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, scenario.repo.git.replace(/[^a-z0-9]+/gi, '_'));
  // A clone that lost its metadata is not a repository any more: clone it again.
  if (existsSync(cached) && !isRepoRoot(cached)) rmSync(cached, { recursive: true, force: true });
  if (!existsSync(cached)) execFileSync('git', ['clone', '-q', scenario.repo.git, cached]);
  try {
    git(['cat-file', '-e', `${scenario.repo.ref}^{commit}`], cached);
  } catch {
    git(['fetch', '-q', 'origin'], cached);
  }
  mkdirSync(workParent, { recursive: true });
  const work = mkdtempSync(join(workParent, 'anyray-bench-work-'));
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
 * The connect hook switches (`fleetHookPolicy.<name>` = on|off) one session pins:
 * `hookPosture`, plus `readTrim` (the `--read-trim` spelling of readTrim=on).
 */
export function sessionHookPosture({ readTrim = false, hookPosture = {} } = {}) {
  if (readTrim && hookPosture.readTrim === 'off') throw new Error('readTrim is set both on and off for this arm');
  return { ...hookPosture, ...(readTrim ? { readTrim: 'on' } : {}) };
}

/** `logRead=on, digest=off`. */
const postureList = (pinned) => Object.entries(pinned).map(([k, v]) => `${k}=${v}`).join(', ');

/** The flag a posture came from, for errors: readTrim=on alone is still `--read-trim`. */
const postureFlag = (pinned) => (postureList(pinned) === 'readTrim=on' ? '--read-trim' : `--hook-posture ${postureList(pinned)}`);

/** A switch that is on may need the transcript (readTrim's hook waits for a retrieve in it). */
const pinsAnyOn = (pinned) => Object.values(pinned).includes('on');

/**
 * Pin `pinned` over the profile's cached fleet posture. On a gateway this machine is not
 * enrolled on, the arm otherwise has no hooks, so digest goes off too (unless pinned):
 * the pinned switches are the only hook change. Experiment policies (hookPolicies) go.
 */
function pinHookPosture(profile, pinned, enrolled) {
  profile.fleetHookPolicy = enrolled ? { ...(profile.fleetHookPolicy ?? {}), ...pinned } : { digest: 'off', ...pinned };
  delete profile.hookPolicies;
  return profile;
}

/**
 * `--read-trim`, `--hook-posture`: set anyray-connect hook switches for THIS session only.
 *
 * The hook takes each switch from the fleet posture cached in $HOME/.anyray/connect.json
 * (`fleetHookPolicy.<name>`, e.g. readTrim); there is no env var or flag for them, and
 * the gateway's connect policy is shared. So the hooks and the MCP server run under a
 * private HOME:
 *   .anyray/connect.json   this machine's profile with the switches pinned (pinHookPosture).
 *   .claude/settings.json  the arm's env (gateway + headers: where hook and MCP send) and
 *                          the anyray_* approvals.
 *   .claude.json           the MCP registration the hook checks before minting handles.
 * Key refresh is off there, so no policy sync rewrites the copy mid-session (and the round
 * fails if it changed anyway: hookPostureAtEnd). With a switch on, the arm keeps session
 * persistence on and deletes its transcript afterwards: the read trim only trims a Read
 * once the main transcript shows a successful anyray_retrieve.
 */
function hookPostureHome(cfgDir, env, enrolled, pinned, { connect: readProfile, bin }) {
  const home = privateArmHome(cfgDir);
  mkdirSync(join(home, '.anyray'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const profile = pinHookPosture(readProfile(), pinned, enrolled);
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
  return { home, posture: profile.fleetHookPolicy, pinned, env: { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' } };
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

/**
 * Each pinned switch as the session's profile copy ended with it (policy sync, or connect
 * rewriting the profile, could change it), and which ones moved. A switch is compared as
 * written: one that is gone is `absent` (connect keeps only the switches it knows), one in
 * a profile that no longer parses is `unreadable`; both are drift.
 */
export function hookPostureAtEnd({ home, posture, pinned }) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(join(home, '.anyray', 'connect.json'), 'utf8')).fleetHookPolicy ?? {};
  } catch {
    policy = null;
  }
  const atEnd = Object.fromEntries(Object.keys(pinned).map((k) => [k, policy === null ? 'unreadable' : policy[k] ?? 'absent']));
  return { set: posture, pinned, atEnd, drifted: Object.keys(pinned).filter((k) => atEnd[k] !== pinned[k]) };
}

/** Why the round fails when a pinned switch drifted; null when every pin held. */
export const postureDriftMessage = ({ pinned, atEnd, drifted }) =>
  drifted.length ? `the hook posture did not hold in the arm's profile: ${drifted.map((k) => `${k} set ${pinned[k]}, ended ${atEnd[k]}`).join('; ')}` : null;

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
  ...liveKeys(),
  anyrayHooks,
  binExists: () => existsSync(ANYRAY_BIN),
  bin: ANYRAY_BIN,
  configureArm: configureWithConnect, // anyray-connect configures the arm in its private HOME
};

/** A connect binary's identity for the result file: its sha256 prefix, never its path. */
export function binDigest(bin) {
  try {
    return { sha256: createHash('sha256').update(readFileSync(bin)).digest('hex').slice(0, 16) };
  } catch {
    return { sha256: null };
  }
}

const NO_CONNECT = () => ({ configured: false, reason: 'anyray-connect not used' });

/**
 * `--read-trim` / `--hook-posture` on the connect-configured arm: the session already runs
 * under the HOME anyray-connect enrolled, so the switches go into THAT profile (pinned over
 * the posture connect cached, hookPolicies dropped), with key refresh off so no policy sync
 * rewrites them mid-session. Same posture as hookPostureHome on an enrolled gateway.
 */
function pinConnectPosture(home, pinned) {
  const f = join(home, '.anyray', 'connect.json');
  let profile;
  try {
    profile = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new Error(`${postureFlag(pinned)}: anyray-connect wrote no profile to the arm HOME`);
  }
  pinHookPosture(profile, pinned, true);
  writeFileSync(f, JSON.stringify(profile, null, 2));
  chmodSync(f, 0o600); // client key
  return { home, posture: profile.fleetHookPolicy, pinned, env: { HOME: home, ANYRAY_REFRESH_DISABLE: 'true' } };
}

/** What setup records for the pinned switches (`base`: what they are pinned over; `where`: which profile). */
const describePosture = (pinned, base, where) => ({
  pinned,
  how: `for this session only: fleetHookPolicy = ${base} + ${Object.entries(pinned).map(([k, v]) => `${k} ${v}`).join(', ')} ${where} (key refresh off, so no policy sync rewrites it; the round fails if it ends otherwise)${pinsAnyOn(pinned) ? '; session persistence on so the hook can read the transcript' : ''}`,
});

// Headers whose value the harness sets for the Anyray arm (route, credential, run tag,
// requested kinds); ANYRAY_BENCH_EXTRA_HEADERS may not replace them.
const OWNED_HEADERS = /^(authorization|x-api-key|x-anyray-(api-key|metadata|optimization-kinds|provider|auth-mode))$/i;

/**
 * `ANYRAY_BENCH_EXTRA_HEADERS`: extra gateway headers for the Anyray arm, newline-separated
 * "name: value" (e.g. to select a gateway-side experiment by header). --arm-env cannot
 * carry them: it refuses ANTHROPIC_CUSTOM_HEADERS, which holds the arm's route.
 */
const benchHeaderLines = (varName, raw) => {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const name = /^([A-Za-z0-9-]+):\s*\S/.exec(l)?.[1];
    if (!name) throw new Error(`${varName} expects "name: value" lines, got "${l}"`);
    if (OWNED_HEADERS.test(name)) throw new Error(`${varName} cannot set ${name}: the harness sets it for the arm`);
  }
  return lines;
};
const headerName = (line) => line.slice(0, line.indexOf(':')).trim().toLowerCase();

export function benchExtraHeaders(env = process.env) {
  return benchHeaderLines('ANYRAY_BENCH_EXTRA_HEADERS', env.ANYRAY_BENCH_EXTRA_HEADERS);
}

/**
 * ANYRAY_BENCH_SHARED_HEADERS: headers every Anyray arm carries, for a setting both arms must
 * share (x-anyray-tool-defer: off, to match a production default the dev org differs from).
 * Never the treatment, so a name may not also be in ANYRAY_BENCH_EXTRA_HEADERS.
 */
export function benchSharedHeaders(env = process.env) {
  const shared = benchHeaderLines('ANYRAY_BENCH_SHARED_HEADERS', env.ANYRAY_BENCH_SHARED_HEADERS);
  const treatment = new Set(benchExtraHeaders(env).map(headerName));
  const both = shared.map(headerName).filter((n) => treatment.has(n));
  if (both.length) throw new Error(`${both.join(', ')} is in both ANYRAY_BENCH_SHARED_HEADERS and ANYRAY_BENCH_EXTRA_HEADERS: a shared header cannot be the treatment`);
  return shared;
}

// The account identity a real enrolled user's Claude Code has in ~/.claude.json. A private
// HOME without it runs as an anonymous install, which is not the session a customer gets.
const IDENTITY_KEYS = ['userID', 'oauthAccount'];
const readRealClaudeJson = () => {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  } catch {
    return {};
  }
};

/** Copy the identity keys (only those) into the arm HOME's .claude.json; returns the keys copied. */
function copyIdentity(home, real) {
  const file = join(home, '.claude.json');
  let dst = {};
  try {
    dst = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  const copied = IDENTITY_KEYS.filter((k) => real[k] !== undefined && dst[k] === undefined);
  for (const k of copied) dst[k] = real[k];
  writeFileSync(file, JSON.stringify(dst));
  chmodSync(file, 0o600);
  return copied;
}

/** The unset keys that are back in the arm HOME's user settings (something re-applied connect's config). */
export function restoredKeys(home, keys) {
  if (!keys.length) return [];
  let env = {};
  try {
    env = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).env ?? {};
  } catch {}
  return keys.filter((k) => k in env);
}

/** Drop --arm-env's unset keys from the user settings connect wrote, which the session also reads. */
function unsetInUserSettings(home, env) {
  const keys = Object.keys(env).filter((k) => env[k] === UNSET);
  const file = join(home, '.claude', 'settings.json');
  if (!keys.length || !existsSync(file)) return;
  const user = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of keys) delete user.env?.[k];
  writeFileSync(file, JSON.stringify(user));
}

/**
 * Merge `policies` ({name: boolean}) into `clientToolPolicies` of the connect profile under
 * `home`, keeping every other field; returns the resulting switches. Throws when connect
 * wrote no profile, since then nothing would read them.
 */
export function setClientToolPolicies(home, policies) {
  const p = join(home, '.anyray', 'connect.json');
  const profile = JSON.parse(readFileSync(p, 'utf8'));
  profile.clientToolPolicies = { ...(profile.clientToolPolicies ?? {}), ...policies };
  writeFileSync(p, JSON.stringify(profile, null, 2));
  chmodSync(p, 0o600); // holds the client key
  return profile.clientToolPolicies;
}

/**
 * The arm's Claude Code settings and MCP config (written by the caller), the setting
 * sources and HOME the session runs under (`home` null = the real one), extra process env
 * (`procEnv`) and what to record in setup. `deps` reads this machine's anyray-connect
 * install; tests inject their own. `readTrim` / `hookPosture` (Anyray arm only) pin connect
 * hook switches for the session (`trimHome`, key refresh off); with one on, the session
 * must persist its transcript: `persistSession`.
 *
 * The Anyray arm is configured by anyray-connect itself, the way an enrolled user gets it,
 * in a private HOME the session then runs under. If connect can't (no service key, no
 * binary, it fails), the arm falls back to the harness config and records why.
 */
export function armConfig({ arm, gatewayUrl, runTag, readTrim = false, hookPosture = {}, integrationLevel = null, clientToolPolicies = null, cfgDir, env: armEnv = {}, kinds = null, extraHeaders = [], provider = 'anthropic', bedrock = null, bare = false, connectBin = null, deps = LIVE }) {
  assertArmEnvSafe(armEnv);
  // --connect-bin-b: this arm alone is configured by another anyray-connect build, so its
  // hooks and MCP server run that build too (connect wires them to the binary that ran).
  if (connectBin && arm === 'anyray') deps = { ...deps, bin: connectBin, binExists: () => existsSync(connectBin) };
  const anyray = arm === 'anyray';
  const settings = { env: {} };
  const mcp = { mcpServers: {} };
  let trimHome = null;
  // --arm-env goes into the SESSION's settings.env only, on top of the gateway env. The
  // private HOME (read trim / retrieval MCP) keeps just the gateway env its hooks and MCP need.
  const real = { settingSources: '', home: null, procEnv: {} }; // the harness config's session
  const onBedrock = provider === 'bedrock';
  // Direct on Bedrock: Claude Code's own Bedrock client, signed with this machine's AWS profile.
  if (!anyray) return { settings: withArmEnv(settings, armEnv), mcp, trimHome, persistSession: false, ...real, procEnv: onBedrock ? bedrockDirectEnv(bedrock) : {}, setup: null };
  const pinned = sessionHookPosture({ readTrim, hookPosture });
  const pins = Object.keys(pinned).length > 0;
  if (pins && !deps.binExists()) throw new Error(`${postureFlag(pinned)} needs anyray-connect installed`);

  // --bare: what a seat gets with ONLY the base URL changed. No anyray-connect, so no
  // hooks, MCP server, skills or first-party flag; the gateway forwards the request as
  // sent (optimization off, as on the /k/<key>/ lane) and attributes it. Same session
  // shape as the direct arm otherwise: no setting sources, the real HOME.
  if (bare) {
    settings.env = {
      ANTHROPIC_BASE_URL: gatewayUrl,
      ANTHROPIC_CUSTOM_HEADERS: [
        'x-anyray-provider: anthropic',
        'x-anyray-auth-mode: passthrough',
        `x-anyray-api-key: ${deps.clientKey()}`,
        'x-anyray-optimize: off',
        'x-anyray-tool-defer: off', // an org-wide toolDefer would rewrite the catalog
        `x-anyray-metadata: ${JSON.stringify(runTag)}`,
        ...extraHeaders,
      ].join('\n'),
    };
    return {
      settings: withArmEnv(settings, armEnv), mcp, trimHome, persistSession: false, ...real,
      setup: { configuredBy: 'harness (bare base URL)', clientSide: 'none: base URL and headers only, optimization and tool deferral off' },
    };
  }

  // The product path. The HOME is confined to the session dir before connect writes to it.
  const connectHome = privateArmHome(cfgDir);
  mkdirSync(join(connectHome, '.claude'), { recursive: true }); // connect configures Claude Code only where it is installed
  // Bedrock is the org's provider account, so connect's org lane; a seat rides the subscription lane.
  const lane = onBedrock ? 'org' : 'subscription';
  const c = (deps.configureArm ?? NO_CONNECT)({ home: connectHome, gatewayUrl, clientKey: deps.serviceKey?.(), lane, integrationLevel, ...(connectBin ? { bin: connectBin } : {}) });
  if (integrationLevel && !c.configured) throw new Error(`--integration-level needs a Connect binary that applies the requested level: ${c.reason}`);
  // The harness fallback pins Anthropic with the seat token: not a Bedrock client at all.
  if (onBedrock && !c.configured) throw new Error(`--provider bedrock needs anyray-connect to configure the Anyray arm: ${c.reason}`);
  if (c.configured) {
    if (integrationLevel && c.setup?.appliedIntegrationLevel !== integrationLevel) throw new Error(`anyray-connect did not report the requested integration level (${integrationLevel}); use a Connect build with integration-level support`);
    if (c.checks) assertChecks(c.checks, 'anyray-connect left the arm misconfigured');
    const { env: connectEnv, ...connectSetup } = c.setup; // `env` in setup is --arm-env's
    // --client-tool-policy: connect's local switches for what its MCP server advertises
    // (clientToolPolicies in the arm's connect profile, read at each server start).
    if (clientToolPolicies && Object.keys(clientToolPolicies).length) connectSetup.clientToolPolicies = setClientToolPolicies(connectHome, clientToolPolicies);
    const identity = copyIdentity(connectHome, (deps.realClaudeJson ?? readRealClaudeJson)());
    unsetInUserSettings(connectHome, armEnv);
    // connect's refresh (spawned when its MCP server starts) re-applies its config and
    // would write an unset key straight back, seconds into the session: keep it off.
    const unsetKeys = Object.keys(armEnv).filter((k) => armEnv[k] === UNSET);
    // The session reads connect's user settings (env, hooks, permissions, skills) under
    // that HOME; --settings repeats connect's env with the run's metadata tag, so the
    // gateway's traces are attributable per round.
    const headers = String(c.settings.env?.ANTHROPIC_CUSTOM_HEADERS ?? '')
      .split('\n')
      .filter((h) => h && !/^x-anyray-metadata:/i.test(h));
    settings.env = { ...c.settings.env, ANTHROPIC_CUSTOM_HEADERS: withKindsHeader([...headers, `x-anyray-metadata: ${JSON.stringify(runTag)}`, ...extraHeaders].join('\n'), kinds) };
    if (pins) trimHome = pinConnectPosture(connectHome, pinned);
    return {
      settings: withArmEnv(settings, armEnv),
      mcp: { mcpServers: c.mcpServers },
      trimHome,
      persistSession: pinsAnyOn(pinned),
      settingSources: 'user',
      home: connectHome,
      procEnv: trimHome || unsetKeys.length ? { ANYRAY_REFRESH_DISABLE: 'true' } : {}, // hooks + MCP inherit it
      unsetKeys,
      setup: {
        configuredBy: 'anyray-connect',
        clientSide: 'anyray-connect enrolled on this gateway with the client key in a private HOME',
        settingSources: 'user (what connect wrote to the private HOME)',
        readTrim: pinned.readTrim === 'on'
          ? 'on for this session only: fleetHookPolicy.readTrim = on in the profile anyray-connect wrote to the arm HOME (key refresh off); session persistence on so the hook can read the transcript'
          : pinned.readTrim === 'off' ? 'off for this session only: fleetHookPolicy.readTrim = off in the profile anyray-connect wrote to the arm HOME (key refresh off)'
          : 'fleet policy (as anyray-connect cached it in the arm HOME)',
        ...(pins ? { hookPosture: describePosture(pinned, 'the posture anyray-connect cached', 'in the profile anyray-connect wrote to the arm HOME') } : {}),
        ...connectSetup,
        connectEnv,
        connectChecks: c.checks ?? null, // what connect wrote, checked before the session
        ...(unsetKeys.length ? { refresh: `off for this session (--arm-env unsets ${unsetKeys.join(', ')}, which a refresh would write back)` } : {}),
        identity, // which ~/.claude.json account keys the arm HOME carries (names only)
        connectBin: binDigest(deps.bin), // which anyray-connect build configured this arm
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
      ...extraHeaders,
    ].join('\n'), kinds),
  };
  if (pins) {
    trimHome = hookPostureHome(cfgDir, settings.env, enrolled, pinned, deps);
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
    settings: withArmEnv(settings, armEnv), mcp, trimHome, persistSession: pinsAnyOn(pinned), ...real,
    setup: { configuredBy: 'harness (fallback)', fallbackReason: c.reason, ...(connectBin ? { connectBin: binDigest(connectBin) } : {}) },
  };
}

/**
 * The session's own model traffic goes through the local result proxy (which forwards to
 * the gateway); hooks and MCP keep the gateway URL they were configured with.
 */
export const routeViaProxy = (settings, proxyUrl) => ({ ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: proxyUrl } });

/** The arm's setup, minus secrets — recorded in the report. */
export function describeSetup({ arm, model, gatewayUrl, runTag, maxTurns, readTrim = false, hookPosture = {}, integrationLevel = null, enrolled, env = {}, kinds = null, kindsSource = null, tenant = null, noSubagents = false, extraHeaders = [], provider = 'anthropic', bedrock = null, bare = false }) {
  const anyray = arm === 'anyray';
  const onBedrock = provider === 'bedrock';
  const pinned = anyray ? sessionHookPosture({ readTrim, hookPosture }) : {};
  const pins = Object.keys(pinned).length > 0;
  readTrim = pinned.readTrim === 'on';
  if (anyray && bare) {
    return {
      ...describeSetup({ arm: 'direct', model, gatewayUrl, runTag, maxTurns, env, noSubagents }),
      arm,
      endpoint: `${gatewayUrl}/v1/messages`,
      auth: `passthrough: subscription OAuth upstream + Anyray key from ${tenant?.keyVar ?? '~/.anyray/connect.json'}`,
      tenant,
      headers: {
        'x-anyray-provider': 'anthropic', 'x-anyray-auth-mode': 'passthrough', 'x-anyray-api-key': '<client key>', 'x-anyray-optimize': 'off', 'x-anyray-tool-defer': 'off', 'x-anyray-metadata': runTag,
        ...Object.fromEntries(extraHeaders.map((h) => [h.slice(0, h.indexOf(':')).trim(), '<ANYRAY_BENCH_EXTRA_HEADERS>'])),
      },
      clientSide: 'none (bare base URL: no anyray-connect, no first-party flag, optimization and tool deferral off)',
    };
  }
  const onGateway = enrolled ?? (anyray && clientSideApplies(gatewayUrl));
  let client;
  try {
    client = `Claude Code ${execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()} (headless, claude -p)`;
  } catch {
    client = 'Claude Code (headless, claude -p)';
  }
  return {
    arm,
    ...(anyray && integrationLevel ? { integrationLevel } : {}),
    client,
    provider,
    model: onBedrock && !anyray ? bedrock?.model ?? model : model,
    endpoint: anyray ? `${gatewayUrl}/v1/messages` : onBedrock ? `bedrock-runtime.${bedrock?.region} (InvokeModel, Claude Code's own client)` : 'https://api.anthropic.com/v1/messages',
    auth: onBedrock
      ? anyray ? `org lane: Anyray key from ${tenant?.keyVar ?? 'the environment'} as bearer; the gateway holds the AWS credentials (served as ${bedrock?.model ?? 'a Bedrock id'})` : `AWS profile "${bedrock?.profile}" in ${bedrock?.region} (CLAUDE_CODE_USE_BEDROCK=1)`
      : !anyray ? 'subscription OAuth'
      : tenant?.keyVar ? `passthrough: subscription OAuth upstream + Anyray key from ${tenant.keyVar}`
      : 'passthrough: subscription OAuth upstream + Anyray client key (~/.anyray/connect.json)',
    tenant: anyray ? tenant : null, // where the gateway keeps this arm's regret guard, cooloffs, holdouts
    headers: anyray
      ? {
          ...(onBedrock ? { authorization: 'Bearer <client key>' } : { 'x-anyray-provider': 'anthropic', 'x-anyray-auth-mode': 'passthrough', 'x-anyray-api-key': '<client key>' }), 'x-anyray-metadata': runTag,
          ...Object.fromEntries(extraHeaders.map((h) => [h.slice(0, h.indexOf(':')).trim(), '<ANYRAY_BENCH_EXTRA_HEADERS>'])),
          ...(kinds?.length ? { [KINDS_HEADER]: kinds.join(',') } : {}),
        }
      : {},
    optimizationKinds: anyray && kinds?.length
      ? { requested: kinds, source: kindsSource, header: KINDS_HEADER, feedback: `${RESULT_HEADER}, read per request by a local pass-through proxy` }
      : null,
    hooks: anyray && pins
      ? { PostToolUse: ['anyray-connect __anyray-hook'], PostToolUseFailure: ['anyray-connect __anyray-hook'] }
      : anyray && onGateway
      ? Object.fromEntries(Object.entries(anyrayHooks()).map(([e, g]) => [e, g.flatMap((x) => x.hooks.map((h) => h.command.replace(/^.*\//, '')))]))
      : {},
    clientSide: anyray ? (onGateway ? 'anyray-connect hooks + MCP (this machine is enrolled on this gateway)' : 'retrieval MCP only, pointed at this gateway; no client hooks (this machine is enrolled on a different gateway)') : null,
    mcpServers: anyray ? { anyray: { type: 'stdio', command: 'anyray-connect __anyray-mcp-server claude' } } : {},
    tools: noSubagents
      ? `Claude Code defaults minus subagents (${subagentArgs(true).join(' ')}), permissions bypassed`
      : 'Claude Code defaults (incl. Task → subagents), permissions bypassed',
    maxTurns,
    settingSources: 'none (user/project settings ignored)',
    readTrim: !anyray ? null
      : readTrim
        ? `on for this session only: hooks + MCP under a private HOME whose profile copy has fleetHookPolicy ${onGateway ? '= cached posture + readTrim on' : '{digest: off, readTrim: on}'} (key refresh off); session persistence on so the hook can read the transcript`
        : pinned.readTrim === 'off' ? 'off for this session only: pinned in the private HOME profile copy (key refresh off)'
        : onGateway ? 'fleet policy (as cached in ~/.anyray/connect.json)' : 'off (no client hooks)',
    ...(pins ? { hookPosture: describePosture(pinned, onGateway ? 'the cached posture' : '{digest: off}', 'in a private HOME copy of the profile, which the hooks and MCP run under') } : {}),
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
/** Every tracked file in the checkout, relative to its root (empty when it is not a git checkout). */
export function checkoutFiles(work) {
  try {
    return git(['ls-files'], work).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function checkCitations(text, work, files = checkoutFiles(work)) {
  const lineCount = (rel) => {
    try {
      return readFileSync(join(work, rel), 'utf8').split('\n').length;
    } catch {
      return null;
    }
  };
  // ref -> 'exact' (path from the checkout root) | 'suffix' (the path names exactly one
  // file by its tail, e.g. `cli/main.py` for `pkg/cli/main.py`) | 'ambiguous' (the tail
  // names several files, so the citation does not say which) | null (no such file or line).
  const seen = new Map();
  for (const m of text.matchAll(/([\w./-]+\.(?:go|md|mod|ts|js|py|ya?ml|json)):(\d+)/g)) {
    const [ref, file, line] = m;
    if (seen.has(ref)) continue;
    const rel = file.replace(/^\.\//, '');
    const n = lineCount(rel);
    let how = null;
    if (n !== null) how = n >= Number(line) ? 'exact' : null;
    else {
      const tails = files.filter((f) => f.endsWith(`/${rel}`));
      if (tails.length === 1) how = lineCount(tails[0]) >= Number(line) ? 'suffix' : null;
      else if (tails.length > 1) how = 'ambiguous';
    }
    seen.set(ref, how);
  }
  const count = (how) => [...seen.values()].filter((v) => v === how).length;
  const exact = count('exact');
  const bySuffix = count('suffix');
  return {
    total: seen.size,
    resolved: exact + bySuffix, // what the solved test counts
    exact,
    bySuffix,
    ambiguous: count('ambiguous'),
    unresolved: [...seen].filter(([, how]) => how !== 'exact' && how !== 'suffix').map(([r]) => r).slice(0, 20),
  };
}

// Claude Code's own files (persisted tool results, its config), which a session may read,
// and the full output an anyray-hook digest points at (its retrieval path).
const CLIENT_OWN_PATH = /\/\.claude(\/|$)|\/claude-\d+\/|\/\.anyray\/hook-tee\//;
// Absolute files a shell command writes: `> /f`, `>> /f`, `tee [-a] /f`.
const SHELL_WRITE = /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?(\/[^\s;&|"')]+)/g;

/**
 * Tool calls that reached outside the session's own checkout: a Read, Grep or Glob given
 * an absolute path elsewhere, or a shell `cd` to one. Another copy of the repo on the
 * machine (found with a wide `find`) is the case this catches: the session then works on
 * files the grader never sees. A file the session itself wrote earlier (a shell redirect,
 * `tee`, or the Write tool) is its own output, wherever it lives.
 */
export function outsideCheckout(requests, work) {
  const roots = [work];
  try {
    roots.push(realpathSync(work));
  } catch {}
  const inside = (p) => roots.some((r) => p === r || p.startsWith(`${r}/`));
  const dirs = new Map();
  const written = new Set();
  let count = 0;
  for (const r of requests) {
    for (const b of r.blocks ?? []) {
      if (b.type !== 'tool_use') continue;
      const input = b.input ?? {};
      const paths = ['file_path', 'path', 'notebook_path'].map((k) => input[k]).filter((v) => typeof v === 'string' && v.startsWith('/'));
      if (b.name === 'Bash' && typeof input.command === 'string') {
        for (const m of input.command.matchAll(/(?:^|[;&|(]\s*|\s)cd\s+["']?(\/[^\s;&|"')]+)/g)) paths.push(m[1]);
      }
      for (const p of paths) {
        if (inside(p) || CLIENT_OWN_PATH.test(p) || written.has(p)) continue;
        count++;
        const dir = p.split('/').slice(0, 4).join('/');
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
      // Recorded after this call's own paths, so only a LATER read of the file is excused.
      if (b.name === 'Bash' && typeof input.command === 'string') for (const m of input.command.matchAll(SHELL_WRITE)) written.add(m[1]);
      if (b.name === 'Write' && typeof input.file_path === 'string') written.add(input.file_path);
    }
  }
  return { count, dirs: Object.fromEntries([...dirs].sort((x, y) => y[1] - x[1]).slice(0, 5)) };
}

/** The idle gap before the i-th follow-up: `followupDelaySec` is one number or a list (last repeats). */
export function followupDelayMs(scenario, i) {
  const d = scenario.followupDelaySec ?? 0;
  const sec = Array.isArray(d) ? (d[i] ?? d.at(-1) ?? 0) : d;
  return sec * 1000;
}

const WARM_UP_PROMPT = 'Reply with the single word: ok';

/** The timed session's argv with the task swapped for a one-turn no-op. */
export function warmUpArgs(args, task) {
  const out = [...args];
  const p = out.indexOf('-p');
  if (task !== null && out[p + 1] === task) out[p + 1] = WARM_UP_PROMPT;
  else out.splice(p + 1, out[p + 1] === '--input-format' ? 2 : 0, WARM_UP_PROMPT);
  const t = out.indexOf('--max-turns');
  out[t + 1] = '1';
  if (!out.includes('--no-session-persistence')) out.push('--no-session-persistence');
  return out;
}

/** Run the warm-up; its cost is recorded apart from the session's and never added to it. */
function warmUpSession({ args, cwd, env, task }) {
  return new Promise((resolve) => {
    const child = spawn('claude', warmUpArgs(args, task), { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(timer);
      let costUsd = null;
      for (const l of out.split('\n')) {
        try {
          const j = JSON.parse(l);
          if (j.type === 'result') costUsd = j.total_cost_usd ?? null;
        } catch {}
      }
      resolve({ ran: true, costUsd });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ran: false, costUsd: null });
    });
  });
}

/** Claude Code flags that keep a session from spawning subagents (Task, Workflow). */
export function subagentArgs(noSubagents) {
  return noSubagents ? ['--disallowed-tools', 'Task', 'Workflow'] : [];
}

/**
 * Run the scenario on one arm. Returns the parsed session: every model request with
 * its usage and agent (main / subagent), tool calls and results, the final result,
 * the check outcome and the diff the agent left behind.
 */
export async function runAgent({ arm, scenario, scenarioDir, model, gatewayUrl, runTag, readTrim = false, hookPosture = {}, integrationLevel = null, clientToolPolicies = null, env: armEnv, kinds = null, extraHeaders = [], noSubagents = false, provider = 'anthropic', bedrock = null, bare = false, warmUp = false, redraw = null, connectBin = null, timeoutMs = (scenario.timeoutMin ?? 6) * 60000 }) {
  // Fail in seconds, not at hour three: a pause scenario needs a seat token that outlasts it.
  if (provider !== 'bedrock' && pauseBudgetMs(scenario)) {
    const token = tokenOutlastsPauses(scenario, { expiresAtMs: seatTokenExpiresAt() });
    if (!token.ok) throw new Error(token.why);
  }
  const work = prepareRepo(scenario, scenarioDir);
  const cfgDir = mkdtempSync(join(tmpdir(), 'anyray-bench-cfg-'));
  bare = bare && arm === 'anyray';
  const { settings, mcp, trimHome, persistSession, settingSources, home, procEnv, setup, unsetKeys = [] } = armConfig({ arm, gatewayUrl, runTag, readTrim, hookPosture, integrationLevel, clientToolPolicies, cfgDir, env: armEnv, kinds, extraHeaders, provider, bedrock, bare, connectBin });
  // Requested kinds: read each response's feedback header through a local pass-through.
  // A bare arm goes through it too, for the budget-notice outcome of each request.
  // `redraw` ({ signal, report }): the caller restarts the pair when the gateway drew this
  // session into a holdout. Watch the first responses for one and report it; stop when the
  // signal fires (this arm's report, or the other arm's).
  const watchHoldout = redraw && kinds?.length
    ? (results) => {
        const held = redraw.signal.aborted ? [] : earlyHoldout(results, kinds);
        if (held.length) redraw.report(held);
      }
    : null;
  const proxy = arm === 'anyray' && (kinds?.length || bare) ? await startResultProxy({ upstream: settings.env.ANTHROPIC_BASE_URL ?? gatewayUrl, onResult: watchHoldout }) : null;
  const settingsFile = join(cfgDir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(proxy ? routeViaProxy(settings, proxy.url) : settings));
  chmodSync(settingsFile, 0o600); // holds the client key on the anyray arm
  const mcpFile = join(cfgDir, 'mcp.json');
  writeFileSync(mcpFile, JSON.stringify(mcp));

  // `followups`: more user turns, each sent when the previous one finishes, so the
  // session has closed user loops and old tool output (what history trims act on).
  // `followupDelaySec` idles before each one, the way a person pausing would.
  const followups = scenario.followups ?? [];
  const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  const args = [
    '-p', ...(followups.length ? ['--input-format', 'stream-json'] : [scenario.task]),
    // Direct on Bedrock calls the Bedrock id the gateway serves the same model as.
    '--model', provider === 'bedrock' && arm !== 'anyray' ? bedrock.model : model,
    '--setting-sources', settingSources,
    '--settings', settingsFile,
    '--strict-mcp-config', '--mcp-config', mcpFile,
    '--dangerously-skip-permissions',
    '--max-turns', String(scenario.maxTurns ?? 40),
    ...subagentArgs(noSubagents),
    '--output-format', 'stream-json', '--verbose',
    ...(persistSession ? [] : ['--no-session-persistence']),
  ];
  // On Bedrock neither arm may carry the seat token: AWS bills the direct arm, the gateway key the other.
  const upstream = provider === 'bedrock' ? {} : { CLAUDE_CODE_OAUTH_TOKEN: oauthToken() };
  const env = { PATH: process.env.PATH, HOME: home ?? homedir(), ...upstream, GOFLAGS: '-mod=mod', ...procEnv };
  // A private HOME must not also mean a cold Go module/build cache on one arm only.
  if (home) Object.assign(env, { GOPATH: join(homedir(), 'go'), GOCACHE: join(homedir(), 'Library', 'Caches', 'go-build') });

  // --warm-up: one throwaway one-turn session with this arm's exact setup, so the timed
  // session starts with its stable prefix (tools + system prompt) already in the provider's
  // cache on BOTH arms. Without it an arm whose setup changed since the last run starts
  // cold while the other reads a prefix the previous round left warm.
  const warm = warmUp ? await warmUpSession({ args, cwd: work, env, task: followups.length ? null : scenario.task }) : null;
  if (warm && proxy) {
    // The warm-up's requests are not the session's.
    proxy.results.length = 0;
    for (const tally of [proxy.notice, proxy.toolDefer]) for (const k of Object.keys(tally ?? {})) tally[k] = 0;
    for (const reasons of [proxy.noticeReasons, proxy.toolDeferReasons]) for (const k of Object.keys(reasons ?? {})) delete reasons[k];
  }

  const started = Date.now();
  const { lines, stderr, code } = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: work, env, stdio: [followups.length ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    redraw?.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    if (redraw?.signal.aborted) child.kill('SIGKILL');
    const pending = [...followups];
    if (followups.length) child.stdin.write(userLine(scenario.task));
    let seen = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (!followups.length) return;
      const results = (out.match(/"type":"result"/g) ?? []).length;
      for (; seen < results; seen++) {
        if (pending.length) {
          const next = pending.shift();
          setTimeout(() => child.stdin.write(userLine(next)), followupDelayMs(scenario, followups.length - pending.length - 1));
        } else child.stdin.end();
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
  // The pinned hook switches as the profile ended (read before the private HOME goes).
  const posture = trimHome ? hookPostureAtEnd(trimHome) : null;
  const activity = home ? connectActivity(home) : null; // read before the private HOME goes
  // An --arm-env unset only counts if the key stayed out of the arm's settings all session.
  const restored = home ? restoredKeys(home, unsetKeys) : [];
  rmSync(cfgDir, { recursive: true, force: true }); // a connect-HOME transcript goes with it
  if (persistSession && !home) {
    const id = lines.map((l) => l.match(/"session_id":"([^"]+)"/)?.[1]).find(Boolean);
    removeTranscript(id);
  }
  if (redraw?.signal.aborted) {
    rmSync(work, { recursive: true, force: true });
    throw Object.assign(new Error('stopped: the gateway drew a session of this pair into a holdout'), { holdoutDrawn: true });
  }
  if (!lines.length) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`);
  }
  if (restored.length) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`--arm-env unset did not hold: ${restored.join(', ')} was written back to the arm's settings during the session`);
  }
  // A switch the session did not run with means the arm did not measure what it records.
  if (posture?.drifted.length) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(postureDriftMessage(posture));
  }
  const session = parseSession(lines);
  if (posture) session.hookPosture = { set: posture.set, pinned: posture.pinned, atEnd: posture.atEnd };
  session.setup = activity ? { ...setup, activity } : setup;
  // Did Claude Code load what connect installed (MCP server, tools, skill)?
  if (setup?.configuredBy === 'anyray-connect') {
    session.setup.sessionChecks = checkConnectSession({ init: session.init, activity, level: integrationLevel, appliedIntegrationLevel: setup.appliedIntegrationLevel, refreshDisabled: procEnv.ANYRAY_REFRESH_DISABLE === 'true', expectRefreshDisabled: Boolean(trimHome || unsetKeys.length) });
    assertChecks(session.setup.sessionChecks, 'the Anyray session did not load what anyray-connect installed');
  }
  session.wallMs = Date.now() - started;
  if (proxy && kinds?.length) session.optimization = { requested: kinds, results: proxy.results, tally: tallyKinds(proxy.results, kinds), selectionHeadersStripped: proxy.stripped };
  if (proxy) session.budgetNotice = { ...proxy.notice }; // per inference response: applied / notApplied / absent (no mode in effect)
  // Why each gateway rewrite stood aside, and tool deferral's own outcome, per inference response.
  if (proxy) Object.assign(session, { budgetNoticeReasons: { ...proxy.noticeReasons }, toolDefer: { ...proxy.toolDefer }, toolDeferReasons: { ...proxy.toolDeferReasons } });
  session.check = scenario.check ? runCheck(scenario.check, work) : null;
  session.citations = scenario.citations ? checkCitations(session.result?.text ?? '', work) : null;
  session.outsideCheckout = outsideCheckout(session.requests, work);
  if (warm) session.warmUp = warm;
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
      // session_id is also the x-claude-code-session-id header the gateway keys spend on.
      init = { sessionId: j.session_id ?? null, model: j.model, tools: j.tools, mcpServers: j.mcp_servers, skills: j.skills ?? null, apiKeySource: j.apiKeySource ?? null };
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

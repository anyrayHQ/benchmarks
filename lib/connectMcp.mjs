// anyray-connect's local stdio MCP server, mounted into a Claude Agent SDK app (arm D of
// the sdk-app lanes). An SDK app gets only the gateway's remote `/mcp` today
// (anyray_retrieve, anyray_recall); `anyray_read_batch` exists only in connect's local
// server, `anyray-connect __anyray-mcp-server <source>`. Arm D mounts that server as one
// more `mcpServers` entry, so the model is offered the batch read on top of arm B.
//
// connect enrolls the way an agent host gets it (the service key in ANYRAY_CLIENT_KEY,
// `--gateway <url> --yes`), in a private HOME, and configures NO client there: the server
// needs only the enrolled profile (gateway + key). The SDK app never runs under that HOME
// (it keeps its own env and `settingSources: []`), so the only thing the app gains is the
// server entry, whose env names that HOME so the server reads the profile.
//
// Nothing here logs or stores content: tool names and enum states only, never a tool's
// description, a path the model read, or a key.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ANYRAY_BIN, assertIsolatedHome, parseJsonLine, readJson, scrub } from './connectArm.mjs';
import { createHash } from 'node:crypto';
import { armSeeds, seedArmHome, sessionDirParent } from './agentRun.mjs';
import { ARMS, batchReadFailureCode } from './agentSdkApp.mjs';

/** The SDK `mcpServers` key arm D mounts connect under ('anyray' is the gateway's /mcp). */
export const CONNECT_MCP_SERVER = 'anyray-connect';
/** The registration source connect writes for Claude Code, which the Agent SDK runs: it
 *  advertises retrieval plus the batch read, not the local search/read tools. */
export const CONNECT_MCP_SOURCE = 'claude';

/** The registration source an arm starts connect's server with: its own, else `claude`. */
export const connectSourceOf = (arm) => ARMS[arm]?.connectSource ?? CONNECT_MCP_SOURCE;

/** Only the `sdk` source sends initialize instructions; every other arm must not get them. */
export const instructionsExpectedFor = (arm) => connectSourceOf(arm) === 'sdk';

/** What arm B's gateway /mcp already serves; an `all` arm hides connect's copies. */
const GATEWAY_READ_PATH_TOOLS = ['anyray_retrieve', 'anyray_recall'];
export const READ_BATCH_TOOL = 'anyray_read_batch';

export const mcpToolName = (server, tool) => `mcp__${server}__${tool}`;

/**
 * The SDK stdio entry for connect's MCP server. `home` is the enrolled connect HOME the
 * server reads its profile from. Key refresh is off, so no policy sync rewrites the
 * profile's switches mid-run. `alwaysLoad` keeps the tool in the turn-1 prompt (the SDK
 * otherwise starts MCP servers without waiting); connect lists the batch read with
 * `anthropic/alwaysLoad` for Claude Code itself. No key in the env: the profile holds it.
 * The SDK starts the server in the session's cwd, which is what the batch read confines
 * its reads beneath (checked by tools/probe-sdk-code-scan.mjs).
 */
export const connectMcpServerConfig = ({ home, bin = ANYRAY_BIN, path = process.env.PATH, source = CONNECT_MCP_SOURCE }) => ({
  type: 'stdio',
  command: bin,
  args: ['__anyray-mcp-server', source],
  env: { PATH: path, HOME: home, ANYRAY_REFRESH_DISABLE: 'true' },
  alwaysLoad: true,
});

/**
 * What arm D exposes of connect's server: the batch read only. Everything else it
 * advertises (its own anyray_retrieve / anyray_recall, which arm B already has from the
 * gateway's /mcp) is disallowed, so D differs from B by exactly one tool. Throws when the
 * server does not advertise the batch read: the arm would then be B under another name.
 */
export const connectArmTools = (advertised, server = CONNECT_MCP_SERVER, { instructionsExpected = null, instructions = null, exposeAll = false } = {}) => {
  // Two-sided. An `sdk` arm's whole treatment is the instructions: a build that does not
  // send them (a stock connect reads an unknown source as `auto`) measures its base arm
  // under another name. And a build that sends them to any other source makes the
  // baseline a treatment arm too.
  if (instructionsExpected === true && instructions?.present !== true) {
    throw new Error("anyray-connect's MCP server sent no initialize instructions for this source; the arm would not differ from its base");
  }
  if (instructionsExpected === false && instructions?.present === true) {
    throw new Error("anyray-connect's MCP server sent initialize instructions for a source that must not get them; the baseline would carry the treatment");
  }
  const names = (advertised ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter((n) => typeof n === 'string');
  if (!names.includes(READ_BATCH_TOOL)) {
    throw new Error(`anyray-connect's MCP server does not advertise ${READ_BATCH_TOOL} (it lists: ${names.join(', ') || 'nothing'}); arm D would not differ from B`);
  }
  const offered = exposeAll ? names.filter((n) => !GATEWAY_READ_PATH_TOOLS.includes(n)) : [READ_BATCH_TOOL];
  return {
    allowed: offered.map((n) => mcpToolName(server, n)),
    disallowed: names.filter((n) => !offered.includes(n)).map((n) => mcpToolName(server, n)),
  };
};

/**
 * The preflight's batch read: two located ranges, the first audited file of the first two
 * slices, by ABSOLUTE path in the checkout. The Agent SDK's Read, Grep and Glob work in
 * absolute paths, so that is the shape the model passes on; a build that serves only
 * repo-relative paths fails every call the agents make (`unsafe_path`, connect before
 * ANY-1124).
 */
export const preflightReadBatchCall = (scenario, work) => ({
  name: READ_BATCH_TOOL,
  arguments: { reads: scenario.slices.slice(0, 2).map((s) => ({ path: join(work, s.audit[0].file), offset: 1, limit: 20 })) },
});

/** Throws unless the preflight's batch read was served. `call` is probeMcpTools' `call`. */
export const checkPreflightRead = (arm, call) => {
  if (call && !call.error && call.isError === false && call.header) return;
  const why = call?.failure ? `failure ${call.failure}` : call?.error !== undefined ? `JSON-RPC error ${call.error}` : 'no answer';
  throw new Error(`arm ${arm}: anyray-connect's batch read did not serve absolute in-checkout paths, the shape the SDK's Read and Grep produce (${why}); every batch read the agents make would fail`);
};

export const PROBE_TIMEOUT_MS = 20_000;

/** A batch read result's first line is its format header (`READ_BATCH_V2 <entries>`): kept, never the text after it. */
const BATCH_HEADER = /^READ_BATCH_V\d+ \d+$/;

/**
 * Start a stdio MCP server, run initialize → notifications/initialized → tools/list the
 * way Claude Code does (clientInfo `claude-code`), optionally one `tools/call`, and stop
 * it. Returns the advertised tools as `{ name, alwaysLoad }`, the server's name and
 * protocol version, whether `initialize` carried `instructions` (presence and a hash), and
 * for the call `{ isError, chars, header }` (the result's size and a batch read's format
 * header); never a description, the instructions or a result's text. `{ error }` on a
 * server that exits, writes no answer, or times out.
 */
export const probeMcpTools = ({ command, args = [], env, cwd, clientName = 'claude-code', call = null, revealInstructions = false, timeoutMs = PROBE_TIMEOUT_MS, spawnImpl = spawn }) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      resolve({ error: `spawn failed: ${String(e?.code ?? e?.name ?? 'error').slice(0, 40)}` });
      return;
    }
    let buf = '';
    let done = false;
    let serverInfo = null;
    let protocolVersion = null;
    let tools = null;
    let instructions = { present: false, sha256: null };
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      resolve(out);
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on('error', (e) => finish({ error: `spawn failed: ${String(e?.code ?? e?.name ?? 'error').slice(0, 40)}` }));
    child.on('exit', (code, signal) => finish({ error: `server exited ${code ?? signal} before it answered` }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) return finish({ error: `initialize failed (${msg.error.code})` });
          serverInfo = msg.result?.serverInfo?.name ?? null;
          protocolVersion = msg.result?.protocolVersion ?? null;
          const text = msg.result?.instructions;
          if (typeof text === 'string' && text) {
            instructions = { present: true, sha256: createHash('sha256').update(text).digest('hex').slice(0, 16) };
            // In memory only, for an offline probe that looks for this text in what the SDK sends.
            if (revealInstructions) instructions.text = text;
          }
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ error: `tools/list failed (${msg.error.code})` });
          tools = (msg.result?.tools ?? []).map((t) => ({ name: t?.name, alwaysLoad: t?._meta?.['anthropic/alwaysLoad'] === true }));
          if (!call) return finish({ serverInfo, protocolVersion, instructions, tools });
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.arguments ?? {} } });
        } else if (msg.id === 3) {
          if (msg.error) return finish({ serverInfo, protocolVersion, instructions, tools, call: { error: msg.error.code } });
          const text = (msg.result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
          const first = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
          const isError = msg.result?.isError === true;
          return finish({ serverInfo, protocolVersion, instructions, tools, call: { isError, chars: text.length, header: BATCH_HEADER.test(first) ? first : null, ...(isError && { failure: batchReadFailureCode(text) }) } });
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '0' } },
    });
  });

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * Enroll connect's profile in `home` for arm D, configuring no client: the agent-host apply
 * (`--gateway <url> --org --yes --json`, the service key in ANYRAY_CLIENT_KEY only), with
 * `--tools claude-code` so the run touches no other client. connect detects Claude Code by
 * a ~/.claude directory, which this HOME never has (refused up front if it does), so the
 * apply commits the profile and connects nothing: `Connected: no tools completed automatic
 * configuration`, an `applied` event with `connected: []`, exit 0. That is success here,
 * once the profile it wrote names this gateway and D's own key (compared, never recorded).
 * Whether the server then serves the batch read is the runner's tools/list preflight.
 */
export function enrollConnectProfile({ home, gatewayUrl, clientKey, bin = ANYRAY_BIN, realHome = homedir(), run = spawnSync }) {
  assertIsolatedHome(home, realHome);
  if (!clientKey) return { configured: false, reason: 'no key for arm D: connect enrolls an agent host from a service key in ANYRAY_CLIENT_KEY' };
  if (!existsSync(bin)) return { configured: false, reason: `anyray-connect not found (${basename(bin)})` };
  if (existsSync(join(home, '.claude'))) return { configured: false, reason: 'the connect HOME has a .claude directory, so connect would write Claude Code config there' };
  const args = ['--gateway', gatewayUrl, '--tools', 'claude-code', '--org', '--yes', '--json'];
  const r = run(bin, args, { env: { PATH: process.env.PATH, HOME: home, ANYRAY_CLIENT_KEY: clientKey }, encoding: 'utf8', timeout: 180000 });
  const events = String(r.stdout ?? '').split('\n').map(parseJsonLine).filter(Boolean);
  const applied = events.find((e) => e.event === 'applied');
  if (r.status !== 0) {
    const error = events.find((e) => e.event === 'error');
    const why = error?.message ?? (r.error?.message || String(r.stderr ?? '').trim().split('\n').slice(-3).join(' '));
    return { configured: false, reason: scrub(`anyray-connect exited ${r.status ?? r.signal}: ${why || 'no reason given'}`) };
  }
  if (!applied) return { configured: false, reason: 'anyray-connect exited 0 with no applied event' };
  const profile = readJson(join(home, '.anyray', 'connect.json'));
  if (!profile) return { configured: false, reason: 'anyray-connect wrote no profile' };
  const gatewayMatches = Boolean(originOf(profile.gateway)) && originOf(profile.gateway) === originOf(gatewayUrl);
  const keyMatches = typeof profile.clientKey === 'string' && profile.clientKey.trim() === clientKey.trim();
  if (!gatewayMatches) return { configured: false, reason: 'the enrolled profile names another gateway' };
  if (!keyMatches) return { configured: false, reason: "the enrolled profile does not hold arm D's key" };
  return {
    configured: true,
    setup: {
      connectBinary: basename(bin),
      keyKind: applied.keyKind ?? null,
      connected: applied.connected ?? [],
      notConnected: [...(applied.held ?? []), ...(applied.manual ?? []), ...(applied.failed ?? []), ...(applied.skipped ?? [])].map((t) => t.id),
      profile: { gatewayMatches, keyMatches },
    },
  };
}

/**
 * A private, enrolled connect HOME for arm D, made once per run under the bench session
 * directory (not the OS temp dir: connect will not write a temp-dir launcher path). It
 * always starts from the no-app profile: D starts `bin` itself as its MCP server, so the
 * same build must enroll the profile, and an installed Connect app must not take the
 * enrollment over. `configure` defaults to enrollConnectProfile (`run` is its spawn, for
 * tests). Returns the HOME and what the enrollment recorded (names and booleans, no key).
 */
export const prepareConnectHome = ({ gatewayUrl, clientKey, parent = sessionDirParent(), bin = ANYRAY_BIN, run = spawnSync, configure = (a) => enrollConnectProfile({ ...a, run }) }) => {
  mkdirSync(parent, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(parent, 'anyray-bench-sdk-connect-')));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const seeded = seedArmHome(home, armSeeds([], true));
  const r = configure({ home, gatewayUrl, clientKey, bin });
  if (!r.configured) return { dir, home, configured: false, reason: r.reason, seeded };
  return { dir, home, configured: true, seeded, setup: r.setup };
};


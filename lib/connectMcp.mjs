// anyray-connect's local stdio MCP server, mounted into a Claude Agent SDK app (arm D of
// the sdk-app lanes). An SDK app gets only the gateway's remote `/mcp` today
// (anyray_retrieve, anyray_recall); `anyray_read_batch` exists only in connect's local
// server, `anyray-connect __anyray-mcp-server <source>`. Arm D mounts that server as one
// more `mcpServers` entry, so the model is offered the batch read on top of arm B.
//
// connect runs the way an agent host gets it (the service key in ANYRAY_CLIENT_KEY,
// `--gateway <url> --yes`), through lib/connectArm.mjs, in a private HOME. Whatever connect
// writes stays in that HOME: the SDK app never runs under it (it keeps its own env and
// `settingSources: []`), so the only thing the app gains is the server entry, whose env
// names that HOME so the server reads the enrolled profile.
//
// Nothing here logs or stores content: tool names and enum states only, never a tool's
// description, a path the model read, or a key.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ANYRAY_BIN, CONNECT_BIN_PINNED, configureWithConnect } from './connectArm.mjs';
import { armSeeds, seedArmHome, sessionDirParent } from './agentRun.mjs';

/** The SDK `mcpServers` key arm D mounts connect under ('anyray' is the gateway's /mcp). */
export const CONNECT_MCP_SERVER = 'anyray-connect';
/** The registration source connect writes for Claude Code, which the Agent SDK runs: it
 *  advertises retrieval plus the batch read, not the local search/read tools. */
export const CONNECT_MCP_SOURCE = 'claude';
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
export const connectMcpServerConfig = ({ home, bin = ANYRAY_BIN, path = process.env.PATH }) => ({
  type: 'stdio',
  command: bin,
  args: ['__anyray-mcp-server', CONNECT_MCP_SOURCE],
  env: { PATH: path, HOME: home, ANYRAY_REFRESH_DISABLE: 'true' },
  alwaysLoad: true,
});

/**
 * What arm D exposes of connect's server: the batch read only. Everything else it
 * advertises (its own anyray_retrieve / anyray_recall, which arm B already has from the
 * gateway's /mcp) is disallowed, so D differs from B by exactly one tool. Throws when the
 * server does not advertise the batch read: the arm would then be B under another name.
 */
export const connectArmTools = (advertised, server = CONNECT_MCP_SERVER) => {
  const names = (advertised ?? []).map((t) => (typeof t === 'string' ? t : t?.name)).filter((n) => typeof n === 'string');
  if (!names.includes(READ_BATCH_TOOL)) {
    throw new Error(`anyray-connect's MCP server does not advertise ${READ_BATCH_TOOL} (it lists: ${names.join(', ') || 'nothing'}); arm D would not differ from B`);
  }
  return {
    allowed: [mcpToolName(server, READ_BATCH_TOOL)],
    disallowed: names.filter((n) => n !== READ_BATCH_TOOL).map((n) => mcpToolName(server, n)),
  };
};

export const PROBE_TIMEOUT_MS = 20_000;

/** A batch read result's first line is its format header (`READ_BATCH_V2 <entries>`): kept, never the text after it. */
const BATCH_HEADER = /^READ_BATCH_V\d+ \d+$/;

/**
 * Start a stdio MCP server, run initialize → notifications/initialized → tools/list the
 * way Claude Code does (clientInfo `claude-code`), optionally one `tools/call`, and stop
 * it. Returns the advertised tools as `{ name, alwaysLoad }` plus the server's name and
 * protocol version, and for the call `{ isError, chars, header }` (the result's size and a
 * batch read's format header); never a description or a result's text. `{ error }` on a
 * server that exits, writes no answer, or times out.
 */
export const probeMcpTools = ({ command, args = [], env, cwd, clientName = 'claude-code', call = null, timeoutMs = PROBE_TIMEOUT_MS, spawnImpl = spawn }) =>
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
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ error: `tools/list failed (${msg.error.code})` });
          tools = (msg.result?.tools ?? []).map((t) => ({ name: t?.name, alwaysLoad: t?._meta?.['anthropic/alwaysLoad'] === true }));
          if (!call) return finish({ serverInfo, protocolVersion, tools });
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: call.name, arguments: call.arguments ?? {} } });
        } else if (msg.id === 3) {
          if (msg.error) return finish({ serverInfo, protocolVersion, tools, call: { error: msg.error.code } });
          const text = (msg.result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('');
          const first = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length);
          return finish({ serverInfo, protocolVersion, tools, call: { isError: msg.result?.isError === true, chars: text.length, header: BATCH_HEADER.test(first) ? first : null } });
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

/**
 * A private, enrolled connect HOME for arm D, made once per run under the bench session
 * directory (not the OS temp dir: connect will not write a temp-dir launcher path). It
 * always starts from the no-app profile: D starts `bin` itself as its MCP server, so the
 * same build must enroll the profile, and an installed Connect app must not take the
 * configure over. Enrollment is lib/connectArm.mjs's agent-host flow on the org lane (the
 * SDK app pays per token through the gateway): `--gateway <url> --tools claude-code --org
 * --yes --json` with the arm's service key in ANYRAY_CLIENT_KEY only. Returns the HOME and
 * what connect configured (redacted: names and shapes, no key).
 */
export const prepareConnectHome = ({
  gatewayUrl,
  clientKey,
  parent = sessionDirParent(),
  bin = ANYRAY_BIN,
  binPinned = CONNECT_BIN_PINNED,
  configure = configureWithConnect,
}) => {
  mkdirSync(parent, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(parent, 'anyray-bench-sdk-connect-')));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const seeded = seedArmHome(home, armSeeds([], true));
  const r = configure({ home, gatewayUrl, clientKey, lane: 'org', bin, binPinned });
  if (!r.configured) return { dir, home, configured: false, reason: r.reason, seeded };
  return { dir, home, configured: true, seeded, setup: r.setup, checks: r.checks };
};


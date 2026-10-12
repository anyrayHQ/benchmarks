#!/usr/bin/env node
// Offline wiring check for sdk-app-code-scan's arm D. No model traffic, no gateway, no key:
//
//   1. a fresh checkout of the scenario (the cached clone at the pinned ref, patch applied);
//   2. anyray-connect's stdio MCP server, started exactly as arm D's mcpServers entry starts
//      it (lib/connectMcp.mjs) in that checkout: tools/list, then one anyray_read_batch call
//      over two located ranges of the slice files (its size and header only);
//   3. the Claude Agent SDK with arm D's options (lib/sdkAppCodeScan.mjs codeScanOptions),
//      pointed at a closed local port so no request can leave the machine, run to its init
//      message: which MCP servers it connected, which anyray tools the model is offered, and
//      the cwd a stdio server is started in (the batch read's confinement root).
//
// Without --connect-home the server runs in an empty private HOME, so it resolves connect's
// shipped switch defaults (no profile). With --connect-home <dir> it reads that HOME's
// enrolled profile, as a run does after run_sdk_app.mjs enrolls it. Prints tool and server
// names, states and counts; never file text, a description or a key.
//
//   node tools/probe-sdk-code-scan.mjs [--connect-home <dir>] [--model claude-sonnet-5-5]

import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { load as parseYaml } from 'js-yaml';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { prepareRepo, sessionDirParent } from '../lib/agentRun.mjs';
import { CONNECT_MCP_SERVER, READ_BATCH_TOOL, connectArmTools, connectMcpServerConfig, probeMcpTools } from '../lib/connectMcp.mjs';
import { codeScanOptions } from '../lib/sdkAppCodeScan.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SCENARIO = 'sdk-app-code-scan';
const INIT_TIMEOUT_MS = 60_000;

const parseArgs = (argv) => {
  const a = { connectHome: null, model: 'claude-sonnet-5-5' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--connect-home') a.connectHome = argv[++i];
    else if (argv[i] === '--model') a.model = argv[++i];
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  return a;
};

/** A local URL nothing listens on: bind an ephemeral port, then release it. */
const closedPortUrl = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });

/** Run the SDK with `options` until its init message, then abort. Returns the init message. */
const sdkInit = async (options) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);
  let init = null;
  try {
    for await (const m of query({ prompt: 'Reply with OK.', options: { ...options, abortController: controller } })) {
      if (m.type === 'system' && m.subtype === 'init') {
        init = m;
        controller.abort();
        break;
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError' && !init) throw e;
  } finally {
    clearTimeout(timer);
  }
  return init;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = join(ROOT, 'scenarios', SCENARIO);
  const scenario = parseYaml(readFileSync(join(dir, 'scenario.yaml'), 'utf8'));
  const work = prepareRepo(scenario, dir);
  mkdirSync(sessionDirParent(), { recursive: true });
  const scratch = mkdtempSync(join(sessionDirParent(), 'anyray-bench-probe-'));
  const home = args.connectHome ?? join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const report = { scenario: SCENARIO, connectHome: args.connectHome ? 'enrolled (--connect-home)' : 'empty private HOME (switch defaults)' };
  try {
    // 2. The server alone, as D starts it, in the checkout.
    const server = connectMcpServerConfig({ home });
    const [s1, s2] = scenario.slices;
    const probe = await probeMcpTools({
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: work,
      call: { name: READ_BATCH_TOOL, arguments: { reads: [{ path: s1.files[0], offset: 1, limit: 40 }, { path: s2.files[0], offset: 1, limit: 40 }] } },
    });
    report.server = { command: server.command.split('/').pop(), args: server.args, envKeys: Object.keys(server.env), alwaysLoad: server.alwaysLoad, ...probe };
    if (probe.error) throw new Error(`connect's MCP server: ${probe.error}`);
    const tools = connectArmTools(probe.tools);
    report.arm = tools;

    // 3. The SDK with arm D's options, plus a server that records its own cwd.
    const cwdFile = join(scratch, 'cwd.txt');
    const options = codeScanOptions({
      arm: 'D',
      scenario,
      work,
      model: args.model,
      gatewayUrl: await closedPortUrl(),
      clientKey: 'ark_synthetic-probe-key',
      sessionId: 'probe-sdk-code-scan',
      connect: { name: CONNECT_MCP_SERVER, server, tools },
    });
    options.mcpServers['cwd-probe'] = { type: 'stdio', command: process.execPath, args: [join(ROOT, 'tools', 'mcp-cwd-probe-server.mjs'), cwdFile], alwaysLoad: true };
    options.maxTurns = 1;
    const init = await sdkInit(options);
    for (let i = 0; i < 20 && !existsSync(cwdFile); i++) await sleep(250);
    const mcpTools = (init?.tools ?? []).filter((t) => t.startsWith('mcp__'));
    const serverCwd = existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8') : null;
    report.sdk = {
      claudeCodeVersion: init?.claude_code_version ?? null,
      initCwdIsCheckout: init ? realpathSync(init.cwd) === realpathSync(work) : null,
      mcpServers: (init?.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status, ...(s.source ? { source: s.source } : {}) })),
      mcpTools,
      readBatchOffered: tools.allowed.every((t) => mcpTools.includes(t)),
      disallowedHidden: tools.disallowed.every((t) => !mcpTools.includes(t)),
      stdioServerCwdIsCheckout: serverCwd === null ? null : realpathSync(serverCwd) === realpathSync(work),
      agents: init?.agents ?? null,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
  const ok = report.sdk?.readBatchOffered && report.sdk?.disallowedHidden && report.sdk?.stdioServerCwdIsCheckout && report.server?.call?.isError === false;
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

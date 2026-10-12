#!/usr/bin/env node
// Minimal MCP stdio server that records the working directory it was started in, for
// tools/probe-sdk-code-scan.mjs: anyray_read_batch confines its reads beneath its server's
// cwd, so the probe checks where the Agent SDK starts a stdio server. Lists no tools.
// Usage: node tools/mcp-cwd-probe-server.mjs <file to write the cwd to>
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const out = process.argv[2];
if (!out) {
  process.stderr.write('usage: mcp-cwd-probe-server.mjs <out file>\n');
  process.exit(2);
}
writeFileSync(out, process.cwd());

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cwd-probe', version: '1.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});

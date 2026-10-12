#!/usr/bin/env node
// Minimal MCP stdio server that lists a synthetic tool catalog (lib/mcpCatalog.mjs).
// Usage: node tools/mcp-catalog-server.mjs <n>
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, as Claude Code's stdio transport speaks.
import { createInterface } from 'node:readline';
import { catalogTools } from '../lib/mcpCatalog.mjs';

const n = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isInteger(n) || n <= 0) {
  process.stderr.write('usage: mcp-catalog-server.mjs <n>\n');
  process.exit(2);
}
const tools = catalogTools(n);
const names = new Set(tools.map((t) => t.name));

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const handle = (msg) => {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification needs no answer
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'bench-catalog', version: '1.0.0' },
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools });
    case 'tools/call':
      if (!names.has(params?.name)) return fail(id, -32602, 'unknown tool');
      return reply(id, { content: [{ type: 'text', text: 'No matching records.' }] });
    default:
      return fail(id, -32601, 'method not found');
  }
};

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  handle(msg);
});

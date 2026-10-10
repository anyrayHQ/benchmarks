import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { catalogTools, withMcpCatalog, CATALOG_SERVER } from '../lib/mcpCatalog.mjs';
import { parseArgs, requestRecord, slotOptions, armsFor } from '../run_agent.mjs';

const serverPath = fileURLToPath(new URL('../tools/mcp-catalog-server.mjs', import.meta.url));

test('catalogTools: n tools, unique names, deterministic, each about the requested size', () => {
  const tools = catalogTools(200, { toolChars: 2000 });
  assert.equal(tools.length, 200);
  assert.equal(new Set(tools.map((t) => t.name)).size, 200);
  assert.deepEqual(catalogTools(200, { toolChars: 2000 }), tools, 'same catalog on every call, so both arms see the same bytes');
  for (const t of tools) {
    assert.match(t.name, /^[a-z0-9_]{1,40}$/);
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
    const chars = JSON.stringify(t).length;
    assert.ok(chars >= 1800 && chars <= 2200, `${t.name} is ${chars} chars`);
  }
});

test('catalogTools: the catalog size scales with n and toolChars', () => {
  const total = (n, toolChars) => catalogTools(n, { toolChars }).reduce((s, t) => s + JSON.stringify(t).length, 0);
  const sett = total(200, 2085);
  assert.ok(sett > 380_000 && sett < 460_000, `Sett-shaped catalog is ${sett} chars`);
  assert.ok(total(100, 1180) < 140_000, 'the #3120 shape (+100 MCP, ~118k chars) stays reachable');
});

test('withMcpCatalog adds the stub server beside the arm servers, and leaves mcp untouched without a count', () => {
  const mcp = { mcpServers: { anyray: { type: 'stdio', command: 'anyray-connect' } } };
  assert.equal(withMcpCatalog(mcp, 0), mcp);
  assert.equal(withMcpCatalog(mcp, undefined), mcp);
  const out = withMcpCatalog(mcp, 200);
  assert.notEqual(out, mcp, 'never mutates the arm config');
  assert.deepEqual(Object.keys(out.mcpServers).sort(), ['anyray', CATALOG_SERVER]);
  const s = out.mcpServers[CATALOG_SERVER];
  assert.equal(s.type, 'stdio');
  assert.equal(s.command, process.execPath);
  assert.ok(s.args[0].endsWith('tools/mcp-catalog-server.mjs'));
  assert.deepEqual(s.args.slice(1), ['200']);
  assert.deepEqual(mcp.mcpServers, { anyray: { type: 'stdio', command: 'anyray-connect' } });
});

const KINDS = ['--kinds', 'cache_optimizer,relevance_filter,code_graph,observation_mask,content_census,cache_lint'];

test('--mcp-catalog reaches both slots identically and is recorded', () => {
  const args = parseArgs(['--scenario', 's', '--compare', 'gateway', ...KINDS, '--mcp-catalog', '200']);
  const arms = armsFor('gateway');
  assert.equal(args.mcpCatalog, 200);
  assert.equal(slotOptions(args, arms, 'a').mcpCatalog, 200);
  assert.equal(slotOptions(args, arms, 'b').mcpCatalog, 200);
  assert.equal(requestRecord(args).mcpCatalog, 200);
  const none = parseArgs(['--scenario', 's', '--compare', 'gateway', ...KINDS]);
  assert.equal('mcpCatalog' in slotOptions(none, arms, 'a'), false);
  assert.equal('mcpCatalog' in requestRecord(none), false);
});

test('--mcp-catalog refuses a non-positive or non-integer count', () => {
  for (const bad of ['0', '-3', 'abc', '2.5']) {
    assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway', ...KINDS, '--mcp-catalog', bad]), /--mcp-catalog needs a positive integer/);
  }
});

const rpc = (child, msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const readMessages = (child) => {
  const got = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) got.push(JSON.parse(line));
    }
  });
  return got;
};
const waitFor = async (got, id) => {
  for (let i = 0; i < 100; i++) {
    const m = got.find((x) => x.id === id);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no response for id ${id}`);
};

test('the stub server speaks MCP over stdio: initialize, tools/list (the catalog), tools/call', async () => {
  const child = spawn(process.execPath, [serverPath, '12'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const got = readMessages(child);
  try {
    rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const init = await waitFor(got, 1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    rpc(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitFor(got, 2);
    assert.deepEqual(list.result.tools, catalogTools(12));
    rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: list.result.tools[0].name, arguments: {} } });
    const call = await waitFor(got, 3);
    assert.equal(call.result.content[0].type, 'text');
    rpc(child, { jsonrpc: '2.0', id: 4, method: 'no/such/method' });
    const err = await waitFor(got, 4);
    assert.equal(err.error.code, -32601);
  } finally {
    child.kill();
  }
});

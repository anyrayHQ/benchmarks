import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSession } from '../lib/agentRun.mjs';
import { addGatewayPings, sessionGatewaySpend } from '../lib/traces.mjs';

const GW = 'http://gw.test';
const ENV = { ANYRAY_ADMIN_KEY: 'test-admin-key' };
const noSleep = async () => {};

// The gateway's per-session spend read: client requests first, then keep-warm pings.
const spendBody = (pings, pingCost, clientRequests = 10) => ({
  clientSessionId: 's-1',
  includeSubagents: true,
  sessions: 1,
  total: { requests: clientRequests + pings, costUsd: 1 + pingCost },
  byRequestKind: [
    { requestKind: null, requests: clientRequests, costUsd: 1 },
    { requestKind: 'cache_warm', requests: pings, costUsd: pingCost },
  ],
});
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('parseSession keeps the Claude Code session id from the init event', () => {
  const s = parseSession([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'm', tools: [], mcp_servers: [] }),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 1, result: 'ok' }),
  ]);
  assert.equal(s.init.sessionId, 'abc-123');
});

test('sessionGatewaySpend reads the session with its subagents until the ping count settles', async () => {
  const calls = [];
  const bodies = [spendBody(1, 0.01), spendBody(2, 0.02), spendBody(2, 0.02)];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    return json(200, bodies[calls.length - 1]);
  };
  const out = await sessionGatewaySpend(GW, 's-1', { env: ENV, fetchImpl, sleep: noSleep });
  assert.equal(calls[0].url, `${GW}/admin/v1/spend/sessions/s-1?includeSubagents=true`);
  assert.equal(calls[0].auth, 'Bearer test-admin-key');
  assert.equal(calls.length, 3);
  assert.equal(out.pingCount, 2);
  assert.equal(out.pingCostUsd, 0.02);
  assert.equal(out.settled, true);
});

test('sessionGatewaySpend gives up at the deadline with the last read', async () => {
  let n = 0;
  let now = 0;
  const out = await sessionGatewaySpend(GW, 's-1', {
    env: ENV,
    fetchImpl: async () => json(200, spendBody(++n, n / 100)),
    sleep: async (ms) => {
      now += ms;
    },
    clock: () => now,
    waitMs: 30000,
  });
  assert.equal(out.settled, false);
  assert.ok(out.pingCount >= 2 && out.pingCount <= 8);
});

test('sessionGatewaySpend is unavailable on an older gateway, a missing key or no session id', async () => {
  const old = await sessionGatewaySpend(GW, 's-1', { env: ENV, fetchImpl: async () => json(404, {}), sleep: noSleep });
  assert.match(old.unavailable, /404/);
  const noKey = await sessionGatewaySpend(GW, 's-1', { env: {}, fetchImpl: async () => assert.fail('no call'), sleep: noSleep });
  assert.ok(noKey.unavailable);
  const noId = await sessionGatewaySpend(GW, null, { env: ENV, fetchImpl: async () => assert.fail('no call'), sleep: noSleep });
  assert.ok(noId.unavailable);
});

test('addGatewayPings adds ping cost to the arm cost and keeps the client figure', () => {
  const t = addGatewayPings({ costUsd: 1 }, { pingCount: 3, pingCostUsd: 0.05 });
  assert.equal(t.clientCostUsd, 1);
  assert.equal(t.gatewayPingCount, 3);
  assert.equal(t.gatewayPingCostUsd, 0.05);
  assert.equal(t.costUsd, 1.05);
});

test('addGatewayPings records null and leaves cost alone when the read was unavailable', () => {
  const t = addGatewayPings({ costUsd: 1 }, { unavailable: 'GET spend/sessions 404' });
  assert.equal(t.clientCostUsd, 1);
  assert.equal(t.gatewayPingCount, null);
  assert.equal(t.gatewayPingCostUsd, null);
  assert.equal(t.costUsd, 1);
});

test('sessionGatewaySpend treats a network error as unavailable', async () => {
  const out = await sessionGatewaySpend(GW, 's-1', { env: ENV, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, sleep: noSleep });
  assert.match(out.unavailable, /ECONNREFUSED/);
});

test('addGatewayPings keeps a missing client cost missing', () => {
  const t = addGatewayPings({ costUsd: null }, { pingCount: 1, pingCostUsd: 0.01 });
  assert.equal(t.costUsd, null);
  assert.equal(t.gatewayPingCount, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { startResultProxy, isInference } from '../lib/resultProxy.mjs';

/** A stand-in gateway: logs what it received and answers with an optional result header. */
async function fakeGateway(respond = () => ({})) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { status = 200, headers = {}, chunks = ['{"ok":true}'] } = respond(req);
      res.writeHead(status, { 'content-type': 'text/event-stream', ...headers });
      for (const c of chunks) res.write(c);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const FEEDBACK = JSON.stringify({ status: 'applied', applied: ['observation_mask'], skipped: [{ kind: 'code_graph', reason: 'no_change' }], preserved: [] });

test('isInference: only inference POSTs carry a selection', () => {
  assert.equal(isInference('POST', '/v1/messages?beta=true'), true);
  assert.equal(isInference('POST', '/v1/messages'), true);
  assert.equal(isInference('POST', '/v1/messages/count_tokens'), false);
  assert.equal(isInference('GET', '/v1/messages'), false);
  assert.equal(isInference('GET', '/v1/models'), false);
});

test('forwards the request as sent, streams the response back, and records the feedback header', async () => {
  const gw = await fakeGateway(() => ({ headers: { 'x-anyray-optimization-result': FEEDBACK }, chunks: ['event: a\n\n', 'event: b\n\n'] }));
  const proxy = await startResultProxy({ upstream: gw.url });
  try {
    const res = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'x-anyray-optimization-kinds': 'observation_mask,code_graph', 'x-anyray-api-key': 'ark_fake', 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'event: a\n\nevent: b\n\n');
    assert.equal(res.headers.get('x-anyray-optimization-result'), FEEDBACK);
    assert.equal(gw.seen[0].url, '/v1/messages?beta=true');
    assert.equal(gw.seen[0].body, '{"model":"m"}');
    assert.equal(gw.seen[0].headers['x-anyray-optimization-kinds'], 'observation_mask,code_graph');
    assert.equal(gw.seen[0].headers['x-anyray-api-key'], 'ark_fake');
    assert.deepEqual(proxy.results, [{ status: 'applied', applied: ['observation_mask'], skipped: [{ kind: 'code_graph', reason: 'no_change' }], preserved: [] }]);
  } finally {
    await proxy.close();
    await gw.close();
  }
});

test('an inference response without the feedback header is recorded as unconfirmed', async () => {
  const gw = await fakeGateway();
  const proxy = await startResultProxy({ upstream: gw.url });
  try {
    await (await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })).text();
    assert.deepEqual(proxy.results, [{ status: 'unconfirmed', why: 'missing' }]);
  } finally {
    await proxy.close();
    await gw.close();
  }
});

test('non-inference calls lose the selection headers (the gateway 400s them) and are not recorded', async () => {
  const gw = await fakeGateway();
  const proxy = await startResultProxy({ upstream: gw.url });
  try {
    await (await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'x-anyray-optimization-kinds': 'observation_mask', 'x-anyray-optimization-profile': 'exact', 'x-anyray-optimization-shadow-kinds': 'repeat_factor', 'x-anyray-api-key': 'ark_fake' },
      body: '{}',
    })).text();
    assert.equal(gw.seen[0].headers['x-anyray-optimization-kinds'], undefined);
    assert.equal(gw.seen[0].headers['x-anyray-optimization-profile'], undefined);
    assert.equal(gw.seen[0].headers['x-anyray-optimization-shadow-kinds'], undefined);
    assert.equal(gw.seen[0].headers['x-anyray-api-key'], 'ark_fake');
    assert.deepEqual(proxy.results, []);
    assert.equal(proxy.stripped, 1);
  } finally {
    await proxy.close();
    await gw.close();
  }
});

test('keeps the upstream base path and passes error statuses through', async () => {
  const gw = await fakeGateway(() => ({ status: 429, chunks: ['{"error":"rate"}'] }));
  const proxy = await startResultProxy({ upstream: `${gw.url}/base/` });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 429);
    await res.text();
    assert.equal(gw.seen[0].url, '/base/v1/messages');
    assert.deepEqual(proxy.results, [{ status: 'unconfirmed', why: 'missing', httpStatus: 429 }]);
  } finally {
    await proxy.close();
    await gw.close();
  }
});

test('an unreachable upstream answers 502 instead of hanging the session', async () => {
  const proxy = await startResultProxy({ upstream: 'http://127.0.0.1:1' });
  try {
    const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 502);
  } finally {
    await proxy.close();
  }
});

// ---- a session killed mid-request (live kit run, 2026-10-22) -----------------------------------
// The gateway took ~30 s to first byte; the session hit its timeout and was killed while a
// request was in flight. The proxy kept that upstream request open, its socket kept the kit
// process alive after it reported run_failed, and a CI job would have hung until its timeout.

/** A stand-in gateway that takes a request and never answers; resolves when it sees one, and when that socket closes. */
async function stallingGateway() {
  let received, closed;
  const gotRequest = new Promise((r) => (received = r));
  const upstreamClosed = new Promise((r) => (closed = r));
  const server = createServer((req) => {
    received();
    req.socket.on('close', () => closed());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    gotRequest,
    upstreamClosed,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

const within = (p, ms, what) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]).then((ok) => assert.ok(ok, what));

/** An in-flight inference request through the proxy (a raw request, so the test can drop it like a killed client). */
function sendInFlight(proxy) {
  const req = httpRequest(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end('{}');
  return req;
}

test('a client that disconnects mid-request takes the upstream request down with it', async (t) => {
  const gw = await stallingGateway();
  const proxy = await startResultProxy({ upstream: gw.url });
  t.after(async () => { await proxy.close(); await gw.close(); });
  const req = sendInFlight(proxy);
  await within(gw.gotRequest, 2000, 'the request reached the gateway');
  req.destroy(); // the session was killed
  await within(gw.upstreamClosed, 2000, 'the upstream request is still open after its client went away');
});

test('close() aborts every request still in flight, so nothing keeps the process alive', async (t) => {
  const gw = await stallingGateway();
  t.after(() => gw.close());
  const proxy = await startResultProxy({ upstream: gw.url });
  sendInFlight(proxy);
  await within(gw.gotRequest, 2000, 'the request reached the gateway');
  await within(proxy.close(), 2000, 'close() did not resolve');
  await within(gw.upstreamClosed, 2000, 'an upstream request outlived close()');
});

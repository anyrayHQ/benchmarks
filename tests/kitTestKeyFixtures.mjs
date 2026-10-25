// Shared inputs for the self-serve kit tests (ANY-1516): the kit on ONE short-lived test key that
// `anyray-connect test-key` mints (a client-test service key), with no admin token anywhere.
// A fake gateway on 127.0.0.1 that serves the /connect/test/* routes of SPEC section G and
// answers them only for the test key; the ~/.anyray/test-kit.env that `anyray-connect test-key`
// writes; a stand-in `anyray-connect`; and a URL nothing listens on. Everything is synthetic:
// nothing reaches a real gateway, a provider or a Claude session.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

/** The client-test key (a service key, `ark_svc_`); benign by construction. */
export const TEST_KEY = 'ark_svc_synthetic-test-0001';
/** What GET /connect/test/context reports; differs from the admin route's 1.10.515 on purpose. */
export const CONTEXT_VERSION = '1.10.520';
/** The id POST /connect/test/results gives a result; differs from the admin route's id on purpose. */
export const TEST_PUBLISHED_ID = '5a7c3e21-9b4d-4f6a-8c2e-1d0b9a8f7e63';
/** The keep-warm pings GET /connect/test/sessions/:id reports for any session. */
export const PING = { requests: 2, costUsd: 0.05 };
/** Replica start times GET /connect/test/context reports, before and after a "restart". */
export const REPLICA_STARTED = '2026-10-22T08:00:00.000Z';
export const REPLICA_RESTARTED = '2026-10-22T08:30:00.000Z';

const CLEAN_RESULT = { status: 'applied', applied: ['observation_mask'], skipped: [], preserved: [] };

/** The result body's top-level fields before ANY-1684: a gateway this old refuses any other. */
export const OLD_RESULT_FIELDS = [
  'planHash', 'kitVersion', 'benchmarksCommit', 'gatewayVersion', 'releaseTag', 'clientTool', 'clientToolVersion',
  'model', 'provider', 'scenarios', 'totals', 'rule0Verdict',
];

const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** The key a /connect/* request presents: x-anyray-api-key first, then a Bearer token (SPEC "Verified facts"). */
export function keyOf(r) {
  if (typeof r.apiKey === 'string' && r.apiKey) return r.apiKey;
  // Linear string ops, not a regex: the header is request data (CodeQL js/polynomial-redos).
  const header = r.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

/** ISO instants a week ahead and a day behind now (a fresh test key, an expired one). */
export const futureIso = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
export const pastIso = () => new Date(Date.now() - 86_400_000).toISOString();

/**
 * ~/.anyray/test-kit.env under `home`, exactly as `anyray-connect test-key` writes it (SPEC C):
 * three KEY=value lines, mode 0600 unless `mode` says otherwise. Returns its path.
 */
export function writeTestKitEnv(home, { gateway, key = TEST_KEY, expiresAt = futureIso(), mode = 0o600 }) {
  const dir = join(home, '.anyray');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'test-kit.env');
  writeFileSync(file, `ANYRAY_GATEWAY_URL=${gateway}\nANYRAY_BENCH_CLIENT_KEY=${key}\nANYRAY_TEST_KEY_EXPIRES_AT=${expiresAt}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

/**
 * A stand-in `anyray-connect` that prints a version for any arguments, written both to
 * `<binDir>/anyray-connect` (prepend binDir to PATH) and to `<home>/.anyray/bin/anyray-connect`
 * (where the kit's connect arm looks). Returns binDir.
 */
export function fakeConnect(binDir, home) {
  const script = "#!/bin/sh\necho 'anyray-connect 1.10.520'\n";
  for (const dir of [binDir, join(home, '.anyray', 'bin')]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'anyray-connect'), script);
    chmodSync(join(dir, 'anyray-connect'), 0o755);
  }
  return binDir;
}

/** A gateway URL on 127.0.0.1 that nothing listens on (a port bound, read, then released). */
export async function closedGatewayUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/**
 * The gateway as a test key sees it (SPEC G), on 127.0.0.1. Records every request: method, path,
 * query, the two key headers, the inference metadata and any JSON body.
 *
 * - POST /v1/messages: 200 with x-anyray-optimization-result (a test key always gets it), after
 *   `probeDelayMs` before the first byte.
 * - /connect/test/*: 403 { error: { type: 'client_test_key_required' } } unless the request
 *   presents TEST_KEY. GET context -> { tenant, gatewayVersion, evaluationCohort, sessionGate,
 *   replicas } (or `contextStatus`); POST results -> 201 { result: { ...body, id, receivedAt } };
 *   GET results -> { results: state.results }; GET sessions/:id -> a content-free spend summary
 *   with PING as its cache_warm pings.
 * - `restartOnFirstInference`: the one replica reports a later start time once the first
 *   inference request has arrived (a gateway restart during the first round).
 * - `state.sessionGate` is what the context reports from then on: a test may change it between
 *   two kit commands (kinds promoted, or a malformed answer).
 * - `oldGateway`: POST results refuses a body with a top-level field the gateway predates (any
 *   field outside OLD_RESULT_FIELDS, e.g. ANY-1684's evaluatedKinds) exactly as the strict schema
 *   does: 400 { issues: [{ path: [], code: 'unrecognized_keys' }] }.
 * - `postResults`: replies POST results gives, one per POST in order ({ status, payload }); once
 *   they run out it answers as above.
 * - /admin/*: 401. No test here holds an admin token, so a request there is a regression.
 */
export async function fakeTestGateway({
  sessionGate = { on: 0, shadow: 4, off: 0 }, evaluationCohort = true, contextStatus = 200,
  probeDelayMs = 0, restartOnFirstInference = false, results = [], oldGateway = false, postResults = [],
} = {}) {
  const requests = [];
  const state = { results, inferenceSeen: false, sessionGate, postResults: [...postResults] };
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const metaRaw = req.headers['x-anyray-metadata'];
      const entry = {
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
        apiKey: req.headers['x-anyray-api-key'] ?? null,
        authorization: req.headers.authorization ?? null,
        metadata: typeof metaRaw === 'string' ? parseJson(metaRaw) : null,
        body: req.method === 'POST' ? parseJson(raw) : null,
      };
      requests.push(entry);
      const send = (code, payload, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'POST' && /^\/(v1\/)?messages$/.test(url.pathname)) {
        state.inferenceSeen = true;
        const answer = () => send(200, { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
          { 'x-anyray-optimization-result': JSON.stringify(CLEAN_RESULT) });
        if (probeDelayMs > 0) setTimeout(answer, probeDelayMs);
        else answer();
        return;
      }
      if (url.pathname.startsWith('/connect/test/')) {
        if (keyOf(entry) !== TEST_KEY) return send(403, { error: { type: 'client_test_key_required' } });
        if (req.method === 'GET' && url.pathname === '/connect/test/context') {
          if (contextStatus !== 200) return send(contextStatus, { error: { type: 'unavailable' } });
          const startedAt = restartOnFirstInference && state.inferenceSeen ? REPLICA_RESTARTED : REPLICA_STARTED;
          return send(200, { tenant: 'acme', gatewayVersion: CONTEXT_VERSION, evaluationCohort, sessionGate: state.sessionGate, replicas: [{ replicaId: 'replica-1', startedAt }] });
        }
        if (req.method === 'POST' && url.pathname === '/connect/test/results') {
          const reply = state.postResults.shift();
          if (reply) return send(reply.status, reply.payload);
          const fields = entry.body && typeof entry.body === 'object' ? Object.keys(entry.body) : [];
          if (oldGateway && fields.some((f) => !OLD_RESULT_FIELDS.includes(f))) return send(400, { issues: [{ path: [], code: 'unrecognized_keys' }] });
          return send(201, { result: { ...(entry.body ?? {}), id: TEST_PUBLISHED_ID, receivedAt: '2026-10-22T09:00:00.000Z' } });
        }
        if (req.method === 'GET' && url.pathname === '/connect/test/results') return send(200, { results: state.results });
        if (req.method === 'GET' && url.pathname.startsWith('/connect/test/sessions/')) {
          return send(200, { requests: 3, costUsd: 0.07, byRequestKind: { cache_warm: { ...PING } } });
        }
        return send(404, { error: { type: 'not_found' } });
      }
      if (url.pathname.startsWith('/admin/')) return send(401, { error: { message: 'unauthorized' } });
      return send(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    inference: () => requests.filter((r) => r.method === 'POST' && /^\/(v1\/)?messages$/.test(r.path)),
    admin: () => requests.filter((r) => r.path.startsWith('/admin/')),
    testRoute: (method, path) => requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

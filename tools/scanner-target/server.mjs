// The live service of the sdk-app-scanner-long target, on 127.0.0.1 and an ephemeral
// port: it serves target.mjs's endpoint catalog and nothing else. Two routing rules make
// the hidden parts reachable the way a real service would be: the export ignores its
// query string, and /api/search answers its debug variant only with debug=1. Everything is
// synthetic, and every response is data the scanner reads, never instructions.

import http from 'node:http';
import { scannerEndpoints, DEFAULT_SEED } from './target.mjs';

/** The catalog key a request maps to, or null. */
export const catalogKey = (catalog, rawUrl) => {
  const url = new URL(rawUrl ?? '/', 'http://local');
  const path = url.pathname;
  if (path === '/api/search' && url.searchParams.get('debug') === '1') return '/api/search?debug=1';
  return catalog.has(path) ? path : null;
};

export const startScannerTargetServer = async ({ seed = DEFAULT_SEED, host = '127.0.0.1' } = {}) => {
  const catalog = scannerEndpoints({ seed });
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end('{"synthetic":true,"error":"method_not_allowed"}');
      return;
    }
    let key = null;
    try {
      key = catalogKey(catalog, req.url);
    } catch {
      key = null;
    }
    if (!key) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"synthetic":true,"error":"not_found"}');
      return;
    }
    const e = catalog.get(key);
    res.writeHead(e.status, { 'content-type': e.type });
    res.end(e.body);
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return { url: `http://${host}:${port}`, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
};

// A local, deterministic fixture web app the scanner reaches with its `http_get` tool.
// It binds to 127.0.0.1 on an ephemeral port and serves a handful of synthetic endpoints;
// four of them carry the `where: 'http'` vulnerability markers. Nothing here talks to a
// real network or holds a real secret — every body is fabricated and every marker is a
// SYNTHETIC sentinel. The server is the untrusted-input source the scanner reads, so its
// responses are data, never instructions.

import http from 'node:http';
import { httpVulnerabilities } from './vulnerabilities.mjs';

/** The index page: lists the endpoints a scanner would crawl, markers excluded. */
const INDEX_ENDPOINTS = ['/', '/api/profile', '/account/settings', '/uploads/', '/internal/debug/exec', '/health'];

/** Body for one planted endpoint: a short synthetic response carrying its marker. */
const bodyFor = (path, marker) => {
  switch (path) {
    case '/internal/debug/exec':
      return `{"synthetic":true,"warning":"debug shell reachable without auth","example":"${marker}","ran":"id"}`;
    case '/account/settings':
      return `{"synthetic":true,"note":"privileged save accepted this request header","observed_header":"${marker}","changed":"email"}`;
    case '/api/profile':
      return `{"synthetic":true,"cors_header":"${marker}","with_credentials":true,"user":"synthetic-user-42"}`;
    case '/uploads/':
      return `<html><body><h1>${marker}</h1><ul><li>q1-synthetic.csv</li><li>notes-synthetic.txt</li></ul></body></html>`;
    default:
      return `{"synthetic":true,"path":"${path}"}`;
  }
};

/**
 * Start the fixture server. Returns `{ url, port, close }`; `url` is the base the
 * `http_get` tool is confined to. `close()` resolves once the socket is down. The
 * server never blocks on a client and ignores anything but GET.
 */
export const startFixtureServer = async ({ host = '127.0.0.1' } = {}) => {
  const byPath = new Map(httpVulnerabilities().map((v) => [v.path, v.marker]));
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('content-type', path === '/uploads/' ? 'text/html' : 'application/json');
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('{"synthetic":true,"error":"method_not_allowed"}');
      return;
    }
    if (path === '/' || path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ synthetic: true, service: 'synthetic-shop', endpoints: INDEX_ENDPOINTS }));
      return;
    }
    const marker = byPath.get(path);
    if (marker !== undefined) {
      res.writeHead(200);
      res.end(bodyFor(path, marker));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ synthetic: true, error: 'not_found', path }));
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

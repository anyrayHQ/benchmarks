// The sdk-app-scanner-long target: a synthetic bank's web service a security scanner
// assesses through three read paths, all generated deterministically from one seed so two
// arms read byte-identical data and a round is reproducible.
//
//   recorded traffic  traffic.sqlite, 48 rows of 20-60 kB (the traffic_query tool)
//   live service      the endpoint catalog below, served by server.mjs (the http_get tool):
//                     22 paths on the index, plus hidden ones only a lead names
//   customer files    files/ (the customer_file tool): an API spec, an nginx config, an
//                     env file, a scope note and an access-log sample
//
// Vulnerability markers and leads come from vulnerabilities.mjs, so where a finding is
// planted and what points at it are written once. Content-free by construction: every
// body is fabricated filler around SYNTHETIC sentinels; no real host, user or secret.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rng, fillerBody, WORDS, MIN_ROW_BYTES, MAX_ROW_BYTES } from '../traffic-fixture/generate.mjs';
import { SCANNER_VULNERABILITIES, SCANNER_LEADS } from './vulnerabilities.mjs';

export const DEFAULT_SEED = 4242;
export const DEFAULT_ROWS = 48;

/** The service index (GET /): what a crawler sees first. No hidden path is listed. */
export const INDEX_PATHS = [
  '/', '/health', '/status', '/api/profile', '/account/settings', '/internal/debug/exec', '/api/graphql',
  '/api/orders', '/api/users', '/api/cart', '/api/search', '/api/reports', '/api/products', '/api/inventory',
  '/api/notifications', '/api/payments/methods', '/api/shipping/rates', '/api/coupons', '/api/reviews',
  '/api/settings/locale', '/api/feature-flags', '/api/sessions',
];

/** FNV-1a over a name, so each endpoint and file has its own stream under one seed. */
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
const streamFor = (seed, name) => rng((seed ^ fnv(name)) >>> 0);

const vulnAt = (pred) => SCANNER_VULNERABILITIES.filter(pred);
const leadsFrom = (pred) => SCANNER_LEADS.filter(pred).map((l) => l.text);

/** Sizes (bytes of filler) per path; anything unlisted is a small 1.5-6 kB JSON body. */
const LARGE = {
  '/api/reports': 26_000,
  '/api/products': 12_000,
  '/api/v2/export': 28_000,
  '/internal/metrics/raw': 30_000,
  '/backups/db-2026-09.sql': 36_000,
  '/api/search?debug=1': 8_000,
};

const jsonBody = (seed, path, injects) => {
  const next = streamFor(seed, path);
  const size = LARGE[path] ?? 1_500 + Math.floor(next() * 4_500);
  return fillerBody(next, size, injects.join(' '));
};

/** The SQL dump at the end of the deepest chain: plain text, not JSON. */
const dumpBody = (seed, marker) => {
  const next = streamFor(seed, '/backups/db-2026-09.sql');
  const lines = ['-- synthetic dump of bank_synthetic, 2026-09', 'SET client_encoding = UTF8;'];
  let size = 0;
  for (let i = 0; size < LARGE['/backups/db-2026-09.sql']; i++) {
    const w = WORDS[Math.floor(next() * WORDS.length)];
    const line = `INSERT INTO ${w}_log VALUES (${i}, '${w}-${Math.floor(next() * 1e6)}', 'synthetic row for padding');`;
    lines.push(line);
    size += line.length + 1;
    if (i === 400) lines.push(`ALTER ROLE app_rw WITH LOGIN ${marker};`);
  }
  return lines.join('\n');
};

/**
 * The live service: path (with the one probe query) -> { status, type, body }. Index paths,
 * the hidden paths leads point at, the probe variant of /api/search, and non-admin user
 * records beside the admin one, so a probe of a neighbouring id finds nothing.
 */
export const scannerEndpoints = ({ seed = DEFAULT_SEED } = {}) => {
  const out = new Map();
  const vulnOn = (path) => vulnAt((v) => v.where === 'http' && v.path === path).map((v) => v.marker);
  const leadOn = (path) => leadsFrom((l) => l.where === 'http' && l.from === path);
  out.set('/', { status: 200, type: 'application/json', body: JSON.stringify({ synthetic: true, service: 'synthetic-bank', endpoints: INDEX_PATHS }) });
  for (const path of INDEX_PATHS.slice(1)) {
    out.set(path, { status: 200, type: 'application/json', body: jsonBody(seed, path, [...vulnOn(path), ...leadOn(path)]) });
  }
  for (const path of ['/api/v2/export', '/internal/metrics/raw', '/api/search?debug=1', '/legacy/login.php']) {
    const status = path === '/api/search?debug=1' || path === '/legacy/login.php' ? 500 : 200;
    out.set(path, { status, type: 'application/json', body: jsonBody(seed, path, [...vulnOn(path), ...leadOn(path)]) });
  }
  const [listingMarker] = vulnOn('/backups/');
  out.set('/backups/', {
    status: 200,
    type: 'text/html',
    body: `<html><head><title>${listingMarker}</title></head><body><h1>${listingMarker}</h1><ul>` +
      `<li><a ${leadOn('/backups/').join(' ')}>db-2026-09.sql</a></li><li>notes-synthetic.txt</li><li>rotate-synthetic.log</li></ul></body></html>`,
  });
  const [dumpMarker] = vulnOn('/backups/db-2026-09.sql');
  out.set('/backups/db-2026-09.sql', { status: 200, type: 'text/plain', body: dumpBody(seed, dumpMarker) });
  for (let id = 1; id <= 5; id++) {
    const path = `/api/admin/users/${id}`;
    const role = id === 1 ? 'admin' : 'member';
    out.set(path, { status: 200, type: 'application/json', body: JSON.stringify({ synthetic: true, id, role, name: `synthetic-user-${id}`, ...(id === 1 && { record: vulnOn(path)[0] }) }) });
  }
  return out;
};

/** A YAML-ish OpenAPI spec listing the index paths with filler descriptions, plus the
 *  two internal paths its leads name. */
const openapiYaml = (seed) => {
  const next = streamFor(seed, 'openapi.yaml');
  const lines = ['openapi: 3.0.3', 'info:', '  title: synthetic-bank API', '  version: 2026.09-synthetic', 'paths:'];
  const leads = leadsFrom((l) => l.where === 'file' && l.file === 'openapi.yaml');
  const blocks = INDEX_PATHS.filter((p) => p !== '/').map((p) => [`  ${p}:`, '    get:']);
  blocks.splice(9, 0, [leads[0]]);
  blocks.splice(17, 0, [leads[1]]);
  for (const block of blocks) {
    lines.push(...block);
    for (let i = 0; i < 12; i++) {
      const w = WORDS[Math.floor(next() * WORDS.length)];
      lines.push(`      # ${w} ${w} field ${Math.floor(next() * 1e5)}: synthetic description line for padding`);
    }
  }
  return lines.join('\n') + '\n';
};

const fileText = (seed, name, minBytes, linesAround) => {
  const next = streamFor(seed, name);
  const out = [];
  let size = 0;
  let planted = false;
  while (size < minBytes || !planted) {
    if (!planted && size >= minBytes / 2) {
      out.push(...linesAround);
      planted = true;
    }
    const w = WORDS[Math.floor(next() * WORDS.length)];
    const line = `# ${w} ${Math.floor(next() * 1e6)} synthetic ${w} note for padding`;
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n') + '\n';
};

/** The customer-provided files, name -> text. */
export const customerFiles = ({ seed = DEFAULT_SEED } = {}) => {
  const vulnIn = (file) => vulnAt((v) => v.where === 'file' && v.file === file).map((v) => v.marker);
  const leadIn = (file) => leadsFrom((l) => l.where === 'file' && l.file === file);
  return new Map([
    ['openapi.yaml', openapiYaml(seed)],
    ['nginx.conf', fileText(seed, 'nginx.conf', 5_000, ['server {', '    listen 443 ssl;', `    ${vulnIn('nginx.conf')[0]} TLSv1.2;`, `    ${leadIn('nginx.conf')[0]}`, '        proxy_pass http://php-legacy-synthetic;', '    }', '}'])],
    ['env.staging', fileText(seed, 'env.staging', 3_000, ['APP_ENV=staging', 'DB_HOST=db.synthetic.internal', vulnIn('env.staging')[0], 'FEATURE_FLAGS=synthetic'])],
    ['pentest-scope.md', fileText(seed, 'pentest-scope.md', 4_000, ['## Scope (synthetic engagement)', 'In scope: the public API, the account pages, any internal path the service exposes, and everything the recorded traffic shows.', 'Out of scope: denial of service.'])],
    ['access-log-sample.txt', fileText(seed, 'access-log-sample.txt', 30_000, ['# rotated 2026-09-30 (synthetic)'])],
  ]);
};

/**
 * Build the target under `dir`: `traffic.sqlite` and `files/`. Returns the row count and
 * which row carries each planted marker or lead (ids only, never content). Idempotent.
 */
export const buildScannerTarget = (dir, { seed = DEFAULT_SEED, rows = DEFAULT_ROWS } = {}) => {
  const plants = [
    ...SCANNER_VULNERABILITIES.filter((v) => v.where === 'traffic').map((v) => ({ id: v.id, text: v.marker })),
    ...SCANNER_LEADS.filter((l) => l.where === 'traffic').map((l) => ({ id: l.id, text: l.text })),
  ];
  // Interleave leads among the findings so a reader meets one early and one late.
  const order = [plants[0], plants[7], ...plants.slice(1, 4), plants[8], ...plants.slice(4, 7)];
  if (rows < order.length * 2) throw new Error(`need at least ${order.length * 2} rows`);
  // Spread from row 2 to near the last row, so the scan finds something early and late.
  const step = Math.floor((rows - 3) / (order.length - 1));
  const planted = {};
  for (const [i, p] of order.entries()) planted[2 + i * step] = p;

  mkdirSync(join(dir, 'files'), { recursive: true });
  const dbPath = join(dir, 'traffic.sqlite');
  const next = rng(seed);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TABLE IF EXISTS traffic');
    db.exec(
      'CREATE TABLE traffic (id INTEGER PRIMARY KEY, method TEXT NOT NULL, url TEXT NOT NULL, status INTEGER NOT NULL, request_body TEXT NOT NULL, response_body TEXT NOT NULL, captured_at TEXT NOT NULL, bytes INTEGER NOT NULL)'
    );
    const insert = db.prepare('INSERT INTO traffic (id, method, url, status, request_body, response_body, captured_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const paths = ['/api/orders', '/api/users', '/auth/login', '/api/search', '/api/cart', '/api/payments/methods', '/api/reports', '/api/profile'];
    db.exec('BEGIN');
    for (let id = 0; id < rows; id++) {
      const p = planted[id];
      const minBytes = MIN_ROW_BYTES + Math.floor(next() * (MAX_ROW_BYTES - MIN_ROW_BYTES - 2048));
      const response = fillerBody(next, minBytes, p ? p.text : '');
      const method = ['GET', 'POST', 'PUT', 'DELETE'][Math.floor(next() * 4)];
      const url = `https://bank.synthetic.example${paths[Math.floor(next() * paths.length)]}?p=${Math.floor(next() * 9999)}`;
      const request = JSON.stringify({ synthetic: true, q: WORDS[Math.floor(next() * WORDS.length)], n: Math.floor(next() * 1000) });
      const status = [200, 200, 201, 204, 400, 500][Math.floor(next() * 6)];
      const capturedAt = new Date(Date.UTC(2026, 8, 1 + (id % 28), id % 24, id % 60)).toISOString();
      insert.run(id, method, url, status, request, response, capturedAt, response.length);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const filesDir = join(dir, 'files');
  for (const [name, text] of customerFiles({ seed })) writeFileSync(join(filesDir, name), text);
  return { dbPath, filesDir, rows, planted: Object.fromEntries(Object.entries(planted).map(([id, p]) => [id, p.id])) };
};

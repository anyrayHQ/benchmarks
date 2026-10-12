// Deterministic generator for the synthetic recorded-traffic SQLite the scanner's
// `traffic_query` tool reads. Everything is synthetic: fabricated request/response
// bodies padded to 20–60 kB each, with the six `where: 'traffic'` vulnerability markers
// planted in known rows. A fixed seed gives byte-identical rows every run, so a round is
// reproducible and two arms read the same bytes. Content-free by construction — no real
// host, user or secret appears, and every marker is an obvious SYNTHETIC sentinel.
//
// Table: traffic(id INTEGER PRIMARY KEY, method TEXT, url TEXT, status INTEGER,
//                 request_body TEXT, response_body TEXT, captured_at TEXT, bytes INTEGER)
// One row per captured request; `bytes` is the response_body length, which the row's
// generator holds between MIN_ROW_BYTES and MAX_ROW_BYTES.

import { DatabaseSync } from 'node:sqlite';
import { trafficVulnerabilities } from './vulnerabilities.mjs';

export const MIN_ROW_BYTES = 20 * 1024;
export const MAX_ROW_BYTES = 60 * 1024;
export const DEFAULT_ROW_COUNT = 24;

/** mulberry32: a tiny deterministic PRNG, so a seed fixes every byte. */
const rng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];
const PATHS = ['/api/orders', '/api/users', '/auth/login', '/api/search', '/metrics', '/api/cart', '/webhook/stripe', '/api/reports'];
const WORDS = ['order', 'user', 'latency', 'region', 'status', 'payload', 'retry', 'cache', 'shard', 'tenant', 'cursor', 'quota', 'batch', 'token', 'queue'];

/** A synthetic JSON log blob padded with deterministic filler to at least `minBytes`. */
const fillerBody = (next, minBytes, inject = '') => {
  const events = [];
  let size = inject.length;
  let i = 0;
  while (size < minBytes) {
    const w = WORDS[Math.floor(next() * WORDS.length)];
    const ev = {
      seq: i++,
      field: `${w}_${Math.floor(next() * 100000)}`,
      value: Math.floor(next() * 1_000_000),
      note: `${w} ${w} ${w} ${w} ${w} synthetic record line for padding`,
    };
    const s = JSON.stringify(ev);
    size += s.length + 1;
    events.push(ev);
  }
  const body = { synthetic: true, events };
  let text = JSON.stringify(body);
  if (inject) {
    // Splice the marker into the middle of the body so it is not a tidy prefix a
    // skim would catch; the scanner has to read the row to find it.
    const at = Math.floor(text.length / 2);
    text = `${text.slice(0, at)} /* ${inject} */ ${text.slice(at)}`;
  }
  return text;
};

/**
 * Build the SQLite file at `path`. Returns the row count and which row id carries each
 * planted marker, so a test can assert the planting without re-reading content. Deletes
 * any existing file first, so re-generation is idempotent.
 */
export const buildTrafficDb = (path, { seed = 1337, rows = DEFAULT_ROW_COUNT } = {}) => {
  const vulns = trafficVulnerabilities();
  if (rows < vulns.length) throw new Error(`need at least ${vulns.length} rows to plant every traffic marker`);
  const next = rng(seed);
  const db = new DatabaseSync(path);
  try {
    db.exec('DROP TABLE IF EXISTS traffic');
    db.exec(
      'CREATE TABLE traffic (id INTEGER PRIMARY KEY, method TEXT NOT NULL, url TEXT NOT NULL, status INTEGER NOT NULL, request_body TEXT NOT NULL, response_body TEXT NOT NULL, captured_at TEXT NOT NULL, bytes INTEGER NOT NULL)'
    );
    const insert = db.prepare(
      'INSERT INTO traffic (id, method, url, status, request_body, response_body, captured_at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    // Spread the planted rows across the table (every `step`-th row) so they are not
    // clustered at the start.
    const step = Math.floor(rows / vulns.length) || 1;
    const planted = {};
    for (const [i, v] of vulns.entries()) planted[(i * step) % rows] = v;
    db.exec('BEGIN');
    for (let id = 0; id < rows; id++) {
      const v = planted[id];
      const minBytes = MIN_ROW_BYTES + Math.floor(next() * (MAX_ROW_BYTES - MIN_ROW_BYTES - 2048));
      const response = fillerBody(next, minBytes, v ? v.marker : '');
      const method = METHODS[Math.floor(next() * METHODS.length)];
      const url = `https://shop.synthetic.example${PATHS[Math.floor(next() * PATHS.length)]}?p=${Math.floor(next() * 9999)}`;
      const request = JSON.stringify({ synthetic: true, q: WORDS[Math.floor(next() * WORDS.length)], n: Math.floor(next() * 1000) });
      const status = v?.id === 'verbose-stacktrace' ? 500 : [200, 200, 201, 204, 400][Math.floor(next() * 5)];
      const capturedAt = new Date(Date.UTC(2026, 8, 1 + (id % 28), id % 24, id % 60)).toISOString();
      insert.run(id, method, url, status, request, response, capturedAt, response.length);
    }
    db.exec('COMMIT');
    return { rows, planted: Object.fromEntries(Object.entries(planted).map(([id, v]) => [id, v.id])) };
  } finally {
    db.close();
  }
};

// CLI: node tools/traffic-fixture/generate.mjs <out.sqlite> [seed] [rows]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, seed, rows] = process.argv.slice(2);
  if (!out) {
    console.error('usage: node tools/traffic-fixture/generate.mjs <out.sqlite> [seed] [rows]');
    process.exit(2);
  }
  const info = buildTrafficDb(out, { seed: seed ? Number(seed) : undefined, rows: rows ? Number(rows) : undefined });
  console.log(`wrote ${info.rows} rows to ${out}; planted ${Object.keys(info.planted).length} markers`);
}

// The API-agent replica of a graph agent on a company's internal API: search the catalog, select an
// endpoint to read its spec, call it page after page. The catalog is generated from a seed, so both
// arms see identical data and the right answer is known without a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_SEED, buildCatalog, executeApiTool, expectedAnswer, writeCatalog } from '../lib/apiCatalog.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'api-catalog-'));

test('the catalog and its answer repeat exactly for a seed', () => {
  assert.deepEqual(buildCatalog(API_SEED), buildCatalog(API_SEED));
  assert.notDeepEqual(buildCatalog(API_SEED).ledger, buildCatalog(API_SEED + 1).ledger);
});

test('the expected answer is the open balance of the target building, from the raw records', () => {
  const c = buildCatalog(API_SEED);
  const open = c.ledger.filter((e) => e.building === c.target && e.status === 'open');
  assert.equal(expectedAnswer(c), `ANSWER: ${open.reduce((n, e) => n + e.amount, 0)} ${open.length}`);
  assert.ok(c.ledger.filter((e) => e.building === c.target).length > 4 * 25, 'the ledger spans several pages, so one page cannot answer it');
});

test('search finds the ledger endpoint among near-duplicates; select returns its spec', () => {
  const c = buildCatalog(API_SEED);
  const hits = executeApiTool(c, 'searchApi', { query: 'ledger entries' });
  assert.match(hits, /listLedgerEntries\b/);
  assert.match(hits, /listLedgerEntriesArchived/, 'a decoy sits beside the real endpoint');
  const spec = executeApiTool(c, 'selectApi', { name: 'listLedgerEntries' });
  assert.match(spec, /building/);
  assert.match(spec, /page/);
});

test('a call pages through the whole ledger and the last page is short', () => {
  const c = buildCatalog(API_SEED);
  const pages = [];
  for (let page = 1; ; page++) {
    const out = JSON.parse(executeApiTool(c, 'apiCall', { name: 'listLedgerEntries', params: { building: c.target, page } }));
    pages.push(out);
    if (!out.nextPage) break;
  }
  assert.ok(pages.length >= 4);
  const all = pages.flatMap((p) => p.items);
  assert.equal(all.length, c.ledger.filter((e) => e.building === c.target).length);
  assert.ok(pages.at(-1).items.length <= pages[0].items.length);
});

test('a decoy endpoint returns different data, and unknown names or params are refused', () => {
  const c = buildCatalog(API_SEED);
  const real = executeApiTool(c, 'apiCall', { name: 'listLedgerEntries', params: { building: c.target, page: 1 } });
  const decoy = executeApiTool(c, 'apiCall', { name: 'listLedgerEntriesArchived', params: { building: c.target, page: 1 } });
  assert.notEqual(real, decoy);
  assert.match(executeApiTool(c, 'apiCall', { name: 'nope', params: {} }), /unknown endpoint/);
  assert.match(executeApiTool(c, 'apiCall', { name: 'listLedgerEntries', params: { page: 1 } }), /building is required/);
});

test('writeCatalog leaves catalog.json for the tools to read', () => {
  const dir = fresh();
  try {
    writeCatalog(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')), buildCatalog(API_SEED));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the scenario file states the right answer and a task that cannot be answered from one page', () => {
  const yaml = readFileSync(new URL('../scenarios/framework-api-agent/scenario.yaml', import.meta.url), 'utf8');
  assert.ok(yaml.includes(expectedAnswer(buildCatalog(API_SEED))), 'keyFacts holds the expected answer line');
  assert.match(yaml, /tools: api/);
});

// A synthetic internal-API catalog for the API-agent replica: the shape of a graph agent that
// searches an API catalog, selects an endpoint to read its spec, then calls it page by page. Built
// from a seed so both arms see identical data and the right answer is known without a model. No
// real company data: names, amounts and memos are generated.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seededUniform } from './seededRandom.mjs';

export const API_SEED = 20261025;
export const PAGE_SIZE = 25;
const BUILDINGS = Array.from({ length: 12 }, (_, i) => `B-${String(i + 1).padStart(2, '0')}`);
const TARGET = 'B-07';
const KINDS = ['rent', 'late fee', 'deposit', 'utility', 'parking'];
const STATUSES = ['open', 'paid', 'paid', 'void'];
const WORDS = ['carried', 'from', 'prior', 'month', 'adjusted', 'per', 'lease', 'addendum', 'waived', 'partial', 'payment', 'received', 'unit', 'inspection', 'credit', 'pending', 'review', 'resident', 'request', 'invoice', 'posted'];

const pick = (next, xs) => xs[Math.floor(next() * xs.length)];
const int = (next, lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
const sentence = (next, n) => Array.from({ length: n }, () => pick(next, WORDS)).join(' ');

function ledger(next, prefix, perBuilding) {
  let n = 0;
  return BUILDINGS.flatMap((building) => Array.from({ length: building === TARGET ? perBuilding.target : perBuilding.other }, () => ({
    id: `${prefix}-${String(++n).padStart(5, '0')}`, building, unit: `U-${int(next, 100, 499)}`, tenantId: `T-${int(next, 1000, 9999)}`,
    kind: pick(next, KINDS), amount: int(next, 150, 3200), status: pick(next, STATUSES),
    dueDate: `2026-${String(int(next, 1, 12)).padStart(2, '0')}-${String(int(next, 1, 28)).padStart(2, '0')}`,
    memo: sentence(next, 14), notes: sentence(next, 12),
  })));
}

const RESOURCES = ['tenants', 'units', 'leases', 'ledger', 'vendors', 'workOrders', 'payments', 'listings'];
const VERBS = [['list', 'List'], ['get', 'Get one of the'], ['search', 'Search the'], ['create', 'Create a record in the'], ['update', 'Update a record in the']];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const PAGED = [{ name: 'page', type: 'integer', required: false, description: 'One-based page number; 25 items per page.' }];

function endpoint(resource, [verb, phrase], next) {
  const name = `${verb}${cap(resource === 'ledger' && verb === 'list' ? 'ledgerEntries' : resource)}`;
  return {
    name, resource, summary: `${phrase} ${resource} records`,
    params: verb === 'list' ? PAGED : [{ name: 'id', type: 'string', required: true, description: `The ${resource} record id.` }],
    doc: `${phrase} ${resource} records. ${sentence(next, 40)}. Returns JSON. Rate limited. ${sentence(next, 40)}.`,
  };
}

/** The whole catalog: endpoints (with decoys beside the real ledger endpoint) and the data behind them. */
export function buildCatalog(seed = API_SEED) {
  const next = seededUniform(seed);
  const endpoints = RESOURCES.flatMap((r) => VERBS.map((v) => endpoint(r, v, next)));
  const ledgerParams = [{ name: 'building', type: 'string', required: true, description: 'Building code such as B-07.' }, ...PAGED];
  const real = endpoints.find((e) => e.name === 'listLedgerEntries');
  real.summary = 'List ledger entries for a building (current period and all open charges)';
  real.params = ledgerParams;
  endpoints.push(
    { name: 'listLedgerEntriesArchived', resource: 'ledger', summary: 'List archived ledger entries for a building (closed periods only)', params: ledgerParams, doc: `Archived ledger entries. ${sentence(next, 40)}.` },
    { name: 'listLedgerSummary', resource: 'ledger', summary: 'Ledger totals per building, no entry detail', params: [], doc: `Totals only. ${sentence(next, 30)}.` },
  );
  return {
    target: TARGET, endpoints,
    ledger: ledger(next, 'L', { target: 130, other: 100 }),
    ledgerArchived: ledger(next, 'A', { target: 80, other: 60 }),
  };
}

/** The line the task asks for: the target building's open balance and how many entries make it up. */
export function expectedAnswer(catalog) {
  const open = catalog.ledger.filter((e) => e.building === catalog.target && e.status === 'open');
  return `ANSWER: ${open.reduce((n, e) => n + e.amount, 0)} ${open.length}`;
}

export function writeCatalog(dir, seed = API_SEED) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(buildCatalog(seed)));
}

const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** One tool call against the catalog; the result is the text the model reads. */
export function executeApiTool(catalog, tool, input = {}) {
  if (tool === 'searchApi') {
    const q = words(String(input.query ?? ''));
    const scored = catalog.endpoints.map((e) => ({ e, s: q.filter((w) => words(`${e.name} ${e.summary}`).some((x) => x.includes(w))).length })).filter((x) => x.s > 0);
    return scored.sort((a, b) => b.s - a.s).slice(0, 8).map(({ e }) => `${e.name}: ${e.summary}`).join('\n') || 'no endpoints match';
  }
  const found = catalog.endpoints.find((e) => e.name === input.name);
  if (!found) return `unknown endpoint ${String(input.name).slice(0, 60)}`;
  if (tool === 'selectApi') return JSON.stringify(found);
  if (tool !== 'apiCall') return `unknown tool ${tool}`;
  const params = input.params ?? {};
  const rows = { listLedgerEntries: catalog.ledger, listLedgerEntriesArchived: catalog.ledgerArchived }[found.name];
  if (!rows) return JSON.stringify({ items: [], page: 1, nextPage: null, note: 'no data behind this endpoint in this environment' });
  if (!params.building) return 'building is required';
  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const all = rows.filter((e) => e.building === params.building);
  const items = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return JSON.stringify({ items, page, nextPage: page * PAGE_SIZE < all.length ? page + 1 : null, total: all.length });
}

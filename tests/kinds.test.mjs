import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS_HEADER,
  RESULT_HEADER,
  parseKinds,
  withKindsHeader,
  parseOptimizationResult,
  tallyKinds,
  formatKindTally,
} from '../lib/optimizationKinds.mjs';

test('header names match the gateway contract', () => {
  assert.equal(KINDS_HEADER, 'x-anyray-optimization-kinds');
  assert.equal(RESULT_HEADER, 'x-anyray-optimization-result');
});

test('parseKinds: comma list, trimmed, deduped, order kept', () => {
  assert.deepEqual(parseKinds('observation_mask, relevance_filter,observation_mask'), ['observation_mask', 'relevance_filter']);
});

test('parseKinds: refuses an empty list or a malformed kind', () => {
  assert.throws(() => parseKinds(''), /--kinds/);
  assert.throws(() => parseKinds(' , '), /--kinds/);
  assert.throws(() => parseKinds('observation_mask,Bad Kind'), /--kinds/);
  assert.throws(() => parseKinds('a\nx-anyray-api-key: ark_x'), /--kinds/); // no header injection
});

test('withKindsHeader appends the kinds header and keeps every other header', () => {
  const merged = withKindsHeader('x-anyray-provider: anthropic\nx-anyray-api-key: ark_k', ['observation_mask', 'code_graph']);
  assert.deepEqual(merged.split('\n'), [
    'x-anyray-provider: anthropic',
    'x-anyray-api-key: ark_k',
    'x-anyray-optimization-kinds: observation_mask,code_graph',
  ]);
});

test('withKindsHeader replaces a kinds header already present (case-insensitive), never duplicates it', () => {
  const merged = withKindsHeader('X-Anyray-Optimization-Kinds: thinking_trim\nx-anyray-provider: anthropic', ['observation_mask']);
  assert.deepEqual(merged.split('\n'), ['x-anyray-provider: anthropic', 'x-anyray-optimization-kinds: observation_mask']);
});

test('withKindsHeader without kinds leaves the headers untouched', () => {
  assert.equal(withKindsHeader('a: 1\nb: 2', []), 'a: 1\nb: 2');
  assert.equal(withKindsHeader(undefined, null), '');
});

test('parseOptimizationResult reads applied, skipped with reasons, and preserved', () => {
  const r = parseOptimizationResult(JSON.stringify({
    status: 'applied',
    requested: { only: ['observation_mask', 'code_graph'] },
    applied: ['observation_mask', 'cache_optimizer'],
    skipped: [{ kind: 'code_graph', reason: 'safety_gate' }],
    preserved: ['thinking_trim'],
  }));
  assert.deepEqual(r, {
    status: 'applied',
    applied: ['observation_mask', 'cache_optimizer'],
    skipped: [{ kind: 'code_graph', reason: 'safety_gate' }],
    preserved: ['thinking_trim'],
  });
});

test('parseOptimizationResult: a missing or invalid header is unconfirmed', () => {
  assert.deepEqual(parseOptimizationResult(undefined), { status: 'unconfirmed', why: 'missing' });
  assert.deepEqual(parseOptimizationResult(''), { status: 'unconfirmed', why: 'missing' });
  assert.deepEqual(parseOptimizationResult('{not json'), { status: 'unconfirmed', why: 'invalid' });
  assert.deepEqual(parseOptimizationResult('"applied"'), { status: 'unconfirmed', why: 'invalid' });
  assert.deepEqual(parseOptimizationResult(JSON.stringify({ applied: 'x' })), { status: 'unconfirmed', why: 'invalid' });
});

test('parseOptimizationResult keeps only catalogue-shaped ids and reasons (nothing else from the wire)', () => {
  const r = parseOptimizationResult(JSON.stringify({
    status: 'applied', applied: ['ok_kind', 'Bad Kind'], skipped: [{ kind: 'k', reason: 'no_change', extra: 'x' }, { kind: 1 }], preserved: [],
  }));
  assert.deepEqual(r.applied, ['ok_kind']);
  assert.deepEqual(r.skipped, [{ kind: 'k', reason: 'no_change' }]);
});

test('tallyKinds counts per requested kind: applied, skipped by reason, unconfirmed', () => {
  const results = [
    { status: 'applied', applied: ['observation_mask'], skipped: [{ kind: 'code_graph', reason: 'no_change' }], preserved: [] },
    { status: 'applied', applied: [], skipped: [{ kind: 'observation_mask', reason: 'safety_gate' }, { kind: 'code_graph', reason: 'no_change' }], preserved: [] },
    { status: 'unavailable', applied: [], skipped: [{ kind: 'observation_mask', reason: 'unavailable' }, { kind: 'code_graph', reason: 'unavailable' }], preserved: [] },
    { status: 'unconfirmed', why: 'missing' },
  ];
  const t = tallyKinds(results, ['observation_mask', 'code_graph']);
  assert.equal(t.requests, 4);
  assert.equal(t.unconfirmed, 1);
  assert.deepEqual(t.byKind.observation_mask, { applied: 1, skipped: { safety_gate: 1, unavailable: 1 }, unconfirmed: 1 });
  assert.deepEqual(t.byKind.code_graph, { applied: 0, skipped: { no_change: 2, unavailable: 1 }, unconfirmed: 1 });
});

test('tallyKinds: a requested kind the response neither applied nor skipped counts as unconfirmed', () => {
  const t = tallyKinds([{ status: 'applied', applied: [], skipped: [], preserved: [] }], ['observation_mask']);
  assert.deepEqual(t.byKind.observation_mask, { applied: 0, skipped: {}, unconfirmed: 1 });
});

test('tallyKinds also counts kinds applied outside the request (support kinds, preserved rewrites)', () => {
  const t = tallyKinds([{ status: 'applied', applied: ['observation_mask', 'cache_optimizer'], skipped: [], preserved: ['thinking_trim'] }], ['observation_mask']);
  assert.deepEqual(t.otherApplied, { cache_optimizer: 1 });
  assert.deepEqual(t.preserved, { thinking_trim: 1 });
});

test('formatKindTally prints one line per requested kind', () => {
  const t = tallyKinds([{ status: 'applied', applied: ['observation_mask'], skipped: [{ kind: 'code_graph', reason: 'no_change' }], preserved: [] }, { status: 'unconfirmed', why: 'missing' }], ['observation_mask', 'code_graph']);
  const lines = formatKindTally(t).split('\n');
  assert.match(lines[0], /2 request/);
  assert.match(lines.find((l) => l.includes('observation_mask')), /applied 1 · skipped 0 · unconfirmed 1/);
  assert.match(lines.find((l) => l.includes('code_graph')), /applied 0 · skipped 1 \(no_change 1\) · unconfirmed 1/);
});

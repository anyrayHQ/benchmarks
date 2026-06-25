// Unit tests for the measurement primitives the whole benchmark rests on.
// If these are wrong, every published saving and quality number is wrong — so
// they get pinned. Pure functions, no optimizer, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { estTokens, savedPct, sizeOf, textOf } from '../lib/tokens.mjs';
import { keyFactSurvival, verdictFor, fullText } from '../lib/quality.mjs';

test('estTokens rounds chars / basis', () => {
  assert.equal(estTokens(400), 100);
  assert.equal(estTokens(402), 101); // 100.5 rounds up
  assert.equal(estTokens(100, 5), 20);
});

test('savedPct is a clean percentage and never divides by zero', () => {
  assert.equal(savedPct(100, 25), 75);
  assert.equal(savedPct(100, 0), 100);
  assert.equal(savedPct(0, 0), 0); // empty request -> no saving claimed
});

test('sizeOf counts message text plus the tools schema', () => {
  const req = { messages: [{ role: 'user', content: 'abcd' }], tools: [{ a: 1 }] };
  assert.equal(sizeOf(req), 'abcd'.length + JSON.stringify(req.tools).length);
});

test('textOf flattens both string and block-array message content', () => {
  const req = {
    messages: [
      { role: 'user', content: 'plain' },
      { role: 'tool', content: [{ type: 'text', text: 'block' }] },
    ],
  };
  const t = textOf(req);
  assert.ok(t.includes('plain'));
  assert.ok(t.includes('block'));
});

test('verdictFor bands: PASS >= 90%, MARGINAL >= 75%, else FAIL', () => {
  assert.equal(verdictFor(0.95), 'PASS');
  assert.equal(verdictFor(0.9), 'PASS');
  assert.equal(verdictFor(0.89), 'MARGINAL');
  assert.equal(verdictFor(0.75), 'MARGINAL');
  assert.equal(verdictFor(0.74), 'FAIL');
});

test('keyFactSurvival splits present vs missing verbatim and scores them', () => {
  const req = { messages: [{ role: 'user', content: 'alpha beta gamma' }] };
  const r = keyFactSurvival(req, ['alpha', 'delta', 'gamma']);
  assert.deepEqual(r.present, ['alpha', 'gamma']);
  assert.deepEqual(r.missing, ['delta']);
  assert.equal(Math.round(r.coverage * 100), 67);
  assert.equal(r.verdict, 'FAIL');
});

test('fullText searches the tools schema, so tool-name key facts survive', () => {
  const req = {
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [{ function: { name: 'jira_search_issues' } }],
  };
  assert.ok(fullText(req).includes('jira_search_issues'));
  assert.equal(keyFactSurvival(req, ['jira_search_issues']).present.length, 1);
});

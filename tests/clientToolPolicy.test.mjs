import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setClientToolPolicies } from '../lib/agentRun.mjs';
import { parseArgs, parseClientToolPolicy } from '../run_agent.mjs';

test('parseClientToolPolicy: name=true|false only', () => {
  assert.deepEqual(parseClientToolPolicy('readBatchRanges=true'), { readBatchRanges: true });
  assert.deepEqual(parseClientToolPolicy('readBatch=false'), { readBatch: false });
  for (const bad of ['readBatchRanges', 'readBatchRanges=1', '=true', 'Read=true', 'a b=true', undefined]) assert.throws(() => parseClientToolPolicy(bad), /name=true\|false/);
});

test('--client-tool-policy is repeatable and refused with --bare', () => {
  const a = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--client-tool-policy', 'readBatchRanges=true', '--client-tool-policy', 'readBatch=true']);
  assert.deepEqual(a.clientToolPolicies, { readBatchRanges: true, readBatch: true });
  assert.throws(() => parseArgs(['--scenario', 's', '--bare', '--client-tool-policy', 'readBatchRanges=true']), /--bare runs without anyray-connect/);
});

test('setClientToolPolicies merges into the profile and keeps everything else', () => {
  const home = mkdtempSync(join(tmpdir(), 'ctp-'));
  mkdirSync(join(home, '.anyray'));
  const p = join(home, '.anyray', 'connect.json');
  writeFileSync(p, JSON.stringify({ gateway: 'https://g.test.invalid', clientToolPolicies: { readBatch: true, teeFooterIdRoute: false }, other: 1 }));
  const out = setClientToolPolicies(home, { readBatchRanges: true });
  assert.deepEqual(out, { readBatch: true, teeFooterIdRoute: false, readBatchRanges: true });
  const saved = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(saved.other, 1);
  assert.equal(saved.gateway, 'https://g.test.invalid');
  assert.equal(statSync(p).mode & 0o077, 0, 'profile stays private');
});

test('setClientToolPolicies throws when connect wrote no profile', () => {
  assert.throws(() => setClientToolPolicies(mkdtempSync(join(tmpdir(), 'ctp-none-')), { readBatchRanges: true }));
});

// No customer identifier in this public repo (ANY-1643). Token matching, not substring: SaltStack is fine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { customerIdentifierHits } from '../lib/customerIdentifiers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
// Synthetic stand-ins, so this test file names no customer.
const hashes = new Set([sha('acme'), sha('globex-corp')]);

test('a whole-token or hyphenated identifier is a hit, in any case', () => {
  assert.equal(customerIdentifierHits('built for ACME last week', hashes).length, 1);
  assert.equal(customerIdentifierHits('the Globex-Corp task', hashes).length, 1);
  assert.equal(customerIdentifierHits('globex corp', hashes).length, 1);
  assert.equal(customerIdentifierHits('path/to/acme/file.go', hashes).length, 1);
});

test('a substring of a longer word is not a hit', () => {
  assert.deepEqual(customerIdentifierHits('acmeist saltstack/globex-corporation', hashes), []);
});

test('the matcher returns hashes, never the words', () => {
  assert.deepEqual(customerIdentifierHits('acme', hashes), [sha('acme')]);
});

test('no tracked text file names a customer', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && !/\.(png|jpg|gif|ico|patch|lock)$/.test(f) && f !== 'package-lock.json');
  const dirty = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    if (customerIdentifierHits(text).length || customerIdentifierHits(f).length) dirty.push(f);
  }
  assert.deepEqual(dirty, []);
});

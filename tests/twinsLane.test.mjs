// A twin on the API-key lane is for the parity check (ANY-1643), not the seat-lane release rerun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { copyReleaseTwins } from '../lib/kitRelease.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'twins-lane-'));
const twin = (root, id, yaml) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'scenario.yaml'), yaml);
  writeFileSync(join(root, id, 'task.patch'), 'x');
};

test('the release rerun copies seat-lane twins and leaves api-key twins out, with their files', () => {
  const src = tmp();
  const dest = join(tmp(), 'twins');
  try {
    twin(src, 'seat-twin', 'title: a\nsource: proposed\n');
    twin(src, 'key-twin', 'title: b\nsource: proposed\nlane: api-key\n');
    copyReleaseTwins(src, dest);
    assert.ok(existsSync(join(dest, 'seat-twin', 'scenario.yaml')) && existsSync(join(dest, 'seat-twin', 'task.patch')));
    assert.equal(existsSync(join(dest, 'key-twin')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('a twin with no readable scenario.yaml is copied, so a broken one still fails the freeze loudly', () => {
  const src = tmp();
  const dest = join(tmp(), 'twins');
  try {
    mkdirSync(join(src, 'odd'));
    writeFileSync(join(src, 'odd', 'notes.txt'), 'x');
    copyReleaseTwins(src, dest);
    assert.ok(existsSync(join(dest, 'odd', 'notes.txt')));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('the committed protogetter twin is on the api-key lane, so the release rerun skips it', () => {
  const dest = join(tmp(), 'twins');
  const sc = load(readFileSync(new URL('../twins/go-protogetter-lint/scenario.yaml', import.meta.url), 'utf8'));
  assert.equal(sc.lane, 'api-key');
  copyReleaseTwins(new URL('../twins', import.meta.url).pathname, dest);
  assert.equal(existsSync(join(dest, 'go-protogetter-lint')), false);
  assert.ok(existsSync(join(dest, 'gin-lint-fix', 'scenario.yaml')));
});

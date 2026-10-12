import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { prepareRepo, repoCacheDir, scenarioPatches, sessionDirParent } from '../lib/agentRun.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A one-commit repo to clone from, and a scenario pinned to that commit. */
function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'bench-origin-'));
  git(['init', '-q'], dir);
  writeFileSync(join(dir, 'hello.txt'), 'hello\n');
  git(['add', '-A'], dir);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one'], dir);
  return { dir, scenario: { repo: { git: dir, ref: git(['rev-parse', 'HEAD'], dir) } } };
}

test('repoCacheDir: outside the OS temp dir by default, and overridable', () => {
  assert.equal(repoCacheDir({}), join(homedir(), '.cache', 'anyray-bench-repos'));
  assert.equal(repoCacheDir({ XDG_CACHE_HOME: '/x/cache' }), join('/x/cache', 'anyray-bench-repos'));
  assert.equal(repoCacheDir({ ANYRAY_BENCH_REPO_CACHE: '/y/repos', XDG_CACHE_HOME: '/x/cache' }), '/y/repos');
  assert.ok(!repoCacheDir({}).startsWith(tmpdir()), 'the OS prunes its temp dir and leaves half a clone');
});

test('sessionDirParent: outside the OS temp dir by default, and overridable', () => {
  assert.equal(sessionDirParent({}), join(homedir(), '.cache', 'anyray-bench-sessions'));
  assert.equal(sessionDirParent({ XDG_CACHE_HOME: '/x/cache' }), join('/x/cache', 'anyray-bench-sessions'));
  assert.equal(sessionDirParent({ ANYRAY_BENCH_SESSION_DIR: '/y/sessions', XDG_CACHE_HOME: '/x/cache' }), '/y/sessions');
  assert.ok(!sessionDirParent({}).startsWith(tmpdir()), 'connect installs no hooks or MCP server for a HOME in the temp dir');
});

test('prepareRepo: clones once into the cache and hands each session its own checkout', () => {
  const { dir, scenario } = origin();
  const cacheDir = mkdtempSync(join(tmpdir(), 'bench-cache-'));
  const works = [];
  try {
    works.push(prepareRepo(scenario, dir, { cacheDir }));
    works.push(prepareRepo(scenario, dir, { cacheDir }));
    assert.notEqual(works[0], works[1]);
    for (const w of works) assert.equal(readFileSync(join(w, 'hello.txt'), 'utf8'), 'hello\n');
    assert.equal(readdirSync(cacheDir).length, 1);
  } finally {
    for (const d of [dir, cacheDir, ...works]) rmSync(d, { recursive: true, force: true });
  }
});

test('prepareRepo: a cached clone that lost its git metadata is cloned again', () => {
  const { dir, scenario } = origin();
  const cacheDir = mkdtempSync(join(tmpdir(), 'bench-cache-'));
  const works = [];
  try {
    works.push(prepareRepo(scenario, dir, { cacheDir }));
    const cached = join(cacheDir, readdirSync(cacheDir)[0]);
    // What a temp-dir cleaner leaves behind: the directories, without HEAD or config.
    for (const f of ['HEAD', 'config', 'index', 'packed-refs', 'description']) rmSync(join(cached, '.git', f), { force: true });
    assert.ok(existsSync(join(cached, '.git', 'objects')));
    works.push(prepareRepo(scenario, dir, { cacheDir }));
    assert.equal(readFileSync(join(works[1], 'hello.txt'), 'utf8'), 'hello\n');
    assert.ok(existsSync(join(cached, '.git', 'HEAD')));
  } finally {
    for (const d of [dir, cacheDir, ...works]) rmSync(d, { recursive: true, force: true });
  }
});

test('scenarioPatches: none, one file, or a list in order', () => {
  assert.deepEqual(scenarioPatches({}), []);
  assert.deepEqual(scenarioPatches({ patch: 'a.patch' }), ['a.patch']);
  assert.deepEqual(scenarioPatches({ patch: ['a.patch', 'b.patch'] }), ['a.patch', 'b.patch']);
});

test('prepareRepo: applies a list of patches in order, and hidePatch leaves one commit', () => {
  const { dir, scenario } = origin();
  const scenarioDir = mkdtempSync(join(tmpdir(), 'bench-scenario-'));
  const cacheDir = mkdtempSync(join(tmpdir(), 'bench-cache-'));
  const works = [];
  try {
    // The second patch edits what the first one wrote, so it only applies after it.
    writeFileSync(join(scenarioDir, 'one.patch'), [
      'diff --git a/hello.txt b/hello.txt', '--- a/hello.txt', '+++ b/hello.txt', '@@ -1 +1 @@', '-hello', '+hello, world', '',
    ].join('\n'));
    writeFileSync(join(scenarioDir, 'two.patch'), [
      'diff --git a/hello.txt b/hello.txt', '--- a/hello.txt', '+++ b/hello.txt', '@@ -1 +1,2 @@', ' hello, world', '+again', '',
    ].join('\n'));
    const patched = { ...scenario, patch: ['one.patch', 'two.patch'], hidePatch: true };
    works.push(prepareRepo(patched, scenarioDir, { cacheDir }));
    assert.equal(readFileSync(join(works[0], 'hello.txt'), 'utf8'), 'hello, world\nagain\n');
    assert.equal(git(['rev-list', '--count', 'HEAD'], works[0]), '1');
    assert.equal(git(['status', '--porcelain'], works[0]), '');
    // A single patch named as a string still applies.
    works.push(prepareRepo({ ...scenario, patch: 'one.patch' }, scenarioDir, { cacheDir }));
    assert.equal(readFileSync(join(works[1], 'hello.txt'), 'utf8'), 'hello, world\n');
  } finally {
    for (const d of [dir, scenarioDir, cacheDir, ...works]) rmSync(d, { recursive: true, force: true });
  }
});

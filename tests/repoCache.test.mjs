import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { prepareRepo, repoCacheDir, sessionDirParent } from '../lib/agentRun.mjs';

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

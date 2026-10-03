import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCitations, outsideCheckout, warmUpArgs } from '../lib/agentRun.mjs';
import { startTokens, parseArgs } from '../run_agent.mjs';

const checkout = () => {
  const work = mkdtempSync(join(tmpdir(), 'grade-'));
  const files = { 'pkg/cli/run.py': 10, 'pkg/loader/lazy.py': 20, 'pkg/utils/context.py': 5, 'pkg/loader/context.py': 5, 'setup.py': 3 };
  for (const [f, n] of Object.entries(files)) {
    mkdirSync(join(work, f, '..'), { recursive: true });
    writeFileSync(join(work, f), Array.from({ length: n }, (_, i) => `l${i}`).join('\n'));
  }
  return { work, files: Object.keys(files) };
};

test('checkCitations: a path from the checkout root resolves exactly', () => {
  const { work, files } = checkout();
  const c = checkCitations('see pkg/cli/run.py:4 and setup.py:2', work, files);
  assert.deepEqual({ total: c.total, resolved: c.resolved, exact: c.exact, bySuffix: c.bySuffix }, { total: 2, resolved: 2, exact: 2, bySuffix: 0 });
});

test('checkCitations: a tail that names exactly one file resolves, counted apart', () => {
  const { work, files } = checkout();
  const c = checkCitations('cli/run.py:4, lazy.py:19, pkg/cli/run.py:1', work, files);
  assert.deepEqual({ total: c.total, resolved: c.resolved, exact: c.exact, bySuffix: c.bySuffix, ambiguous: c.ambiguous }, { total: 3, resolved: 3, exact: 1, bySuffix: 2, ambiguous: 0 });
  assert.deepEqual(c.unresolved, []);
});

test('checkCitations: a tail that names several files stays unresolved, as ambiguous', () => {
  const { work, files } = checkout();
  const c = checkCitations('context.py:2', work, files);
  assert.deepEqual({ resolved: c.resolved, ambiguous: c.ambiguous, unresolved: c.unresolved }, { resolved: 0, ambiguous: 1, unresolved: ['context.py:2'] });
});

test('checkCitations: a line past the end of the file is unresolved, by tail too', () => {
  const { work, files } = checkout();
  const c = checkCitations('pkg/cli/run.py:999 lazy.py:999 nowhere.py:1', work, files);
  assert.equal(c.resolved, 0);
  assert.equal(c.ambiguous, 0);
  assert.equal(c.unresolved.length, 3);
});

test('checkCitations: a tail must match on a path boundary', () => {
  const { work, files } = checkout();
  assert.equal(checkCitations('azy.py:1', work, files).resolved, 0);
});

const use = (name, input) => ({ agent: 'main', blocks: [{ type: 'tool_use', name, input }] });

test('outsideCheckout: counts reads and cd outside the checkout, by directory', () => {
  const work = '/tmp/x/bench-work-1';
  const o = outsideCheckout(
    [
      use('Read', { file_path: `${work}/a.py` }),
      use('Read', { file_path: '/private/tmp/other-src/a.py' }),
      use('Grep', { pattern: 'x', path: '/private/tmp/other-src' }),
      use('Bash', { command: 'cd /private/tmp/other-src && grep -n x a.py' }),
      use('Bash', { command: `cd ${work} && ls` }),
      use('Bash', { command: 'grep -rn x pkg/' }),
      use('Read', { file_path: 'relative/a.py' }),
    ],
    work
  );
  assert.deepEqual(o, { count: 3, dirs: { '/private/tmp/other-src': 3 } });
});

test("outsideCheckout: Claude Code's own files are not counted", () => {
  const o = outsideCheckout([use('Read', { file_path: '/Users/u/.claude/projects/p/tool-results/t.txt' }), use('Read', { file_path: '/private/tmp/claude-501/p/tasks/t.output' })], '/tmp/w');
  assert.equal(o.count, 0);
});

test('outsideCheckout: a file the session wrote earlier is its own, not another checkout', () => {
  const o = outsideCheckout(
    [
      use('Bash', { command: 'go test -v ./... > /tmp/testout.log 2>&1; echo EXIT:$?' }),
      use('Read', { file_path: '/tmp/testout.log' }),
      use('Bash', { command: 'go test ./... 2>&1 | tee -a /tmp/gotest.log | tail -100' }),
      use('Read', { file_path: '/tmp/gotest.log' }),
      use('Write', { file_path: '/tmp/notes.md', content: 'x' }),
      use('Read', { file_path: '/tmp/notes.md' }),
    ],
    '/tmp/w'
  );
  // The Write itself still reaches outside (it could land in another checkout); the read after it does not.
  assert.deepEqual(o, { count: 1, dirs: { '/tmp/notes.md': 1 } });
});

test('outsideCheckout: a read BEFORE the session wrote that file still counts', () => {
  const o = outsideCheckout(
    [use('Read', { file_path: '/tmp/testout.log' }), use('Bash', { command: 'go test ./... > /tmp/testout.log' })],
    '/tmp/w'
  );
  assert.deepEqual(o, { count: 1, dirs: { '/tmp/testout.log': 1 } });
});

test("outsideCheckout: reading back an anyray-hook tee file is the hook's retrieval path, not counted", () => {
  const o = outsideCheckout(
    [use('Read', { file_path: '/private/var/folders/9g/x/T/anyray-bench-cfg-abc/home/.anyray/hook-tee/63378d635d586ae4.txt' })],
    '/tmp/w'
  );
  assert.equal(o.count, 0);
});

test('startTokens: sums the first request of each agent only', () => {
  const u = (r, w) => ({ cache_read_input_tokens: r, cache_creation_input_tokens: w });
  const s = startTokens([
    { agent: 'main', usage: u(0, 28000) },
    { agent: 'main', usage: u(28000, 500) },
    { agent: 's1', usage: u(7000, 3000) },
    { agent: 's1', usage: u(10000, 100) },
    { agent: 's2', usage: {} },
  ]);
  assert.deepEqual(s, { agents: 3, read: 7000, written: 31000 });
});

test('warmUpArgs: same setup, a one-turn no-op instead of the task', () => {
  const args = ['-p', 'THE TASK', '--model', 'm', '--settings', 's.json', '--max-turns', '80', '--output-format', 'stream-json'];
  const w = warmUpArgs(args, 'THE TASK');
  assert.equal(w.includes('THE TASK'), false);
  assert.equal(w[w.indexOf('--max-turns') + 1], '1');
  assert.equal(w[w.indexOf('--settings') + 1], 's.json');
  assert.equal(w[w.indexOf('--model') + 1], 'm');
  assert.ok(w.includes('--no-session-persistence'));
  assert.deepEqual(args[1], 'THE TASK'); // the timed session's argv is untouched
});

test('warmUpArgs: a streamed-input session gets a plain prompt', () => {
  const w = warmUpArgs(['-p', '--input-format', 'stream-json', '--max-turns', '40', '--no-session-persistence'], null);
  assert.equal(w.includes('--input-format'), false);
  assert.equal(w[0], '-p');
  assert.equal(typeof w[1], 'string');
  assert.equal(w.filter((a) => a === '--no-session-persistence').length, 1);
});

test('--warm-up is parsed and off by default', () => {
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--warm-up']).warmUp, true);
  assert.equal(parseArgs(['--scenario', 's', '--kinds', 'observation_mask']).warmUp, undefined);
});

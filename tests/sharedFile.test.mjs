// A file both arms of a round wrote outside their checkouts: the arms run at once on one
// machine, so each can overwrite or read the other's (the same /tmp log name is the usual
// case). Recorded per session (paths and a count, never contents), intersected per round,
// and the round is excluded from the paired cost verdict as `shared file`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTSIDE_WRITES_CAP, outsideWrites, sharedOutsideWrites } from '../lib/agentRun.mjs';
import { benchVerdict, exclusionReasons, formatVerdictBlock } from '../lib/benchVerdict.mjs';
import { parseArgs, runComparison, sharedFileNote } from '../run_agent.mjs';

const WORK = '/private/var/folders/x/T/anyray-bench-work-abc';
const use = (name, input) => ({ agent: 'main', blocks: [{ type: 'tool_use', name, input }] });
const bash = (...commands) => commands.map((command) => use('Bash', { command }));

// ---- what a session wrote outside its checkout --------------------------------------

test('outsideWrites: shell redirects and tee, in the shapes sessions use', () => {
  const o = outsideWrites(bash(
    'go test -v ./... 2>&1 | tee /tmp/go_test_output.txt | wc -l',
    'go test -v ./... > /tmp/go_test_verify.txt 2>&1; echo "EXIT:$?"',
    'go test ./... >> /tmp/append.log',
    'go test ./... >| /tmp/clobber.log',
    'go test ./... &> /tmp/both.log',
    'go test ./... 2> /tmp/stderr.log',
    'set -o pipefail; go test ./... 2>&1 | tee -a /tmp/tee_append.log | grep FAIL',
    "cat > /tmp/check/main.go <<'EOF'\npackage main\nEOF",
  ), WORK);
  assert.deepEqual(o, {
    count: 8,
    paths: ['/tmp/go_test_output.txt', '/tmp/go_test_verify.txt', '/tmp/append.log', '/tmp/clobber.log', '/tmp/both.log', '/tmp/stderr.log', '/tmp/tee_append.log', '/tmp/check/main.go'],
  });
});

test('outsideWrites: an unquoted -o target and a plain cp/mv target', () => {
  const o = outsideWrites(bash(
    'go build -o /tmp/bin/check ./...',
    'curl -s https://example.com/README.md -o /tmp/upstream_readme.md',
    "grep -o '/api/v1' routes.go", // a quoted -o is a grep pattern, not a file
    'cp gin.go /tmp/gin.go.bak && mv /tmp/a_test.go /tmp/pkgdir/', // a target ending in / is a directory
    '(cd sub && cp -r fixtures /tmp/fixtures_copy)',
  ), WORK);
  assert.deepEqual(o.paths, ['/tmp/bin/check', '/tmp/upstream_readme.md', '/tmp/gin.go.bak', '/tmp/fixtures_copy']);
});

test('outsideWrites: the Write, Edit, MultiEdit and NotebookEdit tools', () => {
  const o = outsideWrites([
    use('Write', { file_path: '/tmp/notes.md', content: 'never recorded' }),
    use('Edit', { file_path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }),
    use('MultiEdit', { file_path: '/var/tmp/scratch.go', edits: [] }),
    use('NotebookEdit', { notebook_path: '/tmp/n.ipynb', new_source: 'x' }),
    use('Read', { file_path: '/tmp/read_only.txt' }),
  ], WORK);
  assert.deepEqual(o, { count: 3, paths: ['/tmp/notes.md', '/var/tmp/scratch.go', '/tmp/n.ipynb'] });
  assert.ok(!JSON.stringify(o).includes('never recorded'), 'paths only, never contents');
});

test("outsideWrites: Claude Code's own files, the anyray-hook tee and /dev are not counted", () => {
  const o = outsideWrites([
    ...bash(
      'go test ./... 2>/dev/null > /dev/stderr',
      'echo x > /Users/u/.claude/projects/p/memory/x.md',
      'go test ./... > /private/tmp/claude-501/p/tasks/t.output',
      'tee /private/var/folders/x/T/anyray-bench-cfg-1/home/.anyray/hook-tee/63378d635d586ae4.txt',
    ),
    use('Write', { file_path: '/Users/u/.claude/plans/plan.md' }),
  ], WORK);
  assert.deepEqual(o, { count: 0, paths: [] });
});

test('outsideWrites: relative paths and paths in the checkout are its own; arrows are not redirects', () => {
  const o = outsideWrites([
    ...bash(
      'go test ./... > out.txt 2>&1 | tee logs/run.log',
      `go test ./... > ${WORK}/abs_inside.log`,
      'go test ./... > /var/folders/x/T/anyray-bench-work-abc/no_private_prefix.log', // the same checkout, spelled without /private
      'node -e "const f = (x) => /re/.test(x)"',
    ),
    use('Write', { file_path: 'docs/notes.md' }),
    use('Write', { file_path: `${WORK}/docs/abs.md` }),
  ], WORK);
  assert.deepEqual(o, { count: 0, paths: [] });
});

test('outsideWrites: /private/tmp is /tmp, each path once, the list capped with the count kept', () => {
  const twice = outsideWrites(bash('go test > /private/tmp/go_test_output.txt', 'go test > /tmp/go_test_output.txt'), WORK);
  assert.deepEqual(twice, { count: 1, paths: ['/tmp/go_test_output.txt'] });
  const many = outsideWrites(bash(...Array.from({ length: OUTSIDE_WRITES_CAP + 5 }, (_, i) => `go test > /tmp/run_${i}.log`)), WORK);
  assert.equal(many.count, OUTSIDE_WRITES_CAP + 5);
  assert.equal(many.paths.length, OUTSIDE_WRITES_CAP);
  assert.equal(many.paths[0], '/tmp/run_0.log');
});

// ---- per round ----------------------------------------------------------------------

test('sharedOutsideWrites: the paths both sessions wrote, in A order; none without a record', () => {
  const a = { outsideWrites: { count: 3, paths: ['/tmp/go_test_output.txt', '/tmp/a_only.log', '/tmp/notes.md'] } };
  const b = { outsideWrites: { count: 2, paths: ['/tmp/notes.md', '/tmp/go_test_output.txt'] } };
  assert.deepEqual(sharedOutsideWrites(a, b), ['/tmp/go_test_output.txt', '/tmp/notes.md']);
  assert.deepEqual(sharedOutsideWrites(a, { outsideWrites: { count: 1, paths: ['/tmp/b_only.log'] } }), []);
  assert.deepEqual(sharedOutsideWrites(a, {}), []);
  assert.deepEqual(sharedOutsideWrites(undefined, b), []);
});

const round = (n, extra = {}) => ({
  round: n, ratio: 0.8, quality: { a: true, b: true },
  sessions: { a: { totals: { costUsd: 2, outsideCheckout: 0 } }, b: { totals: { costUsd: 1.6, outsideCheckout: 0 } } },
  ...extra,
});

test('exclusionReasons and the paired verdict: a shared file excludes the round, beside outside checkout', () => {
  assert.deepEqual(exclusionReasons(round(1, { sharedOutsideWrites: ['/tmp/go_test_output.txt'] })), ['shared file']);
  assert.deepEqual(exclusionReasons(round(1, { sharedOutsideWrites: [] })), []);
  const both = round(3, { sharedOutsideWrites: ['/tmp/x.txt'], sessions: { a: { totals: { costUsd: 2, outsideCheckout: 2 } }, b: { totals: { costUsd: 1.6 } } } });
  assert.deepEqual(exclusionReasons(both), ['outside checkout', 'shared file']);
  const v = benchVerdict([round(1), round(2, { sharedOutsideWrites: ['/tmp/go_test_output.txt'] }), both], { minRounds: 1 });
  assert.equal(v.n, 1);
  assert.equal(v.excludedByReason['shared file'], 2);
  assert.equal(v.excludedByReason['outside checkout'], 1);
  const block = formatVerdictBlock(v).split('\n');
  assert.ok(block.includes('Excluded: 2  (not solved 0, failed round 0, outside checkout 1, shared file 2, gateway restart 0; reasons may overlap)'), block.join('\n'));
  assert.ok(block.includes('Excluded rounds: 2 (shared file); 3 (outside checkout, shared file)'), block.join('\n'));
});

test('sharedFileNote: the first shared path, and how many more', () => {
  assert.equal(sharedFileNote({}), '');
  assert.equal(sharedFileNote({ sharedOutsideWrites: [] }), '');
  assert.equal(sharedFileNote({ sharedOutsideWrites: ['/tmp/x.txt'] }), ' · SHARED FILE with the other arm: /tmp/x.txt');
  assert.equal(sharedFileNote({ sharedOutsideWrites: ['/tmp/x.txt', '/tmp/y.txt', '/tmp/z.txt'] }), ' · SHARED FILE with the other arm: /tmp/x.txt (+2)');
});

// ---- the round, end to end with stubbed sessions ------------------------------------

test('runComparison: a round whose arms wrote the same file is recorded, printed once, excluded, and retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-shared-file-run-'));
  try {
    mkdirSync(join(root, 'scenarios', 's'), { recursive: true });
    writeFileSync(join(root, 'scenarios', 's', 'scenario.yaml'), 'repo: { git: none, ref: none }\nprompt: p\nmaxTurns: 5\n');
    const cfg = { root, pricing: { models: {} }, run: { model: 'm', gatewayUrl: null } };
    // Round 1: both arms tee to /tmp/go_test_output.txt and write /tmp/notes.md. Round 2: their own names.
    const writes = [
      ['/tmp/go_test_output.txt', '/tmp/a_only.log', '/tmp/notes.md'], ['/tmp/notes.md', '/tmp/go_test_output.txt'],
      ['/tmp/a_round2.log'], ['/tmp/b_round2.log'],
    ];
    let n = 0;
    const runAgent = async () => {
      const paths = writes[n++];
      return { requests: [], subagents: [], wallMs: 1, result: { costUsd: 1, numTurns: 3, text: 'done', modelUsage: {} }, outsideWrites: { count: paths.length, paths } };
    };
    const lines = [];
    const deps = { runAgent, prepareRepo: () => join(tmpdir(), 'bench-shared-file-none'), describeRepo: () => ({}), log: (m) => lines.push(m) };
    const { record } = await runComparison(parseArgs(['--scenario', 's', '--compare', 'control', '--rounds', '1', '--parallel', '1', '--retry-invalid', '1']), cfg, { deps });
    const [first, second] = record.rounds;
    assert.deepEqual(first.sharedOutsideWrites, ['/tmp/go_test_output.txt', '/tmp/notes.md']);
    assert.equal(second.round, 2);
    assert.equal('sharedOutsideWrites' in second, false);
    const out = lines.join('\n').split('\n');
    assert.deepEqual(out.filter((l) => l.includes('SHARED FILE')), ['  round 1 ratio B/A 1.000 · SHARED FILE with the other arm: /tmp/go_test_output.txt (+1)']);
    assert.ok(out.includes('  round 1 is not usable (shared file); running round 2 in its place (retry 1/1)'), out.join('\n'));
    assert.deepEqual(record.retries, [{ round: 1, reasons: ['shared file'], retriedAs: 2 }]);
    assert.equal(record.verdict.n, 1);
    assert.equal(record.verdict.excludedByReason['shared file'], 1);
    assert.match(formatVerdictBlock(record.verdict), /outside checkout 0, shared file 1, gateway restart 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

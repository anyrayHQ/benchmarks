// Doc files a session wrote to its checkout instead of its final answer: recorded per
// session (paths and counts, never contents), graded like the answer on citation-graded
// scenarios, and reported as "answered via file" without ever counting as solved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docBaseline, parsePorcelainZ, recordWrittenDocs, writtenDocs } from '../lib/agentRun.mjs';
import { benchVerdict, formatVerdictBlock } from '../lib/benchVerdict.mjs';
import { answeredViaFile, parseArgs, runComparison, solved, writtenDocsNote } from '../run_agent.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A committed checkout: a three-line Python file, three docs and a Go file. */
function checkout(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-written-docs-'));
  try {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'a.py'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'README.md'), '# readme\n');
    writeFileSync(join(dir, 'docs', 'old.md'), '# old\n');
    writeFileSync(join(dir, 'docs', 'gone.md'), '# gone\n');
    writeFileSync(join(dir, 'main.go'), 'package main\n');
    git(['init', '-q'], dir);
    git(['add', '-A'], dir);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one'], dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RULE = { min: 2, resolveRate: 0.9 };
const cites = (resolved, total) => ({ total, resolved, exact: resolved, bySuffix: 0, ambiguous: 0 });
const doc = (path, c, bytes = 100) => ({ path, status: 'untracked', bytes, ...(c ? { citations: c } : {}) });

// ---- git status parsing -----------------------------------------------------------

test('parsePorcelainZ: untracked, modified, renamed (new path, then the original) and spaces in paths', () => {
  const raw = '?? notes/my doc.md\0 M README.md\0R  docs/new name.md\0docs/old.md\0?? main2.go\0 D gone.md\0';
  assert.deepEqual(parsePorcelainZ(raw), [
    { status: '??', path: 'notes/my doc.md' },
    { status: ' M', path: 'README.md' },
    { status: 'R ', path: 'docs/new name.md', from: 'docs/old.md' },
    { status: '??', path: 'main2.go' },
    { status: ' D', path: 'gone.md' },
  ]);
  assert.deepEqual(parsePorcelainZ(''), []);
  assert.deepEqual(parsePorcelainZ(null), []);
});

// ---- writtenDocs on a real checkout -------------------------------------------------

test('writtenDocs: lists created, modified and renamed doc files with their git status; ignores non-doc and deleted files', () => checkout((dir) => {
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'my doc.md'), 'See pkg/a.py:2 and pkg/a.py:3.\n');
  writeFileSync(join(dir, 'README.md'), '# readme, edited\n');
  git(['mv', 'docs/old.md', 'docs/new.md'], dir);
  writeFileSync(join(dir, 'guide.rst'), 'guide\n');
  writeFileSync(join(dir, 'out.txt'), 'plain\n');
  writeFileSync(join(dir, 'main2.go'), 'package main\n'); // not a doc
  writeFileSync(join(dir, 'main.go'), 'package main // edited\n'); // not a doc
  writeFileSync(join(dir, 'NOTES.markdown'), 'n\n');
  rmSync(join(dir, 'docs', 'gone.md')); // deleted: nothing to list
  const { docs, omitted } = writtenDocs(dir);
  assert.equal(omitted, 0);
  assert.deepEqual(docs.map((d) => [d.path, d.status, d.from ?? null]), [
    ['NOTES.markdown', 'untracked', null],
    ['README.md', 'modified', null],
    ['docs/new.md', 'renamed', 'docs/old.md'],
    ['guide.rst', 'untracked', null],
    ['notes/my doc.md', 'untracked', null],
    ['out.txt', 'untracked', null],
  ]);
  assert.equal(docs.find((d) => d.path === 'notes/my doc.md').bytes, 'See pkg/a.py:2 and pkg/a.py:3.\n'.length);
  assert.ok(docs.every((d) => !('citations' in d)), 'no citation check unless asked');
}));

test('writtenDocs: grades each doc with the citation check the answer gets, and never records its text', () => checkout((dir) => {
  const text = 'Loader: pkg/a.py:2, a.py:3 (by suffix), pkg/a.py:99 (no such line), pkg/nope.py:1.\n';
  writeFileSync(join(dir, 'answer.md'), text);
  const { docs } = writtenDocs(dir, { citations: true });
  assert.deepEqual(docs, [{ path: 'answer.md', status: 'untracked', bytes: text.length, citations: { total: 4, resolved: 2, exact: 1, bySuffix: 1, ambiguous: 0 } }]);
  assert.ok(!JSON.stringify(docs).includes('Loader'), 'paths and counts only');
}));

test('writtenDocs: a doc already changed before the session (a patch, the warm-up) is left out until the session changes it', () => checkout((dir) => {
  writeFileSync(join(dir, 'README.md'), '# readme, patched by the scenario\n');
  const baseline = docBaseline(dir);
  assert.deepEqual([...baseline.keys()], ['README.md']);
  assert.deepEqual(writtenDocs(dir, { baseline }).docs, []);
  writeFileSync(join(dir, 'README.md'), '# readme, patched, then edited by the session\n');
  assert.deepEqual(writtenDocs(dir, { baseline }).docs.map((d) => d.path), ['README.md']);
}));

test('writtenDocs: caps the file count (the rest counted) and grades no file over the byte cap', () => checkout((dir) => {
  writeFileSync(join(dir, 'a.md'), 'pkg/a.py:1\n');
  writeFileSync(join(dir, 'b.md'), 'pkg/a.py:2 and a long tail of text\n');
  writeFileSync(join(dir, 'c.md'), 'pkg/a.py:3\n');
  const capped = writtenDocs(dir, { citations: true, maxFiles: 2, maxBytes: 20 });
  assert.equal(capped.omitted, 1);
  assert.deepEqual(capped.docs.map((d) => d.path), ['a.md', 'b.md']);
  assert.deepEqual(capped.docs[0].citations, { total: 1, resolved: 1, exact: 1, bySuffix: 0, ambiguous: 0 });
  assert.equal(capped.docs[1].citations, undefined);
  assert.equal(capped.docs[1].notGraded, 'over 20 bytes');
}));

test('recordWrittenDocs: any failure records null with a reason and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-written-docs-gone-'));
  try {
    const s = recordWrittenDocs({}, join(dir, 'missing'), { citations: true });
    assert.equal(s.writtenDocs, null);
    assert.equal(typeof s.writtenDocsError, 'string');
    assert.ok(s.writtenDocsError.length > 0 && s.writtenDocsError.length <= 200);
    assert.equal(docBaseline(join(dir, 'missing')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordWrittenDocs: an empty list when the session wrote no doc', () => checkout((dir) => {
  const s = recordWrittenDocs({}, dir, { citations: true });
  assert.deepEqual(s.writtenDocs, []);
  assert.equal(s.writtenDocsOmitted, undefined);
}));

// ---- answered via file ------------------------------------------------------------

test('answeredViaFile: set only on an unsolved citation-graded session whose written doc passes the rule', () => {
  const scenario = { citations: RULE };
  const unsolved = { citations: cites(0, 0), writtenDocs: [doc('notes.md', cites(1, 1)), doc('docs/guide.md', cites(5, 5)), doc('docs/draft.md', cites(3, 3))] };
  assert.deepEqual(answeredViaFile(scenario, unsolved), { path: 'docs/guide.md', resolved: 5, total: 5 });
  // The answer itself passed: solved, nothing to report.
  assert.equal(answeredViaFile(scenario, { ...unsolved, citations: cites(3, 3) }), null);
  // No written doc passes (too few, or too many unresolved).
  assert.equal(answeredViaFile(scenario, { citations: cites(0, 0), writtenDocs: [doc('a.md', cites(1, 1)), doc('b.md', cites(5, 10))] }), null);
  // Not graded (over the byte cap), none written, or the listing failed.
  assert.equal(answeredViaFile(scenario, { citations: cites(0, 0), writtenDocs: [{ path: 'big.md', status: 'untracked', bytes: 3e6, notGraded: 'over 2097152 bytes' }] }), null);
  assert.equal(answeredViaFile(scenario, { citations: cites(0, 0), writtenDocs: [] }), null);
  assert.equal(answeredViaFile(scenario, { citations: cites(0, 0), writtenDocs: null }), null);
  // Not citation-graded: a check or key facts decide, and a doc file is no answer to them.
  assert.equal(answeredViaFile({ check: 'true', citations: RULE }, { check: { passed: false }, ...unsolved }), null);
  assert.equal(answeredViaFile({ keyFacts: ['x'] }, { result: { text: '' }, writtenDocs: unsolved.writtenDocs }), null);
});

test('answeredViaFile never changes solved: the session stays unsolved', () => {
  const scenario = { citations: RULE };
  const session = { citations: cites(0, 0), writtenDocs: [doc('docs/guide.md', cites(5, 5))] };
  assert.equal(solved(scenario, session), false);
  session.answeredViaFile = answeredViaFile(scenario, session);
  assert.ok(session.answeredViaFile);
  assert.equal(solved(scenario, session), false);
});

// ---- printouts --------------------------------------------------------------------

test('writtenDocsNote: the round line fragments', () => {
  assert.equal(writtenDocsNote({}), '');
  assert.equal(writtenDocsNote({ writtenDocs: [] }), '');
  assert.equal(writtenDocsNote({ writtenDocs: null, writtenDocsError: 'git failed' }), ' · written docs n/a');
  assert.equal(writtenDocsNote({ writtenDocs: [doc('docs/guide.md', cites(1, 4))] }), ' · wrote docs/guide.md (1/4 citations)');
  // The doc with the most resolved citations is named; the others are counted, capped ones too.
  assert.equal(writtenDocsNote({ writtenDocs: [doc('a.md', cites(1, 1)), doc('b.md', cites(7, 9))], writtenDocsOmitted: 2 }), ' · wrote b.md (7/9 citations) +3 more');
  assert.equal(
    writtenDocsNote({ writtenDocs: [doc('a.md', cites(9, 9)), doc('docs/my guide.md', cites(5, 5))], answeredViaFile: { path: 'docs/my guide.md', resolved: 5, total: 5 } }),
    ' · wrote docs/my guide.md (5/5 citations) +1 more · answered via file (not solved)',
  );
  // Not citation-graded: size only; over the byte cap: not graded.
  assert.equal(writtenDocsNote({ writtenDocs: [doc('NOTES.md', null, 120)] }), ' · wrote NOTES.md (120 bytes)');
  assert.equal(writtenDocsNote({ writtenDocs: [{ path: 'big.md', status: 'untracked', bytes: 3000000, notGraded: 'over 2097152 bytes' }] }), ' · wrote big.md (3000000 bytes, not graded)');
});

/** Rounds for benchVerdict: B unsolved in round 2, answering via a file or not. */
const rounds = (viaFile) => [1, 2, 3].map((n) => ({
  round: n, ratio: 0.8, quality: { a: true, b: n !== 2 },
  sessions: { a: { totals: { costUsd: 2, outsideCheckout: 0 } }, b: { totals: { costUsd: 1.6, outsideCheckout: 0 }, ...(n === 2 && viaFile ? { answeredViaFile: { path: 'docs/guide.md', resolved: 5, total: 5 } } : {}) } },
}));

test('benchVerdict: answered via file is counted among the not-solved exclusions, and changes nothing else', () => {
  const v = benchVerdict(rounds(true), { minRounds: 2 });
  const plain = benchVerdict(rounds(false), { minRounds: 2 });
  assert.equal(v.notSolvedAnsweredViaFile, 1);
  assert.equal(plain.notSolvedAnsweredViaFile, 0);
  for (const k of ['verdict', 'n', 'excludedCount', 'excludedByReason', 'geometricMeanRatio', 'confidenceInterval95']) assert.deepEqual(v[k], plain[k], k);
  const block = formatVerdictBlock(v).split('\n');
  assert.ok(block.includes('Excluded: 1  (not solved 1 (answered via file 1), failed round 0, outside checkout 0, gateway restart 0; reasons may overlap)'), block.join('\n'));
  assert.ok(block.includes('Excluded rounds: 2 (not solved: B answered via file)'), block.join('\n'));
  const before = formatVerdictBlock(plain).split('\n');
  assert.ok(before.includes('Excluded: 1  (not solved 1, failed round 0, outside checkout 0, gateway restart 0; reasons may overlap)'));
  assert.ok(before.includes('Excluded rounds: 2 (not solved)'));
});

// ---- the round line, end to end with a stubbed session ------------------------------

test('runComparison: a session that answered via a file prints it, stays NOT solved, and the verdict counts it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-written-docs-run-'));
  try {
    mkdirSync(join(root, 'scenarios', 's'), { recursive: true });
    writeFileSync(join(root, 'scenarios', 's', 'scenario.yaml'), 'repo: { git: none, ref: none }\nprompt: p\nmaxTurns: 5\ncitations: { min: 2, resolveRate: 0.9 }\n');
    const cfg = { root, pricing: { models: {} }, run: { model: 'm', gatewayUrl: null } };
    let n = 0;
    const runAgent = async () => {
      const b = n++ % 2 === 1; // the second session of the pair writes its doc to a file
      return {
        requests: [], subagents: [], wallMs: 1, result: { costUsd: 1, numTurns: 3, text: 'see the file', modelUsage: {} },
        citations: b ? cites(0, 0) : cites(3, 3),
        writtenDocs: b ? [doc('docs/guide.md', cites(53, 55))] : [],
      };
    };
    const lines = [];
    const deps = { runAgent, prepareRepo: () => join(tmpdir(), 'bench-written-docs-none'), describeRepo: () => ({}), log: (m) => lines.push(m) };
    const { record } = await runComparison(parseArgs(['--scenario', 's', '--compare', 'control', '--rounds', '1', '--parallel', '1']), cfg, { deps });
    const r = record.rounds[0];
    const [slot] = ['a', 'b'].filter((x) => r.sessions[x].answeredViaFile);
    assert.ok(slot, 'one session answered via a file');
    assert.equal(r.quality[slot], false);
    assert.deepEqual(r.sessions[slot].answeredViaFile, { path: 'docs/guide.md', resolved: 53, total: 55 });
    const line = lines.join('\n').split('\n').find((l) => l.includes(`round 1 ${slot.toUpperCase()} `) && l.includes('wrote'));
    assert.ok(line?.endsWith(' · wrote docs/guide.md (53/55 citations) · answered via file (not solved) · NOT solved'), line);
    assert.equal(record.verdict.notSolvedAnsweredViaFile, 1);
    assert.equal(record.verdict.n, 0);
    assert.match(formatVerdictBlock(record.verdict), /not solved 1 \(answered via file 1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

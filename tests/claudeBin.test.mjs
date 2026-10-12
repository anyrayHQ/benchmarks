// --claude-bin / ANYRAY_CLAUDE_BIN: which Claude Code binary both arms spawn, and the
// subagent load each session's totals carry. Pure: nothing here spawns `claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLAUDE_BIN_ENV, PATH_CLAUDE, claudeBinRequest, claudeVersion, describeClaudeBin, parseVersionOutput, resolveClaudeBin } from '../lib/claudeBin.mjs';
import { claudeClientRecord, describeSetup } from '../lib/agentRun.mjs';
import { armSetups, armsFor, claudeVersions, controlArgs, formatVerdict, parseArgs, requestRecord, slotOptions, subagentLoad, subagentLoadSummary, subagentNote, withSessionSetups } from '../run_agent.mjs';

const NO_ENV = {}; // parseArgs reads ANYRAY_CLAUDE_BIN from the env it is given, never the test runner's
const base = ['--scenario', 's', '--kinds', 'observation_mask'];

/** A temp dir with an executable `claude`, a non-executable file, and an empty directory. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-bin-'));
  const exe = join(dir, 'claude');
  writeFileSync(exe, '#!/bin/sh\necho "2.1.286 (Claude Code)"\n');
  chmodSync(exe, 0o755);
  const plain = join(dir, 'notes.txt');
  writeFileSync(plain, 'x');
  chmodSync(plain, 0o644);
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(dir, 'nested', 'claude'), { recursive: true }); // a directory named claude is not an executable
  return { dir, exe, plain, empty: join(dir, 'empty'), nested: join(dir, 'nested') };
}

// ---- which binary was asked for ------------------------------------------------------

test('claudeBinRequest: the flag wins over the env, the env over PATH, and an empty value is none', () => {
  assert.deepEqual(claudeBinRequest({ flag: '/a/claude', env: { [CLAUDE_BIN_ENV]: '/b/claude' } }), { path: '/a/claude', source: '--claude-bin' });
  assert.deepEqual(claudeBinRequest({ env: { [CLAUDE_BIN_ENV]: '/b/claude' } }), { path: '/b/claude', source: 'ANYRAY_CLAUDE_BIN' });
  assert.deepEqual(claudeBinRequest({ env: { [CLAUDE_BIN_ENV]: '' } }), { path: null, source: 'PATH' });
  assert.deepEqual(claudeBinRequest({}), { path: null, source: 'PATH' });
  assert.deepEqual(claudeBinRequest(), { path: null, source: 'PATH' });
});

test('resolveClaudeBin: PATH needs no check; a pinned path must be absolute, exist and be executable', () => {
  const f = fixture();
  try {
    assert.equal(resolveClaudeBin({ path: null, source: 'PATH' }), PATH_CLAUDE);
    assert.deepEqual(resolveClaudeBin({ path: f.exe, source: '--claude-bin' }), { bin: f.exe, source: '--claude-bin', pinned: true });
    assert.throws(() => resolveClaudeBin({ path: 'versions/2.1.286', source: '--claude-bin' }), /--claude-bin: takes an absolute path/);
    assert.throws(() => resolveClaudeBin({ path: join(f.dir, 'missing'), source: 'ANYRAY_CLAUDE_BIN' }), /ANYRAY_CLAUDE_BIN: no such file or directory/);
    assert.throws(() => resolveClaudeBin({ path: f.plain, source: '--claude-bin' }), /is not executable/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('resolveClaudeBin: a directory is accepted when it holds a claude executable', () => {
  const f = fixture();
  try {
    assert.deepEqual(resolveClaudeBin({ path: f.dir, source: '--claude-bin' }), { bin: f.exe, source: '--claude-bin', pinned: true });
    assert.throws(() => resolveClaudeBin({ path: f.empty, source: '--claude-bin' }), /is a directory with no claude executable in it/);
    assert.throws(() => resolveClaudeBin({ path: f.nested, source: '--claude-bin' }), /is a directory, not an executable/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('claudeVersion: the version number out of `claude --version`, null when it cannot run', () => {
  assert.equal(parseVersionOutput('2.1.286 (Claude Code)\n'), '2.1.286');
  assert.equal(parseVersionOutput('2.1.300-beta.1 (Claude Code)'), '2.1.300-beta.1');
  assert.equal(parseVersionOutput('Claude Code'), null);
  assert.equal(parseVersionOutput(''), null);
  const calls = [];
  const exec = (bin, args) => { calls.push([bin, args]); return '2.1.292 (Claude Code)'; };
  assert.equal(claudeVersion('/pinned/claude', { exec }), '2.1.292');
  assert.deepEqual(calls, [['/pinned/claude', ['--version']]]);
  assert.equal(claudeVersion('/pinned/claude', { exec: () => { throw new Error('ENOENT'); } }), null);
});

test('describeClaudeBin: the run header says the version and whether it is pinned', () => {
  assert.equal(describeClaudeBin({ bin: '/v/2.1.286/claude', source: '--claude-bin', pinned: true, version: '2.1.286' }), 'Claude Code 2.1.286 pinned by --claude-bin: /v/2.1.286/claude');
  assert.match(describeClaudeBin({ ...PATH_CLAUDE, version: '2.1.292' }), /^Claude Code 2\.1\.292 from PATH \(unpinned/);
  assert.match(describeClaudeBin({ ...PATH_CLAUDE, version: null }), /version unknown/);
});

// ---- the flag through parseArgs and into each arm --------------------------------------

test('parseArgs: --claude-bin is recorded as the request, wins over ANYRAY_CLAUDE_BIN, and must be absolute', () => {
  assert.deepEqual(parseArgs([...base, '--claude-bin', '/v/claude'], { [CLAUDE_BIN_ENV]: '/env/claude' }).claudeBin, { path: '/v/claude', source: '--claude-bin' });
  assert.deepEqual(parseArgs(base, { [CLAUDE_BIN_ENV]: '/env/claude' }).claudeBin, { path: '/env/claude', source: 'ANYRAY_CLAUDE_BIN' });
  assert.deepEqual(parseArgs(base, NO_ENV).claudeBin, { path: null, source: 'PATH' });
  assert.throws(() => parseArgs([...base, '--claude-bin', 'versions/2.1.286'], NO_ENV), /--claude-bin takes an absolute path/);
  assert.throws(() => parseArgs([...base, '--claude-bin'], NO_ENV), /--claude-bin takes an absolute path/);
  assert.throws(() => parseArgs(base, { [CLAUDE_BIN_ENV]: 'claude' }), /ANYRAY_CLAUDE_BIN takes an absolute path/);
  assert.throws(() => parseArgs(['--scenario', 'sdk-docs', '--provider', 'bedrock', '--claude-bin', '/v/claude'], NO_ENV), /supports the paired SDK comparison/);
});

test('parseArgs: --compare control takes --claude-bin too, and the control of --with-control keeps it', () => {
  const args = parseArgs(['--scenario', 's', '--compare', 'control', '--claude-bin', '/v/claude'], NO_ENV);
  assert.equal(args.claudeBin.source, '--claude-bin');
  const resolved = { ...args, claude: { bin: '/v/claude', source: '--claude-bin', pinned: true, version: '2.1.286' } };
  assert.deepEqual(controlArgs({ ...parseArgs([...base, '--with-control', '--claude-bin', '/v/claude'], NO_ENV), claude: resolved.claude }).claude, resolved.claude);
});

test('slotOptions / requestRecord: the resolved binary reaches both slots; the record keeps source and version, never the path', () => {
  const claude = { bin: '/v/2.1.286/claude', source: '--claude-bin', pinned: true, version: '2.1.286' };
  const args = { ...parseArgs([...base, '--claude-bin', claude.bin], NO_ENV), claude, extraHeaders: [] };
  const arms = armsFor('anyray');
  assert.deepEqual(slotOptions(args, arms, 'a').claude, claude);
  assert.deepEqual(slotOptions(args, arms, 'b').claude, claude);
  assert.equal('claude' in slotOptions({ ...parseArgs(base, NO_ENV), extraHeaders: [] }, arms, 'a'), false); // unresolved: nothing passed, runAgent uses PATH
  assert.deepEqual(requestRecord(args).claudeBin, { source: '--claude-bin', version: '2.1.286' });
  assert.equal(JSON.stringify(requestRecord(args)).includes('/v/2.1.286'), false);
  assert.equal('claudeBin' in requestRecord({ ...args, claude: { ...PATH_CLAUDE, version: '2.1.292' } }), false); // PATH is not a pin
});

test('claudeClientRecord / describeSetup: client, claudeVersion and claudeBinSource from the resolved binary, no exec when the version is known', () => {
  const claude = { bin: '/v/2.1.286/claude', source: 'ANYRAY_CLAUDE_BIN', pinned: true, version: '2.1.286' };
  assert.deepEqual(claudeClientRecord(claude), { client: 'Claude Code 2.1.286 (headless, claude -p)', claudeVersion: '2.1.286', claudeBinSource: 'ANYRAY_CLAUDE_BIN' });
  assert.deepEqual(claudeClientRecord({ ...PATH_CLAUDE, version: null }), { client: 'Claude Code (headless, claude -p)', claudeVersion: null, claudeBinSource: 'PATH' });
  const s = describeSetup({ arm: 'direct', model: 'm', gatewayUrl: 'https://gateway.test.invalid', runTag: {}, maxTurns: 3, claude });
  assert.equal(s.client, 'Claude Code 2.1.286 (headless, claude -p)');
  assert.equal(s.claudeVersion, '2.1.286');
  assert.equal(s.claudeBinSource, 'ANYRAY_CLAUDE_BIN');
  assert.equal(JSON.stringify(s).includes('/v/2.1.286'), false);
  const bare = describeSetup({ arm: 'anyray', bare: true, model: 'm', gatewayUrl: 'https://gateway.test.invalid', runTag: {}, maxTurns: 3, claude });
  assert.equal(bare.claudeVersion, '2.1.286');
});

test('armSetups records the pinned version on both arms; a session that ran another build overrides it per round', () => {
  const claude = { bin: '/v/claude', source: '--claude-bin', pinned: true, version: '2.1.286' };
  const args = { ...parseArgs([...base, '--claude-bin', claude.bin], NO_ENV), claude, extraHeaders: [] };
  const setup = armSetups(args, armsFor('anyray'), { model: 'm', gatewayUrl: 'https://gateway.test.invalid' }, { maxTurns: 3 }, { enrolled: true });
  assert.equal(setup.a.claudeVersion, '2.1.286');
  assert.equal(setup.b.claudeVersion, '2.1.286');
  const merged = withSessionSetups(setup, { a: { setup: { claudeVersion: '2.1.292', claudeBinSource: 'PATH', client: 'Claude Code 2.1.292 (headless, claude -p)' } }, b: {} });
  assert.equal(merged.a.claudeVersion, '2.1.292');
  assert.equal(merged.b.claudeVersion, '2.1.286');
});

// ---- subagent load -------------------------------------------------------------------------

const rq = (agent) => ({ agent, blocks: [] });

test('subagentLoad: main vs subagent requests, and requests per subagent over the Task calls', () => {
  const requests = [rq('main'), rq('t1'), rq('t1'), rq('main'), rq('t2'), rq('t1'), rq('main')];
  assert.deepEqual(subagentLoad(requests, [{ id: 't1' }, { id: 't2' }]), { mainRequests: 3, subagentRequests: 4, requestsPerSubagent: 2 });
  assert.deepEqual(subagentLoad([rq('main'), rq('main')], []), { mainRequests: 2, subagentRequests: 0, requestsPerSubagent: null });
  assert.deepEqual(subagentLoad([], []), { mainRequests: 0, subagentRequests: 0, requestsPerSubagent: null });
  // A subagent that was spawned but never answered still counts in the denominator.
  assert.equal(subagentLoad([rq('main'), rq('t1')], [{ id: 't1' }, { id: 't2' }]).requestsPerSubagent, 0.5);
});

test('subagentNote: the round line part, per-agent figure only when there were subagents', () => {
  assert.equal(subagentNote({ subagents: 4, subagentRequests: 68, requestsPerSubagent: 17, mainRequests: 20 }), ' · 4 subagents · 68 sub-req (17.0/agent) · 20 main-req');
  assert.equal(subagentNote({ subagents: 3, subagentRequests: 50, requestsPerSubagent: 50 / 3, mainRequests: 9 }), ' · 3 subagents · 50 sub-req (16.7/agent) · 9 main-req');
  assert.equal(subagentNote({ subagents: 0, subagentRequests: 0, requestsPerSubagent: null, mainRequests: 12 }), ' · 0 subagents · 0 sub-req · 12 main-req');
  assert.equal(subagentNote({ subagents: 0 }), ' · 0 subagents · 0 sub-req · 0 main-req'); // an older session without the fields
});

const round = (n, a, b, versions = {}) => ({
  round: n,
  ratio: 1,
  sessions: {
    a: { totals: { costUsd: 1, subagents: a[0], subagentRequests: a[1], mainRequests: a[2], requestsPerSubagent: a[0] ? a[1] / a[0] : null }, setup: versions.a ? { claudeVersion: versions.a } : {} },
    b: { totals: { costUsd: 1, subagents: b[0], subagentRequests: b[1], mainRequests: b[2], requestsPerSubagent: b[0] ? b[1] / b[0] : null }, setup: versions.b ? { claudeVersion: versions.b } : {} },
  },
  quality: { a: true, b: true },
});

test('subagentLoadSummary: pooled per arm over the rounds with a session, with the per-round ratios', () => {
  const rounds = [round(1, [4, 68, 20], [2, 20, 30]), { round: 2, error: 'timed out' }, round(3, [2, 32, 10], [0, 0, 25])];
  const s = subagentLoadSummary(rounds);
  assert.deepEqual(s.a, { rounds: 2, subagents: 6, subagentRequests: 100, mainRequests: 30, requestsPerSubagent: 100 / 6 });
  assert.deepEqual(s.b, { rounds: 2, subagents: 2, subagentRequests: 20, mainRequests: 55, requestsPerSubagent: 10 });
  assert.deepEqual(s.perRound, [{ round: 1, a: 17, b: 10 }, { round: 3, a: 16, b: null }]);
  assert.deepEqual(subagentLoadSummary([]), { a: { rounds: 0, subagents: 0, subagentRequests: 0, mainRequests: 0, requestsPerSubagent: null }, b: { rounds: 0, subagents: 0, subagentRequests: 0, mainRequests: 0, requestsPerSubagent: null }, perRound: [] });
  // Rounds from before these fields existed are left out of the pool, not counted as zero.
  assert.equal(subagentLoadSummary([{ round: 1, sessions: { a: { totals: { subagents: 3 } }, b: { totals: { subagents: 1 } } } }]).a.rounds, 0);
});

test('claudeVersions: counts each arm\'s versions over the rounds and flags a mixed block', () => {
  const same = [round(1, [1, 1, 1], [1, 1, 1], { a: '2.1.286', b: '2.1.286' }), round(2, [1, 1, 1], [1, 1, 1], { a: '2.1.286', b: '2.1.286' })];
  assert.deepEqual(claudeVersions(same), { a: { '2.1.286': 2 }, b: { '2.1.286': 2 }, mixed: false });
  const drifted = [...same, round(3, [1, 1, 1], [1, 1, 1], { a: '2.1.292', b: '2.1.292' })];
  assert.deepEqual(claudeVersions(drifted), { a: { '2.1.286': 2, '2.1.292': 1 }, b: { '2.1.286': 2, '2.1.292': 1 }, mixed: true });
  const armsDiffer = [round(1, [1, 1, 1], [1, 1, 1], { a: '2.1.286', b: '2.1.292' })];
  assert.equal(claudeVersions(armsDiffer).mixed, true);
  assert.deepEqual(claudeVersions([round(1, [1, 1, 1], [1, 1, 1]), { round: 2, error: 'x' }]), { a: { unknown: 1 }, b: { unknown: 1 }, mixed: false });
  assert.deepEqual(claudeVersions([]), { a: {}, b: {}, mixed: false });
});

test('formatVerdict prints the subagent load per arm and warns when the block mixed Claude Code versions', () => {
  const rounds = [round(1, [4, 68, 20], [2, 20, 30], { a: '2.1.286', b: '2.1.286' }), round(2, [2, 32, 10], [0, 0, 25], { a: '2.1.292', b: '2.1.292' })];
  const out = formatVerdict({ scenario: 's', compare: 'anyray', rounds });
  assert.match(out, /subagent load: A 16\.7\/agent \(100 sub-req over 6 subagents, 30 main-req, 2 rounds\) · B 10\.0\/agent \(20 sub-req over 2 subagents, 55 main-req, 2 rounds\)/);
  assert.match(out, /per round \(A \/ B per agent\): r1 17\.00\/10\.00, r2 16\.00\/n\/a/);
  assert.match(out, /Claude Code: A 2\.1\.286 ×1, 2\.1\.292 ×1 · B 2\.1\.286 ×1, 2\.1\.292 ×1 → WARNING: this block mixed Claude Code versions; pin one with --claude-bin/);
  const steady = formatVerdict({ scenario: 's', compare: 'anyray', rounds: [rounds[0]] });
  assert.match(steady, /Claude Code: A 2\.1\.286 ×1 · B 2\.1\.286 ×1$/m);
  assert.doesNotMatch(steady, /WARNING: this block mixed/);
  // Rounds without sessions (all failed) print neither line.
  assert.doesNotMatch(formatVerdict({ scenario: 's', compare: 'anyray', rounds: [{ round: 1, error: 'x' }] }), /subagent load|Claude Code:/);
});

// --parallel N: up to N rounds at once (each still A ‖ B), shared with --with-control's
// control. Offline: runAgent, the repo checkout and the file write are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PARALLEL, armSetups, armsFor, createPool, insertRound, parseArgs, runAll, runComparison } from '../run_agent.mjs';

const base = ['--scenario', 's', '--compare', 'control'];
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/** A scenario root in a temp dir: scenarios/s/scenario.yaml, graded by one key fact. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bench-parallel-'));
  mkdirSync(join(root, 'scenarios', 's'), { recursive: true });
  writeFileSync(join(root, 'scenarios', 's', 'scenario.yaml'), 'repo: { git: none, ref: none }\nprompt: p\nmaxTurns: 5\nkeyFacts: [fact]\n');
  return { root, cfg: { root, pricing: { models: {} }, run: { model: 'm', gatewayUrl: null } }, file: join(root, 'results', 'agent', 's--control.json') };
}

/**
 * A stubbed runAgent that counts sessions in flight and finishes rounds out of order
 * (later rounds sooner), so ordering and write safety are actually exercised.
 */
function stubAgent() {
  const s = { inFlight: 0, maxInFlight: 0, events: [], tags: [] };
  s.runAgent = async ({ runTag }) => {
    const round = Number(/-r(\d+)-/.exec(runTag.sessionId)[1]);
    s.tags.push(runTag.sessionId);
    s.inFlight++;
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    s.events.push(`start ${round}`);
    await delay(2 + ((7 - round) % 5) * 4);
    s.inFlight--;
    s.events.push(`end ${round}`);
    return { requests: [], subagents: [], wallMs: 1, result: { costUsd: 1 + round / 100, numTurns: 3, text: 'fact', modelUsage: {} } };
  };
  return s;
}

const deps = (s, extra = {}) => ({ runAgent: s.runAgent, prepareRepo: () => join(tmpdir(), 'bench-parallel-none'), describeRepo: () => ({}), log: () => {}, ...extra });

// parseArgs

test('parseArgs: --parallel defaults to 2', () => {
  assert.equal(parseArgs(base).parallel, 2);
  assert.equal(parseArgs([...base, '--parallel', '1']).parallel, 1);
  assert.equal(parseArgs([...base, '--parallel', '4']).parallel, 4);
});

test('parseArgs: --parallel needs a positive integer and is capped at 4', () => {
  assert.equal(MAX_PARALLEL, 4);
  for (const bad of ['0', '-1', '1.5', 'two', '']) {
    assert.throws(() => parseArgs([...base, '--parallel', bad]), /--parallel needs a positive integer/);
  }
  assert.throws(() => parseArgs([...base, '--parallel']), /--parallel needs a positive integer/);
  assert.throws(() => parseArgs([...base, '--parallel', '5']), /--parallel 5 is above the cap of 4: every session shares one Claude subscription/);
});

test('armSetups: both arms record parallel', () => {
  const args = parseArgs([...base, '--parallel', '3']);
  const s = armSetups(args, armsFor('control'), { model: 'm' }, { maxTurns: 5 }, {});
  assert.equal(s.a.parallel, 3);
  assert.equal(s.b.parallel, 3);
});

// the pool

test('createPool: never more than N tasks at once, and every task runs', async () => {
  const pool = createPool(3);
  const run = pool.lane();
  let inFlight = 0;
  let max = 0;
  const done = await Promise.all(Array.from({ length: 10 }, (_, i) => run(async () => {
    max = Math.max(max, ++inFlight);
    await delay((i * 3) % 7);
    inFlight--;
    return i;
  })));
  assert.deepEqual(done, [...Array(10).keys()]);
  assert.equal(max, 3);
});

test('createPool: a failing task frees its slot and rejects only its own promise', async () => {
  const run = createPool(1).lane();
  const results = await Promise.allSettled([run(async () => { throw new Error('boom'); }), run(async () => 'ok')]);
  assert.equal(results[0].status, 'rejected');
  assert.deepEqual(results[1], { status: 'fulfilled', value: 'ok' });
});

test('createPool: lanes share the budget and take turns', async () => {
  const pool = createPool(2);
  const main = pool.lane();
  const control = pool.lane();
  const started = [];
  let inFlight = 0;
  let max = 0;
  const task = (name) => async () => {
    started.push(name);
    max = Math.max(max, ++inFlight);
    await delay(3);
    inFlight--;
  };
  await Promise.all([...Array.from({ length: 4 }, () => main(task('main'))), ...Array.from({ length: 4 }, () => control(task('control')))]);
  assert.equal(max, 2);
  assert.deepEqual(started.slice(0, 2).sort(), ['control', 'main']); // not all of main first
  assert.deepEqual(started.slice(0, 4).filter((x) => x === 'main').length, 2);
});

test('createPool: a closed lane hands its share to the lanes still open', async () => {
  const pool = createPool(4);
  const main = pool.lane();
  const control = pool.lane(); // e.g. a control whose setup failed: it never queues a round
  let inFlight = 0;
  let max = 0;
  const work = Array.from({ length: 8 }, () => main(async () => {
    max = Math.max(max, ++inFlight);
    await delay(3);
    inFlight--;
  }));
  await delay(1);
  assert.equal(inFlight, 2); // half of 4 while the control is open
  control.close();
  await Promise.all(work);
  assert.equal(max, 4);
});

test('insertRound: keeps rounds in index order whatever finishes first', () => {
  const rounds = [{ round: 1 }, { round: 2 }];
  for (const n of [5, 3, 4]) insertRound(rounds, { round: n });
  assert.deepEqual(rounds.map((x) => x.round), [1, 2, 3, 4, 5]);
});

// runComparison with a stubbed runAgent

test('runComparison: --parallel 1 runs rounds one after another, exactly as before', async () => {
  const { root, cfg, file } = fixture();
  const s = stubAgent();
  const lines = [];
  const { record } = await runComparison(parseArgs([...base, '--rounds', '3', '--parallel', '1']), cfg, { deps: deps(s, { log: (m) => lines.push(m) }) });
  assert.deepEqual(s.events, ['start 1', 'start 1', 'end 1', 'end 1', 'start 2', 'start 2', 'end 2', 'end 2', 'start 3', 'start 3', 'end 3', 'end 3']);
  assert.equal(s.maxInFlight, 2); // A ‖ B only
  assert.deepEqual(record.rounds.map((x) => x.round), [1, 2, 3]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).rounds.map((x) => x.round), [1, 2, 3]);
  assert.match(lines[0], /parallel 1/);
  rmSync(root, { recursive: true, force: true });
});

test('runComparison: concurrency never exceeds N rounds (2N sessions), and reaches it', async () => {
  for (const n of [2, 3, 4]) {
    const { root, cfg } = fixture();
    const s = stubAgent();
    const { record } = await runComparison(parseArgs([...base, '--rounds', '7', '--parallel', String(n)]), cfg, { deps: deps(s) });
    assert.equal(s.maxInFlight, 2 * n, `--parallel ${n}`);
    assert.equal(record.rounds.length, 7);
    assert.equal(record.setup.a.parallel, n);
    rmSync(root, { recursive: true, force: true });
  }
});

test('runComparison: rounds finish out of order but are saved in index order, none lost', async () => {
  const { root, cfg, file } = fixture();
  const s = stubAgent();
  const writes = [];
  let writing = 0;
  let overlapped = false;
  // An async, slow write: if saves weren't serialised, a stale snapshot could land last.
  const write = async (path, text) => {
    if (writing++) overlapped = true;
    await delay(Math.random() * 5);
    writeFileSync(path, text);
    writes.push(JSON.parse(text).rounds.map((x) => x.round));
    writing--;
  };
  await runComparison(parseArgs([...base, '--rounds', '8', '--parallel', '4']), cfg, { deps: deps(s, { write }) });
  assert.equal(overlapped, false);
  const ends = s.events.filter((e) => e.startsWith('end')).map((e) => Number(e.split(' ')[1]));
  assert.notDeepEqual([...new Set(ends)], [1, 2, 3, 4, 5, 6, 7, 8]); // they did finish out of order
  for (const w of writes) assert.deepEqual(w, [...w].sort((x, y) => x - y)); // every save is in index order
  assert.ok(writes.some((w) => w.length === 1)); // saved as each round finished, not only at the end
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).rounds.map((x) => x.round), [1, 2, 3, 4, 5, 6, 7, 8]);
  rmSync(root, { recursive: true, force: true });
});

test('runComparison: round numbers and session ids are unique per round', async () => {
  const { root, cfg } = fixture();
  const s = stubAgent();
  const { record } = await runComparison(parseArgs([...base, '--rounds', '6', '--parallel', '4']), cfg, { deps: deps(s) });
  assert.equal(new Set(record.rounds.map((x) => x.runTag.sessionId)).size, 6);
  assert.equal(new Set(s.tags).size, 6); // A and B of a control round share one tag, rounds never do
  rmSync(root, { recursive: true, force: true });
});

test('runComparison: each finished round prints lines prefixed with its round number', async () => {
  const { root, cfg } = fixture();
  const s = stubAgent();
  const lines = [];
  await runComparison(parseArgs([...base, '--rounds', '4', '--parallel', '4']), cfg, { deps: deps(s, { log: (m) => lines.push(...m.split('\n')) }) });
  for (const n of [1, 2, 3, 4]) {
    assert.ok(lines.some((l) => l.startsWith(`  round ${n} A direct: $`)), `round ${n} A`);
    assert.ok(lines.some((l) => l.startsWith(`  round ${n} B direct: $`)), `round ${n} B`);
    assert.ok(lines.some((l) => l.startsWith(`  round ${n} ratio B/A `)), `round ${n} ratio`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('runComparison: resumes an existing result file, appending after its rounds', async () => {
  const { root, cfg, file } = fixture();
  mkdirSync(join(root, 'results', 'agent'), { recursive: true });
  const old = [{ round: 1, ratio: 0.9, kept: 'r1' }, { round: 2, error: 'boom' }];
  writeFileSync(file, JSON.stringify({ rounds: old }));
  const s = stubAgent();
  const { record } = await runComparison(parseArgs([...base, '--rounds', '3', '--parallel', '3']), cfg, { deps: deps(s) });
  const saved = JSON.parse(readFileSync(file, 'utf8')).rounds;
  assert.deepEqual(saved.map((x) => x.round), [1, 2, 3, 4, 5]);
  assert.deepEqual(saved.slice(0, 2), old);
  assert.deepEqual(record.rounds.map((x) => x.round), [1, 2, 3, 4, 5]);
  assert.ok(s.tags.every((t) => /-r[345]-/.test(t)));
  rmSync(root, { recursive: true, force: true });
});

test('runComparison: a failed round is recorded in its place and the others still run', async () => {
  const { root, cfg, file } = fixture();
  const s = stubAgent();
  const inner = s.runAgent;
  s.runAgent = async (o) => {
    if (/-r2-/.test(o.runTag.sessionId)) throw new Error('arm crashed');
    return inner(o);
  };
  await runComparison(parseArgs([...base, '--rounds', '3', '--parallel', '2']), cfg, { deps: deps(s) });
  const saved = JSON.parse(readFileSync(file, 'utf8')).rounds;
  assert.deepEqual(saved.map((x) => [x.round, x.error ?? null]), [[1, null], [2, 'arm crashed'], [3, null]]);
  rmSync(root, { recursive: true, force: true });
});

// --with-control shares the budget

test('runAll: main and control share one --parallel budget (≤ N rounds in flight in total)', async () => {
  for (const n of [1, 2, 3]) {
    let inFlight = 0;
    let max = 0;
    const started = [];
    const fake = async (args, cfg, { schedule }) => {
      const name = args.compare;
      await Promise.all(Array.from({ length: args.rounds }, () => schedule(async () => {
        started.push(name);
        max = Math.max(max, ++inFlight);
        await delay(3);
        inFlight--;
      })));
      return { record: { rounds: [] }, file: null, viaGateway: [] };
    };
    const args = parseArgs(['--scenario', 's', '--kinds', 'observation_mask', '--with-control', '--rounds', '3', '--parallel', String(n)]);
    const { main, control } = await runAll(args, {}, { runComparison: fake, log: () => {} });
    assert.equal(main.status, 'fulfilled');
    assert.equal(control.status, 'fulfilled');
    assert.equal(max, n, `--parallel ${n}`);
    assert.equal(started.length, 6);
    // Side by side, as before: the control starts in the first wave, not behind all of main.
    if (n >= 2) assert.deepEqual([...new Set(started.slice(0, n))].sort(), ['anyray', 'control']);
  }
});

test('runAll: without --with-control the main comparison gets the whole budget', async () => {
  let max = 0;
  let inFlight = 0;
  const fake = async (args, cfg, { schedule }) => {
    await Promise.all(Array.from({ length: 6 }, () => schedule(async () => {
      max = Math.max(max, ++inFlight);
      await delay(3);
      inFlight--;
    })));
    return { record: { rounds: [] } };
  };
  const { control } = await runAll(parseArgs([...base, '--parallel', '3']), {}, { runComparison: fake, log: () => {} });
  assert.equal(control, undefined);
  assert.equal(max, 3);
});

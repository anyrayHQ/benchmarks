// ANY-733: --max-turns, --with-control (a direct-vs-direct noise band in the same
// invocation), and a Rule 0 verdict over solved pairs only. Offline: stubbed rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armSetups, armsFor, controlArgs, effectiveScenario, formatVerdict, parseArgs, resultFileName } from '../run_agent.mjs';
import { bandPosition, noiseBand, solvedPairVerdict } from '../lib/stats.mjs';

const base = ['--scenario', 's', '--kinds', 'observation_mask'];
const RUN = { model: 'm', gatewayUrl: 'https://gateway.test.invalid' };

/** A stubbed round: B ÷ A ratio, who solved, and each arm's cost (null = no result). */
const rnd = (round, ratio, a = true, b = true, cost = { a: 1, b: ratio }) => ({
  round,
  ratio,
  quality: { a, b },
  sessions: { a: { totals: { costUsd: cost.a } }, b: { totals: { costUsd: cost.b } } },
});
const timeout = (round, slot = 'b') => ({
  round,
  ratio: null,
  error: `${slot.toUpperCase()} ended without a result (no cost)`,
  quality: { a: true, b: false },
  sessions: { a: { totals: { costUsd: slot === 'a' ? null : 1 } }, b: { totals: { costUsd: slot === 'b' ? null : 1 } } },
});

// --max-turns

test('parseArgs: --max-turns N is a positive integer, default unset', () => {
  assert.equal(parseArgs(base).maxTurns, null);
  assert.equal(parseArgs([...base, '--max-turns', '80']).maxTurns, 80);
  for (const bad of ['0', '-3', '2.5', 'abc', '']) {
    assert.throws(() => parseArgs([...base, '--max-turns', bad]), /--max-turns needs a positive integer/);
  }
  assert.throws(() => parseArgs([...base, '--max-turns']), /--max-turns needs a positive integer/);
});

test('effectiveScenario: --max-turns overrides the scenario cap; without it the scenario stands', () => {
  const scn = { maxTurns: 30, prompt: 'p' };
  assert.deepEqual(effectiveScenario(scn, { maxTurns: 80 }), { maxTurns: 80, prompt: 'p' });
  assert.equal(effectiveScenario(scn, { maxTurns: null }), scn);
  assert.equal(scn.maxTurns, 30); // the scenario itself is untouched
});

test('armSetups: both arms record the override and where the cap came from', () => {
  const args = parseArgs([...base, '--max-turns', '80']);
  const scn = effectiveScenario({ maxTurns: 30 }, args);
  const s = armSetups(args, armsFor('anyray'), RUN, scn, { enrolled: false });
  for (const slot of ['a', 'b']) {
    assert.equal(s[slot].maxTurns, 80);
    assert.equal(s[slot].maxTurnsSource, '--max-turns');
  }
  const plain = armSetups(parseArgs(base), armsFor('anyray'), RUN, { maxTurns: 30 }, { enrolled: false });
  assert.equal(plain.a.maxTurns, 30);
  assert.equal(plain.b.maxTurnsSource, 'scenario');
});

// --with-control

test('parseArgs: --with-control is off by default, on with the flag, refused under --compare control', () => {
  assert.equal(parseArgs(base).withControl, false);
  assert.equal(parseArgs([...base, '--with-control']).withControl, true);
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'control', '--with-control']), /--with-control .*--compare control/);
});

test('controlArgs: direct vs direct with the same scenario, rounds, max turns and subagent setting', () => {
  const main = parseArgs([...base, '--rounds', '5', '--max-turns', '80', '--no-subagents', '--label', 'om', '--with-control', '--read-trim', '--arm-env', 'b:X=1']);
  const c = controlArgs(main);
  assert.equal(c.compare, 'control');
  assert.equal(c.scenario, 's');
  assert.equal(c.rounds, 5);
  assert.equal(c.maxTurns, 80);
  assert.equal(c.noSubagents, true);
  assert.equal(c.withControl, false);
  // Nothing gateway-side and no per-arm treatment leaks into the control.
  assert.equal(c.kinds, null);
  assert.equal(c.strategy, null);
  assert.equal(c.experiment, null);
  assert.equal(c.readTrim, false);
  assert.deepEqual(c.env, { a: {}, b: {} });
});

test('controlArgs: its own result file, label suffixed -control', () => {
  const labelled = parseArgs([...base, '--label', 'om', '--with-control']);
  assert.equal(resultFileName(controlArgs(labelled)), 's--control--om-control.json');
  assert.notEqual(resultFileName(controlArgs(labelled)), resultFileName(labelled));
  const unlabelled = parseArgs([...base, '--with-control']);
  assert.equal(resultFileName(controlArgs(unlabelled)), 's--control--anyray-control.json');
});

// Solved-pair verdict

test('solvedPairVerdict: ratios, win rate, median and Q3 only over rounds both arms solved', () => {
  const v = solvedPairVerdict([
    rnd(1, 0.8),
    rnd(2, 0.5, true, false), // only A solved: a quality event, never a cost win
    rnd(3, 0.9),
    rnd(4, 0.4, false, false), // neither solved
    rnd(5, 1.2),
    timeout(6),
  ]);
  assert.equal(v.n, 6);
  assert.equal(v.k, 3);
  assert.deepEqual(v.pairs, [1, 3, 5]);
  assert.equal(v.stats.n, 3);
  assert.equal(v.stats.wins, 2);
  assert.equal(v.stats.median, 0.9);
  assert.ok(Math.abs(v.stats.q3 - 1.05) < 1e-9);
  assert.deepEqual(v.qualityEvents, [{ round: 2, solvedBy: 'a' }]);
  assert.deepEqual(v.neither, [4]);
  assert.deepEqual(v.noCost, [{ round: 6, reason: 'B ended without a result (no cost)' }]);
  assert.equal(v.insufficient, false);
});

test('solvedPairVerdict: a cheap unsolved session is never counted as a win', () => {
  const v = solvedPairVerdict([rnd(1, 0.2, true, false), rnd(2, 0.3, false, true), rnd(3, 1.1), rnd(4, 1.1), rnd(5, 1.1)]);
  assert.equal(v.stats.wins, 0);
  assert.equal(v.stats.median, 1.1);
  assert.deepEqual(v.qualityEvents, [{ round: 1, solvedBy: 'a' }, { round: 2, solvedBy: 'b' }]);
});

test('solvedPairVerdict: fewer than 3 solved pairs is an insufficient verdict', () => {
  const v = solvedPairVerdict([rnd(1, 0.8), rnd(2, 0.7), rnd(3, 0.5, false, false), timeout(4, 'a')]);
  assert.equal(v.k, 2);
  assert.equal(v.insufficient, true);
  assert.equal(v.verdict, 'INSUFFICIENT');
  assert.match(v.reasons.join(' '), /only 2 solved pair\(s\)/);
  assert.equal(solvedPairVerdict([]).verdict, 'INSUFFICIENT');
});

test('solvedPairVerdict: quality events weigh on quality, not cost', () => {
  const pairs = [0.8, 0.85, 0.9, 0.7, 0.95, 0.88].map((x, i) => rnd(i + 1, x));
  assert.equal(solvedPairVerdict(pairs).verdict, 'PASS');
  const dropped = solvedPairVerdict([...pairs, rnd(7, 0.5, true, false)]);
  assert.equal(dropped.verdict, 'FAIL');
  assert.match(dropped.reasons.join(' '), /quality dropped: only A solved 1 round\(s\), only B 0/);
});

test('solvedPairVerdict: timeouts (a crashed round, no sessions) are excluded and reported', () => {
  const v = solvedPairVerdict([{ round: 1, error: 'spawn failed' }, rnd(2, 0.9), rnd(3, 0.9), rnd(4, 0.9)]);
  assert.equal(v.k, 3);
  assert.deepEqual(v.noCost, [{ round: 1, reason: 'spawn failed' }]);
});

// Noise band

test('noiseBand: the control verdict\'s solved-pair median and range', () => {
  const band = noiseBand(solvedPairVerdict([rnd(1, 0.7), rnd(2, 1.0), rnd(3, 1.4), rnd(4, 0.1, true, false)]));
  assert.deepEqual(band, { median: 1.0, min: 0.7, max: 1.4, k: 3 });
  assert.equal(noiseBand(solvedPairVerdict([rnd(1, 0.5, false, false)])), null);
});

test('bandPosition: below / inside / above the control range', () => {
  const band = { median: 1, min: 0.7, max: 1.4, k: 3 };
  assert.equal(bandPosition(0.6, band), 'below');
  assert.equal(bandPosition(0.7, band), 'inside');
  assert.equal(bandPosition(1.2, band), 'inside');
  assert.equal(bandPosition(1.5, band), 'above');
  assert.equal(bandPosition(null, band), null);
  assert.equal(bandPosition(0.6, null), null);
});

// The printout

test('formatVerdict: solved-pair verdict first, the old all-rounds line kept below', () => {
  const rounds = [rnd(1, 0.8), rnd(2, 0.5, true, false), rnd(3, 0.9), rnd(4, 1.2), timeout(5)];
  const out = formatVerdict({ scenario: 's', compare: 'anyray', rounds });
  assert.match(out, /solved pairs 3\/5: wins 2\/3, median 0\.90, Q3 1\.05/);
  assert.match(out, /quality events \(one arm solved\): round 2 A only/);
  assert.match(out, /no cost \(timeout\/crash\), excluded: round 5 \(B ended without a result \(no cost\)\)/);
  // Old line, same shape as before ANY-733, over all scored rounds (ratio 0.5 of round 2 included).
  assert.match(out, /s \[anyray\] after 4 round\(s\): wins 3\/4, median 0\.85, Q3 0\.9[78], max 1\.20 → /);
  assert.ok(out.indexOf('solved pairs') < out.indexOf('after 4 round(s)'));
});

test('formatVerdict: insufficient solved pairs is said out loud', () => {
  const out = formatVerdict({ scenario: 's', compare: 'anyray', rounds: [rnd(1, 0.8), rnd(2, 0.5, false, false)] });
  assert.match(out, /verdict insufficient: only 1 solved pair\(s\)/);
});

test('formatVerdict: with a control, prints the noise band and whether the median falls outside it', () => {
  const rounds = [rnd(1, 0.5), rnd(2, 0.55), rnd(3, 0.6)];
  const control = [rnd(1, 0.8), rnd(2, 1.0), rnd(3, 1.3)];
  const out = formatVerdict({ scenario: 's', compare: 'anyray', rounds, controlRounds: control });
  assert.match(out, /noise band \(control, 3 solved pairs\): median 1\.00, range 0\.80–1\.30/);
  assert.match(out, /median 0\.55 is below the noise band/);
  const inside = formatVerdict({ scenario: 's', compare: 'anyray', rounds: [rnd(1, 0.9), rnd(2, 0.9), rnd(3, 0.9)], controlRounds: control });
  assert.match(inside, /median 0\.90 is inside the noise band: not distinguishable from noise/);
  const none = formatVerdict({ scenario: 's', compare: 'anyray', rounds, controlRounds: [rnd(1, 0.8, false, false)] });
  assert.match(none, /noise band \(control\): n\/a, no solved pairs/);
});

test('formatVerdict: gateway-restarted rounds are dropped from both lines and listed', () => {
  const out = formatVerdict({ scenario: 's', compare: 'anyray', rounds: [rnd(1, 0.8), { ...rnd(2, 0.1), gatewayRestarted: true }, rnd(3, 0.9), rnd(4, 0.9)] });
  assert.match(out, /solved pairs 3\/3/);
  assert.match(out, /dropped \(gateway restarted\): round\(s\) 2/);
});

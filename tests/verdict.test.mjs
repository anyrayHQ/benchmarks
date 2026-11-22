// ANY-733: --max-turns, --with-control (a direct-vs-direct noise band in the same
// invocation), and a Rule 0 verdict over solved pairs only. Offline: stubbed rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armSetups, armsFor, controlArgs, effectiveScenario, formatVerdict, parseArgs, resultFileName, slotOptions, verdictOptions } from '../run_agent.mjs';
import { bandPosition, kindDifference, noiseBand, solvedPairVerdict } from '../lib/stats.mjs';

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

// A treatment arm that never acted has nothing to measure (2026-10-12: the request-planner
// bench read "neutral" over 19 pairs where the planner-on arm made no edit in any session).

/** A round whose arms report their optimization tally: `applied` edits per kind on each arm. */
const tallied = (round, ratio, appliedA, appliedB) => ({
  ...rnd(round, ratio),
  optimizationA: { requests: 10, byKind: { observation_mask: { applied: appliedA, skipped: {}, unconfirmed: 0 }, content_census: { applied: 10, skipped: {}, unconfirmed: 0 } }, otherApplied: {} },
  optimization: { requests: 10, byKind: { observation_mask: { applied: appliedB, skipped: {}, unconfirmed: 0 }, content_census: { applied: 10, skipped: {}, unconfirmed: 0 } }, otherApplied: {} },
});

test('solvedPairVerdict: a treatment arm that applied no optimization in any solved pair is insufficient, the census aside', () => {
  const idle = [0.8, 0.85, 0.9, 0.7, 0.95, 0.88].map((x, i) => tallied(i + 1, x, 0, 0));
  const v = solvedPairVerdict(idle);
  assert.equal(v.verdict, 'INSUFFICIENT');
  assert.equal(v.treatmentEdits, 0);
  assert.match(v.reasons[0], /treatment arm B applied no optimization in any of the 6 solved pairs/);
  // One edited pair is enough to score; rounds with no tally at all (a control run, an older record) never trip it.
  assert.equal(solvedPairVerdict([...idle.slice(1), tallied(7, 0.8, 0, 3)]).verdict, 'PASS');
  assert.equal(solvedPairVerdict([0.8, 0.85, 0.9, 0.7, 0.95, 0.88].map((x, i) => rnd(i + 1, x))).verdict, 'PASS');
});

test('solvedPairVerdict: --treatment a scores the ratio as A over B and reads A’s edits', () => {
  const rounds = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5].map((x, i) => tallied(i + 1, x, 2, 0));
  const b = solvedPairVerdict(rounds);
  assert.equal(b.verdict, 'INSUFFICIENT', 'B edited nothing');
  const a = solvedPairVerdict(rounds, { treatment: 'a' });
  assert.equal(a.treatment, 'a');
  assert.equal(a.treatmentEdits, 6);
  assert.equal(a.stats.median, 2, 'A costs twice B');
  assert.equal(a.stats.wins, 0);
  assert.equal(a.verdict, 'FAIL');
  assert.match(formatVerdict({ scenario: 's', compare: 'gateway', rounds, treatment: 'a' }), /treatment A \(ratio A\/B\)/);
});

// Under --kinds-b the treatment is the kinds the arms differ by: the other strategies acting
// on either arm is not it (2026-10-15, repeat_factor on A vs off on B: the verdict read
// "applied in 3/3" from command_digest while repeat_factor acted in rounds 2 and 3 only).

/** A round with per-kind `applied` counts on each arm: { kind: n }. */
const byKinds = (round, ratio, a, b) => {
  const tally = (m) => ({ requests: 20, byKind: Object.fromEntries(Object.entries(m).map(([k, n]) => [k, { applied: n, skipped: {}, unconfirmed: 0 }])), otherApplied: {} });
  return { ...rnd(round, ratio), optimizationA: tally(a), optimization: tally(b) };
};
const RF_AB = [
  byKinds(1, 0.554, { command_digest: 27, repeat_factor: 0, content_census: 20 }, { command_digest: 0, content_census: 20 }),
  byKinds(2, 2.079, { command_digest: 24, repeat_factor: 13, content_census: 20 }, { command_digest: 24, content_census: 20 }),
  byKinds(3, 1.072, { command_digest: 18, repeat_factor: 8, content_census: 20 }, { command_digest: 0, content_census: 20 }),
];

test('kindDifference: what only A requests and what only B requests; null without --kinds-b or when equal', () => {
  assert.deepEqual(kindDifference(['a', 'b', 'rf'], ['a', 'b']), { a: ['rf'], b: [] });
  assert.deepEqual(kindDifference(['a', 'x'], ['a', 'y']), { a: ['x'], b: ['y'] });
  assert.equal(kindDifference(['a'], null), null);
  assert.equal(kindDifference(['a'], ['a']), null);
});

test('solvedPairVerdict: under --kinds-b only the differing kinds count as the treatment acting', () => {
  const differingKinds = kindDifference(['command_digest', 'repeat_factor'], ['command_digest']);
  const any = solvedPairVerdict(RF_AB, { treatment: 'a' });
  assert.equal(any.treatmentEdits, 3, 'any kind: command_digest acted on A in every round');
  const v = solvedPairVerdict(RF_AB, { treatment: 'a', differingKinds });
  assert.equal(v.treatmentEdits, 2);
  assert.deepEqual(v.idlePairs, [1]);
  const out = formatVerdict({ scenario: 'gin-long-session', compare: 'gateway', rounds: RF_AB, treatment: 'a', differingKinds });
  assert.match(out, /repeat_factor on A \(the kinds A and B differ by\) applied in 2\/3 solved pair\(s\); idle in round\(s\) 1/);
  // The differing kind idle in every pair: nothing to measure, whatever else acted.
  const idle = RF_AB.map((r) => ({ ...r, optimizationA: { ...r.optimizationA, byKind: { ...r.optimizationA.byKind, repeat_factor: { applied: 0, skipped: {}, unconfirmed: 0 } } } }));
  const none = solvedPairVerdict(idle, { treatment: 'a', differingKinds });
  assert.equal(none.verdict, 'INSUFFICIENT');
  assert.match(none.reasons[0], /the kinds A and B differ by \(repeat_factor on A\) applied nothing in any of the 3 solved pairs/);
  // A kind only B requests is read on B, even when A is the arm under test.
  const onB = solvedPairVerdict(RF_AB, { treatment: 'a', differingKinds: kindDifference(['command_digest'], ['command_digest', 'repeat_factor']) });
  assert.equal(onB.treatmentEdits, 0, 'B never applied repeat_factor');
});

/**
 * A --kinds-b round whose arms carry a shadow tally for repeat_factor: `would` is how many
 * requests on [A, B] the kind would have saved tokens on. `abRatio` is A ÷ B (A under test).
 */
const shadowed = (round, abRatio, [wouldA, wouldB]) => {
  const r = byKinds(round, 1 / abRatio, { repeat_factor: wouldA ? 5 : 0, content_census: 20 }, { content_census: 20 });
  const sh = (n) => ({ repeat_factor: { wouldApply: n, wouldNot: 20 - n, unsupported: 0, unanswered: 0 } });
  r.optimizationA.shadow = sh(wouldA);
  r.optimization.shadow = sh(wouldB);
  return r;
};
const RF_ONLY = kindDifference(['command_digest', 'repeat_factor'], ['command_digest']);
// gin-long-session 2026-10-17 in miniature: five pairs on the kind's shape, and three
// where an arm's session gave it nothing to act on, whose ratios are session noise.
const ON_AND_OFF_SHAPE = [
  shadowed(1, 0.6, [4, 3]),
  shadowed(2, 0.7, [5, 2]),
  shadowed(3, 0.8, [3, 4]),
  shadowed(4, 1.3, [0, 0]),
  shadowed(5, 1.29, [0, 3]),
  shadowed(6, 1.15, [2, 0]),
  shadowed(7, 0.75, [3, 3]),
  shadowed(8, 0.65, [6, 2]),
];

test('solvedPairVerdict: with shadow tallies, only pairs where the differing kinds would act in both arms are scored', () => {
  const v = solvedPairVerdict(ON_AND_OFF_SHAPE, { treatment: 'a', differingKinds: RF_ONLY });
  assert.deepEqual(v.pairs, [1, 2, 3, 7, 8]);
  assert.deepEqual(v.offShapePairs, [4, 5, 6]);
  assert.equal(v.k, 5);
  assert.equal(v.solved, 8);
  assert.equal(v.stats.wins, 5);
  assert.equal(v.verdict, 'PASS');
  // Scored over every pair, the off-shape noise fails the same rounds.
  assert.equal(solvedPairVerdict(ON_AND_OFF_SHAPE, { treatment: 'a' }).verdict, 'FAIL');
});

test('solvedPairVerdict: a pair whose arm has no shadow answer keeps every pair scored, and says why', () => {
  const missing = ON_AND_OFF_SHAPE.map((r) => (r.round === 6 ? { ...r, optimization: { ...r.optimization, shadow: undefined } } : r));
  const v = solvedPairVerdict(missing, { treatment: 'a', differingKinds: RF_ONLY });
  assert.deepEqual(v.pairs, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(v.offShapePairs, null);
  assert.match(v.shapeNote, /no shadow answer for repeat_factor on B in round\(s\) 6: every solved pair is scored/);
  const unsupported = ON_AND_OFF_SHAPE.map((r) => ({ ...r, optimizationA: { ...r.optimizationA, shadow: { repeat_factor: { wouldApply: 0, wouldNot: 0, unsupported: 20, unanswered: 0 } } } }));
  assert.equal(solvedPairVerdict(unsupported, { treatment: 'a', differingKinds: RF_ONLY }).offShapePairs, null);
});

test('solvedPairVerdict: fewer than 3 on-shape pairs is insufficient', () => {
  const v = solvedPairVerdict(ON_AND_OFF_SHAPE.filter((r) => [1, 4, 5, 6, 7].includes(r.round)), { treatment: 'a', differingKinds: RF_ONLY });
  assert.equal(v.verdict, 'INSUFFICIENT');
  assert.match(v.reasons[0], /only 2 solved pair\(s\)/);
});

test('formatVerdict: names the on-shape pairs and the off-shape rounds', () => {
  const out = formatVerdict({ scenario: 'gin-long-session', compare: 'gateway', rounds: ON_AND_OFF_SHAPE, treatment: 'a', differingKinds: RF_ONLY });
  assert.match(out, /on-shape pairs 5\/8 \(repeat_factor on A would act in both arms\); off-shape, not scored: round\(s\) 4, 5, 6/);
});

test('slotOptions: under --kinds-b both Anyray arms ask for the differing kinds in shadow', () => {
  const args = parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'command_digest,repeat_factor', '--kinds-b', 'command_digest', '--treatment', 'a']);
  const arms = armsFor('gateway');
  for (const slot of ['a', 'b']) {
    assert.ok(slotOptions(args, arms, slot).extraHeaders.includes('x-anyray-optimization-shadow-kinds: repeat_factor'), slot);
  }
  const plain = parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'repeat_factor', '--experiment-b', 'x']);
  assert.ok(!slotOptions(plain, arms, 'b').extraHeaders.some((h) => h.startsWith('x-anyray-optimization-shadow-kinds')));
});

test('verdictOptions: the arm under test, and the kinds a --kinds-b pair differs by', () => {
  const ab = parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'command_digest,repeat_factor', '--kinds-b', 'command_digest', '--treatment', 'a']);
  assert.deepEqual(verdictOptions(ab), { treatment: 'a', differingKinds: { a: ['repeat_factor'], b: [] } });
  assert.deepEqual(verdictOptions(parseArgs(base)), { treatment: 'b', differingKinds: null });
});

test('parseArgs: --treatment names the arm under test, b by default, and needs --compare gateway', () => {
  assert.equal(parseArgs(base).treatment, 'b');
  assert.equal(parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask', '--treatment', 'a']).treatment, 'a');
  assert.throws(() => parseArgs(['--scenario', 's', '--compare', 'gateway', '--kinds', 'observation_mask', '--treatment', 'c']), /--treatment must be a or b/);
  assert.throws(() => parseArgs([...base, '--treatment', 'a']), /--treatment a needs --compare gateway/);
});

test('solvedPairVerdict: a client-tool treatment acts through batch reads the control arm did not make', () => {
  // --client-tool-policy-b readBatch=false --treatment a: no optimizer edits on either arm,
  // A batch-reads and B cannot. The edit tally alone would call A idle.
  const reads = (r, a, b) => ({ ...r, sessions: { a: { totals: { ...r.sessions.a.totals, readBatchCalls: a } }, b: { totals: { ...r.sessions.b.totals, readBatchCalls: b } } } });
  const rounds = [2, 1.8, 1.9, 2.1, 1.7, 2.2].map((x, i) => reads(tallied(i + 1, x, 0, 0), 19, 0));
  assert.equal(solvedPairVerdict(rounds, { treatment: 'a' }).verdict, 'INSUFFICIENT', 'without the option, edits decide');
  const v = solvedPairVerdict(rounds, { treatment: 'a', clientToolTreatment: true });
  assert.equal(v.treatmentEdits, 6);
  assert.equal(v.verdict, 'PASS');
  // The treatment arm read no more than the control: it still did nothing to measure.
  const idle = rounds.map((r) => reads(r, 0, 0));
  const w = solvedPairVerdict(idle, { treatment: 'a', clientToolTreatment: true });
  assert.equal(w.verdict, 'INSUFFICIENT');
  assert.match(w.reasons[0], /treatment arm A made no connect client-tool call \(batch read, Symbol context search\) the control arm did not/);
  // Symbol context searches count the same way, and optimizer edits shared by both arms never do.
  const searches = (r, a, b) => ({ ...r, sessions: { a: { totals: { ...r.sessions.a.totals, searchContextCalls: a } }, b: { totals: { ...r.sessions.b.totals, searchContextCalls: b } } } });
  const sc = [2, 1.8, 1.9].map((x, i) => searches(tallied(i + 1, 0.9, 3, 3), 4, 0));
  assert.equal(solvedPairVerdict(sc, { treatment: 'a', clientToolTreatment: true }).treatmentEdits, 3);
  const editsOnly = sc.map((r) => searches(r, 0, 0));
  assert.equal(solvedPairVerdict(editsOnly, { treatment: 'a', clientToolTreatment: true }).verdict, 'INSUFFICIENT', 'shared edits are not the treatment');
  assert.match(formatVerdict({ scenario: 's', compare: 'gateway', rounds, treatment: 'a', clientToolTreatment: true }), /→ PASS/);
});

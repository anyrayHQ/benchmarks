// `npm run report -- --redact --html` writes <scenarios-dir>/report.html: the local, shareable page
// a client opens after a test. Deterministic, from the validated body and the run records only,
// so it can never reword a verdict. Offline (no script, no external asset), content-free (the same
// allowlist as the JSON), and honest about thin data: a curve point needs at least 5 pairs.
// Synthetic records; no session runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { kitIn, leaks, pairRound, syntheticPlan, writeRecord } from './kitRunFixtures.mjs';

const html = (copy, dir, env, args = []) => kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--html', ...args], { env });

// A round with the turn counts the curve needs: direct (a) and Anyray (b).
const turnsRound = (round, a, b, turns, extra = {}) => {
  const r = pairRound(round, a, b, extra);
  r.sessions.a.totals.turns = turns;
  r.sessions.b.totals.turns = turns;
  return r;
};

/** A plan whose only record is check-long: eight pairs of known cost and length. */
async function plan(t, { marked = false, n = 8 } = {}) {
  const root = tempDir(t, 'kit-html-');
  const env = kitEnv(join(root, 'home'));
  const built = await syntheticPlan(root, { env, marked, records: false });
  const bs = [0.5, 0.55, 0.48, 1.1, 0.51, 0.49, 0.53, 0.5];
  const turns = [4, 6, 6, 8, 8, 10, 12, 14];
  const rounds = bs.slice(0, n).map((b, i) => turnsRound(i + 1, 1, b, turns[i]));
  writeRecord(built.dir, built.lock, 'check-long', rounds);
  return { ...built, env, rounds };
}

test('writes report.html beside the scenarios and prints its path', async (t) => {
  const { copy, dir, env } = await plan(t);
  const child = await html(copy, dir, env);
  assert.equal(child.status, 0, `report --html failed: ${child.stdout.slice(0, 300)} ${child.stderr.slice(-400)}`);
  const file = join(dir, 'report.html');
  assert.ok(existsSync(file), 'report.html was not written');
  assert.ok(child.stdout.includes(file), `stdout names the file: ${child.stdout}`);
});

test('the page is offline: no script, no external asset, no URL of any kind', async (t) => {
  const { copy, dir, env } = await plan(t);
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /<link\b/i);
  assert.doesNotMatch(page, /https?:\/\//i);
  assert.match(page, /<!doctype html>/i);
  assert.match(page, /prefers-color-scheme: dark/, 'readable in dark mode too');
});

test('the headline carries the verdict word, dollars per session, the plan and the versions, from the same body the JSON prints', async (t) => {
  const { copy, dir, env, lock } = await plan(t);
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  const body = json(await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--redact', '--json'], { env }), 'report --json');
  assert.ok(page.includes(body.rule0Verdict), 'the pooled Rule 0 word');
  const { direct, anyray } = body.totals.costUsdPerSession;
  assert.ok(page.includes(`$${direct.toFixed(2)}`) && page.includes(`$${anyray.toFixed(2)}`), 'dollars per session for both arms');
  assert.ok(page.includes(lock.planHash.slice(0, 7)), 'the plan, by its short hash');
  assert.ok(!page.includes(lock.planHash), 'never the whole hash');
  assert.ok(page.includes(body.clientToolVersion) && page.includes(body.gatewayVersion), 'versions');
});

test('every counted pair is a row, green when Anyray was cheaper and red when it cost more, with both arms\' check results', async (t) => {
  const { copy, dir, env, rounds } = await plan(t);
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  const rows = page.match(/<tr data-pair[^>]*>/g) ?? [];
  assert.equal(rows.length, rounds.length, 'one row per pair');
  assert.equal(rows.filter((r) => r.includes('data-outcome="saved"')).length, 7);
  assert.equal(rows.filter((r) => r.includes('data-outcome="cost-more"')).length, 1, 'the 1.1 pair');
  assert.match(page, /1\.100/, 'the worst pair\'s ratio, to three places');
  assert.match(page, /passed/, 'check results are shown');
});

test('savings by session length: one point per turn threshold that still has at least 5 pairs, labeled with its share', async (t) => {
  const { copy, dir, env } = await plan(t);
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.match(page, /Savings by session length/);
  // thresholds 4 (8 pairs), 6 (7 pairs), 8 (5 pairs); 10 and up have fewer than 5.
  const titles = [...page.matchAll(/<title>([^<]*pairs cheaper)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['4+ turns: 88% of 8 pairs cheaper', '6+ turns: 86% of 7 pairs cheaper', '8+ turns: 80% of 5 pairs cheaper']);
});

test('with fewer than 5 pairs the curve says so instead of drawing one', async (t) => {
  const { copy, dir, env } = await plan(t, { n: 4 });
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.match(page, /at least 5 pairs/i);
  assert.doesNotMatch(page, /<circle/);
});

test('a pair that was excluded is listed with its reason, not dropped, and a pair only direct solved is named', async (t) => {
  const root = tempDir(t, 'kit-html-');
  const env = kitEnv(join(root, 'home'));
  const { copy, dir, lock } = await syntheticPlan(root, { env, records: false });
  const rounds = [
    ...[1, 2, 3, 4, 5].map((i) => turnsRound(i, 1, 0.6, 5 + i)),
    turnsRound(6, 1, 0.4, 9, { solved: [true, false] }),
    { round: 7, holdoutDrawn: { b: ['observation_mask'] }, redraws: [{ b: ['observation_mask'] }] },
  ];
  writeRecord(dir, lock, 'check-long', rounds);
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.match(page, /holdout drawn/, 'the exclusion reason');
  assert.match(page, /not solved/, 'a pair a check failed on');
  assert.match(page, /1 pair passed only direct/, 'the quality loss, in words');
});

test('no task text, repo, check command, key fact, transcript or diff reaches the page, even when a record carries it', async (t) => {
  const { copy, dir, env } = await plan(t, { marked: true });
  await html(copy, dir, env);
  const page = readFileSync(join(dir, 'report.html'), 'utf8');
  assert.deepEqual(leaks(page), [], 'the page carries client content');
});

test('every string the page prints is escaped', async () => {
  const { escapeHtml } = await import('../lib/reportHtml.mjs');
  assert.equal(escapeHtml('<b a="x">&\'</b>'), '&lt;b a=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

test('--html without --redact is a usage error, like every report', async (t) => {
  const { copy, dir, env } = await plan(t);
  const child = await kitIn(copy.root, ['report', '--scenarios-dir', dir, '--html'], { env });
  assert.equal(child.status, 2);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

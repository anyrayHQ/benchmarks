// ANY-1684: a client-test result discloses how many of the kinds the test evaluated were still in
// shadow on the tenant. Test sessions run the kinds that are on AND the ones in shadow (the
// evaluation cohort); live traffic gets only the kinds that are on, so a saving measured partly on
// shadow kinds is not yet what the tenant's own traffic gets. The run records keep the context's
// { on, shadow } counts (kitTestKey.test.mjs pins that); this file pins what the result does with
// them: the body's optional `evaluatedKinds` (the record with the most shadow kinds), both report
// formats' sentence, and publish-result's single resend to a gateway that predates the field.
//
// Synthetic records and a fake gateway on 127.0.0.1; no session runs, nothing reaches a real gateway.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientTestBodySchema as kitSchema } from '../lib/clientTestBody.mjs';
import { kitEnv, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import { MARK, assertGatewayBody, clientTestBodySchema as gatewaySchema, kitIn, leaks, syntheticPlan, writeRecord } from './kitRunFixtures.mjs';
import { TEST_KEY, TEST_PUBLISHED_ID, fakeTestGateway, keyOf } from './kitTestKeyFixtures.mjs';

const kindsLine = (shadow, total) => `Kinds: ${shadow} of ${total} tested were still in shadow on your tenant; live traffic gets them only after promotion.`;
const DROPPED = { code: 'evaluated_kinds_dropped', message: 'this gateway predates the shadow-kind disclosure; upgrade the gateway to show it.' };
const RESULTS = '/connect/test/results';

const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});
const gatewayFor = async (opts) => {
  const g = await fakeTestGateway(opts);
  gateways.push(g);
  return g;
};

/**
 * A frozen plan with synthetic records for check-long, facts and short-task (docs has none), each
 * record carrying `kinds[id]` as its evaluatedKinds when given. On the test key when `gateway` is.
 */
async function planWith(t, kinds = {}, { gateway } = {}) {
  const root = tempDir(t, 'kit-kinds-');
  const env = kitEnv(join(root, 'home'), gateway ? { ANYRAY_GATEWAY_URL: gateway.url, ANYRAY_BENCH_CLIENT_KEY: TEST_KEY } : {});
  const built = await syntheticPlan(root, { env, ...(gateway ? { gatewayUrl: gateway.url } : {}) });
  const s = { ...built, env };
  setKinds(s, kinds);
  return s;
}

/** Rewrite the records with these evaluatedKinds (an id not named keeps none). */
function setKinds(s, kinds) {
  for (const [id, rounds] of Object.entries(s.rounds)) {
    writeRecord(s.dir, s.lock, id, rounds, kinds[id] === undefined ? {} : { extra: { evaluatedKinds: kinds[id] } });
  }
}

const reportBody = async (s) => json(await kitIn(s.copy.root, ['report', '--scenarios-dir', s.dir, '--redact', '--json'], { env: s.env }), 'report --redact --json');
async function reportText(s) {
  const child = await kitIn(s.copy.root, ['report', '--scenarios-dir', s.dir, '--redact'], { env: s.env });
  assert.equal(child.status, 0, `report --redact failed: ${child.stdout.slice(0, 300)} ${child.stderr.slice(-300)}`);
  return child.stdout;
}
async function reportPage(s) {
  const child = await kitIn(s.copy.root, ['report', '--scenarios-dir', s.dir, '--redact', '--html'], { env: s.env });
  assert.equal(child.status, 0, `report --redact --html failed: ${child.stdout.slice(0, 300)} ${child.stderr.slice(-300)}`);
  return readFileSync(join(s.dir, 'report.html'), 'utf8');
}
/** The line right after "Pooled Rule 0: ...", asserting that line is there. */
function afterPooled(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Pooled Rule 0: '));
  assert.ok(at !== -1, `the text report has its Pooled Rule 0 line: ${JSON.stringify(text.slice(-400))}`);
  return lines[at + 1];
}
/** The Rule 0 card: from its verdict word to the card's closing tag. */
function rule0Card(page, verdict) {
  const start = page.indexOf(`<div class="card"><b>${verdict}</b>`);
  assert.ok(start !== -1, `the page has the Rule 0 card for ${verdict}`);
  return page.slice(start, page.indexOf('</div>', start) + '</div>'.length);
}

// ---- the body ------------------------------------------------------------------------------------

test('the body discloses evaluatedKinds from the run record with the most kinds in shadow, as exactly { on, shadow }, and the gateway accepts it', async (t) => {
  // The record with the most kinds on (check-long) and the one with the most kinds in all (also
  // check-long) are not the one with the most in shadow (facts, between the other two).
  const s = await planWith(t, { 'check-long': { on: 9, shadow: 1 }, facts: { on: 2, shadow: 3 }, 'short-task': { on: 3, shadow: 2 } });
  const body = await reportBody(s);
  assert.deepEqual(body.evaluatedKinds, { on: 2, shadow: 3 }, 'the most shadow kinds any run evaluated, with that run\'s on count');
  assertGatewayBody(body, 'a body with evaluatedKinds');
  assert.equal(kitSchema.safeParse(body).success, true, 'the kit\'s own schema accepts what it built');
});

test('with no record carrying evaluated kinds the body has no evaluatedKinds field (unknown is not zero), and neither report mentions shadow kinds', async (t) => {
  const s = await planWith(t);
  const body = await reportBody(s);
  assert.equal(typeof body.rule0Verdict, 'string', 'the body was built');
  assert.ok(!Object.hasOwn(body, 'evaluatedKinds'), `no evaluatedKinds: ${JSON.stringify(body.evaluatedKinds)}`);
  const text = await reportText(s);
  assert.ok(!text.split('\n').some((l) => l.startsWith('Kinds:')), 'no Kinds line in the text report');
  assert.doesNotMatch(await reportPage(s), /still in shadow/, 'no shadow sentence on the page');
});

test('a record whose counts are not non-negative integers is skipped, and no record field but on and shadow reaches the body', async (t) => {
  const s = await planWith(t, {
    'check-long': { on: 1, shadow: '7' },
    facts: { on: 4, shadow: 2, note: MARK.keyFact },
    'short-task': { on: 0, shadow: 2.5 },
  });
  const body = await reportBody(s);
  assert.deepEqual(body.evaluatedKinds, { on: 4, shadow: 2 }, 'the one record with integer counts, and only its two counts');
  assert.deepEqual(leaks(JSON.stringify(body)), [], 'a hand-edited record field never travels');
});

test('the kit\'s body schema and the gateway copy agree: evaluatedKinds is optional and a strict { on, shadow } of non-negative integers', async (t) => {
  const s = await planWith(t, { facts: { on: 2, shadow: 3 } });
  const body = await reportBody(s);
  const { evaluatedKinds: _, ...without } = body;
  const cases = [
    ['absent', without, true],
    ['zeros', { ...without, evaluatedKinds: { on: 0, shadow: 0 } }, true],
    ['an extra count', { ...without, evaluatedKinds: { on: 1, shadow: 1, off: 0 } }, false],
    ['a negative count', { ...without, evaluatedKinds: { on: -1, shadow: 0 } }, false],
    ['a fractional count', { ...without, evaluatedKinds: { on: 1.5, shadow: 0 } }, false],
    ['a string count', { ...without, evaluatedKinds: { on: '1', shadow: 0 } }, false],
    ['a missing count', { ...without, evaluatedKinds: { shadow: 1 } }, false],
  ];
  for (const [what, candidate, ok] of cases) {
    assert.equal(kitSchema.safeParse(candidate).success, ok, `kit schema, ${what}`);
    assert.equal(gatewaySchema.safeParse(candidate).success, ok, `gateway copy, ${what}`);
  }
});

// ---- the reports ---------------------------------------------------------------------------------

test('the text report says how many of the kinds tested were still in shadow, on the line after Pooled Rule 0, only when at least one was', async (t) => {
  const s = await planWith(t, { 'check-long': { on: 3, shadow: 1 } });
  assert.equal(afterPooled(await reportText(s)), kindsLine(1, 4), 'one of four kinds in shadow');

  setKinds(s, { 'check-long': { on: 2, shadow: 3 } });
  assert.equal(afterPooled(await reportText(s)), kindsLine(3, 5), 'three of five');

  setKinds(s, { 'check-long': { on: 4, shadow: 0 } });
  const body = await reportBody(s);
  assert.deepEqual(body.evaluatedKinds, { on: 4, shadow: 0 }, 'a zero shadow count is still disclosed in the body');
  const text = await reportText(s);
  assert.ok(!text.split('\n').some((l) => l.startsWith('Kinds:')), `no Kinds line when nothing was in shadow: ${JSON.stringify(text.slice(-300))}`);
});

test('the HTML report puts the same sentence in the Rule 0 card, only when at least one kind was in shadow', async (t) => {
  const s = await planWith(t, { 'check-long': { on: 3, shadow: 1 } });
  const { rule0Verdict } = await reportBody(s);
  assert.ok(rule0Card(await reportPage(s), rule0Verdict).includes(kindsLine(1, 4)), 'the Rule 0 card carries the sentence');

  setKinds(s, { 'check-long': { on: 4, shadow: 0 } });
  const page = await reportPage(s);
  rule0Card(page, rule0Verdict);
  assert.doesNotMatch(page, /still in shadow/, 'no sentence when nothing was in shadow');
});

// ---- publish-result against a gateway that predates the field --------------------------------------

const publish = (s, args = []) => kitIn(s.copy.root, ['publish-result', '--scenarios-dir', s.dir, ...args], { env: s.env });
const posted = (gateway) => gateway.testRoute('POST', RESULTS);

test('publish-result to a gateway that predates evaluatedKinds resends once without it and warns, in the human output and in --json', async (t) => {
  const gateway = await gatewayFor({ oldGateway: true });
  const s = await planWith(t, { facts: { on: 2, shadow: 3 } }, { gateway });
  const reported = await reportBody(s);
  assert.deepEqual(reported.evaluatedKinds, { on: 2, shadow: 3 });
  const { evaluatedKinds: _, ...without } = reported;

  const asJson = await publish(s, ['--json']);
  assert.equal(asJson.status, 0, `publish --json failed: ${asJson.stdout.slice(0, 400)} ${asJson.stderr.slice(-400)}`);
  assert.deepEqual(json(asJson, 'publish-result --json (old gateway)'), { ok: true, command: 'publish-result', id: TEST_PUBLISHED_ID, warnings: [DROPPED] });
  const first = posted(gateway);
  assert.equal(first.length, 2, 'the body, then once more without evaluatedKinds');
  for (const p of first) assert.equal(keyOf(p), TEST_KEY);
  assert.deepEqual(first[0].body, reported, 'first the body report --json prints');
  assert.deepEqual(first[1].body, without, 'then the same body without evaluatedKinds, nothing else changed');

  const human = await publish(s);
  assert.equal(human.status, 0, `publish failed: ${human.stdout.slice(0, 400)} ${human.stderr.slice(-400)}`);
  assert.equal(human.stdout, `${TEST_PUBLISHED_ID}\n`, 'stdout stays the bare id');
  assert.ok(human.stderr.split('\n').includes(`${DROPPED.code}: ${DROPPED.message}`), `the warning on stderr: ${JSON.stringify(human.stderr)}`);
  assert.equal(posted(gateway).length, 4, 'two more POSTs');
});

test('publish-result to a current gateway sends evaluatedKinds once and warns about nothing', async (t) => {
  const gateway = await gatewayFor();
  const s = await planWith(t, { facts: { on: 2, shadow: 3 } }, { gateway });
  const child = await publish(s, ['--json']);
  assert.deepEqual(json(child, 'publish-result --json (current gateway)'), { ok: true, command: 'publish-result', id: TEST_PUBLISHED_ID });
  const sent = posted(gateway);
  assert.equal(sent.length, 1, 'one POST');
  assert.deepEqual(sent[0].body.evaluatedKinds, { on: 2, shadow: 3 });
  const human = await publish(s);
  assert.equal(human.status, 0);
  assert.doesNotMatch(human.stderr, /evaluated_kinds_dropped/);
});

const unrecognizedRoot = { path: [], code: 'unrecognized_keys' };
test('any other refusal is still publish_failed after one POST: another issue, another path, an empty list, or another status', async (t) => {
  const refusals = [
    ['an unknown key below the top level', { status: 400, payload: { issues: [{ path: ['scenarios', 0], code: 'unrecognized_keys' }] } }],
    ['an unknown top-level key beside another issue', { status: 400, payload: { issues: [unrecognizedRoot, { path: ['totals'], code: 'invalid_type' }] } }],
    ['a different top-level issue', { status: 400, payload: { issues: [{ path: [], code: 'invalid_type' }] } }],
    ['an empty issue list', { status: 400, payload: { issues: [] } }],
    ['no issue list', { status: 400, payload: { error: { type: 'invalid' } } }],
    ['the same issue under another status', { status: 422, payload: { issues: [unrecognizedRoot] } }],
  ];
  const gateway = await gatewayFor();
  const s = await planWith(t, { facts: { on: 2, shadow: 3 } }, { gateway });
  for (const [what, reply] of refusals) {
    const before = posted(gateway).length;
    gateway.state.postResults.push(reply); // this refusal, then (were it resent) a 201
    const child = await publish(s, ['--json']);
    const out = json(child, `publish-result --json (${what})`);
    assert.deepEqual({ ok: out.ok, code: out.code, status: out.status }, { ok: false, code: 'publish_failed', status: reply.status }, what);
    assert.equal(child.status, 1, what);
    assert.equal(posted(gateway).length - before, 1, `${what}: sent once, never resent`);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /evaluated_kinds_dropped/, `${what}: no warning`);
  }
});

test('the resend happens at most once: refused again, publish-result fails with the second refusal\'s status', async (t) => {
  const refused = { status: 400, payload: { issues: [unrecognizedRoot] } };
  const gateway = await gatewayFor({ postResults: [refused, refused] });
  const s = await planWith(t, { facts: { on: 2, shadow: 3 } }, { gateway });
  const child = await publish(s, ['--json']);
  const out = json(child, 'publish-result --json (refused twice)');
  assert.deepEqual({ ok: out.ok, code: out.code, status: out.status }, { ok: false, code: 'publish_failed', status: 400 });
  assert.equal(child.status, 1);
  assert.equal(posted(gateway).length, 2, 'the body, one resend, and no third POST (the gateway would have taken it)');
  assert.ok(!Object.hasOwn(posted(gateway)[1].body, 'evaluatedKinds'), 'the resend dropped evaluatedKinds');
});

test('a body without evaluatedKinds is never resent: there is nothing to drop', async (t) => {
  const gateway = await gatewayFor({ postResults: [{ status: 400, payload: { issues: [unrecognizedRoot] } }] });
  const s = await planWith(t, {}, { gateway });
  const child = await publish(s, ['--json']);
  const out = json(child, 'publish-result --json (no evaluatedKinds, refused)');
  assert.deepEqual({ ok: out.ok, code: out.code, status: out.status }, { ok: false, code: 'publish_failed', status: 400 });
  assert.equal(posted(gateway).length, 1, 'sent once');
  assert.ok(!Object.hasOwn(posted(gateway)[0].body, 'evaluatedKinds'));
  assert.doesNotMatch(`${child.stdout}${child.stderr}`, /evaluated_kinds_dropped/, 'nothing was dropped, so no warning');
});

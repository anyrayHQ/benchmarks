// `npm run twins -- --release <tag>` (ANY-1491): our side of the release reruns. The kit's committed
// twins/ dir holds public scenarios with a client plan's shape (`source: proposed`, `twinOf` naming
// that plan when there is one). `twins` freezes a temp copy of it (never writing under twins/),
// measures the noise floor, runs the paired rounds, builds the report body and publishes it with
// releaseTag = the release it was told, to the gateway it was told. It runs no client scenario:
// there is no --scenarios-dir. Plus the committed twins/ dir itself and its seed twin.
//
// Driven through the CLI of a kit copy whose twins/ holds one twin against a local git repo, with a
// stand-in Claude Code and a fake gateway on 127.0.0.1: no network, no model call.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import yaml from 'js-yaml';
import { scenarioPatches } from '../lib/agentRun.mjs';
import { shapeFeatures } from '../lib/planner.mjs';
import { HEX64, KIT_ROOT, PINS, freezeOk, tempDir } from './kitFixtures.mjs';
import { json } from './kitPlanFixtures.mjs';
import {
  ADMIN_KEY, BENCH_KEY, GATEWAY_VERSION, NOISE_MIN_ROUNDS, PUBLISHED_ID, fakeClaude, fakeRunGateway, filesUnder, kitIn, kitRunCopy,
  once, originRepo, poisonClaude, runEnv, runScenario, sharedTemp, writeDir,
} from './kitRunFixtures.mjs';
import { TWIN_OF, assertTwinBody, kitScripts, twinScenario } from './kitReleaseFixtures.mjs';

const RELEASE = 'v1.10.520';
// Direct costs that differ round to round, so the noise floor measures an SD above zero.
const DIRECT_COSTS = [1.0, 1.3, 0.85, 1.1, 0.95, 1.2, 0.9];
const gateways = [];
after(async () => {
  for (const g of gateways) await g.close();
});

/** Every file under `dir` as relative path -> bytes (to prove twins/ is left exactly as it was). */
const snapshot = (dir) => Object.fromEntries(filesUnder(dir).map((f) => [relative(dir, f), readFileSync(f, 'utf8')]));

/** A kit copy whose twins/ holds one public twin, a fake gateway, a stand-in Claude, a poisoned PATH. No ANYRAY_GATEWAY_URL. */
async function setup() {
  const root = sharedTemp('kit-twins-');
  const origin = originRepo(root);
  const copy = kitRunCopy(join(root, 'kit'));
  // The API-key lane's twin sits beside it: the release rerun is the seat lane, so it must not run or publish.
  const seatTwin = twinScenario(origin);
  const twinsDir = writeDir(copy.root, { 'lint-twin': seatTwin, 'key-twin': { ...seatTwin, doc: { ...seatTwin.doc, lane: 'api-key' } } }, 'twins');
  const gateway = await fakeRunGateway();
  gateways.push(gateway);
  const poison = poisonClaude(join(root, 'poison'));
  const claude = fakeClaude(join(root, 'claude'), { costs: { direct: DIRECT_COSTS, anyray: [0.5, 0.6] } });
  const env = runEnv(join(root, 'home'), { poison });
  return { root, origin, copy, twinsDir, before: snapshot(twinsDir), gateway, poison, claude, env };
}

const twins = (s, args, env = s.env) => kitIn(s.copy.root, ['twins', '--gateway', s.gateway.url, '--claude-bin', s.claude.bin, ...args], { env });

// One release run: the six noise rounds and one paired round. Run once, read by the leaf tests below.
const released = once(async () => {
  const s = await setup();
  const child = await twins(s, ['--release', RELEASE, '--rounds', '1', '--json']);
  return { ...s, child };
});

function publishedOk(s) {
  const out = json(s.child, 'twins --json');
  assert.equal(out.ok, true, `twins refused or failed: ${s.child.stdout.slice(0, 400)} ${s.child.stderr.slice(-800)}`);
  assert.equal(s.child.status, 0);
  return out;
}

test('package.json runs it as a kit script', () => {
  assert.equal(kitScripts().twins, 'node tools/kit.mjs twins');
});

test('twins publishes one result tagged with the release it was told, from a fresh plan of the kit\'s own twins', async () => {
  const s = await released();
  const out = publishedOk(s);
  assert.deepEqual({ command: out.command, releaseTag: out.releaseTag, gatewayVersion: out.gatewayVersion, id: out.id }, { command: 'twins', releaseTag: RELEASE, gatewayVersion: GATEWAY_VERSION, id: PUBLISHED_ID });
  assert.match(String(out.planHash), HEX64);
  const posts = s.gateway.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/admin/'));
  assert.equal(posts.length, 1, 'one publish');
  assert.equal(posts[0].path, '/admin/v1/client-tests');
  assert.equal(posts[0].authorization, `Bearer ${ADMIN_KEY}`);
  const body = assertTwinBody(posts[0].body, 'the published twin body');
  assert.equal(body.releaseTag, RELEASE, 'releaseTag is --release');
  assert.equal(body.gatewayVersion, GATEWAY_VERSION, 'gatewayVersion is what the gateway answered');
  assert.equal(body.planHash, out.planHash);
  assert.deepEqual({ clientTool: body.clientTool, clientToolVersion: body.clientToolVersion, model: body.model }, { clientTool: 'claude-code', clientToolVersion: PINS.clientVersion, model: PINS.model });
  assert.equal(body.scenarios.length, 1, 'the seat twin only: the api-key lane twin is left out');
  assert.deepEqual({ source: body.scenarios[0].source, twinOf: body.scenarios[0].twinOf }, { source: 'proposed', twinOf: TWIN_OF });
  assert.ok(!`${s.child.stdout}${s.child.stderr}`.includes(ADMIN_KEY), 'the admin key is never printed');
});

test('the noise floor comes first: six direct-vs-direct rounds, then the paired round, every session from the pinned binary', async () => {
  const s = await released();
  publishedOk(s);
  const sessions = s.claude.sessions();
  const noise = 2 * NOISE_MIN_ROUNDS;
  assert.ok(sessions.slice(0, noise).every((x) => x.kind === 'direct'), 'the first twelve sessions are the noise rounds (direct vs direct)');
  assert.deepEqual(sessions.map((x, i) => [x.kind, i]).filter(([k]) => k === 'anyray').map(([, i]) => i >= noise), [true], 'one Anyray session (one paired round), after the noise rounds');
  assert.ok(sessions.every((x) => x.bin === s.claude.realBin), 'every session was the --claude-bin build');
  assert.equal(s.poison.calls(), 0, 'the `claude` on PATH never ran');
});

test('the Anyray arm ran against --gateway (no ANYRAY_GATEWAY_URL is set) on the kit\'s own key and tag', async () => {
  const s = await released();
  publishedOk(s);
  assert.equal(s.env.ANYRAY_GATEWAY_URL, undefined, 'the gateway comes from --gateway alone');
  const inference = s.gateway.inference();
  assert.ok(inference.length > 0, 'the Anyray arm reached the gateway');
  for (const r of inference) {
    assert.equal(r.apiKey, BENCH_KEY);
    assert.equal(r.metadata?.tool, 'anyray-bench');
  }
  assert.ok(s.gateway.requests.some((r) => r.method === 'GET' && r.path === '/admin/v1/settings/updates'), 'the gateway version was read');
});

test('nothing is written under the kit\'s twins/: the plan, its noise block and its records live in a temp copy', async () => {
  const s = await released();
  publishedOk(s);
  assert.deepEqual(snapshot(s.twinsDir), s.before, 'twins/ is byte-for-byte what was committed');
  assert.ok(!existsSync(join(s.twinsDir, 'plan.lock.json')) && !existsSync(join(s.twinsDir, '.kit-results')));
});

test('twins refuses (usage) without --release, with a malformed one, with a scenarios dir, or with bad rounds; before any session or request', async () => {
  const s = await setup();
  const clientDir = writeDir(s.root, { 'acme-fix': runScenario(s.origin) }, 'client-tests');
  const cases = {
    'no --release': [],
    'an empty --release': ['--release', ''],
    'a space in --release': ['--release', 'v1.10 520'],
    'a slash in --release': ['--release', 'release/v1.10.520'],
    'a leading dot in --release': ['--release', '.v1.10.520'],
    'a client scenarios dir': ['--release', RELEASE, '--scenarios-dir', clientDir],
    'zero rounds': ['--release', RELEASE, '--rounds', '0'],
    'rounds in words': ['--release', RELEASE, '--rounds', 'two'],
  };
  for (const [what, args] of Object.entries(cases)) {
    const child = await twins(s, [...args, '--json']);
    const out = json(child, `twins --json, ${what}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'twins', code: 'usage' }, what);
    assert.equal(child.status, 2, `${what}: exit ${child.status}`);
  }
  assert.deepEqual(s.claude.sessions(), [], 'no session');
  assert.deepEqual(s.claude.versions(), [], 'the binary was not even asked its version');
  assert.deepEqual(s.gateway.requests, [], 'no request');
  assert.deepEqual(snapshot(s.twinsDir), s.before);
  assert.ok(!existsSync(join(clientDir, 'plan.lock.json')), 'a client dir is never frozen by twins');
});

test('twins needs the kit\'s own bench key and an admin key before it starts anything', async () => {
  const s = await setup();
  for (const [name, code] of [['ANYRAY_BENCH_CLIENT_KEY', 'bench_key_missing'], ['ANYRAY_ADMIN_KEY', 'admin_key_missing']]) {
    const env = { ...s.env };
    delete env[name];
    const child = await twins(s, ['--release', RELEASE, '--json'], env);
    const out = json(child, `twins --json without ${name}`);
    assert.deepEqual({ ok: out.ok, command: out.command, code: out.code }, { ok: false, command: 'twins', code }, name);
    assert.equal(child.status, 2);
  }
  assert.deepEqual(s.claude.sessions(), [], 'no session');
  assert.deepEqual(s.claude.versions(), [], 'the keys are checked before the binary is even asked its version');
  assert.deepEqual(s.gateway.requests, [], 'no request');
  assert.deepEqual(snapshot(s.twinsDir), s.before);
});

// ---- the committed twins/ ---------------------------------------------------------------------------

const TWINS = join(KIT_ROOT, 'twins');
const twinIds = () => (existsSync(TWINS) ? readdirSync(TWINS).filter((id) => !id.startsWith('.') && existsSync(join(TWINS, id, 'scenario.yaml'))) : []);
const twinDoc = (id) => yaml.load(readFileSync(join(TWINS, id, 'scenario.yaml'), 'utf8'));

test('the committed twins/ freezes with the real kit, and every twin is a proposed scenario on a public GitHub repo', (t) => {
  const ids = twinIds();
  assert.ok(ids.length >= 1, `${TWINS} holds at least one twin`);
  const copy = join(tempDir(t, 'kit-twins-real-'), 'twins');
  cpSync(TWINS, copy, { recursive: true });
  const { out } = freezeOk(t, copy);
  assert.deepEqual(out.scenarios.map((x) => x.id).sort(), [...ids].sort());
  for (const id of ids) {
    const doc = twinDoc(id);
    assert.equal(doc.source, 'proposed', `${id}: a twin is our public scenario`);
    const url = new URL(doc.repo.git);
    assert.deepEqual({ protocol: url.protocol, hostname: url.hostname }, { protocol: 'https:', hostname: 'github.com' }, `${id}: a public repo`);
  }
});

test('the seed twin is a one-turn lint fix on gin, graded by a check, with a patch that plants the findings', () => {
  const file = join(TWINS, 'gin-lint-fix', 'scenario.yaml');
  assert.ok(existsSync(file), `${file} is the seed twin`);
  const doc = twinDoc('gin-lint-fix');
  assert.equal(doc.repo.git, 'https://github.com/gin-gonic/gin.git');
  assert.match(String(doc.repo.ref), /^[0-9a-f]{40}$/);
  assert.deepEqual(shapeFeatures(doc, 'claude-code'), { client: 'claude-code', cacheMarkers: 'client', mcp: 'none', requests: 'single', pause: false, outcome: 'check' });
  assert.ok(scenarioPatches(doc).length >= 1, 'a patch plants the lint findings');
});

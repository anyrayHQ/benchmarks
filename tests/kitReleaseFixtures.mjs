// Shared inputs for the release-rerun tests (ANY-1491): the client regression template
// (kit/workflows/anyray-regression.yml) parsed into the pieces the tests pin, a shell runner for
// one of its `run:` steps, a fake gateway that also answers the client-tests READ the template's
// version check makes, stored results as that route returns them, a public twin scenario, and the
// gateway's client-tests body schema WITH the optional `twinOf` the monorepo half adds.
// Everything is synthetic: nothing reaches a real gateway, a provider or a Claude session.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { KIT_ROOT } from './kitFixtures.mjs';
import { ADMIN_KEY } from './kitPlanFixtures.mjs';
import { GATEWAY_VERSION, PUBLISHED_ID, clientTestBodySchema } from './kitRunFixtures.mjs';

export const TEMPLATE = join(KIT_ROOT, 'kit', 'workflows', 'anyray-regression.yml');
export const KIT_REPOSITORY = 'anyrayHQ/benchmarks';
export const RUNNER = "vars.ANYRAY_TEST_RUNNER || 'ubuntu-latest'";

/** Two client plan hashes a twin can stand in for (synthetic, lowercase hex, 64 chars). */
export const TWIN_OF = '7a1c'.repeat(16);
export const TWIN_OF_2 = '5e3d'.repeat(16);
/** Another client's plan, whose results must never count for this one. */
export const OTHER_PLAN = '9b2f'.repeat(16);
/** In every error body the fake gateway sends: a refusal must never print the server's answer. */
export const SERVER_MARK = 'ZQX-SERVER-ANSWER-4490';

// ---- the gateway body, once the monorepo half adds twinOf ---------------------------------------

// The ONE change ANY-1491 asks of the gateway's clientTestResultSchema (tests/kitRunFixtures.mjs keeps
// the current schema): an optional `twinOf` on a scenario, a client planHash, never the 64-zero
// placeholder. Everything else stays strict.
const twinOf = z.string().min(1).regex(/^[0-9a-f]{64}$/).refine((h) => !/^0{64}$/.test(h));
const scenarioWithTwin = clientTestBodySchema.shape.scenarios.element.extend({ twinOf: twinOf.optional() });
export const twinBodySchema = clientTestBodySchema.extend({ scenarios: z.array(scenarioWithTwin).min(1).max(50) });

/** Parse with the gateway's schema plus `twinOf`; a failure names the paths (never the values). */
export function assertTwinBody(body, what) {
  const r = twinBodySchema.safeParse(body);
  assert.ok(r.success, `${what}: the gateway (with twinOf) would refuse this body: ${r.success ? '' : JSON.stringify(r.error.issues.map((i) => ({ path: i.path, code: i.code })))}`);
  return r.data;
}

// ---- scenarios ----------------------------------------------------------------------------------

/**
 * A public twin: `source: proposed`, standing in for the client plan `twinOf`, one user turn,
 * graded by a check that passes against `origin` (tests/kitRunFixtures.mjs originRepo, or any
 * `{ git, ref, patchText }`).
 */
export function twinScenario(origin, over = {}) {
  return {
    doc: {
      title: 'Lint fix',
      source: 'proposed',
      twinOf: TWIN_OF,
      repo: { git: origin.git, ref: origin.ref },
      patch: 'lint.patch',
      task: 'The lint step is red. Fix every finding in the library code.',
      check: 'cat check-out.log',
      maxTurns: 80,
      timeoutMin: 2,
      ...over,
    },
    files: { 'lint.patch': origin.patchText },
  };
}

// ---- the template -----------------------------------------------------------------------------

/** The template's text and its parsed document; a clear failure while it does not exist. */
export function loadTemplate() {
  assert.ok(existsSync(TEMPLATE), `${TEMPLATE} does not exist: the client regression template ships in the kit`);
  const text = readFileSync(TEMPLATE, 'utf8');
  const doc = yaml.load(text);
  assert.ok(doc && typeof doc === 'object' && !Array.isArray(doc), 'the template parses to a mapping');
  assert.ok(doc.jobs && typeof doc.jobs === 'object', 'the template has jobs');
  return { text, doc };
}

/** `${{ x }}` -> `x`, whitespace runs collapsed (so a pin compares the expression, not its spacing). */
export const expr = (s) => (typeof s === 'string' ? s.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim().replace(/\s+/g, ' ') : s);

/** Every string value under `node`, with its key path (array indexes as numbers). */
export function strings(node, path = []) {
  if (typeof node === 'string') return [{ path, value: node }];
  if (Array.isArray(node)) return node.flatMap((v, i) => strings(v, [...path, i]));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
}

/** A job's steps (a clear failure when the job is missing). */
export function stepsOf(doc, job) {
  const steps = doc.jobs?.[job]?.steps;
  assert.ok(Array.isArray(steps), `job ${job} has steps`);
  return steps;
}

/** A one-line shell command as words: quotes and `${}` braces dropped (enough for the template's commands). */
export const words = (cmd) => String(cmd ?? '').replace(/["']/g, '').replace(/[{}]/g, '').trim().split(/\s+/).filter(Boolean);

/** The kit script a step runs (`npm run [-s|--silent] <script> -- ...`), or null. */
export function kitScript(step) {
  if (typeof step?.run !== 'string') return null;
  const w = words(step.run);
  const i = w.indexOf('npm');
  if (i < 0 || w[i + 1] !== 'run') return null;
  let j = i + 2;
  while (w[j] === '-s' || w[j] === '--silent') j++;
  return w[j] ?? null;
}

/** Every step of `job` that runs a kit script, in order: { script, step, index, words }. */
export const kitSteps = (doc, job) => stepsOf(doc, job)
  .map((step, index) => ({ script: kitScript(step), step, index, words: words(step.run) }))
  .filter((s) => s.script !== null);

/** The checkout steps of `job`: { step, index }. */
export const checkouts = (doc, job) => stepsOf(doc, job)
  .map((step, index) => ({ step, index }))
  .filter(({ step }) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));

/** The value `name` has for a step: its own env, else the job's, else the workflow's. */
export const envFor = (doc, job, step, name) => step.env?.[name] ?? doc.jobs[job].env?.[name] ?? doc.env?.[name];

/**
 * Run one step's `run:` the way GitHub runs it on Linux (bash --noprofile --norc -eo pipefail)
 * in `cwd`, with exactly `env` (PATH defaults to node's directory plus the system bins).
 */
export function runStep(step, env, cwd) {
  assert.equal(typeof step?.run, 'string', 'the step has a run script');
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
    cwd,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

/** The `name=value` lines a step appended to its $GITHUB_OUTPUT file (empty when it wrote none). */
export function outputLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// ---- the fake gateway ----------------------------------------------------------------------------

/**
 * A client-tests result as GET /admin/v1/client-tests returns it (ANY-1488): the content-free body
 * plus the server's `id` and `receivedAt`. Only planHash, gatewayVersion, releaseTag and receivedAt
 * matter to a version check; the rest is a valid body.
 */
export function storedResult(planHash, gatewayVersion, receivedAt, id = PUBLISHED_ID) {
  return {
    planHash,
    kitVersion: '0.1.0',
    benchmarksCommit: 'a'.repeat(40),
    gatewayVersion,
    releaseTag: `v${gatewayVersion}`,
    clientTool: 'claude-code',
    clientToolVersion: '2.1.300',
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    scenarios: [{
      shapeId: 'unknown', source: 'client', predictedBand: { kind: 'none' }, n: 8, excluded: 0,
      winRate: 0.75, median: 0.8, q3: 0.9, max: 1.1, ci95: { lower: 0.7, upper: 0.95 }, verdict: 'pass',
    }],
    totals: { n: 8, excluded: 0, costUsdPerSession: { direct: 1, anyray: 0.8 } },
    rule0Verdict: 'PASS',
    id,
    receivedAt,
  };
}

/**
 * An HTTP server on 127.0.0.1 standing in for the gateway a version check reads:
 * GET /admin/v1/settings/updates -> { version } (or `versionStatus`), GET /admin/v1/client-tests ->
 * { results } (or `resultsStatus`), POST /admin/v1/client-tests -> 201. Admin routes need the
 * synthetic admin key. `state.results` may be set after the plan is frozen (results name its hash).
 * Records method, path, query and authorization of every request. Error bodies carry SERVER_MARK.
 */
export async function fakeReleaseGateway({ version = GATEWAY_VERSION, versionStatus = 200, results = [], resultsStatus = 200 } = {}) {
  const requests = [];
  const state = { results };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null });
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const failure = (code) => send(code, { status: 'failure', message: `refused ${SERVER_MARK}` });
      if (req.headers.authorization !== `Bearer ${ADMIN_KEY}`) return failure(401);
      if (req.method === 'GET' && url.pathname === '/admin/v1/settings/updates') {
        return versionStatus === 200 ? send(200, { version, updateMethod: 'compose', hasApplier: false, update: null }) : failure(versionStatus);
      }
      if (req.method === 'GET' && url.pathname === '/admin/v1/client-tests') {
        return resultsStatus === 200 ? send(200, { results: state.results }) : failure(resultsStatus);
      }
      if (req.method === 'POST' && url.pathname === '/admin/v1/client-tests') return send(201, { result: { id: PUBLISHED_ID } });
      return failure(404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** The kit's package.json scripts (the real kit). */
export const kitScripts = () => JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).scripts ?? {};

// Shared inputs for the plan tests (ANY-1486): the CLIs spawned without blocking this process
// (so a fake gateway here can answer them), a fake gateway that serves the session-gate read,
// a copy of the kit with a test catalog, scenario builders for each shape feature, and the
// power formula written out independently of lib/benchVerdict.mjs. Everything is synthetic:
// nothing reaches a real gateway, a provider or a Claude session.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { KIT_ROOT, REF, kitEnv, tempDir } from './kitFixtures.mjs';

export const ADMIN_KEY = 'aak_synthetic-plan-0001';
export const SHAPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX40 = /^[0-9a-f]{40}$/;

// ---- the formula, written out here so the library is checked, not copied --------------------

export const PRIOR_SD = 0.924;
export const MIN_PUBLIC_ROUNDS = 8;
/** z(0.975) + z(0.80), exact: with the rounded 1.96 + 0.84 the 10% rung is 603, not 604. */
export const Z_SUM = 1.959963984540054 + 0.8416212335729143;
export const formulaPairs = (target, sd = PRIOR_SD) => (target === 1 ? null : Math.ceil(((Z_SUM * sd) / Math.abs(Math.log(target))) ** 2));
export const formulaDetectable = (pairs, sd = PRIOR_SD) => (pairs < 2 ? null : Math.exp(-(Z_SUM * sd) / Math.sqrt(pairs)));

// ---- shape features ---------------------------------------------------------------------------

export const FEATURES = {
  client: ['claude-code', 'codex'],
  cacheMarkers: ['client', 'none'],
  mcp: ['none', 'some', 'many'],
  requests: ['short', 'single', 'medium', 'long'],
  pause: [true, false],
  outcome: ['check', 'citations', 'keyFacts'],
};

/** The first catalog shape whose every match key equals the feature (the catalog's order decides). */
export const firstShape = (catalog, features) => catalog.shapes.find((s) => Object.entries(s.match).every(([k, v]) => features[k] === v)) ?? null;

/** What a scenario matched to `shape` must be predicted as. */
export function expectedPrediction(shape) {
  if (!shape) return { status: 'none', reason: 'unknown_shape' };
  if (shape.rounds < MIN_PUBLIC_ROUNDS) return { status: 'none', reason: 'too_few_rounds', rounds: shape.rounds };
  return { status: 'band', expect: shape.expect, lo: shape.band.lo, hi: shape.band.hi, rounds: shape.rounds };
}

/**
 * A valid scenario with the given shape. requests: short = a turn cap of 6 (with a follow-up,
 * so a short session can pause); single = one turn under a cap of 80; medium = one follow-up;
 * long = three follow-ups. pause = 360 s before each follow-up. mcp: none/some/many = no
 * mcpTools, 10, 200.
 */
export function shapeScenario({ requests = 'single', pause = false, mcp = 'none', outcome = 'check' } = {}, over = {}) {
  const doc = {
    title: 'Shape probe',
    source: 'client',
    repo: { git: 'https://git.example.test/acme/app.git', ref: REF },
    task: 'Do the probe task.',
    maxTurns: 80,
    timeoutMin: 10,
  };
  if (requests === 'short') Object.assign(doc, { maxTurns: 6, followups: ['Then the next step.'] });
  if (requests === 'medium') doc.followups = ['Then the next step.'];
  if (requests === 'long') doc.followups = ['Step two.', 'Step three.', 'Step four.'];
  if (pause) {
    assert.ok(doc.followups, `a pause needs a follow-up (requests: ${requests})`);
    doc.followupDelaySec = 360;
  }
  const tools = { none: undefined, some: 10, many: 200 }[mcp];
  if (tools !== undefined) doc.mcpTools = tools;
  if (outcome === 'check') doc.check = 'node --test';
  else if (outcome === 'citations') doc.citations = { min: 3, resolveRate: 0.9 };
  else doc.keyFacts = ['dispatch', 'router.js'];
  return { doc: { ...doc, ...over }, files: {} };
}

/** Every feature combination a kit scenario can have (a pause needs a follow-up): 63 scenarios. */
export function shapeGrid() {
  const scenarios = {};
  const turns = [['short', false], ['short', true], ['single', false], ['medium', false], ['medium', true], ['long', false], ['long', true]];
  for (const [requests, pause] of turns) {
    for (const mcp of FEATURES.mcp) {
      for (const outcome of FEATURES.outcome) {
        scenarios[`g-${requests}-${pause ? 'p' : 'n'}-${mcp}-${outcome.toLowerCase()}`] = shapeScenario({ requests, pause, mcp, outcome });
      }
    }
  }
  return scenarios;
}

// ---- spawning without blocking ---------------------------------------------------------------

/** spawn and collect; resolves (never rejects) with { status, signal, stdout, stderr }. */
export function spawnAsync(cmd, args, { env, cwd = KIT_ROOT, timeout = 90_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.code ?? error.name}` }); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

/** The env a plan run gets: ANY-1485's minimal env plus an admin key (synthetic). */
export const planEnv = (t, extra = {}) => kitEnv(tempDir(t, 'kit-home-'), { ANYRAY_ADMIN_KEY: ADMIN_KEY, ...extra });

/** `node <kitRoot>/tools/kit.mjs <args>` (the real kit unless `kitRoot` names a copy). */
export const kitAsync = (t, args, { kitRoot = KIT_ROOT, env, cwd } = {}) =>
  spawnAsync(process.execPath, [join(kitRoot, 'tools', 'kit.mjs'), ...args], { env: env ?? planEnv(t), cwd: cwd ?? kitRoot });

/** `node tools/kit.mjs plan --scenarios-dir <dir> --gateway <url> <args>` */
export const planRun = (t, dir, gateway, args = [], opts = {}) =>
  kitAsync(t, ['plan', '--scenarios-dir', dir, '--gateway', gateway.url, ...args], opts);

/** `npm --prefix <kit> run -s <script> -- <args>`, from `cwd` (so INIT_CWD is `cwd`). */
export const npmRunAsync = (t, script, args, { kitRoot = KIT_ROOT, env, cwd }) =>
  spawnAsync('npm', ['--prefix', kitRoot, 'run', '-s', script, '--', ...args], { env: env ?? planEnv(t), cwd });

// ---- the fake gateway --------------------------------------------------------------------------

/** One row of GET /admin/v1/optimizer/session-gate, shaped as the gateway's OpenAPI has it. */
export function gateRow(kind, state, override = null) {
  const effectiveState = override === 'force_on' ? 'on' : override === 'force_off' ? 'off' : state;
  return {
    tenant: 'acme', kind, state, override, failedEvaluations: 0, lastEvaluation: null, revision: 1,
    updatedAt: '2026-10-20T00:00:00.000Z', evidenceSince: '2026-10-01T00:00:00.000Z',
    effectiveState, stateLabel: state, evidenceStatus: 'available', enabled: true,
  };
}

/** A tenant that applies something: one kind on, one in shadow, one off. */
export const APPLYING = [gateRow('observation_mask', 'on'), gateRow('relevance_filter', 'shadow'), gateRow('window_budget', 'off')];
/** A new tenant on a deployment that already had traffic: every gated kind still in shadow. */
export const ALL_SHADOW = ['observation_mask', 'relevance_filter', 'window_budget', 'code_graph'].map((k) => gateRow(k, 'shadow'));

/**
 * An HTTP server on 127.0.0.1 that answers the session-gate read (and the optimizer config read)
 * and records every request: method, path, query and the authorization header.
 * `status` / `body` override the session-gate answer.
 */
export async function fakeGateway(t, { strategies = APPLYING, tenant = 'acme', status = 200, body } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null });
    let code = 200;
    let payload;
    if (url.pathname === '/admin/v1/optimizer/session-gate') {
      code = status;
      payload = body !== undefined ? body
        : status === 200 ? { tenant, settings: { evaluatorEnabled: true, measurementFraction: 0.05 }, strategies }
          : { error: { message: 'forbidden', type: 'forbidden' } };
    } else if (url.pathname === '/admin/v1/optimizer') {
      payload = { config: { strategies: [] }, overrides: null };
    } else {
      code = 404;
      payload = { error: { message: 'not found' } };
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// ---- a kit copy with its own catalog -----------------------------------------------------------

const git = (cwd, args) => {
  const child = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(child.status, 0, `git ${args.join(' ')} failed in the kit copy: ${child.stderr}`);
  return child.stdout.trim();
};

/** The commit a kit checkout is at. */
export const gitHead = (root) => git(root, ['rev-parse', 'HEAD']);

/**
 * A copy of the kit (lib/, tools/, config.yaml, package.json, node_modules linked) whose
 * predictions.yaml is `catalogText`, committed in its own git repo, so the planner reads a
 * catalog the test controls and `benchmarksCommit` is that repo's HEAD.
 */
export function kitCopy(t, catalogText = TEST_CATALOG) {
  const root = tempDir(t, 'kit-copy-');
  for (const dir of ['lib', 'tools']) cpSync(join(KIT_ROOT, dir), join(root, dir), { recursive: true });
  for (const file of ['config.yaml', 'package.json']) cpSync(join(KIT_ROOT, file), join(root, file));
  symlinkSync(join(KIT_ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'predictions.yaml'), catalogText);
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'kit copy for a plan test']);
  return { root, head: gitHead(root), recommit: (text) => { writeFileSync(join(root, 'predictions.yaml'), text); git(root, ['commit', '-q', '-am', 'catalog changed']); return gitHead(root); } };
}

/** The real kit's committed catalog, parsed; a clear failure while it does not exist. */
export function readCatalog(root = KIT_ROOT) {
  const file = join(root, 'predictions.yaml');
  assert.ok(existsSync(file), `${file} does not exist: the shape catalog is committed at the kit root`);
  return yaml.load(readFileSync(file, 'utf8'));
}

/**
 * The catalog the kit-copy tests plan against. Order matters (first match wins):
 * a 200-tool seat matches t-mcp-many before t-cc-check-long. Midpoints: 0.8 -> 135 pairs,
 * 0.9 -> 604, 0.7 -> 53 (the ANY-350 ladder), 1 -> none (parity centred on 1).
 */
export const TEST_SHAPES = [
  { id: 't-mcp-many', match: { mcp: 'many' }, expect: 'saving', band: { lo: 0.2, hi: 0.3 }, rounds: 12 },
  { id: 't-cc-check-long', match: { client: 'claude-code', outcome: 'check', requests: 'long' }, expect: 'saving', band: { lo: 0.75, hi: 0.85 }, rounds: 9 },
  { id: 't-cc-short', match: { client: 'claude-code', requests: 'short' }, expect: 'parity', band: { lo: 0.85, hi: 0.95 }, rounds: 20 },
  { id: 't-cc-medium-pause', match: { client: 'claude-code', requests: 'medium', pause: true }, expect: 'saving', band: { lo: 0.6, hi: 0.8 }, rounds: 8 },
  { id: 't-docs-few', match: { client: 'claude-code', outcome: 'citations' }, expect: 'saving', band: { lo: 0.3, hi: 0.5 }, rounds: 7 },
  { id: 't-codex-parity', match: { client: 'codex' }, expect: 'parity', band: { lo: 0.9, hi: 1.1 }, rounds: 8 },
].map((s) => ({ ...s, source: 'synthetic test catalog' }));
export const TEST_CATALOG = yaml.dump({ version: 1, shapes: TEST_SHAPES });

/**
 * One scenario per interesting test shape (claude-code unless noted):
 * check-long -> t-cc-check-long (135 pairs), short-task -> t-cc-short (604, parity),
 * paused -> t-cc-medium-pause (53), mcp-check-long -> t-mcp-many (first match wins),
 * docs -> t-docs-few (7 rounds: none), facts -> no shape (none).
 */
export const shapedScenarios = () => ({
  'check-long': shapeScenario({ requests: 'long', outcome: 'check' }),
  'short-task': shapeScenario({ requests: 'short', outcome: 'keyFacts' }),
  paused: shapeScenario({ requests: 'medium', pause: true, outcome: 'keyFacts' }),
  'mcp-check-long': shapeScenario({ requests: 'long', outcome: 'check', mcp: 'many' }),
  docs: shapeScenario({ requests: 'single', outcome: 'citations' }),
  facts: shapeScenario({ requests: 'single', outcome: 'keyFacts' }),
});

const clip = (s) => JSON.stringify(String(s ?? '').slice(0, 400));

/** stdout parsed as exactly one JSON value; a clear assertion failure otherwise. */
export function json(child, what) {
  try {
    return JSON.parse(child.stdout);
  } catch {
    return assert.fail(`${what}: stdout is not exactly one JSON value (exit ${child.status}); stdout=${clip(child.stdout)} stderr=${clip(child.stderr)}`);
  }
}

/** A successful plan answer, or a failure that says what came back instead. */
export function planOk(child, what) {
  const out = json(child, what);
  assert.equal(out.ok, true, `${what}: plan refused: ${clip(child.stdout)} ${clip(child.stderr)}`);
  assert.equal(child.status, 0, `${what}: exit ${child.status}`);
  assert.ok(Array.isArray(out.scenarios), `${what}: the answer has no scenarios list`);
  return out;
}

export const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

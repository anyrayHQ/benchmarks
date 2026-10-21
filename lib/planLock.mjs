// Portable frozen plans: content is hashed locally; only the keyed plan identifier leaves.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { fillPastes } from './scenarioPastes.mjs';
import { scenarioPatches } from './agentRun.mjs';
import { classify, loadCatalog, predictionValid, SHAPE_ID } from './planner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SOURCES = ['client', 'proposed'];
const PIN_KEYS = ['model', 'provider', 'client', 'clientVersion', 'gatewayHost'];
const nonempty = (s) => typeof s === 'string' && s.trim().length > 0;
const keysAre = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');

export class PlanError extends Error {
  constructor(code, fields = {}, message = code.replaceAll('_', ' ')) {
    super(message);
    this.code = code;
    this.fields = fields;
    this.exitCode = code === 'usage' || code === 'pin_missing' ? 2 : code.startsWith('plan_') ? 3 : 4;
  }
}

export const resolveScenariosDir = (path, env = process.env) => resolve(env.INIT_CWD || process.cwd(), path);
export const gatewayHost = (url) => {
  try { return new URL(url).host || null; } catch { return null; }
};

// Read only the settings here: loadConfig also resolves credentials, which must wait for the gate.
export function runDefaults(env = process.env) {
  const run = parseYaml(readFileSync(join(ROOT, 'config.yaml'), 'utf8')).run ?? {};
  return { model: env.ANYRAY_LIVE_MODEL || run.model, gateway: env.ANYRAY_GATEWAY_URL || run.gateway_url };
}

export function canon(x) {
  const sorted = (v) => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sorted(v[k])]));
    return v;
  };
  return JSON.stringify(sorted(x));
}
const hmac = (nonce, value) => createHmac('sha256', Buffer.from(nonce, 'hex')).update(canon(value)).digest('hex');
const planHash = (nonce, pins, benchmarksCommit, scenarios, predictions) => hmac(nonce, { version: 1, pins, benchmarksCommit, scenarios, predictions });
const invalid = (id, field) => { throw new PlanError('scenario_invalid', { scenario: id, field }); };

export function benchmarksCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const commit = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit ?? '')) throw new PlanError('pin_missing', { pin: 'benchmarksCommit' });
  return commit;
}

function discover(dir, validate) {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    if (validate) throw new PlanError('scenarios_dir_not_found');
    return [];
  }
  const ids = readdirSync(dir).filter((id) => {
    if (id.startsWith('.')) return false;
    const path = join(dir, id);
    const stat = lstatSync(path);
    return (stat.isDirectory() || stat.isSymbolicLink()) && existsSync(join(path, 'scenario.yaml'));
  }).sort();
  if (validate && !ids.length) throw new PlanError('scenarios_empty');
  return ids;
}

function bundle(dir, id, validate) {
  if (validate && !ID.test(id)) invalid(id, 'id');
  const base = join(dir, id);
  const files = {};
  // Inspect hidden entries for symlinks too, but keep their bytes out of the bundle.
  const walk = (path, hidden = false) => {
    const stat = lstatSync(path);
    const rel = relative(base, path).split(sep).join('/');
    if (stat.isSymbolicLink()) {
      if (validate) invalid(id, 'files');
      files[rel || '.'] = 'symlink';
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), hidden || name.startsWith('.'));
    } else if (stat.isFile() && !hidden && rel !== 'scenario.yaml') {
      files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(base);
  const yamlFile = join(base, 'scenario.yaml');
  let scenario;
  try { scenario = parseYaml(readFileSync(yamlFile, 'utf8')); }
  catch {
    if (validate) invalid(id, 'files');
    // Unparseable YAML is still content, and must produce a changed 64-hex hash.
    scenario = readFileSync(yamlFile).toString('hex');
  }
  if (validate) {
    if (!SOURCES.includes(scenario?.source)) invalid(id, 'source');
    if (!nonempty(scenario.repo?.git) || !/^[0-9a-f]{40}$/.test(scenario.repo?.ref ?? '')) invalid(id, 'repo');
    if (!nonempty(scenario.task)) invalid(id, 'task');
    if (['check', 'citations', 'keyFacts'].filter((key) => Object.hasOwn(scenario, key)).length !== 1) invalid(id, 'grading');
    const checkFile = (file, field) => {
      if (!nonempty(file) || isAbsolute(file) || file.split(/[\\/]/).some((part) => part.startsWith('.')) || !Object.hasOwn(files, file)) invalid(id, field);
    };
    if (scenario.mcpTools !== undefined && (!Number.isInteger(scenario.mcpTools) || scenario.mcpTools < 0)) invalid(id, 'mcpTools');
    for (const patch of scenarioPatches(scenario)) checkFile(patch, 'patch');
    if (scenario.pastes != null) {
      if (typeof scenario.pastes !== 'object' || Array.isArray(scenario.pastes)) invalid(id, 'pastes');
      for (const file of Object.values(scenario.pastes)) checkFile(file, 'pastes');
    }
    try { fillPastes(scenario, (file) => readFileSync(join(base, file), 'utf8')); }
    catch { invalid(id, 'pastes'); }
  }
  return { id, source: scenario?.source ?? null, scenario, files };
}

export function validatedScenarios(dir) {
  return discover(dir, true).map((id) => bundle(dir, id, true));
}

function scenarioHashes(dir, nonce, validate = false) {
  return discover(dir, validate).map((id) => {
    const value = bundle(dir, id, validate);
    return { id, source: value.source, hash: hmac(nonce, value) };
  });
}

function schema(lock) {
  return keysAre(lock, ['version', 'algorithm', 'nonce', 'planHash', 'frozenAt', 'pins', 'benchmarksCommit', 'scenarios', 'predictions']) &&
    lock.version === 1 && lock.algorithm === 'hmac-sha256' && HEX.test(lock.nonce) && HEX.test(lock.planHash) &&
    typeof lock.frozenAt === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(lock.frozenAt) && Number.isFinite(Date.parse(lock.frozenAt)) &&
    keysAre(lock.pins, PIN_KEYS) && PIN_KEYS.every((pin) => nonempty(lock.pins[pin])) &&
    ['anthropic', 'bedrock'].includes(lock.pins.provider) && ['claude-code', 'codex'].includes(lock.pins.client) &&
    Array.isArray(lock.scenarios) && lock.scenarios.length > 0 && lock.scenarios.every((s, i) =>
      keysAre(s, ['id', 'source', 'hash']) && ID.test(s.id) && SOURCES.includes(s.source) && HEX.test(s.hash) &&
      (i === 0 || lock.scenarios[i - 1].id < s.id)) &&
    typeof lock.benchmarksCommit === 'string' && /^[0-9a-f]{40}$/.test(lock.benchmarksCommit) &&
    Array.isArray(lock.predictions) && lock.predictions.length === lock.scenarios.length && lock.predictions.every((p, i) =>
      keysAre(p, ['id', 'shapeId', 'prediction']) && p.id === lock.scenarios[i].id &&
      (p.shapeId === null || (typeof p.shapeId === 'string' && SHAPE_ID.test(p.shapeId))) && predictionValid(p.prediction));
}

function readLock(dir) {
  const lockFile = join(dir, 'plan.lock.json');
  let lock;
  try { lock = JSON.parse(readFileSync(lockFile, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') throw new PlanError('plan_lock_missing', { lockFile });
    throw new PlanError('plan_lock_invalid', { lockFile, reason: 'unreadable' });
  }
  if (!schema(lock)) throw new PlanError('plan_lock_invalid', { lockFile, reason: 'schema' });
  if (planHash(lock.nonce, lock.pins, lock.benchmarksCommit, lock.scenarios, lock.predictions) !== lock.planHash) throw new PlanError('plan_lock_invalid', { lockFile, reason: 'self_hash' });
  return lock;
}

export function verifyPlan(dir) {
  const lock = readLock(dir);
  let scenarios;
  try { scenarios = scenarioHashes(dir, lock.nonce); }
  catch { throw new PlanError('plan_lock_invalid', { lockFile: join(dir, 'plan.lock.json'), reason: 'unreadable' }); }
  const found = planHash(lock.nonce, lock.pins, lock.benchmarksCommit, scenarios, lock.predictions);
  if (found !== lock.planHash) {
    const before = new Map(lock.scenarios.map((s) => [s.id, s.hash]));
    const after = new Map(scenarios.map((s) => [s.id, s.hash]));
    throw new PlanError('plan_hash_mismatch', {
      expected: lock.planHash, found,
      changed: [...before.keys()].filter((id) => after.has(id) && after.get(id) !== before.get(id)),
      added: [...after.keys()].filter((id) => !before.has(id)),
      removed: [...before.keys()].filter((id) => !after.has(id)),
    }, `expected ${lock.planHash}, found ${found}`);
  }
  return lock;
}

export function freezePlan(dir, pins, replace = false) {
  const lockFile = join(dir, 'plan.lock.json');
  const old = existsSync(lockFile) ? readLock(dir) : null;
  if (old && !replace) throw new PlanError('plan_lock_exists', { lockFile, planHash: old.planHash });
  const nonce = randomBytes(32).toString('hex');
  const bundles = validatedScenarios(dir);
  const catalog = loadCatalog();
  const commit = benchmarksCommit();
  const scenarios = bundles.map((value) => ({ id: value.id, source: value.source, hash: hmac(nonce, value) }));
  const predictions = bundles.map(({ id, scenario }) => {
    const { shapeId, prediction } = classify(scenario, pins.client, catalog);
    return { id, shapeId, prediction };
  });
  // An explicit allowlist: neither the bundles nor their file digests belong in the lock.
  const lock = { version: 1, algorithm: 'hmac-sha256', nonce, planHash: planHash(nonce, pins, commit, scenarios, predictions), frozenAt: new Date().toISOString(), pins, benchmarksCommit: commit, scenarios, predictions };
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n', { flag: replace ? 'w' : 'wx', mode: 0o600 });
  return { ...planAnswer('freeze', lock), lockFile, ...(old ? { replaces: old.planHash } : {}) };
}

export function assertPlanPin(lock, pin, found) {
  if (lock.pins[pin] !== found) throw new PlanError('plan_pin_mismatch', { pin, expected: lock.pins[pin], found: found ?? null });
}

export const planAnswer = (command, value) => value instanceof PlanError
  ? { ok: false, command, code: value.code, message: value.message, ...value.fields }
  : { ok: true, command, planHash: value.planHash, scenarios: value.scenarios.map(({ id, source }) => ({ id, source })), pins: value.pins, benchmarksCommit: value.benchmarksCommit, predictions: value.predictions };

export function printPlanAnswer(answer, json, write = process.stdout.write.bind(process.stdout)) {
  if (json) write(JSON.stringify(answer) + '\n');
  else if (answer.ok) write(`${answer.command}: ${answer.planHash}\n`);
  else console.error(`${answer.code}: ${answer.message}`);
}

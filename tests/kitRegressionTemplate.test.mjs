// kit/workflows/anyray-regression.yml (ANY-1491): the GitHub Actions workflow a client copies into
// THEIR private scenarios repo, so their frozen test reruns on every gateway release without us
// holding their code. A daily check job asks the gateway what it runs and what this plan last
// published; the regression job runs only when that changed (or a human asked), with the kit at the
// commit the plan was frozen with and the Claude Code build it pinned, and publishes the
// content-free result. The rules here are the repo's workflow security rules: least privilege,
// every action on a full commit SHA, secrets only in a step's env, nothing interpolated into a
// shell line. Parsed as YAML and pinned by structure; the one inline script (the lock step) is run
// for real in bash against a lock the real kit froze.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, PINS, freezeOk, tempDir, twoScenarios, writeScenariosDir } from './kitFixtures.mjs';
import {
  KIT_REPOSITORY, RUNNER, TEMPLATE, checkouts, envFor, expr, kitScript, kitScripts, kitSteps, loadTemplate, outputLines,
  runStep, stepsOf, strings, words,
} from './kitReleaseFixtures.mjs';

const JOBS = ['check', 'regression'];
const SECRET = /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}$/;

test('the template ships in kit/workflows/ and never in this repo\'s .github/workflows/ (it must not run here)', () => {
  assert.ok(existsSync(TEMPLATE), `${TEMPLATE} is missing`);
  assert.ok(!existsSync(join(KIT_ROOT, '.github', 'workflows', 'anyray-regression.yml')), 'a copy under .github/workflows would run in this repository');
  loadTemplate();
});

test('triggers: a manual dispatch and one daily schedule; nothing a push or a pull request can start', () => {
  const { doc } = loadTemplate();
  assert.ok(doc.on && typeof doc.on === 'object' && !Array.isArray(doc.on), '`on` is a mapping of triggers');
  assert.deepEqual(Object.keys(doc.on).sort(), ['schedule', 'workflow_dispatch'], 'exactly workflow_dispatch and schedule');
  assert.ok(doc.on.workflow_dispatch == null || doc.on.workflow_dispatch.inputs === undefined, 'a dispatch takes no inputs (nothing a caller types reaches the run)');
  assert.ok(Array.isArray(doc.on.schedule) && doc.on.schedule.length === 1, 'one schedule entry');
  const cron = doc.on.schedule[0]?.cron;
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(cron));
  assert.ok(m && Number(m[1]) < 60 && Number(m[2]) < 24, `a daily cron (minute hour * * *): ${cron}`);
});

test('least privilege: contents read for the workflow, and no job widens it', () => {
  const { doc } = loadTemplate();
  assert.deepEqual(doc.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (job.permissions !== undefined) assert.deepEqual(job.permissions, { contents: 'read' }, `job ${name} must not widen permissions`);
  }
});

test('every action is pinned to a full commit SHA with its version in a comment, and no job calls a reusable workflow', () => {
  const { text, doc } = loadTemplate();
  const used = [];
  for (const [name, job] of Object.entries(doc.jobs)) {
    assert.equal(job.uses, undefined, `job ${name} calls a reusable workflow`);
    for (const step of stepsOf(doc, name)) if (step.uses !== undefined) used.push(step.uses);
  }
  assert.ok(used.some((u) => u.startsWith('actions/checkout@')) && used.some((u) => u.startsWith('actions/setup-node@')), 'checkout and setup-node are used');
  for (const u of used) assert.match(u, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/, `${u} is not pinned to a 40-hex commit`);
  const lines = text.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));
  assert.equal(lines.length, used.length, 'every `uses:` sits on its own line (block style), so its comment can be checked');
  for (const l of lines) assert.match(l, /^\s*(-\s+)?uses:\s+\S+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/, `the pinned version is named in a comment: ${l.trim()}`);
});

test('secrets reach only the steps that call the gateway or the provider, through the step\'s env, never a run line, an install, a checkout or a job', () => {
  const { doc } = loadTemplate();
  for (const { path, value } of strings(doc).filter(({ value }) => value.includes('secrets.'))) {
    const where = path.join('.');
    assert.ok(path.length === 6 && path[0] === 'jobs' && path[2] === 'steps' && path[4] === 'env', `${where}: a secret belongs in one step's env only`);
    assert.match(value, SECRET, `${where} is exactly one secret, nothing around it`);
  }
  const holders = [];
  for (const job of JOBS) {
    for (const [index, step] of stepsOf(doc, job).entries()) {
      const names = Object.entries(step.env ?? {}).filter(([, v]) => typeof v === 'string' && v.includes('secrets.')).map(([k]) => k).sort();
      if (names.length) holders.push({ job, step: kitScript(step) ?? step.id ?? step.name ?? `#${index}`, names });
    }
  }
  assert.deepEqual(holders, [
    { job: 'check', step: 'release-check', names: ['ANYRAY_ADMIN_KEY'] },
    { job: 'regression', step: 'run', names: ['ANYRAY_ADMIN_KEY', 'ANYRAY_BENCH_CLIENT_KEY', 'ANYRAY_UPSTREAM_TOKEN'] },
    { job: 'regression', step: 'publish-result', names: ['ANYRAY_ADMIN_KEY'] },
  ], 'npm ci, the Claude Code install, the checkouts, verify and report see no secret');
});

test('no expression is interpolated into a run line, and nothing reads github.event', () => {
  const { doc } = loadTemplate();
  for (const job of JOBS) {
    for (const step of stepsOf(doc, job)) {
      if (step.run !== undefined) assert.ok(!String(step.run).includes('${{'), `${job}: ${String(step.run).slice(0, 80)}: values reach a shell through env, never \${{ }}`);
    }
  }
  assert.deepEqual(strings(doc).filter(({ value }) => value.includes('github.event.')).map(({ path }) => path.join('.')), [], 'no github.event.* anywhere');
});

test('every checkout leaves no credential in the workspace (persist-credentials: false)', () => {
  const { doc } = loadTemplate();
  for (const job of JOBS) {
    const found = checkouts(doc, job);
    assert.ok(found.length >= 2, `${job}: the scenarios and the kit are checked out`);
    for (const { step } of found) assert.equal(step.with?.['persist-credentials'], false, `${job}: ${step.uses}: Claude Code runs commands in this workspace`);
  }
});

test('every job runs on the runner the client names in ANYRAY_TEST_RUNNER, ubuntu-latest by default', () => {
  const { doc } = loadTemplate();
  for (const [name, job] of Object.entries(doc.jobs)) {
    assert.match(String(job['runs-on']), /^\$\{\{[\s\S]*\}\}$/, `${name}: runs-on is an expression`);
    assert.equal(expr(job['runs-on']), RUNNER, `${name}: runs-on`);
  }
});

test('two jobs: check publishes whether the gateway changed; regression runs only then, or when a human dispatched it', () => {
  const { doc } = loadTemplate();
  assert.deepEqual(Object.keys(doc.jobs).sort(), JOBS);
  const { check, regression } = doc.jobs;
  assert.ok(stepsOf(doc, 'check').some((s) => s.id === 'release'), 'the check job has the release step');
  assert.equal(expr(check.outputs?.changed), 'steps.release.outputs.changed', 'check exposes the release step\'s answer');
  assert.ok([].concat(regression.needs ?? []).includes('check'), 'regression needs check');
  assert.equal(expr(regression.if), "github.event_name == 'workflow_dispatch' || needs.check.outputs.changed == 'true'");
});

test('the kit is checked out at the commit the plan was frozen with, read from the lock first', () => {
  const { doc } = loadTemplate();
  for (const job of JOBS) {
    const steps = stepsOf(doc, job);
    const lockAt = steps.findIndex((s) => s.id === 'lock');
    assert.ok(lockAt >= 0, `${job}: a step with id lock`);
    const found = checkouts(doc, job);
    const kit = found.filter(({ step }) => step.with?.repository === KIT_REPOSITORY);
    assert.equal(kit.length, 1, `${job}: one checkout of ${KIT_REPOSITORY}`);
    assert.equal(expr(kit[0].step.with.ref), 'steps.lock.outputs.commit', `${job}: the kit ref is the lock's benchmarksCommit`);
    assert.ok(kit[0].index > lockAt, `${job}: the lock is read before the kit is checked out`);
    const own = found.filter(({ step }) => step.with?.repository === undefined);
    assert.equal(own.length, 1, `${job}: one checkout of the workflow's own repo (the scenarios)`);
    assert.ok(own[0].index < lockAt, `${job}: the scenarios (and their lock) are checked out before the lock step`);
    const scenariosDir = envFor(doc, job, {}, 'SCENARIOS_DIR');
    assert.equal(String(scenariosDir).replace(/\$\{\{\s*github\.workspace\s*\}\}/, '$WS'), `$WS/${own[0].step.with?.path}`, `${job}: SCENARIOS_DIR is the scenarios checkout`);
  }
});

test('the kit commands: release-check in check; verify, run, report --redact, publish-result in regression; on the frozen dir, never moving the plan', () => {
  const { doc } = loadTemplate();
  const scripts = kitScripts();
  for (const job of JOBS) {
    const kitPath = checkouts(doc, job).find(({ step }) => step.with?.repository === KIT_REPOSITORY)?.step.with.path;
    assert.ok(kitPath, `${job}: the kit checkout names its path`);
    const found = kitSteps(doc, job);
    const ci = stepsOf(doc, job).findIndex((s) => { const w = words(s.run); return w.includes('npm') && w[w.indexOf('npm') + 1] === 'ci'; });
    assert.ok(ci >= 0 && ci < found[0]?.index, `${job}: npm ci runs before the kit commands`);
    assert.equal(stepsOf(doc, job)[ci]['working-directory'], kitPath, `${job}: npm ci runs in the kit`);
    for (const { script, step, words: w } of found) {
      assert.equal(step['working-directory'], kitPath, `${job} ${script}: runs in the kit checkout`);
      assert.ok(Object.hasOwn(scripts, script), `${script} is a script of the kit's package.json`);
      const at = w.indexOf('--scenarios-dir');
      assert.ok(at >= 0 && w[at + 1] === '$SCENARIOS_DIR', `${job} ${script}: --scenarios-dir "$SCENARIOS_DIR"`);
    }
    if (job === 'check') {
      assert.deepEqual(found.map((s) => s.script), ['release-check']);
      const [release] = found;
      assert.equal(release.step.id, 'release');
      assert.ok(!release.words.includes('--json'), 'release-check prints the Actions output line, not JSON');
      assert.match(release.step.run.trim(), />>\s*"?\$GITHUB_OUTPUT"?$/, 'its stdout is appended to $GITHUB_OUTPUT');
    } else {
      assert.deepEqual(found.map((s) => s.script), ['verify', 'run', 'report', 'publish-result']);
      for (const s of found) assert.ok(s.words.includes('--json'), `${s.script} --json`);
      assert.ok(found.find((s) => s.script === 'report').words.includes('--redact'), 'report --redact');
    }
  }
  for (const job of JOBS) {
    for (const step of stepsOf(doc, job)) {
      const w = words(step.run);
      assert.ok(!w.includes('--replace') && !w.some((x) => x.endsWith('kit.mjs')), `${job}: no re-freeze and no kit command outside an npm script: ${String(step.run).slice(0, 80)}`);
    }
  }
});

test('the gateway URL is a repository variable every gateway-calling step sees (not a secret, not typed into a command)', () => {
  const { doc } = loadTemplate();
  for (const [job, script] of [['check', 'release-check'], ['regression', 'run'], ['regression', 'publish-result']]) {
    const { step } = kitSteps(doc, job).find((s) => s.script === script) ?? {};
    assert.ok(step, `${job} runs ${script}`);
    assert.equal(expr(envFor(doc, job, step, 'ANYRAY_GATEWAY_URL')), 'vars.ANYRAY_GATEWAY_URL', `${job} ${script}: ANYRAY_GATEWAY_URL`);
  }
});

test('Claude Code is installed at the version the plan pinned, before the run', () => {
  const { doc } = loadTemplate();
  const steps = stepsOf(doc, 'regression');
  const runAt = kitSteps(doc, 'regression').find((s) => s.script === 'run')?.index;
  const installs = steps.map((step, index) => ({ step, index })).filter(({ step }) => {
    const v = Object.entries(step.env ?? {}).find(([, x]) => expr(x) === 'steps.lock.outputs.claude');
    if (!v) return false;
    const w = words(step.run);
    return w.includes('npm') && ['install', 'i'].includes(w[w.indexOf('npm') + 1]) && w.includes('-g') && w.includes(`@anthropic-ai/claude-code@$${v[0]}`);
  });
  assert.equal(installs.length, 1, 'one step installs @anthropic-ai/claude-code@<the lock\'s clientVersion>, read through env');
  assert.ok(installs[0].index < runAt, 'before the paired run');
});

test('the lock step hands the frozen kit commit and Claude Code version to the next steps', (t) => {
  const { doc } = loadTemplate();
  const root = tempDir(t, 'kit-template-');
  const dir = writeScenariosDir(root, twoScenarios());
  const { lock } = freezeOk(t, dir);
  for (const job of JOBS) {
    const step = stepsOf(doc, job).find((s) => s.id === 'lock');
    assert.ok(step, `${job}: a lock step`);
    assert.ok(step.shell === undefined || step.shell === 'bash', `${job}: the lock step runs in bash`);
    const out = join(root, `${job}-output`);
    const child = runStep(step, { SCENARIOS_DIR: dir, GITHUB_OUTPUT: out }, root);
    assert.equal(child.status, 0, `${job}: the lock step failed: ${child.stderr.slice(-400)}`);
    assert.deepEqual(outputLines(out).sort(), [`claude=${PINS.clientVersion}`, `commit=${lock.benchmarksCommit}`], `${job}: exactly the two outputs`);
  }
});

test('the lock step refuses a lock whose commit, version or client is not what it should be, and then writes no output at all', (t) => {
  const { doc } = loadTemplate();
  const root = tempDir(t, 'kit-template-');
  const { lock } = freezeOk(t, writeScenariosDir(root, twoScenarios()));
  const tampered = {
    'branch name': { ...lock, benchmarksCommit: 'main' },
    'commit with a command': { ...lock, benchmarksCommit: `${lock.benchmarksCommit}; touch pwned` },
    'version with a command': { ...lock, pins: { ...lock.pins, clientVersion: `${PINS.clientVersion} && touch pwned` } },
    'version that floats': { ...lock, pins: { ...lock.pins, clientVersion: 'latest' } },
    'a codex plan': { ...lock, pins: { ...lock.pins, client: 'codex' } },
  };
  const step = stepsOf(doc, 'regression').find((s) => s.id === 'lock');
  assert.ok(step, 'regression: a lock step');
  for (const [what, bad] of [...Object.entries(tampered), ['no lock', null]]) {
    const dir = join(root, what.replaceAll(' ', '-'));
    mkdirSync(dir, { recursive: true });
    if (bad) writeFileSync(join(dir, 'plan.lock.json'), `${JSON.stringify(bad, null, 2)}\n`);
    const out = join(dir, 'output');
    const child = runStep(step, { SCENARIOS_DIR: dir, GITHUB_OUTPUT: out }, dir);
    assert.notEqual(child.status, 0, `${what}: the lock step must fail`);
    assert.deepEqual(outputLines(out).filter((l) => /^(commit|claude)=/.test(l)), [], `${what}: no output line, not even the part that was valid`);
    assert.ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(root, 'pwned')), `${what}: nothing from the lock ran as a command`);
  }
});

// Shared inputs for the kit tests (kitFreeze, kitRunGate, kitGitignore): a scenarios dir
// built in a temp directory, the CLIs spawned the way a client (or the test skill) runs
// them, and a stand-in Claude Code binary that records every invocation. Everything is
// synthetic; nothing here reaches a network, a provider or a real Claude session.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT = join(KIT_ROOT, 'tools', 'kit.mjs');
export const RUN_AGENT = join(KIT_ROOT, 'run_agent.mjs');
export const LOCK = 'plan.lock.json';
export const HEX64 = /^[0-9a-f]{64}$/;

export const REF = '0123456789abcdef0123456789abcdef01234567';
export const PINS = {
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  client: 'claude-code',
  clientVersion: '2.1.300',
  gatewayHost: 'gw.example.test',
};
export const PIN_FLAGS = ['--model', PINS.model, '--provider', PINS.provider, '--client', PINS.client, '--client-version', PINS.clientVersion, '--gateway', `https://${PINS.gatewayHost}`];

export const PATCH_TEXT = [
  'diff --git a/src/lexer.js b/src/lexer.js',
  '--- a/src/lexer.js',
  '+++ b/src/lexer.js',
  '@@ -1,3 +1,3 @@',
  ' export function split(s) {',
  '-  return s.split(/\\s+/);',
  "+  return s.split(' ');",
  ' }',
  '',
].join('\n');

/** A bug-fix scenario graded by a check command, with a patch and a paste. */
export const fixScenario = (over = {}) => ({
  doc: {
    title: 'Tokenizer fix',
    source: 'client',
    repo: { git: 'https://git.example.test/acme/app.git', ref: REF },
    patch: 'bug.patch',
    pastes: { ciLog: 'ci-log.txt' },
    task: 'CI is red:\n\n{{ciLog}}\n\nFix the failing tokenizer test.',
    followups: ['List every file you changed.'],
    check: 'node --test check/lexer.test.js',
    maxTurns: 80,
    timeoutMin: 20,
    ...over,
  },
  files: { 'bug.patch': PATCH_TEXT, 'ci-log.txt': 'not ok 1 - tokenizer splits words\n' },
});

/** A codebase question graded by key facts, proposed by us. */
export const docsScenario = (over = {}) => ({
  doc: {
    title: 'Router walkthrough',
    source: 'proposed',
    repo: { git: 'https://git.example.test/acme/app.git', ref: REF },
    task: 'Explain how a request reaches its route handler.',
    keyFacts: ['dispatch', 'router.js'],
    maxTurns: 80,
    timeoutMin: 6,
    ...over,
  },
  files: {},
});

/** A temp directory removed when the test ends. */
export function tempDir(t, prefix = 'kit-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * `<parent>/<name>/<id>/scenario.yaml` (+ files) for each scenario. `yamlText` replaces
 * the dumped YAML when a test needs to control the bytes.
 */
export function writeScenariosDir(parent, scenarios, name = 'scenarios') {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  for (const [id, { doc, files = {}, yamlText }] of Object.entries(scenarios)) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scenario.yaml'), yamlText ?? yaml.dump(doc));
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  }
  return root;
}

/** The env every spawned CLI gets: nothing from the developer's shell beyond PATH. */
export function kitEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'C',
    ANYRAY_UPSTREAM_TOKEN: 'sk-synthetic-placeholder',
    ANYRAY_CLIENT_KEY: 'ark_synthetic-123456',
    ANYRAY_BENCH_REPO_CACHE: join(home, 'repo-cache'),
    ANYRAY_BENCH_SESSION_DIR: join(home, 'sessions'),
    ANYRAY_LIVE_MODEL: PINS.model,
    npm_config_update_notifier: 'false',
    ...extra,
  };
}

const spawnOpts = (t, { env, cwd }) => ({ encoding: 'utf8', env: env ?? kitEnv(tempDir(t, 'kit-home-')), cwd: cwd ?? KIT_ROOT, timeout: 90_000 });

/** `node tools/kit.mjs <args>` */
export const kit = (t, args, opts = {}) => spawnSync(process.execPath, [KIT, ...args], spawnOpts(t, opts));

/** `node run_agent.mjs <args>` */
export const runAgent = (t, args, opts = {}) => spawnSync(process.execPath, [RUN_AGENT, ...args], spawnOpts(t, opts));

/** `npm --prefix <kit> run -s <script> -- <args>`, from `cwd` (so INIT_CWD is `cwd`). */
export const npmRun = (t, script, args, opts = {}) => spawnSync('npm', ['--prefix', KIT_ROOT, 'run', '-s', script, '--', ...args], spawnOpts(t, opts));

const clip = (s) => JSON.stringify(String(s ?? '').slice(0, 400));

/** stdout parsed as exactly one JSON value; a clear assertion failure otherwise. */
export function onlyJson(child, what) {
  try {
    return JSON.parse(child.stdout);
  } catch {
    return assert.fail(`${what}: stdout is not exactly one JSON value (exit ${child.status}${child.error ? `, ${child.error.code}` : ''}); stdout=${clip(child.stdout)} stderr=${clip(child.stderr)}`);
  }
}

/** Freeze a dir with the standard pins; asserts it worked and returns the lock and the JSON answer. */
export function freezeOk(t, dir, extra = [], opts = {}) {
  const child = kit(t, ['freeze', '--scenarios-dir', dir, ...PIN_FLAGS, ...extra, '--json'], opts);
  const out = onlyJson(child, 'freeze --json');
  assert.equal(child.status, 0, `freeze must succeed before this test can check anything: ${clip(child.stderr)}`);
  assert.equal(out.ok, true, `freeze answered ${JSON.stringify(out)}`);
  return { out, lock: readLock(dir), child };
}

export const lockPath = (dir) => join(dir, LOCK);
export const readLock = (dir) => {
  assert.ok(existsSync(lockPath(dir)), `${LOCK} was not written in the scenarios dir`);
  return JSON.parse(readFileSync(lockPath(dir), 'utf8'));
};

/** Two scenarios: acme-fix (client, check-graded) and acme-docs (proposed, key facts). */
export const twoScenarios = (fix = {}, docs = {}) => ({ 'acme-fix': fixScenario(fix), 'acme-docs': docsScenario(docs) });

/** Change exactly one byte of a file: `from` must occur once and be as long as `to`. */
export function changeOneByte(file, from, to) {
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split(from).length, 2, `${from} must occur exactly once in ${file}`);
  assert.equal(from.length, to.length);
  assert.equal([...from].filter((c, i) => c !== to[i]).length, 1, 'one character differs');
  writeFileSync(file, text.replace(from, to));
}

/**
 * A stand-in `claude`: appends its argv to a log and prints a version. `invocations()`
 * lists every call, so a test can prove the run never started a session, or never ran it at all.
 */
export function fakeClaude(t, version = PINS.clientVersion) {
  const dir = tempDir(t, 'kit-claude-');
  const log = join(dir, 'invocations.log');
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho '${version} (Claude Code)'\n`);
  chmodSync(bin, 0o755);
  return { bin, invocations: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

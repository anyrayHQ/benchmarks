#!/usr/bin/env node
// The hook arm B's Codex runs under --codex-hooks-b (lib/codexAgent.mjs codexHookSpec):
// `node codexHookShim.mjs <config>`, once per Bash call, with Codex's PreToolUse payload
// on stdin.
//
// It runs the arm home's own connect hook, as anyray-connect wrote it there, under the
// arm HOME, so the hook reads that home's profile (the bench gateway and key), never the
// real ~/.anyray. connect answers a command it trims with a rewrite to
// `<connect> __anyray-shell-run --b64 …`, which Codex then runs as the command, in Codex's
// own environment, i.e. under the real HOME. So the shim puts the arm HOME (and what the
// wrapped command must keep from the real one) in front of that shell-run, and changes
// nothing else. A rewrite it cannot place exactly is dropped: the command then runs
// unwrapped, which costs the treatment a trim but never reaches the real ~/.anyray.
//
// Always exits 0, as connect's hook does: a failure here is Codex's ordinary flow.

import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SHELL_RUN = '__anyray-shell-run';

/** A POSIX shell single-quoted word. */
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * connect's hook stdout → what Codex gets. `exe`: the connect invocation exactly as its hook
 * command spells it (the shell-run is spelled the same way); `env`: assignments to put in
 * front of it. A rewrite to anything but exactly one such shell-run, or output that is not
 * JSON, gives '' (no rewrite); an answer without a shell-run passes through untouched. Pure.
 */
export function withShellRunEnv(stdout, { exe, env }) {
  if (!String(stdout ?? '').trim()) return '';
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return '';
  }
  const command = answer?.hookSpecificOutput?.updatedInput?.command;
  if (typeof command !== 'string' || !command.includes(SHELL_RUN)) return stdout;
  const anchor = `${exe} ${SHELL_RUN} `;
  const at = command.indexOf(anchor);
  if (at < 0 || command.indexOf(anchor, at + 1) >= 0 || command.split(SHELL_RUN).length !== 2) return '';
  const prefix = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ');
  answer.hookSpecificOutput.updatedInput.command = `${command.slice(0, at)}${prefix} ${command.slice(at)}`;
  return JSON.stringify(answer);
}

/** One outcome per call, one line each (O_APPEND keeps concurrent calls' lines whole). */
function outcomeOf(stdout, answer) {
  if (answer === '') return String(stdout ?? '').trim() ? 'stand-aside' : 'passthrough';
  return answer === stdout ? 'passthrough' : 'rewrite';
}

function main([configPath]) {
  let config;
  let outcome = 'error';
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
    const input = readFileSync(0);
    const r = spawnSync('/bin/sh', ['-c', config.connectHook], {
      input,
      env: { ...process.env, HOME: config.home, ANYRAY_REFRESH_DISABLE: 'true' },
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status === 0) {
      const answer = withShellRunEnv(r.stdout, { exe: config.exe, env: config.shellRunEnv });
      outcome = outcomeOf(r.stdout, answer);
      if (answer) process.stdout.write(answer);
    }
  } catch {
    // Never let a hook failure become a tool failure.
  }
  try {
    if (config?.log) appendFileSync(config.log, `${outcome}\n`);
  } catch {}
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));

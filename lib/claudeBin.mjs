// Which Claude Code binary both arms spawn. By default it is `claude` from PATH, which on
// a machine with auto-update is a link that moves between runs (2.1.286 one round,
// 2.1.292 the next), changing how the sessions split work into subagents without the
// harness saying so. `--claude-bin <abs path>` (or ANYRAY_CLAUDE_BIN; the flag wins) pins
// one build for the task session, the warm-up and every version read. Each arm's setup
// records the version it spawned, per round, so a block that mixed versions shows it.

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const CLAUDE_BIN_ENV = 'ANYRAY_CLAUDE_BIN';

/** The unpinned default: `claude` resolved through PATH at spawn time. */
export const PATH_CLAUDE = Object.freeze({ bin: 'claude', source: 'PATH', pinned: false });

/**
 * What the run asked for, before touching the filesystem: the flag's value, else the
 * env var's, else PATH. `{ path, source }` with source '--claude-bin' | 'ANYRAY_CLAUDE_BIN'
 * | 'PATH'. An empty value is the same as none.
 */
export function claudeBinRequest({ flag = null, env = {} } = {}) {
  if (flag != null && flag !== '') return { path: String(flag), source: '--claude-bin' };
  const fromEnv = env[CLAUDE_BIN_ENV];
  if (fromEnv != null && fromEnv !== '') return { path: String(fromEnv), source: CLAUDE_BIN_ENV };
  return { path: null, source: 'PATH' };
}

const describeBad = (source, why) => new Error(`${source}: ${why}`);

/**
 * Resolve and validate a request: absolute, exists, executable. A directory is accepted
 * when it holds a `claude` executable (the pinned build's install directory). Returns
 * `{ bin, source, pinned }`; the PATH request returns PATH_CLAUDE without any check (the
 * spawn itself reports a missing `claude`).
 */
export function resolveClaudeBin(request = claudeBinRequest(), fs = { existsSync, statSync, accessSync }) {
  const { path, source } = request ?? {};
  if (!path) return PATH_CLAUDE;
  if (!isAbsolute(path)) throw describeBad(source, `takes an absolute path to a claude executable (or a directory holding one), got ${JSON.stringify(path)}`);
  if (!fs.existsSync(path)) throw describeBad(source, `no such file or directory: ${path}`);
  let bin = path;
  if (fs.statSync(path).isDirectory()) {
    bin = join(path, 'claude');
    if (!fs.existsSync(bin)) throw describeBad(source, `${path} is a directory with no claude executable in it`);
    if (fs.statSync(bin).isDirectory()) throw describeBad(source, `${bin} is a directory, not an executable`);
  }
  try {
    fs.accessSync(bin, constants.X_OK);
  } catch {
    throw describeBad(source, `${bin} is not executable`);
  }
  return { bin, source, pinned: true };
}

/** `<bin> --version` → '2.1.286'; null when the binary cannot be run or says something else. */
export function claudeVersion(bin = 'claude', { exec = execFileSync } = {}) {
  try {
    return parseVersionOutput(exec(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }));
  } catch {
    return null;
  }
}

/** '2.1.286 (Claude Code)' → '2.1.286'; anything without a version number → null. */
export function parseVersionOutput(out) {
  const m = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(String(out ?? ''));
  return m ? m[1] : null;
}

/** The run header's part for it: which build the arms spawn and where it came from. */
export function describeClaudeBin({ bin, source, pinned, version }) {
  const v = version ? `Claude Code ${version}` : 'Claude Code (version unknown)';
  return pinned ? `${v} pinned by ${source}: ${bin}` : `${v} from PATH (unpinned: an auto-update between rounds changes it; see --claude-bin)`;
}

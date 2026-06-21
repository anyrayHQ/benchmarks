// Config loader — parses config.yaml (shared settings + per-suite workloads) and
// resolves the admin token from the environment. The Node analog of the
// reference suite's shared_config.py.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const raw = parseYaml(readFileSync(join(ROOT, 'config.yaml'), 'utf8'));
  const shared = raw.shared ?? {};
  const adminToken = process.env[shared.admin_token_env ?? 'ANYRAY_ADMIN_TOKEN'] || '';
  return {
    root: ROOT,
    optimizerUrl: process.env.ANYRAY_OPTIMIZER_URL || shared.optimizer_url,
    endpoint: shared.endpoint ?? '/v1/chat/completions',
    charsPerToken: shared.chars_per_token ?? 4,
    requestTimeoutMs: shared.request_timeout_ms ?? 30000,
    adminToken,
    suites: raw.benchmarks ?? {},
  };
}

/** List suite names, or validate one. */
export function suiteNames(cfg) {
  return Object.keys(cfg.suites);
}

/** Resolve the workloads for a suite (optionally a single workload id). */
export function workloadsFor(cfg, suite, only) {
  const entry = cfg.suites[suite];
  if (!entry) {
    throw new Error(
      `unknown suite "${suite}" — have: ${suiteNames(cfg).join(', ')}`
    );
  }
  const list = entry.workloads ?? [];
  return only ? list.filter((w) => w.id === only) : list;
}

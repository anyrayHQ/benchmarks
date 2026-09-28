// Config loader — parses config.yaml (run settings, pricing, per-suite workloads) and
// merges the environment over it. Nothing here has a gateway default: a run must name
// its gateway explicitly (ANYRAY_GATEWAY_URL or run.gateway_url).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import { resolveAuth } from './auth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const trim = (u) => (u ? String(u).replace(/\/$/, '') : null);

export function loadConfig({ env = process.env, raw } = {}) {
  raw ??= parseYaml(readFileSync(join(ROOT, 'config.yaml'), 'utf8'));
  const run = raw.run ?? {};
  const auth = resolveAuth(env);
  const directUrl = trim(env.ANYRAY_DIRECT_URL || run.direct_url || 'https://api.anthropic.com');
  const gatewayUrl = trim(env.ANYRAY_GATEWAY_URL || run.gateway_url);
  const blocked = (run.blocked_gateways ?? []).map(trim);
  if (gatewayUrl && blocked.includes(gatewayUrl)) {
    throw new Error(`${gatewayUrl} is blocked in config.yaml run.blocked_gateways; point ANYRAY_GATEWAY_URL at another gateway`);
  }
  return {
    root: ROOT,
    suites: raw.benchmarks ?? {},
    pricing: raw.pricing ?? { models: {} },
    run: {
      model: env.ANYRAY_LIVE_MODEL || run.model || 'claude-opus-4-8',
      gatewayUrl,
      directUrl,
      auth,
      temperature: run.temperature ?? null,
      order: env.ANYRAY_ORDER || run.order || 'alternate',
      timeoutMs: run.timeout_ms ?? 300000,
      judge: {
        url: `${directUrl}/v1/messages`,
        model: env.ANYRAY_JUDGE_MODEL || run.judge_model || 'claude-opus-4-8',
        auth,
      },
    },
  };
}

/** List suite names. */
export function suiteNames(cfg) {
  return Object.keys(cfg.suites);
}

/** Resolve the workloads for a suite (optionally a single workload id). */
export function workloadsFor(cfg, suite, only) {
  const entry = cfg.suites[suite];
  if (!entry) {
    throw new Error(`unknown suite "${suite}" — have: ${suiteNames(cfg).join(', ')}`);
  }
  const list = entry.workloads ?? [];
  return only ? list.filter((w) => w.id === only) : list;
}

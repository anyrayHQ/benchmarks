#!/usr/bin/env node
// Turn gateway optimizer strategies on for benchmark traffic only.
//
// Adds (or removes) one targeting rule in the org optimizer config:
//   when metadata.tool == "anyray-bench"  →  enable <kinds>
// run_agent.mjs tags every Anyray-arm request with tool: "anyray-bench", so the rule
// touches nothing else — not your own Claude Code sessions on the same gateway.
// The config before the change is saved to results/optimizer-config.before.json.
//
// Needs ANYRAY_ADMIN_KEY: an aak_ admin API key with optimizer:read + optimizer:write.
//
// Usage:
//   node tools/bench-rule.mjs show
//   node tools/bench-rule.mjs enable [kind …]    # default: every strategy that is off
//   node tools/bench-rule.mjs only <kind …>      # these on, every other strategy off
//   … enable|only … --params '{"observation_mask":{"mintPaybackRatio":0}}'   # strategy params for the rule
//   node tools/bench-rule.mjs remove

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'anyray-bench: strategies on for benchmark traffic only';
const gw = (process.env.ANYRAY_GATEWAY_URL || '').replace(/\/$/, '');
const key = process.env.ANYRAY_ADMIN_KEY;
if (!gw) throw new Error('set ANYRAY_GATEWAY_URL');
if (gw === 'https://gateway.anyray.ai') throw new Error('gateway.anyray.ai is blocked for benchmark changes');
if (!key) throw new Error('set ANYRAY_ADMIN_KEY (aak_ key with optimizer:read + optimizer:write)');

async function call(method, body) {
  const res = await fetch(`${gw}/admin/v1/optimizer`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} /admin/v1/optimizer ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const argv = process.argv.slice(2);
const pi = argv.indexOf('--params');
const params = pi >= 0 ? JSON.parse(argv.splice(pi, 2)[1]) : null;
const [cmd = 'show', ...kinds] = argv;
const current = await call('GET');
const config = current.config;
const rules = config.overrides?.rules ?? [];
const strategies = config.strategies ?? [];

if (cmd === 'show') {
  for (const s of strategies) console.log(`${s.enabled ? 'on ' : 'off'}  ${s.kind}`);
  const mine = rules.find((r) => r.label === LABEL);
  console.log(mine ? `\nbench rule: enables ${mine.enable.join(', ')}${mine.disable?.length ? `; disables ${mine.disable.join(', ')}` : ''}${mine.params ? `; params ${JSON.stringify(mine.params)}` : ''}` : '\nbench rule: not set');
} else if (cmd === 'enable' || cmd === 'only') {
  if (cmd === 'only' && !kinds.length) throw new Error('usage: only <kind …>');
  const known = new Set(strategies.map((s) => s.kind));
  const unknown = kinds.filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unknown strategy: ${unknown.join(', ')}`);
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', 'optimizer-config.before.json'), JSON.stringify(config, null, 2) + '\n');
  const enable = kinds.length ? kinds : strategies.filter((s) => !s.enabled && s.kind !== 'audited_holdout').map((s) => s.kind);
  const rule = { label: LABEL, when: { metadata: { tool: ['anyray-bench'] } }, enable };
  if (params) rule.params = params;
  // `disable` wins over every enable, so `only` isolates the named strategies.
  if (cmd === 'only') rule.disable = strategies.map((s) => s.kind).filter((k) => !kinds.includes(k) && k !== 'audited_holdout');
  const next = { ...config, overrides: { ...(config.overrides ?? {}), rules: [...rules.filter((r) => r.label !== LABEL), rule] } };
  await call('PUT', { config: next });
  console.log(`bench rule set: enables ${enable.join(', ')}${rule.disable ? `; disables the other ${rule.disable.length}` : ''} for tool=anyray-bench\n(previous config saved to results/optimizer-config.before.json)`);
} else if (cmd === 'remove') {
  const next = { ...config, overrides: { ...(config.overrides ?? {}), rules: rules.filter((r) => r.label !== LABEL) } };
  await call('PUT', { config: next });
  console.log('bench rule removed');
} else {
  throw new Error('usage: show | enable [kind …] | only <kind …> | remove');
}

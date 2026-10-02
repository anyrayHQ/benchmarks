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
//   node tools/bench-rule.mjs per-experiment <kind …>   # one rule per kind: a session whose
//                                                # x-anyray-metadata carries experiment=<kind>
//                                                # gets that kind alone (run_agent --strategy)
//   … enable|only … --params '{"observation_mask":{"mintPaybackRatio":0}}'   # strategy params for the rule
//   node tools/bench-rule.mjs remove
//   node tools/bench-rule.mjs params <experiment> --params '{"<kind>":{"<param>":<value>}}'
//                                                # ONE rule: a session tagged tool=anyray-bench AND
//                                                # experiment=<experiment> gets these params. It
//                                                # enables and disables nothing, so that session
//                                                # runs its usual strategies. With
//                                                # `run_agent --compare gateway --experiment-b <experiment>`
//                                                # only arm B is tagged: the params are the treatment.
//   node tools/bench-rule.mjs remove-params <experiment>   # removes exactly that rule
//
// `params` / `remove-params` change one rule and nothing else in a config other people
// edit too: they re-read the config right before writing, send the revision they read (a
// concurrent change is refused and retried, never overwritten), and re-read afterwards to
// check that every other rule is as it was. `remove` and `per-experiment` leave these rules
// alone.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { otherRulesChanged, paramsRuleLabel, removeParamsRule, restChanged, setParamsRule, unknownParams, validExperimentName } from '../lib/benchRule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'anyray-bench: strategies on for benchmark traffic only';
const EXP_LABEL = (k) => `anyray-bench: ${k} alone for experiment=${k}`;
const ours = (r) => r.label === LABEL || r.label?.startsWith('anyray-bench: ') && r.label.includes(' alone for experiment=');
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
  if (!res.ok) throw Object.assign(new Error(`${method} /admin/v1/optimizer ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
  return JSON.parse(text);
}

/**
 * Change one experiment's params rule in the shared config. Re-reads right before the
 * write and sends that reading's revision, so a config someone else changed in between is
 * refused (409) and the change is reapplied to the new reading. Returns the config as read
 * before the write and as read back after it.
 */
async function writeOwnRule(change) {
  for (let attempt = 1; ; attempt++) {
    const read = await call('GET');
    const next = change(read.config, read.capabilities);
    try {
      await call('PUT', { config: next, ...(read.revision ? { expectedRevision: read.revision } : {}) });
    } catch (e) {
      if (e.status === 409 && attempt < 4) continue; // someone else wrote first: read again
      throw e;
    }
    return { before: read.config, after: (await call('GET')).config, guarded: Boolean(read.revision) };
  }
}

/** After a write: say what the config's other rules look like now against before. */
function reportOthers(before, after, name) {
  const changed = [...otherRulesChanged(before, after, name), ...restChanged(before, after).map((k) => `changed outside the rules: ${k}`)];
  const others = (after.overrides?.rules ?? []).filter((r) => r.label !== paramsRuleLabel(name));
  if (changed.length) {
    console.log(`WARNING: the config differs, outside this rule, from the reading taken right before the write (someone else edited it at the same time, or the write was not clean):\n  ${changed.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log(`every other rule is unchanged (${others.length}): ${others.map((r) => r.label ?? '(no label)').join(' | ') || 'none'}; so is the rest of the config`);
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
  for (const r of rules.filter((r) => ours(r) && r.label !== LABEL)) console.log(`${r.label}${r.params ? ` params ${JSON.stringify(r.params)}` : ''}`);
  for (const r of rules.filter((r) => r.label?.startsWith(paramsRuleLabel('')))) console.log(`${r.label} params ${JSON.stringify(r.params)}`);
  // The regret guard is tenant-wide: a strategy it has open is suppressed for every session
  // of the tenant, benchmark arms included, until it closes again.
  const open = (current.guard?.strategies ?? []).filter((g) => g.state && g.state !== 'closed');
  if (current.guard?.strategies) console.log(`\nregret guard: ${open.length ? open.map((g) => `${g.kind} ${g.state} (${g.windowRegrets}/${g.windowFired} regrets in the window${g.openUntilMs ? `, until ${new Date(g.openUntilMs).toISOString().slice(11, 19)}Z` : ''})`).join('; ') : 'every strategy closed (none suppressed)'}`);
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
} else if (cmd === 'per-experiment') {
  if (!kinds.length) throw new Error('usage: per-experiment <kind …>');
  const known = new Set(strategies.map((s) => s.kind));
  const unknown = kinds.filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unknown strategy: ${unknown.join(', ')}`);
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', 'optimizer-config.before.json'), JSON.stringify(config, null, 2) + '\n');
  const all = strategies.map((s) => s.kind).filter((k) => k !== 'audited_holdout');
  const added = kinds.map((k) => ({
    label: EXP_LABEL(k),
    when: { metadata: { tool: ['anyray-bench'], experiment: [k] } },
    enable: [k],
    disable: all.filter((x) => x !== k),
    ...(params?.[k] ? { params: { [k]: params[k] } } : {}),
  }));
  const next = { ...config, overrides: { ...(config.overrides ?? {}), rules: [...rules.filter((r) => !ours(r)), ...added] } };
  await call('PUT', { config: next });
  console.log(`per-experiment rules set for ${kinds.join(', ')} (tool=anyray-bench + experiment=<kind>; every other strategy disabled)`);
} else if (cmd === 'params') {
  const [name] = kinds;
  if (!validExperimentName(name) || !params) throw new Error(`usage: params <experiment> --params '{"<kind>":{"<param>":<value>}}'`);
  const { before, after, guarded } = await writeOwnRule((cfg, capabilities) => {
    const unknown = unknownParams(capabilities, params);
    if (unknown === null) console.warn('this gateway lists no strategy catalogue: param names are not checked');
    else if (unknown.length) throw new Error(`not params of the deployed optimizer: ${unknown.join(', ')}`);
    return setParamsRule(cfg, name, params);
  });
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', `optimizer-config.before-params-${name}.json`), JSON.stringify(before, null, 2) + '\n');
  const mine = (after.overrides?.rules ?? []).find((r) => r.label === paramsRuleLabel(name));
  if (!mine) throw new Error(`the rule for experiment=${name} is not in the config after the write`);
  console.log(`params rule set${guarded ? ' (revision-guarded write)' : ''}:\n  ${JSON.stringify(mine)}`);
  reportOthers(before, after, name);
  console.log(`remove it with: node tools/bench-rule.mjs remove-params ${name}`);
} else if (cmd === 'remove-params') {
  const [name] = kinds;
  if (!validExperimentName(name)) throw new Error('usage: remove-params <experiment>');
  const { before, after } = await writeOwnRule((cfg) => removeParamsRule(cfg, name));
  const was = (before.overrides?.rules ?? []).some((r) => r.label === paramsRuleLabel(name));
  if ((after.overrides?.rules ?? []).some((r) => r.label === paramsRuleLabel(name))) throw new Error(`the rule for experiment=${name} is still in the config after the write`);
  console.log(was ? `params rule for experiment=${name} removed` : `no params rule for experiment=${name}: nothing to remove`);
  reportOthers(before, after, name);
} else if (cmd === 'remove') {
  const next = { ...config, overrides: { ...(config.overrides ?? {}), rules: rules.filter((r) => !ours(r)) } };
  await call('PUT', { config: next });
  console.log('bench rule removed');
} else {
  throw new Error('usage: show | enable [kind …] | only <kind …> | per-experiment <kind …> | remove | params <experiment> --params <json> | remove-params <experiment>');
}

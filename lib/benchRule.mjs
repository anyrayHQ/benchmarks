// A params-only targeting rule for ONE experiment tag: the pure part of
// `bench-rule params <experiment>`.
//
// The rule matches `tool == "anyray-bench"` AND `experiment == <name>` in x-anyray-metadata
// and carries strategy params, nothing else: no enable, no disable. So the sessions it
// matches run the strategies they would have run anyway, with those params. Under
// `--compare gateway --experiment-b <name>` only arm B sends the tag, so only arm B gets
// the params; every other benchmark session, and everything that is not a benchmark, is
// untouched.
//
// The optimizer config is one shared document, written whole. These helpers change one
// rule and leave every other rule, and every other field, exactly as read.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A rule value is matched as a glob, so `*` or `?` in a name would match other runs' tags. */
export const validExperimentName = (name) => typeof name === 'string' && NAME.test(name);

export const paramsRuleLabel = (name) => `anyray-bench: params for experiment=${name}`;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function assertParams(params) {
  const ok = isObject(params) && Object.keys(params).length > 0 && Object.values(params).every((p) => isObject(p) && Object.keys(p).length > 0);
  if (!ok) throw new Error(`--params must be {"<strategy>":{"<param>":<value>}} with at least one param, got ${JSON.stringify(params)}`);
}

function assertName(name) {
  if (!validExperimentName(name)) throw new Error(`experiment name must be letters, digits, ".", "_" or "-" (max 64, no wildcards), got ${JSON.stringify(name)}`);
}

const rulesOf = (config) => config?.overrides?.rules ?? [];
const withRules = (config, rules) => ({ ...config, overrides: { ...(config.overrides ?? {}), rules } });

/** The config with this experiment's params rule set: replaced in place if present, else appended. */
export function setParamsRule(config, name, params) {
  assertName(name);
  assertParams(params);
  const label = paramsRuleLabel(name);
  const rule = { label, when: { metadata: { tool: ['anyray-bench'], experiment: [name] } }, params };
  const rules = rulesOf(config);
  const at = rules.findIndex((r) => r.label === label);
  return withRules(config, at < 0 ? [...rules, rule] : rules.map((r, i) => (i === at ? rule : r)));
}

/** The config without this experiment's params rule. Every other rule stays, in order. */
export function removeParamsRule(config, name) {
  assertName(name);
  const label = paramsRuleLabel(name);
  return withRules(config, rulesOf(config).filter((r) => r.label !== label));
}

// Key order does not make two rules different.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * What happened to the rules that are NOT this experiment's, between two readings of the
 * config: `removed: <label>`, `changed: <label>`, `added: <label>`. Empty = untouched.
 */
export function otherRulesChanged(before, after, name) {
  const label = paramsRuleLabel(name);
  const id = (r, i) => r.label ?? `#${i}`;
  const was = rulesOf(before).filter((r) => r.label !== label);
  const now = rulesOf(after).filter((r) => r.label !== label);
  const out = [];
  was.forEach((r, i) => {
    const match = now.find((n, j) => id(n, j) === id(r, i));
    if (!match) out.push(`removed: ${id(r, i)}`);
    else if (!same(match, r)) out.push(`changed: ${id(r, i)}`);
  });
  now.forEach((n, j) => {
    if (!was.some((r, i) => id(r, i) === id(n, j))) out.push(`added: ${id(n, j)}`);
  });
  return out;
}

/**
 * The parts of the config OTHER than its rules that differ between two readings, as paths
 * (`strategies`, `overrides.byEndpoint`, …). A rule write must leave all of them alone.
 */
export function restChanged(before, after) {
  const strip = (config) => {
    const { overrides, ...top } = config ?? {};
    const { rules, ...rest } = overrides ?? {};
    return { ...top, ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [`overrides.${k}`, v])) };
  };
  const a = strip(before);
  const b = strip(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k])).sort();
}

/**
 * Param names the deployed optimizer does not list for that strategy (its defaults plus
 * its documented params), and strategies it does not have: a misspelt param is accepted
 * by the config API and then silently does nothing. `null` when this gateway returns no
 * strategy catalogue to check against.
 */
export function unknownParams(capabilities, params) {
  const kinds = capabilities?.kinds;
  if (!Array.isArray(kinds) || !kinds.length) return null;
  const out = [];
  for (const [kind, p] of Object.entries(params)) {
    const entry = kinds.find((k) => k.kind === kind);
    if (!entry) {
      out.push(`${kind} (unknown strategy)`);
      continue;
    }
    const known = new Set([...Object.keys(entry.defaultParams ?? {}), ...Object.keys(entry.doc?.params ?? {})]);
    for (const name of Object.keys(p)) if (!known.has(name)) out.push(`${kind}.${name}`);
  }
  return out;
}

/**
 * The rules whose condition names this experiment tag, as `{ label, params }`, from an
 * optimizer config reading (`{ overrides }`). `null` when the config could not be read.
 */
export function experimentRules(optimizerConfig, name) {
  if (!optimizerConfig || optimizerConfig.unavailable) return null;
  return rulesOf(optimizerConfig)
    .filter((r) => (r.when?.metadata?.experiment ?? []).includes(name))
    .map((r) => ({ label: r.label, ...(r.params ? { params: r.params } : {}), ...(r.enable ? { enable: r.enable } : {}), ...(r.disable ? { disable: r.disable } : {}) }));
}

/** Two readings of an experiment's rules are the same rules. */
export const sameRules = (a, b) => same(a, b);

// Extra Claude Code env for one or both arms of a paired run, e.g. to measure a
// setting anyray-connect writes (--arm-env b:CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
// with --compare control = the same direct session with and without it).

/** `[a:|b:]KEY=VALUE[,KEY=VALUE…]`, repeatable; no prefix = both arms. */
export function parseArmEnv(specs) {
  const env = { a: {}, b: {} };
  for (const spec of specs) {
    const m = /^(?:([ab]):)?(.*)$/.exec(spec);
    const slots = m[1] ? [m[1]] : ['a', 'b'];
    for (const pair of m[2].split(',')) {
      const eq = pair.indexOf('=');
      const key = pair.slice(0, eq);
      if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`--arm-env expects [a:|b:]KEY=VALUE[,KEY=VALUE…], got "${spec}"`);
      for (const s of slots) env[s][key] = pair.slice(eq + 1);
    }
  }
  return env;
}

/** The arm's session settings with its extra env on top (settings.env, as connect writes it). */
export const withArmEnv = (settings, env = {}) => ({ ...settings, env: { ...settings.env, ...env } });

// Keys the harness sets for an arm: its route (gateway URL + headers) and the private HOME
// that confines read trim / retrieval MCP. Overriding one would silently reroute an arm or
// point hooks at the real ~/.anyray and ~/.claude, so --arm-env refuses them.
const RESERVED = /^(HOME|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL|ANYRAY_.*)$/;

/** Throw if the arm env would override a key the harness owns. */
export function assertArmEnvSafe(env = {}) {
  const bad = Object.keys(env).filter((k) => RESERVED.test(k));
  if (bad.length) throw new Error(`--arm-env cannot set ${bad.join(', ')}: the harness sets it for the arm (route / private HOME)`);
}

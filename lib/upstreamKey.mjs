// --upstream api-key: the Anthropic API key the Claude arms run on. The harness takes it out of
// its own environment at startup and hands it to the arm processes alone, so a grader, a git
// clone or a helper never inherits it, and it never lands in settings, arm-env, args or results.

let held = null;

/** Returns ANTHROPIC_API_KEY, deletes it from `env` and holds it for the arms; throws when there is none. */
export function captureApiKey(env = process.env) {
  const key = env.ANTHROPIC_API_KEY?.trim();
  delete env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--upstream api-key needs ANTHROPIC_API_KEY in the environment');
  return (held = key);
}

/** The captured key, for an arm process's env alone. */
export const heldApiKey = () => {
  if (!held) throw new Error('--upstream api-key ran before the key was captured');
  return held;
};

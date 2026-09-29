/**
 * Cache breaks in one session. A break: an agent's request reads less than 90% of what
 * that same agent's previous request sent (input + cache read + cache write). Its history
 * only grows, so the prefix changed under it and was re-billed as a cache write. Tracked
 * per agent (`main`, each subagent), so interleaved requests from different agents never
 * look like drops; each agent's first request has nothing to compare against.
 *
 * @param {{ agent: string, usage?: object }[]} requests  in the order they were sent
 */
export function countCacheBreaks(requests) {
  let breaks = 0;
  const lastInput = new Map();
  for (const r of requests) {
    const u = r.usage ?? {};
    const read = u.cache_read_input_tokens ?? 0;
    const prev = lastInput.get(r.agent);
    if (prev && read < prev * 0.9) breaks++;
    lastInput.set(r.agent, (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0));
  }
  return breaks;
}

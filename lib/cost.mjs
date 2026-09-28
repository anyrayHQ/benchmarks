// Price one response from its normalized usage (lib/client.mjs) and config.yaml
// `pricing`. Uncached input bills at the input rate, cache reads and 5-minute cache
// writes at their multipliers, output (thinking included) at the output rate.

/** Longest pricing key the model id starts with, so dated ids resolve (…-20251001). */
export function priceFor(pricing, model) {
  const models = pricing?.models ?? {};
  const key = Object.keys(models)
    .filter((k) => model === k || model?.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? models[key] : null;
}

/** USD for one call, or null when the model is unpriced or usage is missing. */
export function costOf(pricing, model, usage) {
  const p = priceFor(pricing, model);
  if (!p || usage?.input == null || usage?.output == null) return null;
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  const uncached = Math.max(0, usage.input - read - write);
  const inputUnits =
    uncached + read * (p.cache_read ?? pricing.cache_read ?? 0.1) + write * (pricing.cache_write ?? 1.25);
  return (inputUnits * p.input + usage.output * p.output) / 1e6;
}

/**
 * USD for one raw Anthropic `usage` block, splitting 5-minute (1.25x) from 1-hour (2x)
 * cache writes — Claude Code writes the 1-hour cache.
 */
export function costOfAnthropicUsage(pricing, model, u) {
  const p = priceFor(pricing, model);
  if (!p || !u) return null;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = (u.cache_creation_input_tokens ?? 0) - w1h;
  const inputUnits =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) * (p.cache_read ?? pricing.cache_read ?? 0.1) +
    w5m * (pricing.cache_write ?? 1.25) +
    w1h * (pricing.cache_write_1h ?? 2);
  return (inputUnits * p.input + (u.output_tokens ?? 0) * p.output) / 1e6;
}

/** Percent saved going from `before` to `after`; negative when `after` costs more. */
export function savedPct(before, after) {
  if (before == null || after == null || before === 0) return null;
  return Math.round(((before - after) / before) * 1000) / 10;
}

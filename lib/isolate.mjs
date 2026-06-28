// Pin the optimizer to a single strategy, run fn, then restore the prior config —
// even if fn throws — so a live stack is never left pinned to one strategy.

export async function withIsolatedStrategy(client, kind, params, fn) {
  const snapshot = await client.getSettings();
  const priorConfig = snapshot?.config ?? snapshot;
  await client.setStrategy(kind, params);
  try {
    return await fn();
  } finally {
    try {
      await client.putConfig(priorConfig);
    } catch (e) {
      console.error(`WARN: failed to restore optimizer config: ${e.message}`);
    }
  }
}

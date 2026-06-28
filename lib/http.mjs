// fetch with retry/backoff for 429 + 5xx + transient network errors. The live runs
// share a subscription rate limit (the same one the interactive session uses), so
// 429s are expected; back off and retry rather than failing the workload.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchRetry(
  fetchImpl,
  url,
  makeInit,
  { retries = 6, baseMs = 2000, maxMs = 30000, timeoutMs = 30000 } = {}
) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...makeInit(), signal: ctrl.signal });
      clearTimeout(timer);
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (retryable && attempt < retries) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const waitMs =
          Number.isFinite(ra) && ra > 0
            ? ra * 1000
            : Math.min(baseMs * 2 ** attempt, maxMs) + Math.floor(Math.random() * 500);
        await sleep(waitMs);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      last = e;
      if (attempt === retries) throw e;
      await sleep(Math.min(baseMs * 2 ** attempt, maxMs));
    }
  }
  throw last;
}

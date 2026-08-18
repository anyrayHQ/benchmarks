// Thin HTTP client for a running Anyray optimizer (the before-request hook).
//
// We talk to the optimizer over its public contract only — never import its
// internals — exactly the way the gateway does (and the way these benchmarks
// call the hosted service rather than vendoring the compressor). Two calls:
//
//   PUT  /admin/optimizer/settings   isolate ONE strategy at ONE knob (admin-gated)
//   POST /v1/optimize                run the hook over a request, get it transformed
//
// Isolating a single strategy is the Anyray analog of selecting one
// model × aggressiveness in a compression benchmark: it lets each suite attribute
// its saving to a named strategy instead of the whole pipeline.

export class OptimizerClient {
  constructor({
    url,
    adminToken,
    optimizerToken,
    endpoint = '/v1/chat/completions',
    timeoutMs = 30000,
  }) {
    this.url = url.replace(/\/$/, '');
    this.adminToken = adminToken;
    this.optimizerToken = optimizerToken;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  async #fetch(path, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.url}${path}`, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Liveness probe — returns true if the optimizer answers. */
  async ping() {
    try {
      const res = await this.#fetch('/health', { method: 'GET' });
      return res.ok || res.status === 404; // any HTTP answer means it's up
    } catch {
      return false;
    }
  }

  /**
   * Force the optimizer's local embedding model to load before the first
   * measurement.
   *
   * WHY: the embedder warms lazily on first use, and a semanticRerank workload
   * that lands while it is still loading silently falls back to lexical ranking —
   * which is precisely what the vocabulary-mismatch fixtures exist to defeat.
   * That made results depend on suite order: 33-synonym-gap-logs measured
   * 94% saved / 50% key-facts FAIL as the first row of a cold run, and
   * 61% / 100% PASS re-run against the same warm optimizer. A 33-point swing on
   * identical input.
   *
   * A plain /v1/optimize call is not enough: the request has to actually reach
   * the re-ranker. relevance_filter skips embeddings when lexical ranking is
   * already confident, and no-ops entirely when there is nothing worth dropping,
   * so hand-rolled filler tends to be served by BM25 and never touch the model.
   * The caller therefore passes a REAL workload known to exercise the re-ranker
   * (run_benchmark picks the first semanticRerank workload in the config) at its
   * own knob.
   *
   * The request must also carry the retrieve tool (see retrieveTool.mjs), or the
   * optimizer suppresses the strategy as `no_retrieve` before any embedding
   * happens. Polls a few times in case the model resolves lazily.
   *
   * Best-effort: a failure here must not fail the run, since the only cost is
   * the cold-start skew this exists to avoid. Restores the caller's config.
   */
  async warmEmbedder(warmupRequest, params, { attempts = 12, delayMs = 2000 } = {}) {
    if (!this.adminToken || !warmupRequest) return false;
    const snapshot = await this.getSettings().catch(() => null);
    try {
      await this.setStrategy('relevance_filter', params ?? {});
      for (let i = 0; i < attempts; i++) {
        const res = await this.optimize(warmupRequest, ['relevance_filter']).catch(() => null);
        // A semantic note in the decision ⇒ the model is loaded and resident.
        const warm = (res?.decisions ?? []).some((d) =>
          (d.summary ?? '').includes('semantic')
        );
        if (warm) return true;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
      return false;
    } catch {
      return false;
    } finally {
      if (snapshot) await this.putConfig(snapshot).catch(() => {});
    }
  }

  /** Snapshot the optimizer's current config so a run can restore it afterwards. */
  async getSettings() {
    if (!this.adminToken) {
      throw new Error('admin token required (set ANYRAY_ADMIN_TOKEN)');
    }
    const res = await this.#fetch('/admin/optimizer/settings', {
      method: 'GET',
      headers: { authorization: `Bearer ${this.adminToken}` },
    });
    if (!res.ok) {
      throw new Error(`GET settings failed (${res.status})`);
    }
    const body = await res.json();
    return body.config ?? body;
  }

  /** Replace the optimizer's whole config (used to pin one strategy and to restore). */
  async putConfig(config) {
    if (!this.adminToken) {
      throw new Error('admin token required (set ANYRAY_ADMIN_TOKEN)');
    }
    const res = await this.#fetch('/admin/optimizer/settings', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminToken}`,
      },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(
        `PUT settings failed (${res.status}): ${await res.text().catch(() => '')}`
      );
    }
    return res.json();
  }

  /**
   * The optimizer's current defaults-migration revision, memoized per client.
   *
   * WHY: a PUT that omits `defaultsRevision` is treated as revision 0, so the
   * optimizer replays its whole DEFAULTS_MIGRATIONS ledger over the submitted
   * config before persisting it. Several ledger entries force a strategy off by
   * kind (window_budget, tool_pruning), so a pin of exactly those kinds is
   * silently reverted to `enabled: false` and the workload measures 0%.
   * Stamping the revision the optimizer already reports means "this config is
   * current, do not replay history over it" and the pin sticks.
   */
  async #defaultsRevision() {
    if (this.knownDefaultsRevision === undefined) {
      const cfg = await this.getSettings().catch(() => null);
      this.knownDefaultsRevision =
        typeof cfg?.defaultsRevision === 'number' ? cfg.defaultsRevision : null;
    }
    return this.knownDefaultsRevision;
  }

  /**
   * Pin the optimizer to a single strategy at a single knob. Persists a config
   * with only `kind` enabled (a full replace — everything else off), so the next
   * /v1/optimize runs exactly that strategy with `params`.
   */
  async setStrategy(kind, params = {}) {
    const defaultsRevision = await this.#defaultsRevision();
    return this.putConfig({
      ...(defaultsRevision !== null ? { defaultsRevision } : {}),
      strategies: [{ kind, enabled: true, params }],
    });
  }

  /**
   * Run the before-request hook over `request`. `enabledKinds` restricts the run
   * to those strategy kinds (belt-and-suspenders with setStrategy). Workloads may
   * override the endpoint (strategies like provider_context_trim gate on
   * /v1/messages) and pass metadata (reasoning_budget keys off a session id).
   * Returns the optimizer's response body: { request, decisions, ... }.
   */
  async optimize(request, enabledKinds, { endpoint, metadata } = {}) {
    const res = await this.#fetch('/v1/optimize', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.optimizerToken
          ? { authorization: `Bearer ${this.optimizerToken}` }
          : {}),
      },
      body: JSON.stringify({
        endpoint: endpoint ?? this.endpoint,
        request,
        metadata: metadata ?? {},
        ...(enabledKinds ? { enabledKinds } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `POST /v1/optimize failed (${res.status}): ${await res.text().catch(() => '')}`
      );
    }
    return res.json();
  }

  /**
   * Write a provider response into the optimizer's semantic cache so a later
   * identical request hits it. Used by the semantic-cache hit-path workload.
   */
  async cache({ cacheKey, request, response, ttlSeconds, metadata }) {
    const res = await this.#fetch('/v1/cache', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.optimizerToken
          ? { authorization: `Bearer ${this.optimizerToken}` }
          : {}),
      },
      body: JSON.stringify({
        ...(cacheKey ? { cacheKey } : {}),
        ...(request ? { request } : {}),
        response,
        ...(ttlSeconds ? { ttlSeconds } : {}),
        ...(metadata ? { metadata } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `POST /v1/cache failed (${res.status}): ${await res.text().catch(() => '')}`
      );
    }
    return res.json();
  }
}

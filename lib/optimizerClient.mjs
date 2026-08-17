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
  /** Cached head defaults revision; undefined = not yet read, null = unknown. */
  #revision;

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

  /**
   * Provenance for a run: WHICH optimizer produced these numbers.
   *
   * Committed results used to carry no evidence of this, so rows measured months
   * and hundreds of strategy commits apart sat in one table reading as current —
   * and a mixed-version aggregate is indistinguishable from a fresh one. Both
   * fields come off the same admin-gated settings response the runner already
   * fetches to snapshot config.
   *
   * `optimizerVersion` is null on an optimizer predating the field; that is
   * reported honestly rather than guessed, so an old build is visible as unknown
   * instead of silently inheriting the current version.
   */
  async getProvenance() {
    const res = await this.#fetch('/admin/optimizer/settings', {
      method: 'GET',
      headers: { authorization: `Bearer ${this.adminToken}` },
    });
    if (!res.ok) throw new Error(`GET settings failed (${res.status})`);
    const body = await res.json();
    return {
      optimizerVersion: body.optimizerVersion ?? null,
      defaultsRevision: body.config?.defaultsRevision ?? null,
    };
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
   * Pin the optimizer to a single strategy at a single knob. Persists a config
   * with only `kind` enabled (a full replace — everything else off), so the next
   * /v1/optimize runs exactly that strategy with `params`.
   *
   * `defaultsRevision` is REQUIRED, not decoration. The optimizer replays its
   * defaults-migration ledger over any config that arrives stamped older than
   * head, and migration 1 force-disables `window_budget`. A PUT with no stamp
   * reads as revision 0, so every migration replays and the pin comes back
   * `enabled: false` — the PUT still answers 200 and echoes the params, so the
   * harness saw success and then measured a strategy that never ran. That is
   * what silently zeroed all three `window_budget` rows (91%/25%/37% -> 0%);
   * any future default-flipping migration would do the same to another kind.
   *
   * Stamping head means "this config is already current, apply nothing", which
   * is true: the harness composes it fresh from config.yaml every call.
   *
   * The revision is resolved from the live optimizer and cached on the client
   * rather than threaded through callers, so every lane that pins a strategy
   * (run_benchmark, run_quality, run_live via lib/isolate) is covered without
   * each one having to remember.
   */
  async setStrategy(kind, params = {}) {
    const defaultsRevision = await this.#defaultsRevision();
    return this.putConfig({
      ...(defaultsRevision != null ? { defaultsRevision } : {}),
      strategies: [{ kind, enabled: true, params }],
    });
  }

  /** Head defaults revision, read once per client and cached. */
  async #defaultsRevision() {
    if (this.#revision === undefined) {
      this.#revision = await this.getProvenance()
        .then((p) => p.defaultsRevision)
        .catch(() => null);
    }
    return this.#revision;
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

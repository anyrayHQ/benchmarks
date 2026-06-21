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
  constructor({ url, adminToken, endpoint = '/v1/chat/completions', timeoutMs = 30000 }) {
    this.url = url.replace(/\/$/, '');
    this.adminToken = adminToken;
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
   * Pin the optimizer to a single strategy at a single knob. Persists a config
   * with only `kind` enabled (everything else implicitly off), so the next
   * /v1/optimize runs exactly that strategy with `params`.
   */
  async setStrategy(kind, params = {}) {
    if (!this.adminToken) {
      throw new Error(
        'admin token required to set the strategy (set ANYRAY_ADMIN_TOKEN)'
      );
    }
    const body = { strategies: [{ kind, enabled: true, params }] };
    const res = await this.#fetch('/admin/optimizer/settings', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.adminToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `PUT settings failed (${res.status}): ${await res.text().catch(() => '')}`
      );
    }
    return res.json();
  }

  /**
   * Run the before-request hook over `request`. `enabledKinds` restricts the run
   * to those strategy kinds (belt-and-suspenders with setStrategy). Returns the
   * optimizer's response body: { request, decisions, ... }.
   */
  async optimize(request, enabledKinds) {
    const res = await this.#fetch('/v1/optimize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        endpoint: this.endpoint,
        request,
        metadata: {},
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
}

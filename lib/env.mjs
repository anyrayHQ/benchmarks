// Resolve the live-validation config: merge the config.yaml `live` block with env, and
// resolve gateway auth (passthrough OAuth by default — see lib/auth.mjs). The judge rides
// the same gateway + auth so it uses the deployment's subscription.

import { resolveAuth } from './auth.mjs';

export function resolveLiveConfig(cfg, env = process.env) {
  const live = cfg.live || {};
  const gatewayUrl = (
    env.ANYRAY_GATEWAY_URL ||
    live.gateway_url ||
    'http://localhost:8787'
  ).replace(/\/$/, '');
  const auth = resolveAuth(env);
  return {
    gatewayUrl,
    model: env.ANYRAY_LIVE_MODEL || live.model || 'claude-sonnet-4-6',
    auth,
    temperature: live.temperature ?? 0,
    timeoutMs: cfg.requestTimeoutMs ?? 30000,
    judge: {
      url: env.ANYRAY_JUDGE_URL || live.judge_url || `${gatewayUrl}/v1/chat/completions`,
      model: env.ANYRAY_JUDGE_MODEL || live.judge_model || 'claude-opus-4-8',
      auth,
    },
  };
}

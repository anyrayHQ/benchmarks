// Resolve gateway auth. This deployment runs in PASSTHROUGH mode: the caller forwards
// the upstream Anthropic credential in Authorization and presents the Anyray client key
// (ark_…) in x-anyray-api-key. The client key comes from ~/.anyray/connect.json; the
// upstream credential is the Claude subscription OAuth token read fresh from the macOS
// keychain each run (so it's never persisted and is always current). Override either via
// env (ANYRAY_CLIENT_KEY / ANYRAY_UPSTREAM_TOKEN) — e.g. to use an sk-ant-… API key.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function readClientKey() {
  const p = join(homedir(), '.anyray', 'connect.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).clientKey || null;
  } catch {
    return null;
  }
}

function readKeychainOAuth() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8' }
    );
    return JSON.parse(out)?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

export function resolveAuth(env = process.env) {
  const mode = env.ANYRAY_AUTH_MODE || 'passthrough';
  const provider = env.ANYRAY_PROVIDER || 'anthropic';
  const clientKey = env.ANYRAY_CLIENT_KEY || readClientKey();
  const upstreamToken =
    mode === 'passthrough' ? env.ANYRAY_UPSTREAM_TOKEN || readKeychainOAuth() : null;
  return { mode, provider, clientKey, upstreamToken };
}

// A Claude subscription OAuth token is bound to Claude Code's request signature:
// Anthropic only honors it when the call carries the OAuth beta + a CLI user-agent
// (and a "You are Claude Code…" system prompt — added in gatewayClient). Without
// these the provider rejects with a generic error the gateway surfaces as a
// (misleading) rate_limit. Sent only for the anthropic passthrough path.
const CLAUDE_CODE_IDENTITY_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
  'user-agent': 'claude-cli/2.0.0 (external, cli)',
};

/** Auth headers for a gateway /v1 call, per the resolved mode. */
export function authHeaders(auth) {
  if (auth?.mode === 'passthrough') {
    const h = {
      'x-anyray-auth-mode': 'passthrough',
      'x-anyray-provider': auth.provider,
    };
    if (auth.upstreamToken) h.authorization = `Bearer ${auth.upstreamToken}`;
    if (auth.clientKey) h['x-anyray-api-key'] = auth.clientKey;
    // Subscription OAuth only works when the request looks like Claude Code.
    if (auth.provider === 'anthropic' && auth.upstreamToken) {
      Object.assign(h, CLAUDE_CODE_IDENTITY_HEADERS);
    }
    return h;
  }
  // managed: the client key alone authenticates; gateway uses its server-side credential.
  return auth?.clientKey ? { authorization: `Bearer ${auth.clientKey}` } : {};
}

/** Claude Code's required leading system identity (Anthropic checks the system prefix). */
export const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/** Ensure the messages begin with the Claude Code system identity (subscription OAuth). */
export function withClaudeIdentity(messages, auth) {
  if (!(auth?.mode === 'passthrough' && auth.provider === 'anthropic' && auth.upstreamToken)) {
    return messages;
  }
  const first = messages?.[0];
  if (first?.role === 'system' && String(first.content).startsWith('You are Claude Code')) {
    return messages;
  }
  return [{ role: 'system', content: CLAUDE_CODE_SYSTEM }, ...(messages || [])];
}

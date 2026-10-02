// A local pass-through between the Anyray arm's Claude Code and the gateway, so the
// harness can read each response's `x-anyray-optimization-result` header (Claude Code
// never surfaces response headers). Bytes are piped both ways untouched; only that one
// header is parsed and kept. No request or response body is recorded.
//
// Claude Code sends ANTHROPIC_CUSTOM_HEADERS on every call, but the gateway rejects a
// selection header on anything but an inference POST (400), so the proxy drops the
// selection headers from those other calls (e.g. count_tokens).

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { KINDS_HEADER, RESULT_HEADER, parseOptimizationResult } from './optimizationKinds.mjs';

const PROFILE_HEADER = 'x-anyray-optimization-profile';
/** The gateway's answer to `x-anyray-cc-budget-notice` (or the org setting): `{"applied":bool}`. */
export const NOTICE_RESULT_HEADER = 'x-anyray-cc-budget-notice-result';

/** Count one inference response's budget-notice outcome: applied, not applied, or no header. */
export function tallyNotice(tally, header) {
  let applied;
  try {
    applied = header === undefined ? undefined : JSON.parse(header).applied;
  } catch {}
  tally[applied === true ? 'applied' : applied === false ? 'notApplied' : 'absent']++;
  return tally;
}
/** The gateway's answer to `x-anyray-tool-defer` (or the org setting): `{"applied":bool,"reason"?,"deferred"?}`. */
export const TOOL_DEFER_RESULT_HEADER = 'x-anyray-tool-defer-result';

/**
 * Count why a gateway rewrite stood aside, from the `reason` its result header names.
 * A not-applied result with no reason is counted `unnamed`: the gateway owes one.
 */
export function tallyReason(reasons, header) {
  let j;
  try {
    j = header === undefined ? undefined : JSON.parse(header);
  } catch {}
  if (j?.applied === false) {
    const reason = typeof j.reason === 'string' && j.reason ? j.reason : 'unnamed';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return reasons;
}
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** The gateway only honours a selection on inference POSTs. */
export const isInference = (method, url) =>
  method === 'POST' && /^\/(?:v1\/)?(?:chat\/completions|completions|messages|responses)(?:\?|$)/.test(url);

/** Listen on 127.0.0.1 (ephemeral port) and forward to `upstream`. */
export async function startResultProxy({ upstream }) {
  const base = new URL(upstream);
  const basePath = base.pathname.replace(/\/$/, '');
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  const state = { results: [], stripped: 0, notice: { applied: 0, notApplied: 0, absent: 0 }, noticeReasons: {}, toolDefer: { applied: 0, notApplied: 0, absent: 0 }, toolDeferReasons: {} };

  const server = createServer((req, res) => {
    const inference = isInference(req.method, req.url);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    if (!inference && (headers[KINDS_HEADER] !== undefined || headers[PROFILE_HEADER] !== undefined)) {
      delete headers[KINDS_HEADER];
      delete headers[PROFILE_HEADER];
      state.stripped++;
    }
    const up = send(
      { protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path: basePath + req.url, headers: { ...headers, host: base.host } },
      (upRes) => {
        if (inference) {
          const r = parseOptimizationResult(upRes.headers[RESULT_HEADER]);
          state.results.push(upRes.statusCode >= 400 ? { ...r, httpStatus: upRes.statusCode } : r);
          tallyNotice(state.notice, upRes.headers[NOTICE_RESULT_HEADER]);
          tallyReason(state.noticeReasons, upRes.headers[NOTICE_RESULT_HEADER]);
          tallyNotice(state.toolDefer, upRes.headers[TOOL_DEFER_RESULT_HEADER]);
          tallyReason(state.toolDeferReasons, upRes.headers[TOOL_DEFER_RESULT_HEADER]);
        }
        const out = Object.fromEntries(Object.entries(upRes.headers).filter(([k]) => !HOP.has(k)));
        res.writeHead(upRes.statusCode, out);
        upRes.pipe(res);
      }
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'bench_proxy_error', message: `gateway unreachable: ${e.code ?? e.message}` } }));
    });
    req.pipe(up);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get results() {
      return state.results;
    },
    get stripped() {
      return state.stripped;
    },
    get notice() {
      return state.notice;
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

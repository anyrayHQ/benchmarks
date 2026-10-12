// The ten planted vulnerabilities the sdk-app-scanner agent must find, and the exact
// marker string each one carries. Everything here is SYNTHETIC by construction: every
// marker contains the word SYNTHETIC or an obviously fake sentinel, so nothing in a
// result file or a seeded fixture is a real secret (secrets.md). Grading is findings
// recall: a vulnerability counts as found when its marker appears verbatim in the
// agent's answer (its ReportFindings calls plus its final text), the keyFacts contract
// the harness already grades by.
//
// `where` names which tool surfaces the marker:
//   'traffic'  — inside a recorded-traffic row the `traffic_query` tool returns
//   'http'     — inside a `http_get` response from the local fixture server
// so the ten are split across both read paths the scanner uses. A marker is a single
// distinctive token the model quotes when it reports the finding; keep them unique.

/** @typedef {{ id: string, marker: string, where: 'traffic'|'http', path?: string, summary: string, severity: 'low'|'medium'|'high'|'critical' }} Vulnerability */

/** @type {Vulnerability[]} */
export const VULNERABILITIES = [
  {
    id: 'hardcoded-aws-key',
    marker: 'AKIASYNTHETIC00LEAK7F3A2B',
    where: 'traffic',
    summary: 'A hard-coded AWS-style access key id echoed in a captured response body.',
    severity: 'critical',
  },
  {
    id: 'sql-injection-echo',
    marker: "name=admin'--SYNTHETIC-SQLI",
    where: 'traffic',
    summary: 'A login request whose username reaches the query unescaped (SQL injection).',
    severity: 'high',
  },
  {
    id: 'jwt-none-alg',
    marker: 'eyJhbGciOiJub25lSYNTHETIC',
    where: 'traffic',
    summary: 'A JWT issued with alg "none", so any forged token is accepted.',
    severity: 'high',
  },
  {
    id: 'pii-in-logs',
    marker: 'ssn=SYNTHETIC-078-05-1120',
    where: 'traffic',
    summary: 'A plaintext SSN written into an access-log line (PII leak).',
    severity: 'medium',
  },
  {
    id: 'open-redirect',
    marker: 'next=//evil.synthetic.example/steal',
    where: 'traffic',
    summary: 'A redirect endpoint that forwards to an attacker-controlled host.',
    severity: 'medium',
  },
  {
    id: 'verbose-stacktrace',
    marker: 'at app.handlers.pay.SYNTHETIC_STACK_LEAK',
    where: 'traffic',
    summary: 'A 500 response that returns an internal stack trace to the client.',
    severity: 'low',
  },
  {
    id: 'debug-exec-endpoint',
    marker: '/internal/debug/exec?cmd=SYNTHETIC',
    where: 'http',
    path: '/internal/debug/exec',
    summary: 'An unauthenticated debug endpoint that runs shell commands.',
    severity: 'critical',
  },
  {
    id: 'admin-header-bypass',
    marker: 'X-Admin-Override: SYNTHETIC-TRUE',
    where: 'http',
    path: '/account/settings',
    summary: 'A privileged action gated only by a forgeable request header.',
    severity: 'high',
  },
  {
    id: 'cors-wildcard-credentials',
    marker: 'Access-Control-Allow-Origin: *SYNTHETIC-CREDS',
    where: 'http',
    path: '/api/profile',
    summary: 'A wildcard CORS origin served together with credentialed responses.',
    severity: 'medium',
  },
  {
    id: 'directory-listing',
    marker: 'Index of /uploads/SYNTHETIC-LISTING',
    where: 'http',
    path: '/uploads/',
    summary: 'Directory listing enabled, exposing uploaded file names.',
    severity: 'low',
  },
];

/** The ten markers, in manifest order — the scenario's keyFacts. */
export const vulnerabilityMarkers = () => VULNERABILITIES.map((v) => v.marker);

/** The subset planted in recorded traffic rows (the `traffic_query` read path). */
export const trafficVulnerabilities = () => VULNERABILITIES.filter((v) => v.where === 'traffic');

/** The subset planted in the fixture server (the `http_get` read path). */
export const httpVulnerabilities = () => VULNERABILITIES.filter((v) => v.where === 'http');

/**
 * Findings recall: how many of the markers the agent surfaced, which they were, and
 * which it missed. `text` is the agent's whole graded answer (result + ReportFindings),
 * so a marker quoted in either place counts. `vulns` defaults to this lane's ten; the
 * long lane passes its own list. Pure; no content is stored, only the ids.
 */
export const gradeRecall = (text, vulns = VULNERABILITIES) => {
  const haystack = String(text ?? '');
  const found = [];
  const missed = [];
  for (const v of vulns) (haystack.includes(v.marker) ? found : missed).push(v.id);
  return { total: vulns.length, found, missed, recall: found.length };
};

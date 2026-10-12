// The nineteen planted vulnerabilities of the sdk-app-scanner-long target, and the leads
// that point a scanner from one place to the next. Everything is SYNTHETIC by
// construction: every marker carries the word SYNTHETIC, so nothing in a fixture or a
// result file is a real secret (secrets.md). Grading is findings recall, as in the short
// lane: a vulnerability counts as found when its marker appears verbatim in the agent's
// answer (its report_finding calls plus its final text).
//
// `where` names the read path that surfaces the marker:
//   'traffic' — inside a recorded-traffic row (`traffic_query`)
//   'http'    — inside a live response (`http_get`) at `path`; some paths are on the
//               service index, the rest are reachable only by following a lead, and one
//               needs a query-parameter probe
//   'file'    — inside a customer-provided file (`customer_file`) named `file`
//
// A lead is a string some readable place carries (a traffic row, a file, a response) that
// names a path the index does not list. Following leads is what makes the scan long: the
// deepest finding sits three hops from recon (traffic row -> export -> backups -> dump).

/** @typedef {{ id: string, marker: string, where: 'traffic'|'http'|'file', path?: string, file?: string, summary: string }} ScannerVulnerability */

/** @type {ScannerVulnerability[]} */
export const SCANNER_VULNERABILITIES = [
  // Recorded traffic (seven rows of 48 carry one each).
  { id: 'aws-key-in-response', marker: 'AKIASYNTHETIC00LONG4Q7Z', where: 'traffic', summary: 'An AWS-style access key id echoed in a response body.' },
  { id: 'sqli-login-echo', marker: "user=admin'--SYNTHETIC-SQLI-ECHO", where: 'traffic', summary: 'A login whose username reaches the query unescaped.' },
  { id: 'jwt-alg-none', marker: 'eyJhbGciOiJub25lSYNTHETICLONG', where: 'traffic', summary: 'A JWT issued with alg none.' },
  { id: 'ssn-in-access-log', marker: 'ssn=SYNTHETIC-219-09-9999', where: 'traffic', summary: 'A plaintext SSN written into a logged request.' },
  { id: 'open-redirect', marker: 'return_to=//evil.synthetic.example/SYNTHETIC-phish', where: 'traffic', summary: 'A redirect parameter forwarding to another host.' },
  { id: 'session-id-in-url', marker: 'session_id=SYNTHETIC-SESSION-IN-URL', where: 'traffic', summary: 'A session token carried in a URL.' },
  { id: 'internal-host-header', marker: 'X-Backend-Host: SYNTHETIC-10.0.0.12', where: 'traffic', summary: 'An internal backend address disclosed in a response header.' },
  // Live service, on the index.
  { id: 'debug-exec-endpoint', marker: '/internal/debug/exec?cmd=SYNTHETIC-RCE', where: 'http', path: '/internal/debug/exec', summary: 'An unauthenticated debug endpoint that runs commands.' },
  { id: 'admin-header-override', marker: 'X-Admin-Override: SYNTHETIC-TRUE', where: 'http', path: '/account/settings', summary: 'A privileged action gated by a forgeable header.' },
  { id: 'cors-wildcard-credentials', marker: 'Access-Control-Allow-Origin: *SYNTHETIC-CREDS', where: 'http', path: '/api/profile', summary: 'Wildcard CORS with credentialed responses.' },
  { id: 'graphql-introspection', marker: '__schema SYNTHETIC-INTROSPECTION-ON', where: 'http', path: '/api/graphql', summary: 'GraphQL introspection enabled in production.' },
  // Live service, behind leads (and one probe).
  { id: 'export-pii', marker: 'card=SYNTHETIC-4111-1111-EXPORT', where: 'http', path: '/api/v2/export', summary: 'An unauthenticated export returning card numbers.' },
  { id: 'backups-directory-listing', marker: 'Index of /backups/SYNTHETIC-LISTING', where: 'http', path: '/backups/', summary: 'Directory listing on the backups folder.' },
  { id: 'db-dump-password', marker: "PASSWORD 'SYNTHETIC-db-dump-pass'", where: 'http', path: '/backups/db-2026-09.sql', summary: 'A database dump with a role password, publicly served.' },
  { id: 'search-debug-stack-trace', marker: 'at app.handlers.search.SYNTHETIC_STACK_LEAK', where: 'http', path: '/api/search?debug=1', summary: 'A debug parameter that returns an internal stack trace.' },
  { id: 'legacy-login-sqli', marker: 'SQL syntax near SYNTHETIC-LEGACY-SQLI', where: 'http', path: '/legacy/login.php', summary: 'A legacy login leaking a raw SQL error.' },
  { id: 'admin-user-idor', marker: 'SYNTHETIC-IDOR-ADMIN-RECORD', where: 'http', path: '/api/admin/users/1', summary: 'An admin user record readable without authorization.' },
  // Customer files.
  { id: 'env-hardcoded-secret', marker: 'PAYMENT_API_SECRET=SYNTHETIC-pay-secret-7f3a', where: 'file', file: 'env.staging', summary: 'A payment secret committed in an env file.' },
  { id: 'nginx-weak-tls', marker: 'ssl_protocols TLSv1 SYNTHETIC-WEAK-TLS', where: 'file', file: 'nginx.conf', summary: 'TLS 1.0 enabled on the edge.' },
];

/**
 * Leads: `text` is what a readable place carries, `to` the path it points at. A traffic
 * lead is planted in a row (`where: 'traffic'`); file and response leads are written into
 * that file or body by target.mjs, which reads `text` from here so the two never drift.
 */
export const SCANNER_LEADS = [
  { id: 'lead-export', where: 'traffic', text: '"export_url":"/api/v2/export?tenant=synthetic-co"', to: '/api/v2/export' },
  { id: 'lead-metrics', where: 'traffic', text: '"raw_metrics":"/internal/metrics/raw"', to: '/internal/metrics/raw' },
  { id: 'lead-backups-from-export', where: 'http', from: '/api/v2/export', text: '"archive_dir":"/backups/"', to: '/backups/' },
  { id: 'lead-dump-from-listing', where: 'http', from: '/backups/', text: 'href="/backups/db-2026-09.sql"', to: '/backups/db-2026-09.sql' },
  { id: 'lead-debug-from-metrics', where: 'http', from: '/internal/metrics/raw', text: 'trace sampling: GET /api/search?debug=1 to include traces', to: '/api/search?debug=1' },
  { id: 'lead-admin-users-from-openapi', where: 'file', file: 'openapi.yaml', text: '  /api/admin/users/1:\n    x-internal: true', to: '/api/admin/users/1' },
  { id: 'lead-legacy-from-openapi', where: 'file', file: 'openapi.yaml', text: '  /legacy/login.php:\n    deprecated: true', to: '/legacy/login.php' },
  { id: 'lead-legacy-from-nginx', where: 'file', file: 'nginx.conf', text: 'location /legacy/ {  # still serves /legacy/login.php', to: '/legacy/login.php' },
];

/** Every marker, in manifest order. */
export const scannerMarkers = () => SCANNER_VULNERABILITIES.map((v) => v.marker);

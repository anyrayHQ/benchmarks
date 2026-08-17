// Render COVERAGE.md — the registry ↔ benchmark ↔ docs coverage matrix.
//
// Sourced from the committed, reproducible data so it cannot drift from the
// scores: config.yaml (which workloads pin which strategy), optimized.json
// (measured saving, whether the strategy fired), quality.json (key-fact
// survival). The registry column — the 23 kinds, their cache flags, and their
// shipped-default enablement — is a hand-maintained mirror of the monorepo,
// which is NOT a dependency of this repo; REGISTRY_MIRROR below carries the
// provenance for each field so a reviewer can re-derive it.
//
// Regenerate with `npm run coverage` after `npm run bench:all` /
// `npm run quality:all`. tests/consistency.test.mjs asserts the rendered table
// still matches the JSON.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, suiteNames } from './loadConfig.mjs';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * The 23 registered kinds, mirrored from the monorepo. Provenance:
 *   order + membership  — optimizer/src/strategies/index.ts  (REGISTRY)
 *   cacheBusting / cacheSuffixSafe / prefixCacheBusting
 *                       — each strategy's declaration in optimizer/src/strategies/
 *   enabled             — optimizer/optimizer.config.json, the config BAKED INTO
 *                         the image and the seed for a fresh deployment. Note
 *                         this is the shipped default, NOT DEFAULT_CONFIG in
 *                         config.ts: that literal is only the fallback when the
 *                         baked file is unreadable, and the two differ —
 *                         thinking_trim is enabled in the baked file and absent
 *                         from DEFAULT_CONFIG entirely.
 *   docs                — pages under docs/docs/ that describe the kind
 *
 * `enabled: 'n/a'` means the kind takes no per-strategy toggle: audited_holdout
 * is assigned by the top-level `holdout` block (shipped `enabled: false`) and
 * appears in neither strategies array.
 *
 * `docsRef` records where the kind is described for a customer. A kind can be
 * thoroughly documented under its HUMAN NAME while its raw id never appears —
 * audited_holdout is exactly that case — so this column is the result of
 * grepping both, never the id alone.
 */
export const REGISTRY_MIRROR = [
  { kind: 'audited_holdout', flags: [], enabled: 'n/a', docsRef: 'human name only ("audited holdout", 7 pages); id only in the protocol page' },
  { kind: 'prompt_compression', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'context_dedupe', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'observation_mask', flags: ['cacheBusting', 'cacheSuffixSafe'], enabled: true, docsRef: 'strategy page' },
  { kind: 'command_digest', flags: ['cacheBusting'], enabled: true, docsRef: 'strategy page' },
  { kind: 'context_compression', flags: ['cacheBusting'], enabled: true, docsRef: 'strategy page' },
  { kind: 'code_graph', flags: ['cacheBusting'], enabled: true, docsRef: 'strategy page' },
  { kind: 'relevance_filter', flags: ['cacheBusting', 'cacheSuffixSafe'], enabled: true, docsRef: 'strategy page' },
  { kind: 'window_budget', flags: ['cacheBusting', 'cacheSuffixSafe'], enabled: false, docsRef: 'strategy page' },
  { kind: 'provider_context_trim', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'output_shaping', flags: [], enabled: false, docsRef: 'CHANGELOG ONLY — no reference page' },
  { kind: 'reasoning_budget', flags: ['cacheBusting', 'prefixCacheBusting'], enabled: false, docsRef: 'strategy page' },
  { kind: 'thinking_trim', flags: ['cacheBusting'], enabled: true, docsRef: 'strategy + guardrails + protocol' },
  { kind: 'tool_pruning', flags: ['cacheBusting', 'prefixCacheBusting'], enabled: false, docsRef: 'strategy page' },
  { kind: 'tool_schema_compression', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'param_tuning', flags: [], enabled: false, docsRef: 'strategy page' },
  { kind: 'vision_ocr', flags: ['cacheBusting'], enabled: false, docsRef: 'strategy page' },
  { kind: 'semantic_cache', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'cache_optimizer', flags: [], enabled: true, docsRef: 'strategy page' },
  { kind: 'context_quality', flags: [], enabled: false, docsRef: 'ABSENT — id and human name both' },
  { kind: 'content_census', flags: [], enabled: true, docsRef: 'PROTOCOL ONLY (as "census") — no reference page' },
  { kind: 'cache_lint', flags: [], enabled: true, docsRef: 'CHANGELOG ONLY — no reference page' },
  { kind: 'output_externalize', flags: ['cacheBusting'], enabled: false, docsRef: 'strategy page' },
];

/**
 * Why each uncovered kind is uncovered, and what it would take to cover it.
 * Keyed by kind; only consulted for kinds with no workload, so a kind that
 * gains one silently drops out of the section rather than going stale.
 */
export const UNCOVERED_NOTES = {
  thinking_trim: {
    verdict: 'uncovered — benchmarkable, and the gap that matters',
    why:
      'Nothing gates it — no workload in `config.yaml` names it. Note this is NOT a config-enablement ' +
      'question: the harness force-enables the hero per workload (`setStrategy` PUTs `enabled: true`, and ' +
      '`optimize()` is called with `enabledKinds: [strategy]`), so whatever a deployment has on by default ' +
      'is irrelevant to what this suite measures. The kind is simply absent from the workload list.',
    proof:
      'Verified directly against the strategy, not inferred. Driving a synthetic 8-tool-loop transcript ' +
      'through the real `optimize()` pipeline pinned to `thinking_trim` fires it for **12% whole-request ' +
      'reduction on BOTH `/v1/messages` and `/v1/chat/completions`** — there is no endpoint allowlist, the ' +
      'strategy gates on message SHAPE, so no new harness capability is needed. Two things a fixture must ' +
      'get right: the thinking blocks have to be **opaque** (empty `thinking` text plus a signature, which ' +
      'is what `thinking.display: "omitted"` makes every current Claude model replay, and the lane ' +
      '`cutOpaqueChain` serves); and tool results must differ per turn, or `context_dedupe` collapses them ' +
      'first and masks the row. A readable-reasoning transcript correctly yields 0% when its anchors are ' +
      'not externalized into the same assistant turn, so that shape measures the guard, not the saving.',
    worth:
      'HIGHEST of the three. Its live share is first-order and volatile: it ran at ~32% of all optimizer ' +
      'token savings, collapsed to ~1.6% when Anthropic made `thinking.display: "omitted"` the default, ' +
      'and was restored by a defaults migration. A swing that large landed with no offline workload able ' +
      'to catch it. Cover this one first.',
  },
  cache_lint: {
    verdict: 'uncovered — measurable only as a signal, not as a saving',
    why:
      'A read-only prefix-churn SENSOR: it returns the request unchanged and emits hashes and counts, so a ' +
      'before/after token delta is 0 by construction. It also measures ACROSS turns (it compares this turn\'s ' +
      'incoming prefix against the previous one), and every workload here is a single stateless request.',
    worth:
      'LOW as a savings row, real as a diagnostic row. The honest shape is the `26-context-quality` / ' +
      '`41-mixed-content-census` pattern — a `diagnostic` tier asserting on the emitted decision, not on a ' +
      'token delta — but it needs a two-turn fixture the harness cannot currently express.',
  },
  audited_holdout: {
    verdict: 'not benchmarkable — by construction',
    why:
      'The control marker itself. It transforms nothing (`run` returns the request byte-identical) and its ' +
      'assignment is owned by the top-level `holdout` block, not a per-strategy toggle, so there is no knob ' +
      'for the harness to pin. Its saving is measured downstream from a treated cohort\'s real spend.',
    worth:
      'NONE here, and recording it as a gap would be the wrong call. This suite is the wrong instrument; ' +
      'the guardrails quality-parity endpoint is the right one.',
  },
};

/** Kinds that appear in this repo's prose but are NOT registry kinds. */
export const NON_REGISTRY_MENTIONS = [
  {
    name: 'code_skeleton',
    what:
      'A RETIRED kind (v0.3.24), superseded by `code_graph` as a strict superset and mutually exclusive ' +
      'with it — the optimizer rejects a config naming both. It was the original `7-codebase-explore` hero, ' +
      'and that workload now runs `code_graph`. Every surviving mention is dated retirement prose in ' +
      'QUALITY.md, RESULTS.md and config.yaml, plus two `tests/live.test.mjs` fixtures using it as an ' +
      'arbitrary label. History, not drift.',
  },
  {
    name: 'context_management',
    what:
      "NOT a retired strategy id and NOT an old name for `context_compression` — it is Anthropic's own " +
      'request field. `provider_context_trim` injects a `clear_tool_uses` edit into it so the provider ' +
      'clears aged tool results server-side, leaving message bytes untouched; `run_benchmark.mjs` asserts ' +
      'on `after.context_management` to score workload `38-anthropic-context-trim`. The two are unrelated: ' +
      '`context_compression` rewrites bytes we send, this one annotates a request so Anthropic drops bytes ' +
      'we keep. Renaming or removing these mentions would break a scored workload.',
  },
];

const flagCell = (flags) => (flags.length ? flags.map((f) => `\`${f}\``).join(' + ') : 'none (deterministic)');

const enabledCell = (v) => {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return 'n/a — top-level `holdout`';
};

/** Collect every configured workload with its committed score + quality verdict. */
export function collectMeasured(cfg = loadConfig()) {
  const byKind = new Map();
  for (const suite of suiteNames(cfg)) {
    const opt = rd(join(cfg.root, suite, 'results', 'optimized.json')) || [];
    const q = new Map((rd(join(cfg.root, suite, 'results', 'quality.json')) || []).map((r) => [r.id, r]));
    for (const r of opt) {
      if (!r.strategy) continue;
      const entry = byKind.get(r.strategy) || [];
      entry.push({ ...r, suite, quality: q.get(r.id) || null });
      byKind.set(r.strategy, entry);
    }
  }
  return byKind;
}

export function renderCoverage(cfg = loadConfig()) {
  const measured = collectMeasured(cfg);
  const total = REGISTRY_MIRROR.length;
  const covered = REGISTRY_MIRROR.filter((r) => measured.has(r.kind));
  // Ranked by what covering it is worth, highest first — the order the ticket
  // asks for. Anything without a note sorts last rather than being dropped.
  const RANK = ['thinking_trim', 'cache_lint', 'audited_holdout'];
  const uncovered = REGISTRY_MIRROR.filter((r) => !measured.has(r.kind)).sort((a, b) => {
    const ia = RANK.indexOf(a.kind);
    const ib = RANK.indexOf(b.kind);
    return (ia < 0 ? RANK.length : ia) - (ib < 0 ? RANK.length : ib);
  });
  const workloadCount = [...measured.values()].reduce((n, rs) => n + rs.length, 0);

  const out = [];
  out.push('<!-- GENERATED by lib/writeCoverage.mjs (npm run coverage). Do not edit by hand. -->');
  out.push('');
  out.push('# Coverage');
  out.push('');
  out.push(
    `Every strategy the optimizer registers, and whether this suite measures it. ` +
      `**${covered.length} of ${total}** registered kinds are covered by ` +
      `**${workloadCount}** workloads; **${uncovered.length}** are not.`
  );
  out.push('');
  out.push(
    'The source of truth for the kind list is `REGISTRY` in the monorepo ' +
      '(`optimizer/src/strategies/index.ts`), not this file, not the docs, and not the console. ' +
      'Where a doc and the registry disagree, the registry wins and the doc is a bug to file.'
  );
  out.push('');

  out.push('## Matrix');
  out.push('');
  out.push('| Kind | Workload(s) | Measured saving | Cache flags | Default on? | Docs | Verdict |');
  out.push('| --- | --- | --: | --- | --- | --- | --- |');
  for (const r of REGISTRY_MIRROR) {
    const rows = measured.get(r.kind) || [];
    const ids = rows.length ? rows.map((x) => `\`${x.id}\``).join(', ') : '—';
    const acc = rows.filter((x) => x.tier === 'accounting').map((x) => x.savedPct);
    const med = median(acc);
    let saving;
    if (!rows.length) saving = '—';
    else if (med === null) saving = `n/a (${rows[0].tier})`;
    else saving = rows.length > 1 ? `${med}% (median of ${rows.length})` : `${med}%`;
    const verdict = rows.length ? 'covered' : 'UNCOVERED';
    out.push(
      `| \`${r.kind}\` | ${ids} | ${saving} | ${flagCell(r.flags)} | ${enabledCell(r.enabled)} | ${r.docsRef} | ${verdict} |`
    );
  }
  out.push('');

  out.push('## The uncovered kinds, ranked by what covering them is worth');
  out.push('');
  if (!uncovered.length) {
    out.push('None — every registered kind has at least one workload.');
  } else {
    out.push('Ranked highest-value first. "Uncovered" and "not benchmarkable" are different findings:');
    out.push('a kind this suite structurally cannot measure is not a gap in the suite.');
    out.push('');
    for (const r of uncovered) {
      const n = UNCOVERED_NOTES[r.kind];
      out.push(`### \`${r.kind}\` — ${n ? n.verdict : 'uncovered'}`);
      out.push('');
      out.push(`Default on? **${enabledCell(r.enabled)}**. Cache flags: ${flagCell(r.flags)}. Docs: ${r.docsRef}.`);
      out.push('');
      if (n) {
        out.push(`**Why it is uncovered.** ${n.why}`);
        out.push('');
        if (n.proof) {
          out.push(`**Measured, not assumed.** ${n.proof}`);
          out.push('');
        }
        out.push(`**What covering it is worth.** ${n.worth}`);
        out.push('');
      }
    }
  }

  out.push('## Docs drift (the third column)');
  out.push('');
  out.push(
    'A code/doc mismatch on a strategy id is a correctness bug in the monorepo: a reader copies a stale ' +
      'id and it silently fails. Four kinds are registered but have no customer-facing reference entry:'
  );
  out.push('');
  out.push('| Kind | Registered | Reference page | Note |');
  out.push('| --- | --- | --- | --- |');
  out.push('| `context_quality` | yes (off by default) | **none** | Absent from the docs entirely: neither the id nor the human name "context quality" appears anywhere under `docs/docs/`. It IS in the console waste catalog. The widest gap of the four. |');
  out.push('| `cache_lint` | yes (**on** by default) | **none** | Changelog only. On by default with no page describing it. |');
  out.push('| `content_census` | yes (**on** by default) | **none** | Protocol page only, as `census`, plus prose mentions on the strategy page. No entry of its own. |');
  out.push('| `output_shaping` | yes (off by default) | **none** | Changelog only. |');
  out.push('');
  out.push(
    'Not drift, though an id-only search says otherwise: **`audited_holdout`** is documented across seven ' +
      'pages under its human name, "audited holdout" — only the raw id is missing from the strategy page. ' +
      'The method lesson: **grep the human name as well as the id before recording a miss.**'
  );
  out.push('');

  out.push('## Mentioned here but not registry kinds');
  out.push('');
  for (const m of NON_REGISTRY_MENTIONS) {
    out.push(`- **\`${m.name}\`** — ${m.what}`);
  }
  out.push('');
  return out.join('\n');
}

export function writeCoverage(cfg = loadConfig()) {
  const md = renderCoverage(cfg);
  writeFileSync(join(cfg.root, 'COVERAGE.md'), `${md}\n`);
  return md;
}

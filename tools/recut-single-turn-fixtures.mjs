#!/usr/bin/env node
// Re-cut single-turn fixtures so their tool output is HISTORY, not the live turn.
//
// WHY: the optimizer refuses to rewrite tool output the model has not read yet
// (freshInput.ts, #536 / 8e6718c9, 2026-07-02) — a correct guard, because
// trimming output before the model has seen it destroys the current turn's
// input. But a fixture shaped
//
//     user(ask) -> assistant(tool_call) -> tool(big)
//
// puts the entire measured payload in that protected zone, so every eliding
// strategy no-ops and the workload measures 0%. Eight fixtures in this repo were
// authored 2026-07-01, one day before that guard shipped, and were never
// re-measured against it.
//
// The realistic shape is the same conversation one turn later: the read is a
// COMPLETED prior step, and the live turn is the user's question about what was
// read. That is what a coding agent actually sends on the turn where trimming
// history pays off.
//
//     user(ask) -> assistant(tool_call) -> tool(big)
//                -> assistant(ack) -> user(the original question, verbatim)
//
// The original question is reused verbatim as the live turn, so the
// answer-bearing key facts in keyfacts.json still describe exactly what the
// request needs, and the intent text every relevance-ranking strategy keys off
// is unchanged.
//
// Idempotent: a fixture that already ends with a user turn after an assistant
// reply is left alone.
//
// Usage:  node tools/recut-single-turn-fixtures.mjs [--check]
//         --check exits 1 if any fixture still needs re-cutting (for CI).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// The eight fixtures whose payload is entirely inside the fresh-input zone.
const TARGETS = [
  ['logs-and-data', '29-orders-json'],
  ['logs-and-data', '30-metrics-json'],
  ['code-context', '15-multifile-graph'],
  ['code-context', '17-python-multifile'],
  ['code-context', '27-read-service-ts'],
  ['code-context', '28-read-module-py'],
  ['tools-and-rag', '32-vocab-mismatch-rag'],
  ['memory-recall', '18-session-recall'],
];

const ACK = 'Loaded. What would you like to know about it?';

/**
 * Indent width the file already uses, so re-writing it does not reformat every
 * line. Payloads here are a mix of 2- and 4-space; a blanket JSON.stringify(…, 2)
 * turns a 5-line edit into a whole-file diff.
 */
const detectIndent = (source) => {
  const secondLine = source.split('\n')[1] ?? '';
  const leading = secondLine.match(/^[ \t]+/)?.[0];
  return leading && leading.length > 0 ? leading.length : 2;
};

/**
 * True when the last message is a user turn preceded by an assistant reply.
 *
 * Tests the SHAPE, not the ack wording. The recut is defined by where the tool
 * output sits — history rather than the live turn — and every fixture reaching
 * that shape satisfies it regardless of which ack text carried it there. Pinning
 * the literal ACK made this report a hand-written, per-fixture ack as stale, and
 * a re-run then appended a SECOND ack/question pair on top of a fixture that was
 * already correct — silently changing the payload every committed number was
 * measured against.
 */
const alreadyRecut = (messages) => {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  return (
    last.role === 'user' &&
    prev.role === 'assistant' &&
    typeof prev.content === 'string' &&
    prev.content.length > 0
  );
};

let changed = 0;
const stale = [];

for (const [suite, id] of TARGETS) {
  const path = join(ROOT, suite, 'payloads', `${id}.json`);
  const source = readFileSync(path, 'utf8');
  const payload = JSON.parse(source);
  const messages = payload.messages ?? [];

  if (alreadyRecut(messages)) continue;

  const question = messages.find((m) => m.role === 'user')?.content;
  if (typeof question !== 'string' || question.length === 0) {
    throw new Error(`${suite}/${id}: no user question to carry forward`);
  }

  if (CHECK) {
    stale.push(`${suite}/${id}`);
    continue;
  }

  payload.messages = [
    ...messages,
    { role: 'assistant', content: ACK },
    { role: 'user', content: question },
  ];
  writeFileSync(path, `${JSON.stringify(payload, null, detectIndent(source))}\n`);
  console.log(`re-cut ${suite}/${id}`);
  changed++;
}

if (CHECK) {
  if (stale.length) {
    console.error(`Fixtures still single-turn (tool output in the fresh-input zone):\n  ${stale.join('\n  ')}`);
    console.error('Run: node tools/recut-single-turn-fixtures.mjs');
    process.exit(1);
  }
  console.log('All target fixtures are multi-turn.');
} else {
  console.log(changed === 0 ? 'Nothing to do — all target fixtures already multi-turn.' : `Re-cut ${changed} fixture(s). Re-run the benchmark and quality suites.`);
}

#!/usr/bin/env node
// What happened at each cold turn of a pause-scenario round, per arm, from its result file.
//
// A cold turn is the first main-thread request after an idle gap long enough for the
// provider's prompt cache to have expired. Per arm: cost with the gateway's pings in,
// turns, requests, cache breaks, retrievals, solved, and which kind the gateway's session
// gate held out. Per cold turn: whether the gateway attested the expiry to its optimizer,
// the tokens each strategy removed (the optimizer's estimates), whether a strategy counted
// the write it avoided (`cold_write_saving_usd`), what the provider wrote and read, and why
// a strategy declined. A round that cannot be read as a comparison says why.
//
// Reads only the result file: no gateway access, nothing written.
//
// Usage:
//   node tools/cold-turns.mjs results/agent/<scenario>--gateway--<label>.json [--json]

import { readFileSync } from 'node:fs';
import { coldTurnReport, formatColdTurnReport } from '../lib/coldTurns.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/cold-turns.mjs <result file> [--json]');
  process.exit(2);
}
const record = JSON.parse(readFileSync(file, 'utf8'));
const report = coldTurnReport(record);
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${record.scenario?.name ?? file} [${record.compare ?? '?'}]${record.label ? ` ${record.label}` : ''}${report.treated ? ` · arm B carries experiment=${report.treated}` : ''}`);
  console.log(formatColdTurnReport(report));
}

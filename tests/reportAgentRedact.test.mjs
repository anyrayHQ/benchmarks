// `node report_agent.mjs --redact` (ANY-1487): the paired-runs page without what a scenario's
// owner would not hand to a finance team. Today the page embeds every record whole: the task
// (around L324), the repo URL (around L321), the check command, each arm's answer, tool calls,
// diff and check output. Redacted, it keeps the scenario name, costs, ratios and verdicts.
// Run in a kit copy so the page and its records stay out of this checkout's results/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REF, tempDir } from './kitFixtures.mjs';
import { MARK, contentRound, kitRunCopy, leaks } from './kitRunFixtures.mjs';

const A_COST = 1.234567;
const B_COST = 0.617283;

/** A record as run_agent.mjs writes one today: the scenario whole, each round's sessions whole. */
function fullRecord() {
  const repo = `https://git.example.test/acme/${MARK.repo}.git`;
  const patch = `${MARK.patchName}.patch`;
  const round = contentRound(1, A_COST, B_COST);
  for (const slot of ['a', 'b']) Object.assign(round.sessions[slot].totals, { turns: 4, requests: 6, subagents: 0, toolCalls: 1, input: 1000, output: 50, wallMs: 1000, models: ['claude-sonnet-5'], subagentInputShare: 0 });
  return {
    scenario: {
      name: 'acme-fix',
      title: `Fix it ${MARK.title}`,
      source: 'client',
      repo: { git: repo, ref: REF },
      patch,
      task: `${MARK.task} CI is red: not ok 1 - ${MARK.paste}`,
      followups: [`Then ${MARK.followup}.`],
      check: `cat check-out.log # ${MARK.checkCmd}`,
      keyFacts: [MARK.keyFact],
      repoInfo: { git: repo, ref: REF, patch, files: 3, lines: 10, byExt: [['.js', { files: 3, lines: 10 }]], tree: ['app.js'] },
    },
    compare: 'anyray',
    label: null,
    arms: { a: 'direct', b: 'anyray' },
    rounds: [round],
    stats: { n: 1, verdict: 'INCONCLUSIVE', reasons: [] },
  };
}

function page(t, args) {
  const copy = kitRunCopy(tempDir(t, 'kit-report-agent-'));
  const out = join(copy.root, 'results', 'agent');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'acme-fix--anyray.json'), JSON.stringify(fullRecord()));
  const child = spawnSync(process.execPath, [join(copy.root, 'report_agent.mjs'), ...args], { cwd: copy.root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `report_agent ${args.join(' ')} failed: ${child.stderr}`);
  return readFileSync(join(out, 'report.html'), 'utf8');
}

test('report_agent.mjs --redact writes the page without the task, repo URL, patch, check, key facts, answers, tool I/O or diffs', (t) => {
  const plain = page(t, []);
  assert.ok(leaks(plain).includes('task') && leaks(plain).includes('repo'), 'without --redact the page embeds the record whole (the markers were there to drop)');

  const html = page(t, ['--redact']);
  assert.deepEqual(leaks(html), [], 'the redacted page carries scenario content');
  assert.ok(html.includes('acme-fix'), 'it still names the scenario');
  assert.ok(html.includes(String(A_COST)) && html.includes(String(B_COST)), 'it still carries both arms\' costs');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSession, answerText, checkCitations } from '../lib/agentRun.mjs';
import { solved } from '../run_agent.mjs';

// Claude Code 2.1.296 has a ReportFindings tool; a doc-audit session may file its findings
// with it and end on a one-line summary. Shapes as the stream writes them.
const call = (msgId, toolId, findings, { parent = null } = {}) => JSON.stringify({
  type: 'assistant', parent_tool_use_id: parent,
  message: { id: msgId, model: 'claude-sonnet-5', usage: {}, content: [{ type: 'tool_use', id: toolId, name: 'ReportFindings', input: { findings } }] },
});
const reply = (toolId, content, { isError = false, parent = null } = {}) => JSON.stringify({
  type: 'user', parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }] },
});
const finding = (file, line, summary) => ({ file, line, category: 'correctness', summary, failure_scenario: `Compare with utils.go:${line + 1}.`, short_summary: 'short' });
const findings = [finding('README.md', 20, 'Claim is unsupported.'), finding('docs/doc.md', 1626, 'binding.Form is not a BindingBody.')];
const result = (text) => JSON.stringify({ type: 'result', subtype: 'success', result: text, num_turns: 9, total_cost_usd: 1.9, modelUsage: {} });

const session = () => parseSession([
  call('m1', 'rf1', findings),
  reply('rf1', '<tool_use_error>InputValidationError: short_summary too big</tool_use_error>', { isError: true }),
  call('s1', 'rf-sub', [finding('gin.go', 5, 'a subagent finding')], { parent: 'ag1' }),
  reply('rf-sub', '1 findings reported.', { parent: 'ag1' }),
  call('m2', 'rf2', findings),
  reply('rf2', '2 findings reported.'),
  result('Audit complete — 2 verified discrepancies.'),
]);

test('parseSession keeps the findings of the main agent\'s accepted ReportFindings calls only', () => {
  const s = session();
  assert.deepEqual(s.reportedFindings.map((f) => `${f.file}:${f.line}`), ['README.md:20', 'docs/doc.md:1626'], 'not the rejected call, not the subagent\'s');
});

test('answerText grades the result text and each filed finding as file:line — summary — failure scenario', () => {
  assert.equal(
    answerText(session()),
    'Audit complete — 2 verified discrepancies.\n\n' +
      'README.md:20 — Claim is unsupported. — Compare with utils.go:21.\n\n' +
      'docs/doc.md:1626 — binding.Form is not a BindingBody. — Compare with utils.go:1627.',
  );
  assert.equal(answerText({ result: { text: 'just text' } }), 'just text');
  assert.equal(answerText({ result: null }), '');
});

test('the citation check counts filed findings at the same bar as written ones', () => {
  const work = mkdtempSync(join(tmpdir(), 'bench-findings-'));
  try {
    mkdirSync(join(work, 'docs'));
    writeFileSync(join(work, 'README.md'), 'x\n'.repeat(30));
    writeFileSync(join(work, 'docs', 'doc.md'), 'x\n'.repeat(2000));
    writeFileSync(join(work, 'utils.go'), 'x\n'.repeat(50));
    const c = checkCitations(answerText(session()), work, []);
    // README.md:20, docs/doc.md:1626 and utils.go:21 resolve; utils.go:1627 is past the end.
    assert.deepEqual([c.total, c.resolved], [4, 3]);
    const scenario = { citations: { min: 3, resolveRate: 0.75 } };
    assert.equal(solved(scenario, { citations: c }), true);
    assert.equal(solved({ citations: { min: 3, resolveRate: 0.9 } }, { citations: c }), false, 'the resolve rate still applies');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('key facts are looked for in the filed findings too', () => {
  assert.equal(solved({ keyFacts: ['BindingBody', 'unsupported'] }, session()), true);
  assert.equal(solved({ keyFacts: ['not anywhere'] }, session()), false);
});

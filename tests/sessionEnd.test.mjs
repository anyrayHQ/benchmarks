import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

import { driveSession, sessionWatch, ANSWER_SETTLE_MS, TERM_GRACE_MS } from '../lib/sessionEnd.mjs';
import { parseSession, sessionWallMs, followupDelayMs } from '../lib/agentRun.mjs';
import { summarize, roundRatio, endNote } from '../run_agent.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- fakes -----------------------------------------------------------------------------

/** A virtual clock: timers run only when the test advances time. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (f, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, f });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].f();
      }
      now = target;
    },
  };
}

/** A stand-in for the spawned `claude` process. It exits on the signals in `exitOn`. */
function fakeChild({ exitOn = ['SIGTERM', 'SIGKILL'], onTurn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.turns = [];
  child.stdinEnded = false;
  child.signals = [];
  child.stdin = {
    write: (s) => {
      const text = JSON.parse(s).message.content;
      child.turns.push(text);
      onTurn?.(text, child.turns.length - 1);
    },
    end: () => (child.stdinEnded = true),
  };
  child.emitLine = (obj) => child.stdout.emit('data', JSON.stringify(obj) + '\n');
  child.exit = (code = 0) => {
    if (child.closed) return;
    child.closed = true;
    child.emit('close', code);
  };
  child.kill = (sig) => {
    child.signals.push(sig);
    if (exitOn.includes(sig)) child.exit(sig === 'SIGTERM' ? 143 : null);
  };
  return child;
}

// stream-json events, shaped as Claude Code 2.1.296 writes them
const init = () => ({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5', tools: [] });
const msgStart = (id, { parent = null, usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } = {}) =>
  ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id, model: 'claude-sonnet-5', usage: { ...usage, output_tokens: 1 } } } });
const msgDelta = (id, { stop = 'end_turn', out = 50, parent = null } = {}) =>
  ({ type: 'stream_event', parent_tool_use_id: parent, api_message_id: id, event: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: out } } });
const textDelta = (id) => ({ type: 'stream_event', parent_tool_use_id: null, api_message_id: id, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });
const text = (id, t, { parent = null } = {}) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 1 }, content: [{ type: 'text', text: t }] } });
const toolUse = (id, name, input = {}, { parent = null, toolId = `tu-${id}` } = {}) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 1 }, content: [{ type: 'tool_use', id: toolId, name, input }] } });
const toolResult = (toolId, content, { parent = null } = {}) =>
  ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] } });
const result = (t, cost = 0.5) => ({ type: 'result', subtype: 'success', result: t, num_turns: 3, total_cost_usd: cost, duration_ms: 1000, modelUsage: {} });
const taskStarted = (id, type = 'local_agent') => ({ type: 'system', subtype: 'task_started', task_id: id, task_type: type });
const taskDone = (id) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed' });
const idle = () => ({ type: 'system', subtype: 'session_state_changed', state: 'idle' });

/** Lines and times as driveSession records them: [[ms, event], …] → { lines, times }. */
const timed = (pairs) => ({ lines: pairs.map(([, e]) => JSON.stringify(e)), times: pairs.map(([t]) => t) });

// --- sessionWatch ------------------------------------------------------------------------

test('sessionWatch: answered needs a result last, input closed and no background task', () => {
  const w = sessionWatch();
  w.observe(init());
  assert.equal(w.answered(), false);
  w.observe(result('done'));
  assert.equal(w.answered(), true);
  w.observe(idle()); // state reports do not undo it
  assert.equal(w.answered(), true);
  w.observe(init()); // a new turn does
  assert.equal(w.answered(), false);

  const bg = sessionWatch();
  bg.observe(taskStarted('a1'));
  bg.observe(result('status'));
  assert.equal(bg.answered(), false, 'a background agent still runs');
  bg.observe(taskDone('a1'));
  assert.equal(bg.answered(), true, 'its notification only reports state');

  const streamed = sessionWatch({ inputOpen: true });
  streamed.observe(result('turn 1'));
  assert.equal(streamed.answered(), false, 'a follow-up may still come');
  streamed.closeInput();
  assert.equal(streamed.answered(), true);
});

test('sessionWatch tracks whether a wakeup is still scheduled', () => {
  const w = sessionWatch();
  w.observe(toolResult('t1', 'Next wakeup scheduled for 05:30:00 (in 283s).'));
  assert.equal(w.wakeupPending, true);
  w.observe(toolResult('t2', 'Loop stopped — any dynamic loop in this session is ended.'));
  assert.equal(w.wakeupPending, false);
  w.observe(toolResult('t3', 'Next wakeup scheduled for 05:31:00 (in 60s).', { parent: 'sub-1' }));
  assert.equal(w.wakeupPending, false, "a subagent's tool result is not the main agent's wakeup");
});

// --- driveSession: prompt sessions ---------------------------------------------------------

test('driveSession: a session that exits on its own after answering ends "exited"', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  clock.advance(1000);
  child.emitLine(init());
  clock.advance(4000);
  child.emitLine(result('FINAL ANSWER'));
  child.exit(0);
  const r = await done;
  assert.equal(r.end.reason, 'exited');
  assert.deepEqual(r.times, [1000, 5000]);
  assert.deepEqual(child.signals, []);
});

test('driveSession: a session that answers and then lingers on a pending wakeup is ended once it settles', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(init());
  child.emitLine(toolUse('m1', 'ScheduleWakeup', { delaySeconds: 600 }, { toolId: 'w1' }));
  child.emitLine(toolResult('w1', 'Next wakeup scheduled for 05:37:00 (in 623s).'));
  clock.advance(240000);
  child.emitLine(result('the full audit report'));
  child.emitLine(idle());
  clock.advance(ANSWER_SETTLE_MS - 1);
  assert.deepEqual(child.signals, [], 'not before it has been quiet for the settle window');
  clock.advance(1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  const r = await done;
  assert.equal(r.end.reason, 'answered');
  assert.equal(r.end.atMs, 240000 + ANSWER_SETTLE_MS);
  assert.equal(r.end.wakeupPending, true);
  assert.equal(r.stderr.includes('timed out'), false);
});

test('driveSession: a new turn inside the settle window (a wakeup, an agent report) keeps the session going', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(result('status: waiting'));
  clock.advance(10000);
  child.emitLine(init());
  clock.advance(ANSWER_SETTLE_MS); // the new turn works longer than the window
  assert.deepEqual(child.signals, []);
  child.emitLine(text('m2', 'FINAL ANSWER'));
  child.emitLine(result('FINAL ANSWER'));
  clock.advance(ANSWER_SETTLE_MS);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal((await done).end.reason, 'answered');
});

test('driveSession: while a background task runs the session is not ended, however quiet', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(taskStarted('b1', 'local_bash'));
  child.emitLine(result('answered; a background command still runs'));
  clock.advance(120000);
  assert.deepEqual(child.signals, []);
  child.emitLine(taskDone('b1'));
  clock.advance(ANSWER_SETTLE_MS);
  assert.deepEqual(child.signals, ['SIGTERM']);
  const r = await done;
  assert.equal(r.end.reason, 'answered');
  assert.equal(r.end.runningTasks, 0);
});

test('driveSession: killed with SIGKILL at the timeout, with the reason and a timed-out note', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(init());
  child.emitLine(taskStarted('a1'));
  child.emitLine(result('status: waiting on one agent'));
  clock.advance(360000);
  assert.deepEqual(child.signals, ['SIGKILL']);
  const r = await done;
  assert.equal(r.end.reason, 'timeout');
  assert.equal(r.end.runningTasks, 1);
  assert.match(r.stderr, /^timed out after 6 min/);
});

test('driveSession: a session that ignores SIGTERM gets SIGKILL after the grace period', async () => {
  const clock = fakeClock();
  const child = fakeChild({ exitOn: ['SIGKILL'] });
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(result('done'));
  clock.advance(ANSWER_SETTLE_MS);
  assert.deepEqual(child.signals, ['SIGTERM']);
  clock.advance(TERM_GRACE_MS);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal((await done).end.reason, 'answered');
});

test('driveSession: an abort (pair redrawn) kills the session at once', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const ac = new AbortController();
  const done = driveSession({ child, timeoutMs: 360000, clock, signal: ac.signal });
  child.emitLine(init());
  ac.abort();
  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal((await done).end.reason, 'aborted');
});

test('driveSession keeps each request start and end of the partial-message stream, not its deltas', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, timeoutMs: 360000, clock });
  child.emitLine(msgStart('m1'));
  clock.advance(100);
  for (let i = 0; i < 5; i++) child.emitLine(textDelta('m1'));
  child.emitLine(text('m1', 'hi'));
  clock.advance(100);
  child.emitLine(msgDelta('m1'));
  child.exit(0);
  const r = await done;
  assert.deepEqual(r.lines.map((l) => JSON.parse(l).event?.type ?? JSON.parse(l).type), ['message_start', 'assistant', 'message_delta']);
  assert.deepEqual(r.times, [0, 100, 200]);
});

// --- driveSession: pause / follow-up scenarios ------------------------------------------------

const PAUSE_SCENARIOS = ['cobra-pause', 'cobra-3pause', 'gin-long-session', 'pyrepo-long-session', 'pyrepo-long-session-cold'];
const loadScenario = (name) => parseYaml(readFileSync(join(root, 'scenarios', name, 'scenario.yaml'), 'utf8'));

for (const name of PAUSE_SCENARIOS) {
  test(`driveSession: ${name} gets every follow-up after its pause and is ended only after the last turn`, async () => {
    const scenario = loadScenario(name);
    const followups = scenario.followups ?? [];
    assert.ok(followups.length > 0, `${name} has follow-ups`);
    const timeoutMs = (scenario.timeoutMin ?? 6) * 60000;
    const WORK_MS = 90000; // each turn works this long, then answers
    const clock = fakeClock();
    const resultAt = [];
    const sentAt = [];
    const child = fakeChild({
      onTurn: (t, i) => {
        sentAt.push(clock.now());
        clock.setTimeout(() => {
          child.emitLine(init());
          child.emitLine(text(`m${i}`, `answer ${i}`));
          child.emitLine(result(`answer ${i}`));
          child.emitLine(idle()); // a streamed session reports idle between turns
          resultAt.push(clock.now());
        }, WORK_MS);
      },
    });
    const done = driveSession({ child, firstTurn: scenario.task, followups, followupDelayMs: (i) => followupDelayMs(scenario, i), timeoutMs, clock });
    // Run the session through its pauses, a minute at a time.
    while (!child.closed && clock.now() < timeoutMs) {
      clock.advance(60000);
      if (!child.stdinEnded) assert.deepEqual(child.signals, [], `no signal while turns remain (t=${clock.now() / 1000}s)`);
    }
    const r = await done;
    assert.deepEqual(child.turns, [scenario.task, ...followups], 'the task, then each follow-up in order');
    for (let i = 0; i < followups.length; i++) {
      assert.equal(sentAt[i + 1] - resultAt[i], followupDelayMs(scenario, i), `follow-up ${i + 1} waits its pause after the previous answer`);
    }
    assert.equal(child.stdinEnded, true, 'input closed after the last answer');
    assert.equal(r.end.reason, 'answered');
    assert.equal(r.end.atMs, resultAt.at(-1) + ANSWER_SETTLE_MS, 'ended one settle window after the last answer');
    assert.ok(r.end.atMs < timeoutMs, 'well before the timeout');
    assert.deepEqual(child.signals, ['SIGTERM']);
  });
}

test('driveSession: a streamed session is never ended during a pause, even a long one with no events', async () => {
  const clock = fakeClock();
  const child = fakeChild();
  const done = driveSession({ child, firstTurn: 'task', followups: ['next'], followupDelayMs: () => 3720000, timeoutMs: 240 * 60000, clock });
  child.emitLine(result('turn 1'));
  clock.advance(3720000 - 1);
  assert.deepEqual(child.signals, []);
  assert.deepEqual(child.turns, ['task']);
  clock.advance(1);
  assert.deepEqual(child.turns, ['task', 'next']);
  child.emitLine(init());
  child.emitLine(result('turn 2'));
  assert.equal(child.stdinEnded, true);
  clock.advance(ANSWER_SETTLE_MS);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal((await done).end.reason, 'answered');
});

// --- parseSession: answer, wall time and a timed-out session's answer ------------------------

test('parseSession dates requests and the answer, and takes output tokens and stop reason from message_delta', () => {
  const { lines, times } = timed([
    [0, init()],
    [1000, msgStart('m1')],
    [3000, toolUse('m1', 'Bash', { command: 'ls' }, { toolId: 'b1' })],
    [3001, msgDelta('m1', { stop: 'tool_use', out: 40 })],
    [3500, toolResult('b1', 'README.md')],
    [4000, msgStart('m2')],
    [9000, text('m2', 'FINAL ANSWER')],
    [9001, msgDelta('m2', { out: 300 })],
    [9002, result('FINAL ANSWER')],
  ]);
  const s = parseSession(lines, { times, end: { reason: 'answered', atMs: 39002 } });
  assert.deepEqual(s.requests.map((r) => [r.atMs, r.outputTokens, r.stopReason]), [[1000, 40, 'tool_use'], [4000, 300, 'end_turn']]);
  assert.equal(s.answeredAtMs, 9002);
  assert.equal(sessionWallMs(s, s.end), 9002, 'wall time runs to the answer, not to the end of the process');
  assert.equal(s.timedOutAfterAnswer, undefined);
  assert.equal(s.result.text, 'FINAL ANSWER');
  assert.equal(s.unfinishedRequests, 0);
});

test('parseSession: a session that never answered has its wall time to the end of the process', () => {
  const { lines, times } = timed([[0, init()], [1000, msgStart('m1')], [2000, toolUse('m1', 'Bash', { command: 'sleep 999' })], [2001, msgDelta('m1', { stop: 'tool_use' })]]);
  const end = { reason: 'timeout', atMs: 360000 };
  const s = parseSession(lines, { times, end });
  assert.equal(s.result, null);
  assert.equal(s.timedOutAfterAnswer, undefined);
  assert.equal(sessionWallMs(s, end), 360000);
});

// The shape of a delegating session killed at its timeout: background audit agents, the
// main agent ends its turn with a report while one agent still works, so Claude Code holds
// the turn's result back and none is written before the kill.
const heldBack = (last) => timed([
  [0, init()],
  [1000, msgStart('m1')],
  [2000, toolUse('m1', 'Agent', { description: 'Audit part 1', run_in_background: true }, { toolId: 'ag1' })],
  [2001, msgDelta('m1', { stop: 'tool_use' })],
  [2002, taskStarted('task-ag1')],
  [2003, toolResult('ag1', 'Async agent launched successfully.')],
  [5000, msgStart('s1', { parent: 'ag1' })],
  [9000, toolUse('s1', 'Read', { file_path: 'docs/doc.md' }, { parent: 'ag1', toolId: 'r1' })],
  [9001, msgDelta('s1', { stop: 'tool_use', parent: 'ag1' })],
  ...last,
]);

test('parseSession: killed at the timeout after the main agent ended its turn with an answer, it is graded on that answer', () => {
  const { lines, times } = heldBack([
    [300000, msgStart('m2')],
    [330000, text('m2', 'Audit report: README.md:85 is wrong, see utils.go:148')],
    [330001, msgDelta('m2', { out: 900 })],
  ]);
  const s = parseSession(lines, { times, end: { reason: 'timeout', atMs: 360000 } });
  assert.equal(s.timedOutAfterAnswer, true);
  assert.equal(s.result.subtype, 'timed_out_after_answer');
  assert.equal(s.result.text, 'Audit report: README.md:85 is wrong, see utils.go:148');
  assert.equal(s.result.costUsd, null, 'Claude Code never reported a cost for it');
  assert.equal(s.answeredAtMs, 330001);
  assert.equal(sessionWallMs(s, s.end), 330001);
  assert.equal(s.agentsRunningAtEnd, 1);
});

test('parseSession: no answer when the main agent was mid-request, mid-tool-call or starting a new turn at the kill', () => {
  const kill = { reason: 'timeout', atMs: 360000 };
  const cases = {
    'streaming its report (begun, not finished)': [[340000, msgStart('m2')], [355000, text('m2', 'Audit report: README.md:85 …')]],
    'begun, no block yet': [[359000, msgStart('m2')]],
    'calling a tool': [[340000, msgStart('m2')], [345000, text('m2', 'Let me verify one more.')], [345001, toolUse('m2', 'Read', { file_path: 'x.go' })], [345002, msgDelta('m2', { stop: 'tool_use' })]],
    'a new turn began after its answer': [[300000, msgStart('m2')], [330000, text('m2', 'status: waiting')], [330001, msgDelta('m2')], [350000, init()]],
  };
  for (const [what, last] of Object.entries(cases)) {
    const { lines, times } = heldBack(last);
    const s = parseSession(lines, { times, end: kill });
    assert.equal(s.result, null, what);
    assert.equal(s.timedOutAfterAnswer, undefined, what);
  }
});

test('parseSession: only a timeout is graded on a held-back answer; a session that exited without a result is not', () => {
  const { lines, times } = heldBack([[300000, msgStart('m2')], [330000, text('m2', 'report')], [330001, msgDelta('m2')]]);
  const s = parseSession(lines, { times, end: { reason: 'exited', atMs: 331000 } });
  assert.equal(s.result, null);
});

test('parseSession: an answer after the last result event is added to it at the timeout; one before it changes nothing', () => {
  const after = timed([
    [0, init()],
    [1000, text('m1', 'status')],
    [1001, result('status', 0.4)],
    [2000, init()],
    [2001, taskStarted('task-ag1')],
    [300000, msgStart('m2')],
    [330000, text('m2', 'the final report')],
    [330001, msgDelta('m2')],
  ]);
  const s = parseSession(after.lines, { times: after.times, end: { reason: 'timeout', atMs: 360000 } });
  assert.equal(s.timedOutAfterAnswer, true);
  assert.equal(s.result.text, 'status\n\nthe final report');
  assert.equal(s.result.reportedCostUsd, 0.4);
  assert.equal(s.result.costUsd, null);

  const before = timed([[0, init()], [1000, text('m1', 'the final report')], [1001, result('the final report', 0.9)], [1002, idle()]]);
  const t = parseSession(before.lines, { times: before.times, end: { reason: 'timeout', atMs: 360000 } });
  assert.equal(t.timedOutAfterAnswer, undefined, 'answered with a result, then lingered: its result stands');
  assert.equal(t.result.costUsd, 0.9);
  assert.equal(sessionWallMs(t, t.end), 1001);
});

test('parseSession: a stream without partial messages still finds a held-back answer (text, no tool call)', () => {
  const { lines, times } = timed([[0, init()], [1000, toolUse('m1', 'Agent', {}, { toolId: 'ag1' })], [1001, taskStarted('t1')], [300000, text('m2', 'report')]]);
  const s = parseSession(lines, { times, end: { reason: 'timeout', atMs: 360000 } });
  assert.equal(s.result.text, 'report');
  assert.equal(s.unfinishedRequests, undefined, 'no partial messages in this stream');
});

// --- summarize / roundRatio: the same cost rule on both arms -----------------------------------

test('summarize: a session that answered keeps Claude Code\'s total as its cost, and records how it ended', () => {
  const { lines, times } = timed([[0, init()], [1, msgStart('m1')], [2, text('m1', 'ok')], [3, msgDelta('m1', { out: 100 })], [4, result('ok', 0.77)]]);
  const t = summarize(parseSession(lines, { times, end: { reason: 'answered', atMs: 30004 } }), {});
  assert.equal(t.costUsd, 0.77);
  assert.equal(t.endReason, 'answered');
  assert.equal(t.answeredAtMs, 4);
  assert.equal(t.timedOutAfterAnswer, undefined);
});

test('summarize: a session graded on a held-back answer has no cost, and names the agents still running', () => {
  const { lines, times } = heldBack([[300000, msgStart('m2')], [330000, text('m2', 'report')], [330001, msgDelta('m2', { out: 900 })]]);
  const t = summarize(parseSession(lines, { times, end: { reason: 'timeout', atMs: 360000 } }), {});
  assert.equal(t.timedOutAfterAnswer, true);
  assert.equal(t.costUsd, null);
  assert.equal(t.agentsRunningAtEnd, 1);
  assert.equal(t.endReason, 'timeout');
  assert.equal(endNote(t), ' · answered at 330s · TIMED OUT after answering (1 agent(s) still running; no cost)');
});

test('roundRatio names an arm cut off after answering apart from one with no result', () => {
  const arm = (totals) => ({ totals });
  assert.deepEqual(roundRatio(arm({ costUsd: 1 }), arm({ costUsd: 0.8 })), { ratio: 0.8 });
  assert.deepEqual(roundRatio(arm({ costUsd: null }), arm({ costUsd: null })), { ratio: null, error: 'A and B ended without a result (no cost)' });
  assert.deepEqual(roundRatio(arm({ costUsd: null }), arm({ costUsd: null, timedOutAfterAnswer: true })), {
    ratio: null,
    error: 'A ended without a result (no cost); B answered, then timed out before Claude Code reported a cost',
  });
});

test('endNote: answered time, and a timeout only when the session hit one', () => {
  assert.equal(endNote({ answeredAtMs: 241000, endReason: 'answered' }), ' · answered at 241s');
  assert.equal(endNote({ answeredAtMs: null, endReason: 'timeout' }), ' · TIMED OUT');
  assert.equal(endNote({ answeredAtMs: 300000, endReason: 'timeout', timedOutAfterAnswer: true, agentsRunningAtEnd: 2 }), ' · answered at 300s · TIMED OUT after answering (2 agent(s) still running; no cost)');
});

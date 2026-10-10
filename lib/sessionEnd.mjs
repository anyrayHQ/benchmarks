// When is a headless Claude Code session done?
//
// `claude -p` writes a `result` event when a turn ends, but the process does not always
// exit there. While a background agent runs, a turn's result is held back (with input
// closed) and flushed when the agent finishes; the main agent then gets a new turn to read
// the agent's report. A pending ScheduleWakeup keeps the process alive after the final
// answer until the wakeup fires, and the wakeup runs one more model turn whose text and
// cost are added to the session's result. A background command keeps it alive until the
// command ends. Left alone, such a session idles to the scenario's timeout: its wall time
// reads as the timeout, and a wakeup that fires before the kill bills a turn after the answer.
//
// So the harness ends a session once it has answered: the last event is a result, every
// user turn has been sent and the input closed, no background task is still running, and
// no new event arrives for ANSWER_SETTLE_MS. The same rule runs on both arms. A pause
// scenario keeps its input open during a pause (the next follow-up is still to come), so
// a pause never counts as answered, however long it is.

export const ANSWER_SETTLE_MS = 30000;
export const TERM_GRACE_MS = 10000;

// Events that only report state (a task's progress or end among them; the running set
// tracks tasks). Anything else after a result (a new turn's init, a model message, a tool
// result) means the session is still at work.
const PASSIVE_SYSTEM = new Set(['session_state_changed', 'background_tasks_changed', 'task_updated', 'task_progress', 'task_notification', 'hook_started', 'hook_progress', 'hook_response', 'post_turn_summary']);
const PASSIVE_TYPES = new Set(['rate_limit_event']);

const KEPT_STREAM_EVENTS = new Set(['message_start', 'message_delta']);

const passive = (j) => PASSIVE_TYPES.has(j.type) || (j.type === 'system' && PASSIVE_SYSTEM.has(j.subtype));

/**
 * Follows one session's stream-json events: which background tasks (agents, commands)
 * are running, whether the last event was a result, and whether the input is closed.
 */
export function sessionWatch({ inputOpen = false } = {}) {
  const running = new Set();
  let resultLast = false;
  let open = inputOpen;
  let wakeup = false;
  return {
    running,
    /** The main agent's last ScheduleWakeup scheduled one (not stopped since); informational. */
    get wakeupPending() {
      return wakeup;
    },
    get inputOpen() {
      return open;
    },
    closeInput() {
      open = false;
    },
    observe(j) {
      if (!j || typeof j !== 'object') return;
      if (j.type === 'system' && j.subtype === 'task_started' && j.task_id) running.add(j.task_id);
      if (j.type === 'system' && j.subtype === 'task_notification' && j.task_id) running.delete(j.task_id);
      if (j.type === 'user' && !j.parent_tool_use_id && Array.isArray(j.message?.content)) {
        for (const b of j.message.content) {
          const text = typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content.map((x) => x?.text ?? '').join('') : '';
          if (b?.type !== 'tool_result') continue;
          if (text.startsWith('Next wakeup scheduled')) wakeup = true;
          else if (text.startsWith('Loop stopped')) wakeup = false;
        }
      }
      if (j.type === 'result') resultLast = true;
      else if (!passive(j)) resultLast = false;
    },
    /** Answered: last event a result, input closed, no background task left. */
    answered() {
      return !open && resultLast && running.size === 0;
    },
  };
}

export const systemClock = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };

const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';

/**
 * Drive a spawned `claude -p --output-format stream-json` child to its end. `firstTurn`
 * set means the turns go on stdin (`--input-format stream-json`): the first one now, each
 * follow-up `followupDelayMs(i)` after the previous turn's result, and stdin closes after
 * the result that follows the last one. Every stdout line is kept with its arrival time
 * (ms since the drive began).
 *
 * The session ends one of four ways (`end.reason`): `exited` on its own; `answered`, ended
 * by the harness (SIGTERM, SIGKILL after `termGraceMs`) once it had answered (see
 * sessionWatch) and stayed quiet for `settleMs`; `timeout`, killed at `timeoutMs`;
 * `aborted`, killed because `signal` fired.
 */
export function driveSession({ child, firstTurn = null, followups = [], followupDelayMs = () => 0, timeoutMs, settleMs = ANSWER_SETTLE_MS, termGraceMs = TERM_GRACE_MS, signal = null, clock = systemClock }) {
  return new Promise((resolve) => {
    const started = clock.now();
    const streamed = firstTurn !== null;
    const watch = sessionWatch({ inputOpen: streamed });
    const lines = [];
    const times = [];
    const timers = new Set();
    const later = (f, ms) => {
      const t = clock.setTimeout(() => {
        timers.delete(t);
        f();
      }, ms);
      timers.add(t);
      return t;
    };
    const cancel = (t) => {
      if (t == null) return;
      clock.clearTimeout(t);
      timers.delete(t);
    };
    let reason = null;
    let settle = null;
    let buf = '';
    let err = '';
    const stop = (why, sig) => {
      if (reason) return;
      reason = why;
      if (sig !== 'SIGKILL') later(() => child.kill('SIGKILL'), termGraceMs);
      child.kill(sig);
    };
    later(() => stop('timeout', 'SIGKILL'), timeoutMs);
    if (signal) {
      if (signal.aborted) stop('aborted', 'SIGKILL');
      else signal.addEventListener('abort', () => stop('aborted', 'SIGKILL'), { once: true });
    }

    const pending = [...followups];
    let sent = 0;
    if (streamed) child.stdin.write(userLine(firstTurn));
    const onResult = () => {
      if (!streamed) return;
      if (pending.length) {
        const next = pending.shift();
        later(() => child.stdin.write(userLine(next)), followupDelayMs(sent++));
      } else if (watch.inputOpen) {
        child.stdin.end();
        watch.closeInput();
      }
    };
    const onLine = (l) => {
      if (!l.trim()) return;
      let j = null;
      try {
        j = JSON.parse(l);
      } catch {}
      // Of the partial-message stream only each request's start and end are kept: the
      // content deltas between them are thousands of lines a session.
      if (!(j?.type === 'stream_event' && !KEPT_STREAM_EVENTS.has(j.event?.type))) {
        lines.push(l);
        times.push(clock.now() - started);
      }
      if (!j) return;
      watch.observe(j);
      if (j?.type === 'result') onResult();
      cancel(settle);
      settle = !reason && watch.answered() ? later(() => stop('answered', 'SIGTERM'), settleMs) : null;
    };

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(l);
      }
    });
    child.stderr?.on('data', (d) => (err += d));
    child.on('close', (code) => {
      for (const t of [...timers]) cancel(t);
      if (buf.trim()) {
        lines.push(buf);
        times.push(clock.now() - started);
      }
      const end = { reason: reason ?? 'exited', atMs: clock.now() - started, runningTasks: watch.running.size, inputClosed: !watch.inputOpen, wakeupPending: watch.wakeupPending };
      resolve({ lines, times, stderr: reason === 'timeout' ? `timed out after ${timeoutMs / 60000} min\n${err}` : err, code, end });
    });
  });
}

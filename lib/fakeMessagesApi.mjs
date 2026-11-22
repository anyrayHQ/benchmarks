// A local, scripted stand-in for the Anthropic Messages API, for offline probes of what an
// Agent SDK app SENDS: no model, no gateway, no key leaves the machine. The first request
// that offers a subagent tool (Agent/Task) is answered with one call spawning `subagentType`;
// every other request with a short end_turn text. Each request is recorded as booleans
// only: whether it is the subagent's (its body contains `subagentMarker`) and, per entry of
// `markers`, whether the body contains that text. Nothing else of a body is kept.

import { createServer } from 'node:http';

const SPAWN_TOOLS = ['Agent', 'Task'];

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};

const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** One assistant message as a Messages API body, and as its stream events. */
export const scriptedMessage = ({ id, model, block, stopReason }) => {
  const message = { id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stopReason, stop_sequence: null, usage };
  const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text };
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: start },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return { message, events };
};

/**
 * Start the fake API on an ephemeral loopback port. Returns `{ url, requests, close }`;
 * `requests` grows as the SDK calls it: `{ subagent, markers: { name: boolean } }`.
 */
export const startFakeMessagesApi = ({ subagentType, subagentMarker, markers = {} }) =>
  new Promise((resolve, reject) => {
    const requests = [];
    let spawned = false;
    let n = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
          res.writeHead(404).end();
          return;
        }
        if (req.url.startsWith('/v1/messages/count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
          return;
        }
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        const subagent = raw.includes(subagentMarker);
        requests.push({ subagent, markers: Object.fromEntries(Object.entries(markers).map(([k, text]) => [k, Boolean(text) && raw.includes(text)])) });
        const spawnTool = (body.tools ?? []).map((t) => t?.name).find((name) => SPAWN_TOOLS.includes(name));
        const hasToolResult = JSON.stringify(body.messages ?? []).includes('"tool_result"');
        n++;
        const model = body.model ?? 'claude-sonnet-5-5';
        const spawn = !subagent && !spawned && spawnTool && !hasToolResult;
        if (spawn) spawned = true;
        const { message, events } = scriptedMessage({
          id: `msg_probe_${n}`,
          model,
          block: spawn
            ? { type: 'tool_use', id: `toolu_probe_${n}`, name: spawnTool, input: { description: 'probe', prompt: 'Reply with OK.', subagent_type: subagentType } }
            : { type: 'text', text: 'OK' },
          stopReason: spawn ? 'tool_use' : 'end_turn',
        });
        if (body.stream) sse(res, events);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });

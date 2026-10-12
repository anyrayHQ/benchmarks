// A synthetic MCP tool catalog: catalog weight for sessions that carry a large set of MCP
// tool schemas, the shape a seat with many connectors sends (Sett, 2026-10: 222 tools,
// ~70% of them MCP, ~417k chars of MCP schema). The tools are never needed by a scenario;
// they measure what the catalog itself costs, and what deferring it saves.
//
// Deterministic: the same (n, toolChars) gives the same bytes on every call, so both arms
// of a pair see an identical catalog. Every word is synthetic.
import { fileURLToPath } from 'node:url';

export const CATALOG_SERVER = 'catalog';
/** Per-tool JSON size of the Sett shape: ~417k chars over 200 MCP tools. */
export const DEFAULT_TOOL_CHARS = 2085;

const SERVER_PATH = fileURLToPath(new URL('../tools/mcp-catalog-server.mjs', import.meta.url));

const WORDS = [
  'record', 'project', 'workspace', 'ticket', 'channel', 'document', 'folder', 'invoice',
  'contact', 'pipeline', 'release', 'metric', 'dashboard', 'schedule', 'calendar', 'comment',
  'returns', 'updates', 'lists', 'creates', 'archives', 'filters', 'sorts', 'exports',
  'the', 'a', 'every', 'matching', 'selected', 'current', 'synthetic', 'optional',
  'by', 'for', 'with', 'from', 'into', 'when', 'unless', 'after',
];
const PROPS = ['id', 'query', 'limit', 'cursor', 'owner', 'status', 'since', 'fields'];

// A small LCG so the words depend only on (tool index, position).
const rng = (seed) => {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
};

const prose = (seed, chars) => {
  const next = rng(seed);
  let out = '';
  while (out.length < chars) out += `${out ? ' ' : ''}${WORDS[next() % WORDS.length]}`;
  return `${out.slice(0, Math.max(0, chars - 1))}.`;
};

const baseTool = (i) => ({
  name: `cat_tool_${String(i).padStart(3, '0')}`,
  description: '',
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(PROPS.map((p, k) => [p, { type: 'string', description: prose(i * 31 + k, 72) }])),
    required: ['id'],
  },
});

/** n tools, each about `toolChars` characters of JSON (its description absorbs the rest). */
export function catalogTools(n, { toolChars = DEFAULT_TOOL_CHARS } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const tool = baseTool(i);
    const room = toolChars - JSON.stringify(tool).length;
    return { ...tool, description: prose(i + 1, Math.max(40, room)) };
  });
}

/** The arm's MCP config plus the catalog server; the same object when n is not positive. */
export function withMcpCatalog(mcp, n) {
  if (!Number.isInteger(n) || n <= 0) return mcp;
  return {
    ...mcp,
    mcpServers: {
      ...mcp.mcpServers,
      [CATALOG_SERVER]: { type: 'stdio', command: process.execPath, args: [SERVER_PATH, String(n)] },
    },
  };
}

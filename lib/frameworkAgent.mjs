// A graph agent on an agent framework's ChatAnthropic, built the way a framework user builds
// one: a StateGraph with a model node and a ToolNode, tools declared with zod, and no
// cache markers. Both arms run the same graph and the same model class; only the HTTP
// client under ChatAnthropic differs (AnthropicBedrock direct, the Anthropic client
// pointed at the gateway for Anyray).
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Annotation, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { checkCitations } from './agentRun.mjs';
import { costOfAnthropicUsage } from './cost.mjs';
import { countCacheBreaks } from './cacheBreaks.mjs';
import { ANSWER_MAX_TOKENS, EMPTY_ANSWER_REQUEST, executeSdkTool, FINAL_ANSWER_REQUEST, SDK_SYSTEM } from './sdkAgent.mjs';

/** The same three checkout-confined tools as sdk-docs, declared the framework's way. */
export function frameworkTools(work) {
  const run = (name) => async (input) => executeSdkTool(work, name, input);
  return [
    tool(run('read_file'), { name: 'read_file', description: 'Read numbered lines from a repository file.', schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() }) }),
    tool(run('list_dir'), { name: 'list_dir', description: 'List entries in a repository directory.', schema: z.object({ path: z.string() }) }),
    tool(run('grep'), { name: 'grep', description: 'Search repository text files for a literal string.', schema: z.object({ pattern: z.string(), path: z.string().optional() }) }),
  ];
}

// The Anthropic SDK reads these at construction: a shell running inside a routed Claude
// Code session carries that session's base URL and x-anyray-* headers (its own key), which
// would send the "direct" arm to a gateway and the Anyray arm under someone else's key.
const INHERITED_ROUTE = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];

/** Builds a client with the inherited route hidden. Synchronous, so no other arm sees the gap. */
export function withoutInheritedRoute(build, env = process.env) {
  const saved = {};
  for (const k of INHERITED_ROUTE) if (k in env) { saved[k] = env[k]; delete env[k]; }
  try { return build(); } finally { Object.assign(env, saved); }
}

/**
 * fetch for one arm: refuses a request to any other host or carrying an x-anyray-* header
 * the arm did not set, and records each response's billed usage and latency.
 */
export function recordingFetch({ host, anyrayHeaders, requests, fetchImpl = fetch }) {
  return async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.host !== host) throw new Error(`framework arm sent a request to ${target.host}, not ${host}`);
    const stray = [...new Headers(init.headers).keys()].filter((k) => k.startsWith('x-anyray-') && !anyrayHeaders.includes(k));
    if (stray.length) throw new Error(`framework arm carries ${stray.join(', ')} it did not set`);
    const start = Date.now();
    const res = await fetchImpl(url, init);
    const entry = { status: res.status, latencyMs: Date.now() - start };
    if (res.ok) {
      const body = await res.clone().json().catch(() => null);
      Object.assign(entry, { model: body?.model ?? null, usage: body?.usage ?? null, stopReason: body?.stop_reason ?? null, blocks: (body?.content ?? []).map((b) => b.type) });
    }
    requests.push(entry);
    return res;
  };
}

/** ChatAnthropic for one arm; `model` is the id that arm's provider takes. */
export function frameworkModel({ arm, model, gatewayUrl, clientKey, bedrock, kinds, sessionId, requests, fetchImpl = fetch, credentials }) {
  const maxTokens = ANSWER_MAX_TOKENS;
  if (arm === 'direct') {
    if (!bedrock?.model) throw new Error('framework direct arm needs a Bedrock model id');
    const baseURL = `https://bedrock-runtime.${bedrock.region}.amazonaws.com`;
    const fetch = recordingFetch({ host: new URL(baseURL).host, anyrayHeaders: [], requests, fetchImpl });
    const providerChainResolver = async () => (credentials ? async () => credentials : fromNodeProviderChain({ profile: bedrock.profile }));
    return new ChatAnthropic({ model: bedrock.model, maxTokens, createClient: ({ maxRetries }) => withoutInheritedRoute(() => new AnthropicBedrock({ awsRegion: bedrock.region, baseURL, providerChainResolver, maxRetries, fetch })) });
  }
  if (!gatewayUrl || !clientKey) throw new Error('framework gateway arm needs a gateway URL and benchmark client key');
  const defaultHeaders = { 'x-anyray-metadata': JSON.stringify({ tool: 'framework-agent', sessionId }), ...(kinds?.length ? { 'x-anyray-optimization-kinds': kinds.join(',') } : {}) };
  const fetch = recordingFetch({ host: new URL(gatewayUrl).host, anyrayHeaders: Object.keys(defaultHeaders), requests, fetchImpl });
  // A framework user on Anyray sets the base URL and puts the gateway key where the API key goes.
  return new ChatAnthropic({ model, maxTokens, createClient: ({ maxRetries }) => withoutInheritedRoute(() => new Anthropic({ apiKey: clientKey, authToken: null, baseURL: gatewayUrl, defaultHeaders, maxRetries, fetch })) });
}

/**
 * model ⇄ tools until the model stops calling tools; the last allowed turn must answer.
 * A reply with neither tool calls nor text (Sonnet 5 can end a turn on thinking alone) gets
 * one more answer-only request, with the same params so neither arm's cache breaks.
 */
export function buildFrameworkAgent({ llm, tools, system = SDK_SYSTEM, maxTurns, interTurnDelaySec = 0, sleep }) {
  const State = Annotation.Root({ ...MessagesAnnotation.spec, turns: Annotation({ reducer: (_, next) => next, default: () => 0 }) });
  const free = llm.bindTools(tools);
  // Tools stay declared on the last turn (same prefix on both arms) but are not callable.
  const answerOnly = llm.bindTools(tools, { tool_choice: 'none' });
  const agent = async (state) => {
    if (state.turns && interTurnDelaySec) await sleep(interTurnDelaySec * 1000);
    const last = state.turns + 1 >= maxTurns;
    const ask = last ? [new HumanMessage(FINAL_ANSWER_REQUEST)] : [];
    const reply = await (last ? answerOnly : free).invoke([new SystemMessage(system), ...state.messages, ...ask]);
    return { messages: [...ask, reply], turns: state.turns + 1 };
  };
  const answer = async (state) => {
    const ask = new HumanMessage(EMPTY_ANSWER_REQUEST);
    const reply = await answerOnly.invoke([new SystemMessage(system), ...state.messages, ask]);
    return { messages: [ask, reply], turns: state.turns + 1 };
  };
  const next = (state) => {
    const reply = state.messages.at(-1);
    if (reply.tool_calls?.length && state.turns < maxTurns) return 'tools';
    return reply.text.trim() ? END : 'answer';
  };
  return new StateGraph(State)
    .addNode('agent', agent)
    .addNode('tools', new ToolNode(tools))
    .addNode('answer', answer)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', next, ['tools', 'answer', END])
    .addEdge('tools', 'agent')
    .addEdge('answer', END)
    .compile();
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** One arm's session; returns the same shape as runSdkAgent so the record and verdict match. */
export async function runFrameworkAgent({ arm, scenario, work, model, gatewayUrl, clientKey, bedrock, pricing, kinds, sessionId, fetchImpl = fetch, credentials, sleep = wait }) {
  const maxTurns = scenario.maxTurns ?? 30;
  const wire = [];
  const llm = frameworkModel({ arm, model, gatewayUrl, clientKey, bedrock, kinds, sessionId, requests: wire, fetchImpl, credentials });
  const graph = buildFrameworkAgent({ llm, tools: frameworkTools(work), maxTurns, interTurnDelaySec: scenario.interTurnDelaySec ?? 0, sleep });
  const started = Date.now();
  const final = await graph.invoke({ messages: [new HumanMessage(scenario.task)] }, { recursionLimit: 2 * maxTurns + 3 });
  const replies = final.messages.filter((m) => m.getType() === 'ai');
  const last = replies.at(-1);
  const requests = wire.filter((r) => r.usage).map((r, i) => ({
    turn: i + 1, model: r.model ?? model, latencyMs: r.latencyMs,
    usage: { input: r.usage.input_tokens ?? 0, cacheRead: r.usage.cache_read_input_tokens ?? 0, cacheWrite: r.usage.cache_creation_input_tokens ?? 0, output: r.usage.output_tokens ?? 0 },
    costUsd: costOfAnthropicUsage(pricing, r.model ?? model, r.usage),
    stopReason: r.stopReason, blocks: r.blocks,
  }));
  const answer = last?.tool_calls?.length ? '' : (last?.text ?? '');
  const total = (key) => requests.reduce((n, r) => n + r.usage[key], 0);
  const costs = requests.map((r) => r.costUsd);
  const toolCalls = replies.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0);
  const totals = {
    requests: requests.length, turns: final.turns, input: total('input') + total('cacheRead') + total('cacheWrite'),
    cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite'), output: total('output'),
    costUsd: costs.length && costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null,
    wallMs: Date.now() - started, outsideCheckout: 0, subagents: 0, toolCalls, parallelToolTurns: replies.filter((m) => (m.tool_calls?.length ?? 0) > 1).length,
    failedRequests: wire.filter((r) => r.status >= 400).length,
    answerRetries: final.messages.filter((m) => m.getType() === 'human' && m.text === EMPTY_ANSWER_REQUEST).length,
    start: { read: requests[0]?.usage.cacheRead ?? 0, written: requests[0]?.usage.cacheWrite ?? 0 },
    cacheBreaks: countCacheBreaks(requests.map((r) => ({ agent: 'main', usage: { input_tokens: r.usage.input, cache_read_input_tokens: r.usage.cacheRead, cache_creation_input_tokens: r.usage.cacheWrite } }))),
  };
  const stop = last?.response_metadata?.stop_reason;
  const subtype = !answer.trim() ? 'error_no_answer' : stop === 'end_turn' ? 'success' : stop === 'max_tokens' ? 'error_max_tokens' : 'error_max_turns';
  return {
    sdk: true, framework: 'graph-agent', requests, totals,
    result: { text: answer, subtype },
    citations: scenario.citations ? checkCitations(answer, work) : null, outsideCheckout: { count: 0 },
    setup: { transport: arm === 'direct' ? 'framework-anthropic-bedrock' : 'framework-anthropic-gateway', model: arm === 'direct' ? bedrock.model : model, maxTurns, interTurnDelaySec: scenario.interTurnDelaySec ?? 0 },
  };
}

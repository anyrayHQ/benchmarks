// Retrieve-capability signal for the optimizer's toolless-turn gate.
//
// WHY: the optimizer refuses to elide content that the caller could not fetch
// back. A turn that offers no tools is treated as unable to retrieve, so every
// eliding strategy is skipped and the response says so:
//
//   "suppressedKinds": [{ "kind": "relevance_filter", "reason": "no_retrieve" }]
//
// That is correct behaviour — dropping content behind a `retrieve ctx_…` handle
// the client can never resolve would be worse than not dropping it. But these
// fixtures are bare request bodies with no tools array, so without a signal the
// benchmark measures ~0% for exactly the strategies it exists to measure, and
// under-reports the saving a real (tool-carrying) client would get.
//
// So: hand the optimizer a retrieve tool when a payload has none, and keep that
// synthetic tool OUT of the accounting (see stripSyntheticRetrieve). Payloads
// that already declare tools are passed through untouched.

export const RETRIEVE_TOOL_NAME = 'retrieve'

const RETRIEVE_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: RETRIEVE_TOOL_NAME,
    description: 'Retrieve context the optimizer stashed, by handle.',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
    },
  },
})

/** True if the request already advertises tools (either schema shape). */
export function declaresTools(request) {
  return Boolean(request?.tools?.length || request?.functions?.length)
}

/**
 * Add the retrieve tool if the request declares none.
 * Returns { request, injected } so the caller can undo it before measuring.
 */
export function withRetrieveTool(request) {
  if (declaresTools(request)) return { request, injected: false }
  return { request: { ...request, tools: [RETRIEVE_TOOL] }, injected: true }
}

/**
 * Remove the tool we injected, so a synthetic capability signal never lands in
 * the measured size. Only drops OUR tool, and only when we added it — a payload
 * that ships its own `retrieve` tool keeps it.
 */
export function stripSyntheticRetrieve(request, injected) {
  if (!injected || !request?.tools) return request
  const tools = request.tools.filter((t) => (t?.function?.name ?? t?.name) !== RETRIEVE_TOOL_NAME)
  const stripped = { ...request }
  if (tools.length) stripped.tools = tools
  else delete stripped.tools
  return stripped
}

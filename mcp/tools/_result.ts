/**
 * The result envelope every MCP tool returns.
 *
 * Each tool built this by hand before these helpers existed, which is how the
 * shape drifted between tools — some errors were pretty-printed, some were
 * not. `mcp/auth.ts` builds the same envelope for authError() and
 * bookAccessError(); these mirror it deliberately rather than importing from
 * there, because auth's copies are about auth and these are about tools.
 *
 * The drift is not fully resolved. `mcp/auth.ts` and the not-found branch in
 * `mcp/tools/reports.ts` still emit their own compact (non-pretty-printed)
 * JSON instead of calling `fail()`. New code should call `ok()`/`fail()`
 * rather than hand-build the envelope; those two sites are pre-existing and
 * not touched by this change.
 */
export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/** A successful tool result carrying `data` as pretty-printed JSON. */
export function ok(data: unknown): McpToolResult {
  // JSON.stringify(undefined) returns undefined, not a string — it would
  // break the declared `text: string` contract. No tool passes undefined
  // today, but a void-returning tool is the natural way to hit this.
  const text = data === undefined ? "null" : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * A failed tool result. Use it for an expected failure that the caller can act
 * on — a validation error, a missing row. Let an unexpected error throw: the
 * SDK reports it, and a stack trace is more use than a swallowed message.
 */
export function fail(message: string): McpToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

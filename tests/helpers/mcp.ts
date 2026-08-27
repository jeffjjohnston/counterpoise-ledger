import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export type McpCallResult = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  isError: boolean;
};

/**
 * Call an MCP tool and decode its single text block as JSON.
 *
 * Both result paths are strict, and the error path is the one that matters.
 * Every expected failure goes through `fail()`, which emits genuine JSON
 * (`JSON.stringify({ error: message })`). An *unexpected* error thrown past
 * `fail()` reaches the client as the SDK's own plain-text wrapping instead.
 *
 * An earlier version of this helper caught the parse failure and rebuilt
 * `{ error: text }` from that plain text — which is byte-for-byte the shape
 * `fail()` produces. That made every error test unfailable: deleting a tool's
 * whole `fail()` mapping left the suite green, because the helper silently
 * reconstructed the envelope the tool no longer returned. Parse strictly so
 * an uncaught throw fails the test that should have caught it.
 *
 * A schema-level rejection is the one legitimate non-JSON error body: the SDK
 * validates input before the handler runs and reports the failure as a normal
 * error result. Those tests call `client.callTool` directly and assert on the
 * raw text — see "rejects a calendar-invalid startDate at the schema boundary"
 * in tests/mcp/mcp-tools.test.ts. Do not soften this helper to accommodate
 * them; that is the change that broke the error coverage the first time.
 */
export async function callMcpTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const isError = Boolean(result.isError);
  const textContent = (result.content as Array<{ type: string; text: string }>)?.find(
    (c) => c.type === "text"
  );
  if (textContent === undefined) {
    return { data: undefined, isError };
  }

  try {
    return { data: JSON.parse(textContent.text), isError };
  } catch {
    throw new Error(
      `MCP tool "${name}" returned a non-JSON ${isError ? "error " : ""}body. ` +
        `ok() and fail() both emit JSON, so this is either an error thrown past the ` +
        `handler's fail() mapping or a schema-level rejection. A test that means to ` +
        `assert on a schema rejection should call client.callTool directly. Body: ` +
        textContent.text
    );
  }
}

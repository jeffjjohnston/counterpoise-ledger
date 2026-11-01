import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectMcpTestClient, mcpTestTransport, type McpTestClient } from "@/tests/helpers/mcp-client";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { count } from "@/tests/helpers/sql";

// THE REPRESENTATIVE CALLS THAT RUN OVER BOTH TRANSPORTS. The detailed tool
// suites run over HTTP only, because both transports reach the same
// dispatcher (`call_tool` in rust-api/server/src/mcp/mod.rs). What differs
// between the transports is how a request gets its credential and how a
// result goes back to the client. Each case here crosses that boundary
// with a different result kind: a read, a write, a refusal from the
// handler, a refusal at the schema, and an unknown tool. See the coverage
// table in guides/mcp-server.md.
let mcp: McpTestClient;

beforeAll(async () => {
  await setupTestDatabase();
  mcp = await connectMcpTestClient();
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await mcp.close();
});

/** The raw result, for the errors that the SDK writes as plain text. */
async function rawCall(name: string, args: Record<string, unknown>) {
  const result = await mcp.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { isError: Boolean(result.isError), text: content.map((block) => block.text).join("") };
}

describe(`MCP over ${mcpTestTransport()}`, () => {
  it("writes an account and reads it back as the key's user", async () => {
    const created = await mcp.callAs(1, "create_account", { bookId: 1, name: "Cash", type: "asset" });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ bookId: 1, name: "Cash", type: "asset" });

    const listed = await mcp.callAs(1, "list_accounts", { bookId: 1 });
    expect(listed).toEqual({
      isError: false,
      data: [expect.objectContaining({ id: created.data.id, name: "Cash", balanceCents: 0, formattedBalance: "$0.00" })],
    });
  });

  it("returns a handler refusal as a JSON error body", async () => {
    expect(await mcp.callAs(1, "create_account", { bookId: 999999, name: "Cash", type: "asset" })).toEqual({
      isError: true,
      data: { error: "You do not have access to this book" },
    });
    expect(await count("accounts")).toBe(0);
  });

  it("returns a schema refusal as the SDK's plain-text error, before the handler runs", async () => {
    const result = await rawCall("create_account", { bookId: 1, name: "Cash", type: "asset", icon: "ab" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^MCP error -32602: Input validation error: .*Icon must be a single character/s);
    expect(await count("accounts")).toBe(0);
  });

  it("refuses an unknown tool", async () => {
    expect(await rawCall("no_such_tool", {})).toEqual({
      isError: true,
      text: "MCP error -32602: Tool no_such_tool not found",
    });
  });
});

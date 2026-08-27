import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fail, ok } from "@/mcp/tools/_result";
import { READ } from "@/mcp/tools/_annotations";
import { callMcpTool } from "@/tests/helpers/mcp";

/**
 * Guards the decoding contract every other MCP tool test depends on.
 *
 * `MESSAGE` is deliberately shared: a tool that calls fail(message) and a tool
 * that throws Error(message) put the SAME human text on the wire. The only
 * thing separating them is that fail() emits JSON and the SDK's wrapping of an
 * uncaught throw does not. The helper used to catch that parse failure and
 * rebuild `{ error: text }` from the plain text, which reproduced fail()'s
 * envelope exactly — so an assertion on the decoded error could not tell the
 * two apart, and every MCP error test passed whether or not its tool still had
 * a fail() mapping at all. These tests fail if that leniency comes back.
 */
const MESSAGE = "Payee not found";

let client: Client;
let server: McpServer;

beforeAll(async () => {
  server = new McpServer({ name: "test", version: "0.0.1" });
  const config = { title: "T", description: "test tool", inputSchema: {}, annotations: READ };

  server.registerTool("returns_ok", config, async () => ok({ id: 7 }));
  server.registerTool("returns_fail", config, async () => fail(MESSAGE));
  server.registerTool("throws_past_fail", config, async () => {
    throw new Error(MESSAGE);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe("callMcpTool", () => {
  it("decodes an ok() body", async () => {
    const { data, isError } = await callMcpTool(client, "returns_ok");

    expect(isError).toBe(false);
    expect(data).toEqual({ id: 7 });
  });

  it("decodes a fail() body and reports isError", async () => {
    const { data, isError } = await callMcpTool(client, "returns_fail");

    expect(isError).toBe(true);
    expect(data).toEqual({ error: MESSAGE });
  });

  it("rejects an error thrown past fail(), rather than reshaping it to look like fail()", async () => {
    await expect(callMcpTool(client, "throws_past_fail")).rejects.toThrow(
      /returned a non-JSON error body/
    );
  });

  it("puts the offending body in the failure message, so the cause is readable", async () => {
    await expect(callMcpTool(client, "throws_past_fail")).rejects.toThrow(MESSAGE);
  });
});

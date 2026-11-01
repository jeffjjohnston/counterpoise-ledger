import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP weekly review tool", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();
    // No ANTHROPIC_API_KEY: the tool reads the state and never calls Claude.
    mcp = await connectMcpTestClient({ env: { ANTHROPIC_API_KEY: "" } });
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await mcp.close();
  });

  describe("get_weekly_review", () => {
    it("returns the state of a book that has not opted in", async () => {
      const { data, isError } = await callTool("get_weekly_review", { bookId });
      expect(isError).toBe(false);
      expect(data).toEqual({ configured: false, enabled: false, latest: null, running: null, lastFailure: null });
    });

    it("refuses a book that the key cannot read", async () => {
      const { isError } = await callTool("get_weekly_review", { bookId: 999 });
      expect(isError).toBe(true);
    });
  });
});

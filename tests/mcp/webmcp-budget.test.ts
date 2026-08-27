import { describe, expect, it } from "vitest";
import { callWebMcpTool, listWebMcpTools } from "@/mcp/webmcp";

/**
 * A browser build measures the whole registry - every descriptor's name,
 * title, description, input schema and annotations, serialized together - and
 * rejects all of it past 65,536 bytes. The page then loses WebMCP entirely,
 * and the error names no limit, so a regression here is expensive to diagnose
 * from the symptom. These tests are the cheap end of that trade.
 */
const REGISTRY_BYTE_LIMIT = 65_536;

/**
 * Deliberately below the real cap. The reserve absorbs a tool or two before
 * anyone has to think about the budget again, and failing here costs a CI run
 * where failing in the browser costs an afternoon.
 */
const BUDGET = 58_000;

const registryBytes = async () =>
  Buffer.byteLength(JSON.stringify(await listWebMcpTools()), "utf8");

describe("WebMCP registry budget", () => {
  it("stays inside the byte budget the browser enforces", async () => {
    const bytes = await registryBytes();
    expect(bytes).toBeLessThan(BUDGET);
    expect(bytes).toBeLessThan(REGISTRY_BYTE_LIMIT);
  });

  it("keeps the tool count inside the browser's limit", async () => {
    expect((await listWebMcpTools()).length).toBeLessThanOrEqual(100);
  });

  it("omits the $schema key that costs bytes and says nothing", async () => {
    const tools = await listWebMcpTools();
    expect(tools.every((tool) => !("$schema" in tool.inputSchema))).toBe(true);
  });

  it("hides bookId, which the route supplies from the session", async () => {
    const tools = await listWebMcpTools();
    const exposesBookId = tools.some(
      (tool) => "bookId" in ((tool.inputSchema.properties as object) ?? {})
    );
    expect(exposesBookId).toBe(false);
  });
});

describe("WebMCP tool exclusions", () => {
  const withheld = [
    "delete_book",
    "create_book",
    "analyze_usage",
    "delete_plaid_token",
    "create_issue_report",
  ];

  it("does not advertise book, meta, or Plaid-connection admin tools", async () => {
    const names = new Set((await listWebMcpTools()).map((tool) => tool.name));
    for (const name of withheld) expect(names.has(name)).toBe(false);
  });

  it("still advertises the ledger tools the page is for", async () => {
    const names = new Set((await listWebMcpTools()).map((tool) => tool.name));
    for (const name of [
      "list_accounts",
      "create_transaction",
      "list_transactions",
      "get_income_statement",
      "reconcile_plaid_transaction",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("refuses to execute a withheld tool, not merely to list it", async () => {
    // The POST endpoint answers anything holding the session cookie, so an
    // exclusion that only filtered the listing would stop nothing.
    for (const name of withheld) {
      await expect(callWebMcpTool(name, {}, 1)).rejects.toThrow(
        `Unknown MCP tool: ${name}`
      );
    }
  });
});

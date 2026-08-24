import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "@/mcp/register-all";
import { READ, READ_NETWORK, CREATE, UPDATE, DESTRUCTIVE } from "@/mcp/tools/_annotations";

let tools: Tool[];

beforeAll(async () => {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerAllTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  tools = (await client.listTools()).tools;
});

/**
 * Every tool this server registers, mapped to the preset it must carry.
 * Presets come from the constants themselves — not re-spelled literals — so a
 * change to a preset's hint values propagates here instead of drifting out of
 * sync. Plans 2-6 add roughly 40 more tools against this same suite; a new
 * tool that is missing a row here fails the coverage test below rather than
 * going unchecked.
 */
export const EXPECTED_ANNOTATIONS: Record<string, ToolAnnotations> = {
  list_books: READ,
  create_book: CREATE,
  update_book: UPDATE,
  delete_book: DESTRUCTIVE,
  create_demo_book: CREATE,
  list_accounts: READ,
  get_account_tree: READ,
  create_account: CREATE,
  update_account: UPDATE,
  delete_account: DESTRUCTIVE,
  list_transactions: READ,
  search: READ,
  get_income_statement: READ,
  get_report_data: READ,
  get_account_balance_history: READ,
  get_investment_positions: READ,
  get_realized_gains: READ,
  get_security_detail: READ,
  create_security: CREATE,
  create_transaction: CREATE,
  update_transaction: DESTRUCTIVE,
  delete_transaction: DESTRUCTIVE,
  analyze_usage: READ_NETWORK,
  list_payees: READ,
  get_payee: READ,
  create_payee: CREATE,
  delete_payee: DESTRUCTIVE,
  create_issue_report: CREATE,
  list_issue_reports: READ,
  update_issue_report: UPDATE,
  delete_issue_report: DESTRUCTIVE,
  get_system_status: READ,
  list_recurring_rules: READ,
  create_recurring_rule: CREATE,
  update_recurring_rule: DESTRUCTIVE,
  delete_recurring_rule: DESTRUCTIVE,
  get_projected_transactions: READ,
  list_recurring_transactions: READ,
  process_recurring_rules: CREATE,
};

describe("tool annotations", () => {
  it("registers every tool with annotations", () => {
    const missing = tools.filter((t) => !t.annotations).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("maps exactly the registered tool set — no tool missing a row, no stale row", () => {
    const registeredNames = tools.map((t) => t.name).sort();
    const expectedNames = Object.keys(EXPECTED_ANNOTATIONS).sort();
    expect(registeredNames).toEqual(expectedNames);
  });

  it.each(Object.entries(EXPECTED_ANNOTATIONS))(
    "assigns %s its expected preset",
    (name, expected) => {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations).toEqual(expected);
    }
  );

  it("never defines a preset that is both readOnly and destructive", () => {
    const presets = { READ, READ_NETWORK, CREATE, UPDATE, DESTRUCTIVE };
    const contradictory = Object.entries(presets)
      .filter(([, preset]) => preset.readOnlyHint === true && preset.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  // The MCP defaults are not the safe-looking ones: destructiveHint and
  // openWorldHint both default to TRUE, so an omitted hint claims more about a
  // tool than saying nothing would. Omitting openWorldHint made every
  // database-only tool advertise itself as reaching an open world, erasing the
  // distinction from READ_NETWORK for any client that applies the defaults.
  // These two tests exist so that cannot come back.
  it("sets openWorldHint explicitly on every preset", () => {
    const presets = { READ, READ_NETWORK, CREATE, UPDATE, DESTRUCTIVE };
    const implicit = Object.entries(presets)
      .filter(([, preset]) => preset.openWorldHint === undefined)
      .map(([name]) => name);
    expect(
      implicit,
      "openWorldHint defaults to true — an unset preset claims the tool reaches external entities"
    ).toEqual([]);
  });

  it("sets destructiveHint and idempotentHint explicitly on every write preset", () => {
    // The spec calls both "meaningful only when readOnlyHint == false", so the
    // read presets are exempt from idempotentHint by design.
    const writePresets = { CREATE, UPDATE, DESTRUCTIVE };
    const implicit = Object.entries(writePresets)
      .filter(
        ([, preset]) =>
          preset.destructiveHint === undefined || preset.idempotentHint === undefined
      )
      .map(([name]) => name);
    expect(
      implicit,
      "destructiveHint defaults to true — an unset write preset claims the tool destroys data"
    ).toEqual([]);
  });

  // A tool that spreads a shared schema inherits that schema's descriptions —
  // or its lack of them. Plan 1 shipped create_security with every field
  // description silently stripped, because lib/schemas/securities.ts carried
  // none. This is the guard for that, and it binds the 16 tools Plan 2 adds.
  it("describes every input field of every tool", () => {
    const undescribed: string[] = [];
    const inspectedPaths: string[] = [];

    /**
     * Walks a JSON Schema node, checking every leaf a caller can actually
     * fill in. Walking only the top-level `properties` missed the fields that
     * most need describing: create_transaction's `splits` is an array of
     * objects, so `accountId` and `amount` live two levels down, under
     * `items.properties`, and went unchecked.
     */
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const schema = node as {
        description?: string;
        properties?: Record<string, unknown>;
        items?: unknown;
      };

      if (schema.properties) {
        for (const [field, child] of Object.entries(schema.properties)) {
          const childPath = `${path}.${field}`;
          inspectedPaths.push(childPath);
          const description = (child as { description?: string })?.description;
          if (!description?.trim()) undescribed.push(childPath);
          walk(child, childPath);
        }
      }

      // An array's `items` is one schema, not a named field, so it is not
      // counted or required to carry its own description — only the fields
      // inside it are.
      if (schema.items) walk(schema.items, `${path}[]`);
    };

    for (const tool of tools) walk(tool.inputSchema, tool.name);

    expect(
      undescribed,
      "Add .describe() to these fields — in lib/schemas/ if the tool spreads a shared schema."
    ).toEqual([]);

    // Positive control. The assertion above is satisfied by inspecting
    // nothing, so if the SDK ever changes the shape it publishes — a $ref
    // indirection, a renamed `properties` key — this test would keep passing
    // while checking no field at all.
    //
    // The count alone could not do that job. 157 of the 179 fields the walk
    // finds are top level, so a broken items/nested descent still cleared the
    // old `> 50` floor comfortably. Naming a field that only exists two levels
    // down is what makes the recursion itself observable.
    expect(
      inspectedPaths,
      "the walk stopped descending into array items — nested fields are unchecked"
    ).toContain("create_transaction.splits[].amount");

    expect(
      inspectedPaths.length,
      "the description walk inspected almost no fields — is it still finding them?"
    ).toBeGreaterThan(120);
  });
});

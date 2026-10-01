import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createPayee,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count, rows } from "@/tests/helpers/sql";
import type { Payee } from "@/types/db";

let mcp: McpTestClient;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Payee Tools", () => {
  const bookId = 1;

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

  describe("list_payees", () => {
    it("lists every payee in the book with counts and last transaction date", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const coffee = await createAccount({ name: "Coffee", type: "expense", bookId });
      const blueBottle = await createPayee({ name: "Blue Bottle", bookId });
      await createPayee({ name: "Unused Payee", bookId });

      await createTransactionWithSplits({
        bookId,
        date: "2024-03-05",
        description: "Coffee beans",
        payeeId: blueBottle.id,
        splits: [
          { accountId: coffee.id, amount: 1500 },
          { accountId: checking.id, amount: -1500 },
        ],
      });

      const { data, isError } = await callTool("list_payees", { bookId });

      expect(isError).toBe(false);
      expect(data).toHaveLength(2);
      const blueBottleRow = data.find((p: { id: number }) => p.id === blueBottle.id);
      expect(blueBottleRow.transactionCount).toBe(1);
      expect(blueBottleRow.lastTransactionDate).toBe("2024-03-05");
      const unusedRow = data.find((p: { name: string }) => p.name === "Unused Payee");
      expect(unusedRow.transactionCount).toBe(0);
      expect(unusedRow.lastTransactionDate).toBeNull();
    });

    // search and limit reach the same lib/payees.ts listPayees() the route
    // calls. The tool went four commits without them, dumping every payee in
    // the book, because the route-parity guard maps route to tool by name and
    // never compares what they accept.
    it("filters by a case-insensitive substring when search is given", async () => {
      await createPayee({ name: "Blue Bottle", bookId });
      await createPayee({ name: "Whole Foods", bookId });

      const { data, isError } = await callTool("list_payees", { bookId, search: "bLuE" });

      expect(isError).toBe(false);
      expect(data.map((p: { name: string }) => p.name)).toEqual(["Blue Bottle"]);
    });

    it("caps the rows returned when limit is given", async () => {
      await createPayee({ name: "Aardvark Supply", bookId });
      await createPayee({ name: "Blue Bottle", bookId });
      await createPayee({ name: "Whole Foods", bookId });

      const { data, isError } = await callTool("list_payees", { bookId, limit: 2 });

      expect(isError).toBe(false);
      // Sorted by name, so the limit takes the first two alphabetically.
      expect(data.map((p: { name: string }) => p.name)).toEqual([
        "Aardvark Supply",
        "Blue Bottle",
      ]);
    });
  });

  describe("get_payee", () => {
    it("returns the payee with transactionCount and a null lastAccountId when unused", async () => {
      const payee = await createPayee({ name: "Whole Foods", bookId });

      const { data, isError } = await callTool("get_payee", { bookId, payeeId: payee.id });

      expect(isError).toBe(false);
      expect(data.id).toBe(payee.id);
      expect(data.name).toBe("Whole Foods");
      expect(data.transactionCount).toBe(0);
      expect(data.lastAccountId).toBeNull();
    });

    it("returns lastAccountId as the largest debit split on the most recent transaction", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const groceries = await createAccount({ name: "Groceries", type: "expense", bookId });
      const dining = await createAccount({ name: "Dining", type: "expense", bookId });
      const payee = await createPayee({ name: "Whole Foods", bookId });

      // Older transaction — debit is groceries.
      await createTransactionWithSplits({
        bookId,
        date: "2025-01-01",
        payeeId: payee.id,
        splits: [
          { accountId: checking.id, amount: -1000 },
          { accountId: groceries.id, amount: 1000 },
        ],
      });

      // More recent transaction — debit is dining.
      await createTransactionWithSplits({
        bookId,
        date: "2025-01-10",
        payeeId: payee.id,
        splits: [
          { accountId: checking.id, amount: -5000 },
          { accountId: dining.id, amount: 5000 },
        ],
      });

      const { data, isError } = await callTool("get_payee", { bookId, payeeId: payee.id });

      expect(isError).toBe(false);
      expect(data.transactionCount).toBe(2);
      expect(data.lastAccountId).toBe(dining.id);
    });

    it("returns an error for an unknown payee", async () => {
      const { data, isError } = await callTool("get_payee", { bookId, payeeId: 999999 });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });

  describe("create_payee", () => {
    it("creates a payee with a normalized name", async () => {
      const { data, isError } = await callTool("create_payee", {
        bookId,
        name: "  Blue   Bottle  ",
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("Blue Bottle");
      expect(data.bookId).toBe(bookId);
    });

    it("does not fold case — IKEA and Ikea both succeed as distinct payees, through the tool's own wiring", async () => {
      // Exercises the CREATE annotation's contract through call_tool, not
      // lib/payees.ts directly: the library-level IKEA/Ikea test in
      // tests/lib/payees.test.ts calls createPayee() itself, so it can't
      // see a dedup check bolted onto the TOOL's handler instead. If the
      // tool ever grew the HTTP route's case-insensitive pre-check, the
      // second call below would silently return the first call's id
      // instead of succeeding with a new one.
      const upper = await callTool("create_payee", { bookId, name: "IKEA" });
      const mixed = await callTool("create_payee", { bookId, name: "Ikea" });

      expect(upper.isError).toBe(false);
      expect(mixed.isError).toBe(false);
      expect(upper.data.id).not.toBe(mixed.data.id);
    });

    it("refuses a name of only whitespace at the schema boundary, before the book gate", async () => {
      // The zod schema trims before min(1), so the SDK refuses this before the
      // handler runs, and so before requireBookAuth. The JSON Schema that Rust
      // validates has no trim, so the Rust handler must refuse it the same
      // way, and before its own book gate. Book 999 does not exist: a gate
      // that runs first gives an access error instead of the input error. The
      // error is the SDK's plain text, not fail()'s JSON, so this calls
      // client.callTool directly.
      for (const target of [bookId, 999]) {
        const result = await mcp.client.callTool({
          name: "create_payee",
          arguments: { bookId: target, name: "   " },
        });

        expect(result.isError).toBe(true);
        const [content] = result.content as Array<{ type: string; text: string }>;
        expect(content.text).toMatch(/^MCP error -32602: Input validation error: .*Name is required/s);
      }

      expect(await count("payees", "book_id = $1", [bookId])).toBe(0);
    });

    it("refuses an exact repeat rather than silently returning the existing row", async () => {
      // payees has a unique index on (name, book_id) — the baseline
      // migration's payees_name_book_unique — so the tool literally cannot insert two
      // rows for the identical name in one book; "always inserts a new
      // row" can't hold for THIS case the way it does for a case variant.
      // What must hold instead: the second call fails loudly rather than
      // quietly handing back the first row's id, the way the HTTP route's
      // dedup pre-check would. That silent-merge is exactly what this test
      // would fail to catch if it merely asserted "no crash".
      const first = await callTool("create_payee", { bookId, name: "Repeat Co" });
      const second = await callTool("create_payee", { bookId, name: "Repeat Co" });

      expect(first.isError).toBe(false);
      expect(second.isError).toBe(true);
      expect(second.data.error).toMatch(/already exists/i);

      const stored = await rows<Payee>("SELECT * FROM payees WHERE book_id = $1", [bookId]);
      expect(stored.filter((p) => p.name === "Repeat Co")).toHaveLength(1);
    });
  });

  describe("delete_payee", () => {
    it("refuses to delete a payee with transactions", async () => {
      const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank", bookId });
      const coffee = await createAccount({ name: "Coffee", type: "expense", bookId });
      const payee = await createPayee({ name: "Blue Bottle", bookId });

      await createTransactionWithSplits({
        bookId,
        date: "2024-01-01",
        payeeId: payee.id,
        splits: [
          { accountId: coffee.id, amount: 450 },
          { accountId: checking.id, amount: -450 },
        ],
      });

      const { data, isError } = await callTool("delete_payee", { bookId, payeeId: payee.id });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/associated transactions/i);

      // The refused delete must not have partially applied.
      expect(await count("payees", "id = $1", [payee.id])).toBe(1);
    });

    it("deletes an unused payee", async () => {
      const payee = await createPayee({ name: "Unused Payee", bookId });

      const { data, isError } = await callTool("delete_payee", { bookId, payeeId: payee.id });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      expect(await count("payees", "id = $1", [payee.id])).toBe(0);
    });

    it("returns an error for an unknown payee", async () => {
      const { data, isError } = await callTool("delete_payee", { bookId, payeeId: 999999 });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });
});

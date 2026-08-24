import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createPayee,
  createTransactionWithSplits,
} from "@/tests/helpers/db-utils";
import { getDb } from "@/db";
import { payees } from "@/db/schema";
import { eq } from "drizzle-orm";

// Mock MCP auth to return an authenticated user, same pattern as
// mcp-account-tools.test.ts.
vi.mock("@/mcp/auth", () => ({
  getMcpAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  verifyBookAccess: vi.fn().mockResolvedValue(true),
  requireAuth: vi.fn().mockReturnValue({ userId: 1, keyId: 1 }),
  requireBookAuth: vi.fn().mockResolvedValue({ userId: 1, keyId: 1 }),
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual };
});

let client: Client;
let server: McpServer;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const isError = result.isError ?? false;
  const textContent = (result.content as Array<{ type: string; text: string }>)?.find(
    (c) => c.type === "text"
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  if (isError) {
    try {
      data = textContent ? JSON.parse(textContent.text) : undefined;
    } catch {
      data = { error: textContent?.text };
    }
  } else {
    data = textContent ? JSON.parse(textContent.text) : undefined;
  }
  return { data, isError };
}

describe("MCP Payee Tools", () => {
  const bookId = 1;

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerPayeeTools } = await import("@/mcp/tools/payees");
    registerPayeeTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
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

    it("refuses an exact repeat rather than silently returning the existing row", async () => {
      // payees has a unique index on (name, bookId) — db/schema.ts's
      // payees_name_book_unique — so the tool literally cannot insert two
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

      const rows = await getDb().select().from(payees).where(eq(payees.bookId, bookId));
      expect(rows.filter((p) => p.name === "Repeat Co")).toHaveLength(1);
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
      const rows = await getDb().select().from(payees).where(eq(payees.id, payee.id));
      expect(rows).toHaveLength(1);
    });

    it("deletes an unused payee", async () => {
      const payee = await createPayee({ name: "Unused Payee", bookId });

      const { data, isError } = await callTool("delete_payee", { bookId, payeeId: payee.id });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      const rows = await getDb().select().from(payees).where(eq(payees.id, payee.id));
      expect(rows).toHaveLength(0);
    });

    it("returns an error for an unknown payee", async () => {
      const { data, isError } = await callTool("delete_payee", { bookId, payeeId: 999999 });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });
});

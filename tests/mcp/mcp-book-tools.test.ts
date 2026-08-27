import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupTestDatabase, resetTestDatabase, createUser } from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { getDb } from "@/db";
import { books } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createBook } from "@/lib/books";

// Books are user-scoped, not book-scoped: every tool here calls requireAuth(),
// never requireBookAuth(). Mock auth to the same userId the seeded test user
// (tests/helpers/db-utils.ts) has, same pattern as mcp-account-tools.test.ts.
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

// Stub seedBook, same as tests/lib/books.test.ts. What create_demo_book adds
// over its library test is the MCP wiring — auth, the tool result envelope,
// the book that comes back — none of which depends on thousands of seeded
// rows. The real seedBook is covered end to end by tests/api/books-demo.test.ts.
vi.mock("@/db/seed", async (importActual) => {
  const actual = await importActual<typeof import("@/db/seed")>();
  return { ...actual, seedBook: vi.fn() };
});

let client: Client;
let server: McpServer;

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(client, name, args);

describe("MCP Book Tools", () => {
  const userId = 1; // matches the mocked requireAuth() above

  beforeAll(async () => {
    await setupTestDatabase();

    server = new McpServer({ name: "test", version: "0.0.1" });
    const { registerBooksTools } = await import("@/mcp/tools/books");
    registerBooksTools(server);

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

  describe("create_book", () => {
    it("creates a book owned by the authenticated user", async () => {
      const { data, isError } = await callTool("create_book", { name: "Household" });

      expect(isError).toBe(false);
      expect(data.name).toBe("Household");
      expect(data.userId).toBe(userId);
    });
  });

  describe("update_book", () => {
    it("renames a book the user owns", async () => {
      const book = await createBook(getDb(), userId, { name: "Old Name" });

      const { data, isError } = await callTool("update_book", {
        bookId: book.id,
        name: "New Name",
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("New Name");
    });

    it("returns an error for another user's book", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createBook(getDb(), otherUser.id, { name: "Theirs" });

      const { data, isError } = await callTool("update_book", {
        bookId: theirs.id,
        name: "Stolen",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);
    });
  });

  describe("create_demo_book", () => {
    it("creates and seeds a demo book", async () => {
      const { data, isError } = await callTool("create_demo_book");

      expect(isError).toBe(false);
      expect(data.name).toBe("Demo Book");
      expect(data.userId).toBe(userId);
    });
  });

  describe("delete_book", () => {
    it("deletes when confirmBookName matches exactly", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });

      const { data, isError } = await callTool("delete_book", {
        bookId: book.id,
        confirmBookName: "Household",
      });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      const rows = await getDb().select().from(books).where(eq(books.id, book.id));
      expect(rows).toHaveLength(0);
    });

    it("refuses a mismatched confirmBookName and leaves the book present", async () => {
      const book = await createBook(getDb(), userId, { name: "Household" });

      const { data, isError } = await callTool("delete_book", {
        bookId: book.id,
        confirmBookName: "household",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/does not match/i);

      // The guard actually guards: the book must still be there, not merely
      // that the call reported an error.
      const rows = await getDb().select().from(books).where(eq(books.id, book.id));
      expect(rows).toHaveLength(1);
    });

    it("returns an error for another user's book without revealing its name", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await createBook(getDb(), otherUser.id, { name: "Theirs" });

      const { data, isError } = await callTool("delete_book", {
        bookId: theirs.id,
        confirmBookName: "Theirs",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);

      const rows = await getDb().select().from(books).where(eq(books.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });
});

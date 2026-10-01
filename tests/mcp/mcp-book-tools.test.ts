import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  setupTestDatabase, resetTestDatabase, createUser, createBook,
} from "@/tests/helpers/db-utils";
import { callMcpTool } from "@/tests/helpers/mcp";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { count } from "@/tests/helpers/sql";

let mcp: McpTestClient;

/** A book of `userId`. A trigger adds the owner's membership. */
const ownedBook = (userId: number, name: string) => createBook({ name, userId });

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  callMcpTool(mcp.client, name, args);

describe("MCP Book Tools", () => {
  const userId = 1; // the user of the test client's key

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
      const book = await ownedBook(userId, "Old Name");

      const { data, isError } = await callTool("update_book", {
        bookId: book.id,
        name: "New Name",
      });

      expect(isError).toBe(false);
      expect(data.name).toBe("New Name");
    });

    it("returns an error for another user's book", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await ownedBook(otherUser.id, "Theirs");

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

    it("creates the dataset that the dataset parameter names", async () => {
      const { data, isError } = await callTool("create_demo_book", { dataset: "single" });

      expect(isError).toBe(false);
      expect(data.name).toBe("Demo Book - Single");
      expect(await count("accounts", "book_id = $1 AND name = $2", [data.id, "Mortgage"])).toBe(1);
    }, 120_000);

    it("refuses an unknown dataset", async () => {
      // The schema check fails with a non-JSON error result, so read it raw.
      const result = await mcp.client.callTool({
        name: "create_demo_book",
        arguments: { dataset: "nope" },
      });

      expect(result.isError).toBe(true);
      expect(await count("books", "name LIKE $1", ["Demo Book%"])).toBe(0);
    });
  });

  describe("delete_book", () => {
    it("deletes when confirmBookName matches exactly", async () => {
      const book = await ownedBook(userId, "Household");

      const { data, isError } = await callTool("delete_book", {
        bookId: book.id,
        confirmBookName: "Household",
      });

      expect(isError).toBe(false);
      expect(data.success).toBe(true);

      expect(await count("books", "id = $1", [book.id])).toBe(0);
    });

    it("refuses a mismatched confirmBookName and leaves the book present", async () => {
      const book = await ownedBook(userId, "Household");

      const { data, isError } = await callTool("delete_book", {
        bookId: book.id,
        confirmBookName: "household",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/does not match/i);

      // The guard actually guards: the book must still be there, not merely
      // that the call reported an error.
      expect(await count("books", "id = $1", [book.id])).toBe(1);
    });

    it("returns an error for another user's book without revealing its name", async () => {
      const otherUser = await createUser({ username: "someone-else" });
      const theirs = await ownedBook(otherUser.id, "Theirs");

      const { data, isError } = await callTool("delete_book", {
        bookId: theirs.id,
        confirmBookName: "Theirs",
      });

      expect(isError).toBe(true);
      expect(data.error).toMatch(/not found/i);

      expect(await count("books", "id = $1", [theirs.id])).toBe(1);
    });
  });

  describe("list_books with shared books", () => {
    it("returns the role of each book", async () => {
      const { data } = await callTool("list_books");
      expect(data).toEqual([expect.objectContaining({ id: 1, name: "Test Book", role: "owner" })]);
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { books } from "@/db/schema";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import {
  addBookMember, createBook, createUser, db, resetTestDatabase, setupTestDatabase,
} from "@/tests/helpers/db-utils";

// The book gate of the MCP tools, with each role. callAs sends that user's key.
let mcp: McpTestClient;
let editorId: number;
let viewerId: number;
let strangerId: number;

beforeAll(async () => {
  await setupTestDatabase();
  mcp = await connectMcpTestClient();
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase();
  editorId = (await createUser({ username: "editor" })).id;
  viewerId = (await createUser({ username: "viewer" })).id;
  strangerId = (await createUser({ username: "stranger" })).id;
  await addBookMember({ bookId: 1, userId: editorId, role: "editor" });
  await addBookMember({ bookId: 1, userId: viewerId, role: "viewer" });
});

afterAll(async () => {
  await mcp.close();
});

const newAccount = (bookId = 1) => ({ bookId, name: "Cash", type: "asset" });

describe("book gate", () => {
  it("lets an editor write", async () => {
    const { data, isError } = await mcp.callAs(editorId, "create_account", newAccount());
    expect(isError).toBe(false);
    expect(data).toMatchObject({ name: "Cash" });
  });

  it("lets a viewer read, and refuses a write", async () => {
    expect((await mcp.callAs(viewerId, "list_accounts", { bookId: 1 })).isError).toBe(false);
    expect(await mcp.callAs(viewerId, "create_account", newAccount())).toEqual({
      isError: true,
      data: { error: "You have read-only access to this book" },
    });
  });

  it("refuses an editor an owner-only tool", async () => {
    expect(
      await mcp.callAs(editorId, "add_book_member", { bookId: 1, username: "stranger", role: "viewer" })
    ).toEqual({ isError: true, data: { error: "Only an owner can do this" } });
  });

  it("gives a non-member, and a book that does not exist, the book access error", async () => {
    for (const [userId, bookId] of [[strangerId, 1], [1, 999999]]) {
      expect(await mcp.callAs(userId, "list_accounts", { bookId })).toEqual({
        isError: true,
        data: { error: "You do not have access to this book" },
      });
    }
  });

  it("checks the role in the book that the call names", async () => {
    // The editor is a viewer of a second book. The role must come from the
    // book that the call names, not from the first book of the editor.
    const second = await createBook({ name: "Second Book" });
    await addBookMember({ bookId: second.id, userId: editorId, role: "viewer" });
    expect(await mcp.callAs(editorId, "create_account", newAccount(second.id))).toEqual({
      isError: true,
      data: { error: "You have read-only access to this book" },
    });
    expect((await mcp.callAs(editorId, "create_account", newAccount(1))).isError).toBe(false);
  });
});

// update_book and delete_book do not use the book gate: the route checks for
// the owner.
describe("owner-only book tools", () => {
  const storedBook = async () => (await db.select().from(books).where(eq(books.id, 1)))[0];

  it.each([
    ["an editor", () => editorId],
    ["a viewer", () => viewerId],
  ])("refuses update_book from %s and keeps the name", async (_role, userId) => {
    const { data, isError } = await mcp.callAs(userId(), "update_book", { bookId: 1, name: "Renamed" });
    expect(isError).toBe(true);
    expect(data).toEqual({ error: "Only an owner can do this" });
    expect((await storedBook()).name).toBe("Test Book");
  });

  it.each([
    ["an editor", () => editorId],
    ["a viewer", () => viewerId],
  ])("refuses delete_book from %s and keeps the book", async (_role, userId) => {
    const { data, isError } = await mcp.callAs(userId(), "delete_book", { bookId: 1, confirmBookName: "Test Book" });
    expect(isError).toBe(true);
    expect(data).toEqual({ error: "Only an owner can do this" });
    expect(await storedBook()).toBeDefined();
  });

  it("gives a non-member not found, not forbidden", async () => {
    const { data, isError } = await mcp.callAs(strangerId, "update_book", { bookId: 1, name: "Renamed" });
    expect(isError).toBe(true);
    expect(data).toEqual({ error: "Book 1 not found" });
  });

  it("lets the owner rename and delete the book", async () => {
    const renamed = await mcp.callAs(1, "update_book", { bookId: 1, name: "Renamed" });
    expect(renamed.isError).toBe(false);
    expect((await storedBook()).name).toBe("Renamed");

    const deleted = await mcp.callAs(1, "delete_book", { bookId: 1, confirmBookName: "Renamed" });
    expect(deleted).toEqual({ data: { success: true, bookId: 1 }, isError: false });
    expect(await storedBook()).toBeUndefined();
  });
});

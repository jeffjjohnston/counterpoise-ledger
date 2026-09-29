import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectMcpTestClient, type McpTestClient } from "@/tests/helpers/mcp-client";
import { addBookMember, createUser, resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";

// callAs sets the calling user: it sends that user's API key.
let mcp: McpTestClient;
let viewerId: number;

const as = (userId: number, name: string, args: Record<string, unknown>) => mcp.callAs(userId, name, args);

beforeAll(async () => {
  await setupTestDatabase();
  mcp = await connectMcpTestClient();
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase();
  viewerId = (await createUser({ username: "vi" })).id;
  await addBookMember({ bookId: 1, userId: viewerId, role: "viewer" });
  await createUser({ username: "newbie" });
});

afterAll(async () => {
  await mcp.close();
});

describe("member tools", () => {
  it("lists members for a viewer", async () => {
    const { data, isError } = await as(viewerId, "list_book_members", { bookId: 1 });
    expect(isError).toBe(false);
    expect(data.map((m: { username: string }) => m.username)).toEqual(["testuser", "vi"]);
  });

  it("lets an owner add, change and remove", async () => {
    const added = await as(1, "add_book_member", { bookId: 1, username: "newbie", role: "editor" });
    expect(added.data).toMatchObject({ username: "newbie", role: "editor" });
    const changed = await as(1, "update_book_member", { bookId: 1, userId: added.data.userId, role: "viewer" });
    expect(changed.data).toMatchObject({ role: "viewer" });
    const removed = await as(1, "remove_book_member", { bookId: 1, userId: added.data.userId });
    expect(removed.isError).toBe(false);
  });

  it("refuses a viewer who adds a member", async () => {
    const { data, isError } = await as(viewerId, "add_book_member", { bookId: 1, username: "newbie", role: "viewer" });
    expect(isError).toBe(true);
    expect(data).toEqual({ error: "Only an owner can do this" });
  });

  it("refuses a viewer who removes a different member", async () => {
    const { data, isError } = await as(viewerId, "remove_book_member", { bookId: 1, userId: 1 });
    expect(isError).toBe(true);
    expect(data).toEqual({ error: "Only an owner can do this" });

    const { data: members } = await as(1, "list_book_members", { bookId: 1 });
    expect(members.map((m: { userId: number }) => m.userId)).toContain(1);
  });

  it("lets a viewer leave", async () => {
    const { isError } = await as(viewerId, "remove_book_member", { bookId: 1, userId: viewerId });
    expect(isError).toBe(false);
  });

  it("refuses the last owner who leaves", async () => {
    const { data } = await as(1, "remove_book_member", { bookId: 1, userId: 1 });
    expect(data).toEqual({ error: "A book must keep at least one owner" });
  });
});

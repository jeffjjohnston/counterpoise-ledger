import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember,
  createBook,
  createUser,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";
import { exec, insert, row, rows } from "@/tests/helpers/sql";

beforeAll(setupTestDatabase);
beforeEach(resetTestDatabase);

const members = (bookId: number) =>
  rows<{ userId: number; role: string }>(
    "SELECT user_id, role FROM book_members WHERE book_id = $1 ORDER BY user_id",
    [bookId]
  );

describe("book_members", () => {
  it("makes the creator the owner of the seeded test book", async () => {
    expect(await members(1)).toEqual([{ userId: 1, role: "owner" }]);
  });

  it("adds the creator as owner when a book is inserted", async () => {
    const alice = await createUser({ username: "alice" });
    const book = await createBook({ name: "Alice's book", userId: alice.id });
    expect(await members(book.id)).toEqual([{ userId: alice.id, role: "owner" }]);
  });

  it("adds the creator as owner for a raw SQL insert", async () => {
    await exec(`INSERT INTO books (user_id, name, created_at, updated_at)
      VALUES (1, 'Raw', strftime('%Y-%m-%d %H:%M:%f', 'now'), strftime('%Y-%m-%d %H:%M:%f', 'now'))`);
    const raw = await row<{ id: number }>("SELECT id FROM books WHERE name = 'Raw'");
    expect((await members(raw.id)).map((m) => m.role)).toEqual(["owner"]);
  });

  it("refuses an unknown role", async () => {
    const bob = await createUser({ username: "bob" });
    await expect(
      insert("book_members", { bookId: 1, userId: bob.id, role: "admin" })
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("refuses a second row for the same book and user", async () => {
    await expect(addBookMember({ bookId: 1, userId: 1, role: "editor" })).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("deletes the memberships with the book", async () => {
    const book = await createBook({ name: "Short-lived" });
    await exec("DELETE FROM books WHERE id = $1", [book.id]);
    expect(await members(book.id)).toEqual([]);
  });

  it("sets created_by and updated_by to null when the user is deleted", async () => {
    const carol = await createUser({ username: "carol" });
    const txn = await insert<{ id: number }>("transactions", {
      bookId: 1, date: "2026-01-01", createdBy: carol.id, updatedBy: carol.id,
    });
    await exec("DELETE FROM users WHERE id = $1", [carol.id]);
    const after = await row<{ createdBy: number | null; updatedBy: number | null }>(
      "SELECT created_by, updated_by FROM transactions WHERE id = $1",
      [txn.id]
    );
    expect(after).toEqual({ createdBy: null, updatedBy: null });
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bookMembers, books, transactions, users } from "@/db/schema";
import {
  addBookMember,
  createBook,
  createUser,
  db,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";

beforeAll(setupTestDatabase);
beforeEach(resetTestDatabase);

describe("book_members", () => {
  it("makes the creator the owner of the seeded test book", async () => {
    const rows = await db.select().from(bookMembers).where(eq(bookMembers.bookId, 1));
    expect(rows).toEqual([expect.objectContaining({ bookId: 1, userId: 1, role: "owner" })]);
  });

  it("adds the creator as owner when a book is inserted", async () => {
    const alice = await createUser({ username: "alice" });
    const book = await createBook({ name: "Alice's book", userId: alice.id });

    const rows = await db.select().from(bookMembers).where(eq(bookMembers.bookId, book.id));
    expect(rows.map((r) => [r.userId, r.role])).toEqual([[alice.id, "owner"]]);
  });

  it("adds the creator as owner for a raw SQL insert", async () => {
    await db.execute(sql`INSERT INTO books (user_id, name, created_at, updated_at) VALUES (1, 'Raw', now(), now())`);
    const [raw] = await db.select().from(books).where(eq(books.name, "Raw"));
    const rows = await db.select().from(bookMembers).where(eq(bookMembers.bookId, raw.id));
    expect(rows.map((r) => r.role)).toEqual(["owner"]);
  });

  it("refuses an unknown role", async () => {
    const bob = await createUser({ username: "bob" });
    await expect(
      db.execute(sql`INSERT INTO book_members (book_id, user_id, role, created_at) VALUES (1, ${bob.id}, 'admin', now())`)
    ).rejects.toThrow();
  });

  it("refuses a second row for the same book and user", async () => {
    await expect(addBookMember({ bookId: 1, userId: 1, role: "editor" })).rejects.toThrow();
  });

  it("deletes the memberships with the book", async () => {
    const book = await createBook({ name: "Short-lived" });
    await db.delete(books).where(eq(books.id, book.id));
    const rows = await db.select().from(bookMembers).where(eq(bookMembers.bookId, book.id));
    expect(rows).toEqual([]);
  });

  it("sets created_by and updated_by to null when the user is deleted", async () => {
    const carol = await createUser({ username: "carol" });
    const [txn] = await db
      .insert(transactions)
      .values({ bookId: 1, date: "2026-01-01", createdBy: carol.id, updatedBy: carol.id })
      .returning();
    await db.delete(users).where(eq(users.id, carol.id));
    const [after] = await db.select().from(transactions).where(eq(transactions.id, txn.id));
    expect(after.createdBy).toBeNull();
    expect(after.updatedBy).toBeNull();
  });

  it("backfills one owner row for every existing book", async () => {
    const dave = await createUser({ username: "dave" });
    const book = await createBook({ name: "Dave's book", userId: dave.id });
    await db.delete(bookMembers);

    const file = readdirSync("db/migrations").find((f) => f.endsWith("_book_members_owner.sql"));
    const migration = readFileSync(`db/migrations/${file}`, "utf8");
    const backfill = migration
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, "").trim().startsWith("INSERT INTO book_members"));
    expect(backfill).toHaveLength(1);
    await db.execute(sql.raw(backfill[0]));

    const rows = await db.select().from(bookMembers);
    expect(rows.map((r) => [r.bookId, r.userId, r.role]).sort()).toEqual(
      [[1, 1, "owner"], [book.id, dave.id, "owner"]].sort()
    );
  });
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { books, users } from "@/db/schema";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db-utils";
import {
  fetchBookRows,
  formatBooksTable,
  sortBookRows,
  type BookListRow,
} from "@/scripts/list-books";

const db = getDb();

describe("list-books script helpers", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("fetches joined rows with username, book name, and book id", async () => {
    const [alice] = await db
      .insert(users)
      .values({ id: 2, username: "alice", passwordHash: "hash" })
      .returning();

    await db
      .insert(books)
      .values([
        { id: 2, userId: alice.id, name: "Brokerage" },
        { id: 3, userId: alice.id, name: "Family" },
      ]);

    const rows = await fetchBookRows();

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username: "testuser", bookName: "Test Book" }),
        expect.objectContaining({ username: "alice", bookName: "Brokerage" }),
        expect.objectContaining({ username: "alice", bookName: "Family" }),
      ])
    );

    expect(Object.keys(rows[0]).sort()).toEqual(["bookId", "bookName", "username"]);
  });

  it("returns rows in deterministic order: username, book name, then book id", async () => {
    const [alex] = await db
      .insert(users)
      .values({ id: 2, username: "alex", passwordHash: "hash" })
      .returning();

    const [sam] = await db
      .insert(users)
      .values({ id: 3, username: "sam", passwordHash: "hash" })
      .returning();

    await db
      .insert(books)
      .values([
        { id: 2, userId: sam.id, name: "B" },
        { id: 3, userId: alex.id, name: "B" },
        { id: 4, userId: alex.id, name: "A" },
      ]);

    const rows = await fetchBookRows();

    const sortedCopy = sortBookRows(rows);
    expect(rows).toEqual(sortedCopy);
  });

  it("formats the table with headers in required order", () => {
    const rows: BookListRow[] = [
      { username: "bob", bookName: "Primary", bookId: 12 },
      { username: "alice", bookName: "Savings", bookId: 2 },
    ];

    const output = formatBooksTable(sortBookRows(rows));
    const [headerLine, dividerLine, firstDataLine] = output.split("\n");

    expect(headerLine).toBe("username | book name | book id");
    expect(dividerLine).toContain("-+-");
    expect(firstDataLine.startsWith("alice")).toBe(true);
  });

  it("returns empty-state message when there are no books", async () => {
    await db.delete(books);
    await db.delete(users);

    const rows = await fetchBookRows();

    expect(rows).toEqual([]);
    expect(formatBooksTable(rows)).toBe("No books found.");
  });
});

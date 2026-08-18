import { asc, eq } from "drizzle-orm";
import { pathToFileURL } from "url";
import { closeDb, getDb } from "../db";
import { books, users } from "../db/schema";

export type BookListRow = {
  username: string;
  bookName: string;
  bookId: number;
};

export async function fetchBookRows(): Promise<BookListRow[]> {
  const db = getDb();

  return db
    .select({
      username: users.username,
      bookName: books.name,
      bookId: books.id,
    })
    .from(books)
    .innerJoin(users, eq(books.userId, users.id))
    .orderBy(asc(users.username), asc(books.name), asc(books.id));
}

export function sortBookRows(rows: BookListRow[]): BookListRow[] {
  return [...rows].sort((left, right) => {
    const byUsername = left.username.localeCompare(right.username);
    if (byUsername !== 0) return byUsername;

    const byBookName = left.bookName.localeCompare(right.bookName);
    if (byBookName !== 0) return byBookName;

    return left.bookId - right.bookId;
  });
}

export function formatBooksTable(rows: BookListRow[]): string {
  if (rows.length === 0) {
    return "No books found.";
  }

  const headers = ["username", "book name", "book id"];
  const tableRows = rows.map((row) => [row.username, row.bookName, String(row.bookId)]);

  const columnWidths = headers.map((header, columnIndex) => {
    const widestValue = Math.max(...tableRows.map((row) => row[columnIndex].length));
    return Math.max(header.length, widestValue);
  });

  const formatRow = (cells: string[]) =>
    cells.map((cell, columnIndex) => cell.padEnd(columnWidths[columnIndex])).join(" | ");

  const divider = columnWidths.map((width) => "-".repeat(width)).join("-+-");

  return [formatRow(headers), divider, ...tableRows.map(formatRow)].join("\n");
}

export async function listBooksMain(logger: Pick<Console, "log" | "error"> = console) {
  try {
    const rows = await fetchBookRows();
    const sortedRows = sortBookRows(rows);
    logger.log(formatBooksTable(sortedRows));
  } catch (error) {
    logger.error("Failed to list books:", error);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void listBooksMain();
}

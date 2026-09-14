import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { e2eDatabaseUrl } from "./database";
import { seedBookData } from "./seed-book";

// Read-only specs may share the global seed. Every ledger-mutating spec uses
// its own book, including on retries, so other tests cannot change its totals.
export const test = base.extend<{ bookId: number }>({
  bookId: async ({ request }, provide) => {
    const response = await request.post("/api/books", { data: { name: `Fixture ${randomUUID()}` } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json() as { id: number };
    const sql = postgres(e2eDatabaseUrl(), { onnotice: () => {} });
    try {
      await seedBookData(sql, id);
      await provide(id);
    } finally {
      try { await sql`DELETE FROM books WHERE id = ${id} AND user_id = 1`; }
      finally { await sql.end(); }
    }
  },
});
export { expect };

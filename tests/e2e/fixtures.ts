import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { e2eDatabaseUrl } from "./database";
import { seedBookData, seedSmallBookData } from "./seed-book";

// Read-only specs may share the global seed. Every ledger-mutating spec uses
// its own book, including on retries, so other tests cannot change its totals.
function bookFixture(seed: ((sql: postgres.Sql, bookId: number) => Promise<void>) | null, label: string) {
  return async ({ request }: { request: APIRequestContext }, provide: (id: number) => Promise<void>) => {
    const response = await request.post("/api/books", { data: { name: `Fixture ${randomUUID()}` } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json() as { id: number };
    let sql: postgres.Sql | undefined;
    try {
      if (seed) {
        sql = postgres(e2eDatabaseUrl(), { onnotice: () => {} });
        const seedStart = performance.now();
        await seed(sql, id);
        if (process.env.E2E_FIXTURE_TIMING === "1")
          console.log(`E2E ${label} book seed: ${(performance.now() - seedStart).toFixed(1)} ms`);
      }
      await provide(id);
    } finally {
      const cleanupSql = sql ?? postgres(e2eDatabaseUrl(), { onnotice: () => {} });
      try { await cleanupSql`DELETE FROM books WHERE id = ${id} AND user_id = 1`; }
      finally { await cleanupSql.end(); }
    }
  };
}

export const test = base.extend<{ bookId: number }>({
  bookId: bookFixture(seedBookData, "full"),
});
export const smallBookTest = base.extend<{ bookId: number }>({
  bookId: bookFixture(seedSmallBookData, "small"),
});
export const emptyBookTest = base.extend<{ bookId: number }>({
  bookId: bookFixture(null, "empty"),
});
export { expect };

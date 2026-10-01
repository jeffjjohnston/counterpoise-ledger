import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { e2eDatabasePath } from "./database";
import { seedBookData, seedSmallBookData, type ApiPost, type SeedBook } from "./seed-book";
import { exec, setDatabasePath } from "../helpers/sql";

// A Playwright worker is not a Vitest worker, so the SQL helper must be told
// which database to use. Every spec that uses the helper imports this module.
setDatabasePath(e2eDatabasePath());

/** A POST as the E2E user, through the request context of the test. */
function apiPost(request: APIRequestContext): ApiPost {
  return async (path, body) => {
    const response = await request.post(path, { data: body });
    if (!response.ok()) throw new Error(`POST ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
}

// Read-only specs may share the global seed. Every ledger-mutating spec uses
// its own book, including on retries, so other tests cannot change its totals.
function bookFixture(seed: SeedBook | null, label: string) {
  return async ({ request }: { request: APIRequestContext }, provide: (id: number) => Promise<void>) => {
    const response = await request.post("/api/books", { data: { name: `Fixture ${randomUUID()}` } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json() as { id: number };
    try {
      if (seed) {
        const seedStart = performance.now();
        await seed(id, apiPost(request));
        if (process.env.E2E_FIXTURE_TIMING === "1")
          console.log(`E2E ${label} book seed: ${(performance.now() - seedStart).toFixed(1)} ms`);
      }
      await provide(id);
    } finally {
      await exec("DELETE FROM books WHERE id = $1 AND user_id = 1", [id]);
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

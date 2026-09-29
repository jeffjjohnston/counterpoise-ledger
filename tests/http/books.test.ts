import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addBookMember, createBook, createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

type BookBody = { id: number; name: string; role?: string; createdAt: string; updatedAt: string; [field: string]: unknown };
const bookListSchema = contract<BookBody[]>("BookList");
const bookSchema = contract<BookBody>("Book");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

describe("book HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ TZ: "America/New_York" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  const json = (value: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  it("lists membership roles and preserves book response fields", async () => {
    const other = await createUser({ username: "other" });
    const shared = await createBook({ name: "Shared", userId: other.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const response = await client.request("/api/books");
    expect(response.status).toBe(200);
    const books = bookListSchema.parse(await response.json());
    expect(books.map((book) => [book.name, book.role])).toEqual([
      ["Test Book", "owner"], ["Shared", "viewer"],
    ]);
    expect(books[1].userId).toBe(other.id);
  });

  it("creates, updates, and deletes a book with the same response contract", async () => {
    const before = Date.now();
    const createdResponse = await client.request("/api/books", json({ name: "  Ledger  ", id: 999 }));
    expect(createdResponse.status).toBe(200);
    const created = bookSchema.parse(await createdResponse.json());
    expect(created).toMatchObject({ name: "Ledger", upcomingDays: 30, userId: 1 });
    expect(created.role).toBeUndefined();
    expect(new Date(created.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(created.createdAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const updatedResponse = await client.request(`/api/books/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: '{"name":"New Ledger","upcomingDays":45.0}',
    });
    expect(updatedResponse.status).toBe(200);
    const updated = bookSchema.parse(await updatedResponse.json());
    expect(updated).toMatchObject({ id: created.id, name: "New Ledger", upcomingDays: 45 });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(updated.updatedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const deleted = await client.request(`/api/books/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true });
    expect((bookListSchema.parse(await (await client.request("/api/books")).json())).map((book) => book.id)).not.toContain(created.id);
  });

  it("keeps validation and owner denials", async () => {
    for (const [path, init, status, body] of [
      ["/api/books", json({ name: " " }), 400, { error: "Book name is required" }],
      ["/api/books/not-a-book", { ...json({ name: "X" }), method: "PUT" }, 400, { error: "Invalid book ID" }],
      ["/api/books/1", { ...json({ name: "X", upcomingDays: 0 }), method: "PUT" }, 400, { error: "upcomingDays must be an integer between 1 and 365" }],
      ["/api/books/999999", { method: "DELETE" }, 404, { error: "Book not found" }],
      ["/api/books/99999999999", { ...json({ name: " " }), method: "PUT" }, 400, { error: "Book name is required" }],
      ["/api/books/99999999999", { ...json({ name: "X" }), method: "PUT" }, 500, { error: "Failed to update book" }],
      ["/api/books/99999999999", { method: "DELETE" }, 500, { error: "Failed to delete book" }],
    ] as const) {
      const response = await client.request(path, init);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
    const other = await createUser({ username: "other" });
    const shared = await createBook({ name: "Shared", userId: other.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const denied = await client.request(`/api/books/${shared.id}`, { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Only an owner can do this" });
    expect((await client.anonymous("/api/books")).status).toBe(401);
  });
});

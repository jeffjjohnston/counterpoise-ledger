import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { books, users } from "@/db/schema";
import { GET, POST } from "@/app/api/books/route";
import { PUT, DELETE } from "@/app/api/books/[bookId]/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { getSession } from "@/lib/session";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

const db = getDb();

function makeRequest(url: string, init?: RequestInit) {
  return new Request(`http://localhost${url}`, init);
}

function getParams(bookId = "1") {
  return { params: Promise.resolve({ bookId }) };
}

async function createOtherUserBook() {
  const [user] = await db
    .insert(users)
    .values({ username: "other-user", passwordHash: "unused" })
    .returning();
  const [book] = await db
    .insert(books)
    .values({ userId: user.id, name: "Other User Book" })
    .returning();
  return { user, book };
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetTestDatabase();
  vi.mocked(getSession).mockResolvedValue({ userId: 1, sessionId: 1 });
});

describe("GET /api/books", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Not authenticated",
    });
  });

  it("returns only the authenticated user's books", async () => {
    await db.insert(books).values({ userId: 1, name: "Household" });
    await createOtherUserBook();

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, name: "Test Book" }),
        expect.objectContaining({ name: "Household" }),
      ])
    );
    expect(body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Other User Book" })])
    );
  });
});

describe("POST /api/books", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Book" }),
      })
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 for a blank name", async () => {
    const res = await POST(
      makeRequest("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      })
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Book name is required",
    });
  });

  it("creates a book after seeded ids without colliding with the primary key sequence", async () => {
    const res = await POST(
      makeRequest("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Vacation Fund" }),
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(1);
    expect(body.name).toBe("Vacation Fund");

    const persistedBooks = await db.select().from(books);
    expect(persistedBooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, name: "Test Book" }),
        expect.objectContaining({ id: body.id, name: "Vacation Fund" }),
      ])
    );
  });
});

describe("PUT /api/books/[bookId]", () => {
  it("returns 400 for an invalid book id", async () => {
    const res = await PUT(
      makeRequest("/api/books/not-a-number", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      }),
      getParams("not-a-number")
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid book ID",
    });
  });

  it("updates a book owned by the authenticated user", async () => {
    const res = await PUT(
      makeRequest("/api/books/1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Test Book" }),
      }),
      getParams("1")
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed Test Book");
  });

  it("returns 404 for a book owned by another user", async () => {
    const { book } = await createOtherUserBook();

    const res = await PUT(
      makeRequest(`/api/books/${book.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Should Not Update" }),
      }),
      getParams(String(book.id))
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Book not found",
    });
  });
});

describe("DELETE /api/books/[bookId]", () => {
  it("deletes a book owned by the authenticated user", async () => {
    const [book] = await db
      .insert(books)
      .values({ userId: 1, name: "Disposable Book" })
      .returning();

    const res = await DELETE(
      makeRequest(`/api/books/${book.id}`, { method: "DELETE" }),
      getParams(String(book.id))
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });

    const remaining = await db.select().from(books);
    expect(remaining).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: book.id })])
    );
  });

  it("returns 404 when deleting another user's book", async () => {
    const { book } = await createOtherUserBook();

    const res = await DELETE(
      makeRequest(`/api/books/${book.id}`, { method: "DELETE" }),
      getParams(String(book.id))
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Book not found",
    });
  });
});

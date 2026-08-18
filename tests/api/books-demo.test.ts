import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, books, transactions, users } from "@/db/schema";
import { POST } from "@/app/api/books/demo/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db-utils";
import { getSession } from "@/lib/session";
import { seedBook } from "@/db/seed";

vi.mock("@/lib/session", () => ({
  getSession: vi.fn(),
}));

// Only the failure-path test wants seedBook to reject. Every other test needs
// the real one: a demo book that was never actually seeded proves nothing
// about the route. So the mock delegates to the real implementation, and the
// one test that needs a failure overrides it for a single call.
vi.mock("@/db/seed", async (importActual) => {
  const actual = await importActual<typeof import("@/db/seed")>();
  return { ...actual, seedBook: vi.fn(actual.seedBook) };
});

const db = getDb();

// The seed writes thousands of rows one at a time, so these run in seconds,
// not milliseconds — same reason tests/db/seed.test.ts raises its own timeout.
const SEED_TIMEOUT = 120_000;

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

describe("POST /api/books/demo", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);

    const res = await POST();

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Not authenticated" });
    expect(seedBook).not.toHaveBeenCalled();
  });

  it(
    "creates a book owned by the session user and fills it with sample data",
    async () => {
      const res = await POST();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ name: "Demo Book", userId: 1 });

      const [created] = await db.select().from(books).where(eq(books.id, body.id));
      expect(created.userId).toBe(1);

      const bookAccounts = await db
        .select()
        .from(accounts)
        .where(eq(accounts.bookId, body.id));
      const bookTransactions = await db
        .select()
        .from(transactions)
        .where(eq(transactions.bookId, body.id));

      expect(bookAccounts.length).toBeGreaterThan(0);
      expect(bookTransactions.length).toBeGreaterThan(0);
    },
    SEED_TIMEOUT
  );

  it(
    "seeds only the book it just created, leaving other books untouched",
    async () => {
      // seedBook opens with DELETE ... WHERE bookId = ?, so the entire safety
      // of this route rests on which id reaches it. The handler takes no
      // Request parameter at all, so no caller can name one — this checks the
      // consequence end to end: a populated bystander book survives intact.
      const { book: otherBook } = await createOtherUserBook();
      await db
        .insert(accounts)
        .values({ bookId: otherBook.id, name: "Untouchable", type: "asset" });

      const res = await POST();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.id).not.toBe(otherBook.id);
      expect(seedBook).toHaveBeenCalledWith(expect.anything(), body.id);

      const survivors = await db
        .select()
        .from(accounts)
        .where(eq(accounts.bookId, otherBook.id));
      expect(survivors).toHaveLength(1);
      expect(survivors[0].name).toBe("Untouchable");
    },
    SEED_TIMEOUT
  );

  it(
    "seeds a second demo book alongside a book that is already seeded",
    async () => {
      // The real page always has a seeded book already (Family Finances), so
      // this is the ordinary case, not an edge case. It is invisible to every
      // other test here because resetTestDatabase leaves book 1 empty, and the
      // seed writes two globally-unique Plaid identifiers — plaid_tokens.itemId
      // and plaid_accounts.plaidAccountId are unique across the whole table,
      // not per book.
      const first = await POST();
      expect(first.status).toBe(200);

      const second = await POST();

      expect(second.status).toBe(200);
      const body = await second.json();
      expect(body.name).toBe("Demo Book 2");

      const bookTransactions = await db
        .select()
        .from(transactions)
        .where(eq(transactions.bookId, body.id));
      expect(bookTransactions.length).toBeGreaterThan(0);
    },
    SEED_TIMEOUT
  );

  it("names the book uniquely when a demo book already exists", async () => {
    vi.mocked(seedBook).mockResolvedValueOnce(undefined);
    await db.insert(books).values({ userId: 1, name: "Demo Book" });

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ name: "Demo Book 2" });
  });

  it("leaves no half-seeded book behind when seeding fails", async () => {
    vi.mocked(seedBook).mockRejectedValueOnce(new Error("seed exploded"));
    const before = await db.select().from(books);

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to create demo book" });

    const after = await db.select().from(books);
    expect(after).toHaveLength(before.length);
  });
});

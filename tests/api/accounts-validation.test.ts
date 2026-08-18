import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/b/[bookId]/accounts/route";
import { PUT } from "@/app/api/b/[bookId]/accounts/[id]/route";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});

describe("POST /api/b/[bookId]/accounts validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects an invalid account type with 400, not 500", async () => {
    const res = await POST(
      new Request("http://localhost/api/b/1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Checking", type: "banana" }),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    // Before this change there was no runtime check on `type` at all: the
    // `type`/`subtype` columns are plain Postgres `text` (Drizzle's
    // `text(col, { enum: [...] })` is a TypeScript-only annotation, not a
    // DB-level CHECK constraint), so the insert succeeded and the client got
    // a 200 with an account whose type is the literal string "banana".
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid account type");
  });
});

describe("GET /api/b/[bookId]/accounts validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("rejects a malformed asOfDate with 400, not a silent pass-through", async () => {
    // Regression guard for the listAccountsQuery wiring at route.ts's GET:
    // if a future edit swaps one of the three searchParams.get() calls back
    // to raw, unparsed input, this is the test that would catch it.
    const res = await GET(
      new Request("http://localhost/api/b/1/accounts?asOfDate=not-a-date"),
      { params: Promise.resolve({ bookId: "1" }) }
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid ISO date");
  });
});

describe("POST /api/b/[bookId]/accounts icon validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/b/1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

  it("stores a single emoji", async () => {
    const res = await post({ name: "Automobile", type: "expense", icon: "🚗" });
    expect(res.status).toBe(200);
    expect((await res.json()).icon).toBe("🚗");
  });

  it("accepts a multi-code-point emoji as one grapheme", async () => {
    // Eleven UTF-16 units and four code points, but one character on screen.
    const res = await post({ name: "Family", type: "expense", icon: "👨‍👩‍👧‍👦" });
    expect(res.status).toBe(200);
    expect((await res.json()).icon).toBe("👨‍👩‍👧‍👦");
  });

  it("stores null when icon is omitted, so the account inherits", async () => {
    const res = await post({ name: "Food", type: "expense" });
    expect(res.status).toBe(200);
    expect((await res.json()).icon).toBeNull();
  });

  it("stores a whitespace-only icon as null", async () => {
    const res = await post({ name: "Travel", type: "expense", icon: "   " });
    expect(res.status).toBe(200);
    expect((await res.json()).icon).toBeNull();
  });

  it("rejects more than one grapheme with 400", async () => {
    const res = await post({ name: "Bills", type: "expense", icon: "🚗🚙" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Icon must be a single character");
  });

  it("rejects a pasted sentence with 400", async () => {
    const res = await post({ name: "Gifts", type: "expense", icon: "Automobile" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/b/[bookId]/accounts/[id] icon validation", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase();
  });

  const post = (body: Record<string, unknown>) =>
    POST(
      new Request("http://localhost/api/b/1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ bookId: "1" }) }
    );

  const put = (id: number, body: Record<string, unknown>) =>
    PUT(
      new Request(`http://localhost/api/b/1/accounts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ bookId: "1", id: String(id) }) }
    );

  it("clears a stored icon when the PUT body sets icon to null", async () => {
    const created = await (await post({ name: "Dining", type: "expense", icon: "🍔" })).json();
    expect(created.icon).toBe("🍔");

    const res = await put(created.id, { icon: null });
    expect(res.status).toBe(200);
    expect((await res.json()).icon).toBeNull();
  });

  it("leaves a stored icon untouched when the PUT body omits icon", async () => {
    const created = await (await post({ name: "Groceries", type: "expense", icon: "🛒" })).json();
    expect(created.icon).toBe("🛒");

    // The body has no `icon` key. An edit to an unrelated field must not
    // clear the icon. A plain `.set({ icon })` call would pass the clear
    // test above, but it would erase the icon on every edit that omits
    // the key. This test catches that regression.
    const res = await put(created.id, { name: "Groceries & Household" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Groceries & Household");
    expect(body.icon).toBe("🛒");
  });
});

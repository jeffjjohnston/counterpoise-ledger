import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { users } from "@/db/schema";
import { __rateLimitSize, __resetRateLimits } from "@/lib/rate-limit";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";

vi.mock("@/lib/session", () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  getSession: vi.fn(),
}));

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
  __resetRateLimits();
  process.env.REGISTRATION_ENABLED = "true";
});

describe("malformed credential payloads", () => {
  // The limiter lowercases the username to build its key, so a non-string
  // reaching it throws and the route answers 500 instead of 400.
  const hostile = [
    { label: "object", value: { evil: true } },
    { label: "array", value: ["a"] },
    { label: "number", value: 12345 },
  ];

  it.each(hostile)("login rejects a $label username with 400", async ({ value }) => {
    const res = await login(
      post("http://localhost/api/auth/login", { username: value, password: "x" })
    );

    expect(res.status).toBe(400);
  });

  it.each(hostile)("login rejects a $label password with 400", async ({ value }) => {
    const res = await login(
      post("http://localhost/api/auth/login", { username: "alice", password: value })
    );

    expect(res.status).toBe(400);
  });

  it("register rejects a non-string username with 400", async () => {
    const res = await register(
      post("http://localhost/api/auth/register", {
        username: { evil: true },
        password: "password123",
      })
    );

    expect(res.status).toBe(400);
  });
});

describe("rate limit key size", () => {
  it("does not retain an unbounded key for a very long username", async () => {
    const huge = "a".repeat(200_000);

    await login(post("http://localhost/api/auth/login", { username: huge, password: "x" }));

    // The cap bounds how many entries exist; without truncation each one could
    // still retain megabytes, which is the same exhaustion by another route.
    expect(__rateLimitSize()).toBeGreaterThan(0);
    const { __rateLimitKeys } = await import("@/lib/rate-limit");
    for (const key of __rateLimitKeys()) {
      expect(key.length).toBeLessThan(200);
    }
  });

  it("throttles long usernames sharing a prefix together", async () => {
    // Truncation collides them into one bucket, which throttles more, never
    // less — the safe direction for a collision.
    const base = "b".repeat(100);
    for (let i = 0; i < 5; i++) {
      await login(
        post("http://localhost/api/auth/login", {
          username: `${base}${i}`,
          password: "x",
        })
      );
    }

    const res = await login(
      post("http://localhost/api/auth/login", { username: `${base}9`, password: "x" })
    );

    expect(res.status).toBe(429);
  });
});

describe("first-account registration race", () => {
  it("creates only one account when concurrent requests hit an empty instance", async () => {
    delete process.env.REGISTRATION_ENABLED;
    await db.delete(users).where(eq(users.id, 1));

    // Both requests read zero users before either insert commits; the ~50ms of
    // password hashing between the check and the insert widens that window.
    await Promise.all([
      register(
        post("http://localhost/api/auth/register", {
          username: "owner",
          password: "password123",
        })
      ),
      register(
        post("http://localhost/api/auth/register", {
          username: "attacker",
          password: "password123",
        })
      ),
    ]);

    const created = await db.select().from(users);
    expect(created).toHaveLength(1);
  });
});

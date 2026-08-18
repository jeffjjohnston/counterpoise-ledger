import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resetTestDatabase, setupTestDatabase } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { users } from "@/db/schema";
import { __resetRateLimits } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/auth";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as register } from "@/app/api/auth/register/route";

// vi.spyOn cannot patch an ESM namespace import. Wrapping the real function
// keeps behaviour identical while making the call observable.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

// createSession reaches for cookies(), which throws outside a request context.
vi.mock("@/lib/session", () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  getSession: vi.fn(),
}));

function post(url: string, body: object, ip?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await setupTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
  __resetRateLimits();
});

afterEach(() => {
  delete process.env.REGISTRATION_ENABLED;
});

describe("login rate limiting", () => {
  it("returns 429 with Retry-After after five failures", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login(
        post("http://localhost/api/auth/login", {
          username: "testuser",
          password: "wrong",
        })
      );
      expect(res.status).toBe(401);
    }

    const blocked = await login(
      post("http://localhost/api/auth/login", {
        username: "testuser",
        password: "wrong",
      })
    );

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("does not throttle a different username", async () => {
    for (let i = 0; i < 5; i++) {
      await login(
        post("http://localhost/api/auth/login", {
          username: "testuser",
          password: "wrong",
        })
      );
    }

    const other = await login(
      post("http://localhost/api/auth/login", {
        username: "someone-else",
        password: "wrong",
      })
    );

    expect(other.status).toBe(401);
  });
});

describe("login timing uniformity", () => {
  it("performs password verification even for an unknown username", async () => {
    vi.mocked(verifyPassword).mockClear();

    await login(
      post("http://localhost/api/auth/login", {
        username: "no-such-user",
        password: "whatever",
      })
    );

    // Measuring elapsed time would be flaky; asserting the work happens is the
    // honest proxy for a uniform response time.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalled();
  });
});

describe("registration gate", () => {
  it("returns 403 when a user already exists and the flag is unset", async () => {
    const res = await register(
      post("http://localhost/api/auth/register", {
        username: "newcomer",
        password: "password123",
      })
    );

    expect(res.status).toBe(403);
  });

  it("allows the first account on an empty instance", async () => {
    await db.delete(users).where(eq(users.id, 1));

    const res = await register(
      post("http://localhost/api/auth/register", {
        username: "founder",
        password: "password123",
      })
    );

    expect(res.status).toBe(200);
  });

  it("allows registration when explicitly enabled", async () => {
    process.env.REGISTRATION_ENABLED = "true";

    const res = await register(
      post("http://localhost/api/auth/register", {
        username: "invitee",
        password: "password123",
      })
    );

    expect(res.status).toBe(200);
  });
});

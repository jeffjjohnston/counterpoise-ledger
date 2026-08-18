import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimits } from "@/lib/rate-limit";
import { getDb } from "@/db";
import { books, sessions, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { createSession, destroySession, getSession } from "@/lib/session";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as register } from "@/app/api/auth/register/route";
import { setupTestDatabase } from "@/tests/helpers/db-utils";

vi.mock("@/lib/session", () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  getSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = getDb();

beforeAll(async () => {
  await setupTestDatabase();
});

function postJson(url: string, body: object) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createUser(username: string, password: string) {
  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ username, passwordHash }).returning();
  return user;
}

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(sessions);
  await db.delete(books);
  await db.delete(users);
});

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

describe("POST /auth/register", () => {
  // These exercise the register route's own validation, which sits behind the
  // registration gate. Any case that runs with users already present would
  // otherwise get a 403 before reaching what it means to test, so they opt in
  // explicitly rather than the gate being loosened to accommodate them.
  beforeEach(() => {
    process.env.REGISTRATION_ENABLED = "true";
    __resetRateLimits();
  });

  afterEach(() => {
    delete process.env.REGISTRATION_ENABLED;
  });

  it("creates a new user and returns their id and username", async () => {
    vi.mocked(createSession).mockResolvedValue("mock-session-token");

    const res = await register(
      postJson("http://localhost/api/auth/register", {
        username: "alice",
        password: "password123",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("alice");
    expect(body.id).toBeDefined();
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("returns 400 when username or password is missing", async () => {
    const res = await register(
      postJson("http://localhost/api/auth/register", { username: "alice" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when username is shorter than 3 characters", async () => {
    const res = await register(
      postJson("http://localhost/api/auth/register", {
        username: "ab",
        password: "password123",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/3 characters/i);
  });

  it("returns 400 when password is shorter than 8 characters", async () => {
    const res = await register(
      postJson("http://localhost/api/auth/register", {
        username: "alice",
        password: "short",
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/8 characters/i);
  });

  it("returns 409 when the username is already taken", async () => {
    await createUser("alice", "password123");

    const res = await register(
      postJson("http://localhost/api/auth/register", {
        username: "alice",
        password: "password123",
      })
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/taken/i);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe("POST /auth/login", () => {
  it("returns user data and creates a session on valid credentials", async () => {
    vi.mocked(createSession).mockResolvedValue("mock-session-token");
    await createUser("alice", "password123");

    const res = await login(
      postJson("http://localhost/api/auth/login", {
        username: "alice",
        password: "password123",
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("alice");
    expect(body.id).toBeDefined();
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("returns 400 when username or password is missing", async () => {
    const res = await login(
      postJson("http://localhost/api/auth/login", { username: "alice" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 when the username does not exist", async () => {
    const res = await login(
      postJson("http://localhost/api/auth/login", {
        username: "nobody",
        password: "password123",
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it("returns 401 when the password is wrong", async () => {
    await createUser("alice", "password123");

    const res = await login(
      postJson("http://localhost/api/auth/login", {
        username: "alice",
        password: "wrongpassword",
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it("does not create a session when credentials are invalid", async () => {
    await createUser("alice", "password123");

    await login(
      postJson("http://localhost/api/auth/login", {
        username: "alice",
        password: "wrongpassword",
      })
    );

    expect(createSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe("GET /auth/me", () => {
  it("returns the authenticated user's id and username", async () => {
    const user = await createUser("alice", "password123");
    vi.mocked(getSession).mockResolvedValue({ userId: user.id, sessionId: 1 });

    const res = await me();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(user.id);
    expect(body.username).toBe("alice");
  });

  it("returns 401 when there is no active session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await me();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/not authenticated/i);
  });

  it("returns 401 when the session references a non-existent user", async () => {
    vi.mocked(getSession).mockResolvedValue({ userId: 9999, sessionId: 1 });

    const res = await me();

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe("POST /auth/logout", () => {
  it("destroys the session and returns success", async () => {
    vi.mocked(destroySession).mockResolvedValue();

    const res = await logout();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(destroySession).toHaveBeenCalledOnce();
  });
});

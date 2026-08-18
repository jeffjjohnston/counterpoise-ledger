import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { cookies, headers } from "next/headers";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { setupTestDatabase } from "@/tests/helpers/db-utils";

// Must be hoisted before any imports that rely on next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
  headers: vi.fn(),
}));

// Imported after vi.mock so the module sees the mocked next/headers
import {
  createSession,
  getSession,
  destroySession,
  getSessionCookieName,
  shouldWarnInsecureCookie,
} from "@/lib/session";

const COOKIE_NAME = "counterpoise_session";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  maxAge?: number;
};

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeMockCookieStore() {
  const store = new Map<string, string>();
  const options = new Map<string, CookieOptions>();

  return {
    store,
    options,
    cookieStore: {
      get: (name: string) =>
        store.has(name) ? { value: store.get(name)! } : undefined,
      set: (name: string, value: string, opts?: CookieOptions) => {
        store.set(name, value);
        if (opts) options.set(name, opts);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    },
  };
}

function makeMockHeaders(entries: Record<string, string>) {
  return { get: (name: string) => entries[name.toLowerCase()] ?? null };
}

beforeAll(async () => {
  await setupTestDatabase();
});

// Every describe below reaches createSession, which reads the request headers.
// The default carries no Host, which is the "cannot tell" case and stays quiet.
beforeEach(() => {
  vi.mocked(headers).mockResolvedValue(makeMockHeaders({}) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getSessionCookieName
// ---------------------------------------------------------------------------

describe("getSessionCookieName", () => {
  it("returns the expected cookie name constant", () => {
    expect(getSessionCookieName()).toBe(COOKIE_NAME);
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  const db = getDb();
  let mock: ReturnType<typeof makeMockCookieStore>;

  beforeEach(async () => {
    mock = makeMockCookieStore();
    vi.mocked(cookies).mockResolvedValue(mock.cookieStore as never);

    await db.delete(sessions);
    await db.delete(users);
  });

  async function insertUser(username = "alice") {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: "placeholder-hash" })
      .returning();
    return user;
  }

  it("warns when the Secure cookie it just set will be discarded", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(headers).mockResolvedValue(makeMockHeaders({ host: "192.168.1.50:3000" }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const user = await insertUser();
    await createSession(user.id);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("192.168.1.50:3000");
    expect(message).toMatch(/README/);
  });

  it("stays silent when reached over localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(headers).mockResolvedValue(makeMockHeaders({ host: "localhost:3000" }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const user = await insertUser();
    await createSession(user.id);

    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a 64-character hex token", async () => {
    const user = await insertUser();
    const token = await createSession(user.id);
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("inserts a session row into the database with the correct userId", async () => {
    const user = await insertUser();
    const token = await createSession(user.id);

    const [session] = await db.select().from(sessions);
    expect(session).toBeDefined();
    expect(session!.tokenHash).toBe(sha256hex(token));
    expect(session!.userId).toBe(user.id);
  });

  it("sets expiresAt approximately 30 days in the future", async () => {
    const before = Date.now();
    const user = await insertUser();
    await createSession(user.id);
    const after = Date.now();

    const [session] = await db.select().from(sessions);
    const expiresAtMs = session!.expiresAt.getTime();

    expect(expiresAtMs).toBeGreaterThanOrEqual(before + THIRTY_DAYS_MS - 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + THIRTY_DAYS_MS + 1000);
  });

  it("sets the session cookie with the token value", async () => {
    const user = await insertUser();
    const token = await createSession(user.id);
    expect(mock.store.get(COOKIE_NAME)).toBe(token);
  });

  it("sets cookie with httpOnly: true", async () => {
    const user = await insertUser();
    await createSession(user.id);
    expect(mock.options.get(COOKIE_NAME)?.httpOnly).toBe(true);
  });

  it("sets cookie maxAge to 30 days in seconds", async () => {
    const user = await insertUser();
    await createSession(user.id);
    expect(mock.options.get(COOKIE_NAME)?.maxAge).toBe(THIRTY_DAYS_SECONDS);
  });

  it("sets cookie path to /", async () => {
    const user = await insertUser();
    await createSession(user.id);
    expect(mock.options.get(COOKIE_NAME)?.path).toBe("/");
  });

  it("produces a unique token on each call", async () => {
    const user = await insertUser();
    const token1 = await createSession(user.id);
    const token2 = await createSession(user.id);
    expect(token1).not.toBe(token2);
  });

  it("allows creating sessions for different users independently", async () => {
    const userA = await insertUser("alice");
    const userB = await insertUser("bob");

    const tokenA = await createSession(userA.id);
    const tokenB = await createSession(userB.id);

    expect(tokenA).not.toBe(tokenB);

    const allSessions = await db.select().from(sessions);
    expect(allSessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe("getSession", () => {
  const db = getDb();
  let mock: ReturnType<typeof makeMockCookieStore>;

  beforeEach(async () => {
    mock = makeMockCookieStore();
    vi.mocked(cookies).mockResolvedValue(mock.cookieStore as never);

    await db.delete(sessions);
    await db.delete(users);
  });

  async function insertUser(username = "alice") {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: "placeholder-hash" })
      .returning();
    return user;
  }

  async function insertSession(
    userId: number,
    token: string,
    expiresAt: Date = new Date(Date.now() + THIRTY_DAYS_MS)
  ) {
    const [session] = await db
      .insert(sessions)
      .values({ tokenHash: sha256hex(token), userId, expiresAt })
      .returning();
    return session;
  }

  it("returns null when no session cookie is present", async () => {
    const result = await getSession();
    expect(result).toBeNull();
  });

  it("returns null when the cookie token does not match any session", async () => {
    mock.store.set(COOKIE_NAME, "completely-unknown-token");
    const result = await getSession();
    expect(result).toBeNull();
  });

  it("returns userId and sessionId for a valid non-expired session", async () => {
    const user = await insertUser();
    const session = await insertSession(user.id, "valid-token-abc123");
    mock.store.set(COOKIE_NAME, "valid-token-abc123");

    const result = await getSession();
    expect(result).toEqual({ userId: user.id, sessionId: session.id });
  });

  it("returns null for an expired session", async () => {
    const user = await insertUser();
    const pastDate = new Date(Date.now() - 1000); // 1 second ago
    await insertSession(user.id, "expired-token", pastDate);
    mock.store.set(COOKIE_NAME, "expired-token");

    const result = await getSession();
    expect(result).toBeNull();
  });

  it("returns the correct session when multiple sessions exist", async () => {
    const user = await insertUser();
    await insertSession(user.id, "session-one");
    const sessionTwo = await insertSession(user.id, "session-two");
    mock.store.set(COOKIE_NAME, "session-two");

    const result = await getSession();
    expect(result).toEqual({ userId: user.id, sessionId: sessionTwo.id });
  });
});

// ---------------------------------------------------------------------------
// destroySession
// ---------------------------------------------------------------------------

describe("destroySession", () => {
  const db = getDb();
  let mock: ReturnType<typeof makeMockCookieStore>;

  beforeEach(async () => {
    mock = makeMockCookieStore();
    vi.mocked(cookies).mockResolvedValue(mock.cookieStore as never);

    await db.delete(sessions);
    await db.delete(users);
  });

  async function insertUser(username = "alice") {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: "placeholder-hash" })
      .returning();
    return user;
  }

  async function insertSession(userId: number, token: string) {
    const [session] = await db
      .insert(sessions)
      .values({ tokenHash: sha256hex(token), userId, expiresAt: new Date(Date.now() + THIRTY_DAYS_MS) })
      .returning();
    return session;
  }

  it("clears the session cookie", async () => {
    const user = await insertUser();
    await insertSession(user.id, "my-token");
    mock.store.set(COOKIE_NAME, "my-token");

    await destroySession();

    expect(mock.store.has(COOKIE_NAME)).toBe(false);
  });

  it("deletes the matching session row from the database", async () => {
    const user = await insertUser();
    await insertSession(user.id, "my-token");
    mock.store.set(COOKIE_NAME, "my-token");

    await destroySession();

    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(0);
  });

  it("does not throw when no session cookie is present", async () => {
    await expect(destroySession()).resolves.toBeUndefined();
  });

  it("does not affect other sessions belonging to the same user", async () => {
    const user = await insertUser();
    await insertSession(user.id, "session-to-destroy");
    await insertSession(user.id, "session-to-keep");
    mock.store.set(COOKIE_NAME, "session-to-destroy");

    await destroySession();

    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tokenHash).toBe(sha256hex("session-to-keep"));
  });
});

// ---------------------------------------------------------------------------
// session token storage
// ---------------------------------------------------------------------------

describe("session token storage", () => {
  const db = getDb();
  let mock: ReturnType<typeof makeMockCookieStore>;

  beforeEach(async () => {
    mock = makeMockCookieStore();
    vi.mocked(cookies).mockResolvedValue(mock.cookieStore as never);
    await db.delete(sessions);
    await db.delete(users);
  });

  async function insertUser(username = "alice") {
    const [user] = await db
      .insert(users)
      .values({ username, passwordHash: "placeholder-hash" })
      .returning();
    return user;
  }

  it("stores the digest, never the token itself", async () => {
    const user = await insertUser();
    const token = await createSession(user.id);

    const [row] = await db.select().from(sessions);

    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(sha256hex(token));
  });

  it("rejects a cookie containing the digest rather than the token", async () => {
    // Guards against an inverted lookup. If getSession compared the cookie to
    // the stored value directly, this would succeed — and what sat in the
    // database would still be the plaintext.
    const user = await insertUser();
    const token = await createSession(user.id);
    mock.store.set(COOKIE_NAME, sha256hex(token));

    expect(await getSession()).toBeNull();
  });

  it("still authenticates with the plaintext token", async () => {
    const user = await insertUser();
    const token = await createSession(user.id);
    mock.store.set(COOKIE_NAME, token);

    expect(await getSession()).toMatchObject({ userId: user.id });
  });

  it("purges expired sessions when a new one is created", async () => {
    const user = await insertUser();
    await db.insert(sessions).values({
      tokenHash: sha256hex("expired-row"),
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000),
    });

    await createSession(user.id);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(sha256hex("expired-row"));
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  const db = getDb();
  let mock: ReturnType<typeof makeMockCookieStore>;

  beforeEach(async () => {
    mock = makeMockCookieStore();
    vi.mocked(cookies).mockResolvedValue(mock.cookieStore as never);

    await db.delete(sessions);
    await db.delete(users);
  });

  it("create -> get -> destroy flow works end-to-end", async () => {
    const [user] = await db
      .insert(users)
      .values({ username: "alice", passwordHash: "hash" })
      .returning();

    // Create
    const token = await createSession(user.id);
    expect(token).toBeTruthy();

    // Get — should resolve to the new session
    const sessionData = await getSession();
    expect(sessionData).not.toBeNull();
    expect(sessionData!.userId).toBe(user.id);

    // Destroy
    await destroySession();

    // Get after destroy — should return null
    const afterDestroy = await getSession();
    expect(afterDestroy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Insecure-cookie warning
// ---------------------------------------------------------------------------

// The failure this guards is silent and reads as a wrong password: the browser
// discards a Secure cookie delivered over plain HTTP to a non-localhost origin,
// so login returns 200 and then bounces straight back to /login. Compose's
// APP_BIND=0.0.0.0 is exactly the configuration that produces it.
describe("shouldWarnInsecureCookie", () => {
  it("warns when a Secure cookie is served over plain HTTP to a LAN address", () => {
    expect(
      shouldWarnInsecureCookie({ secure: true, forwardedProto: null, host: "192.168.1.50:3000" })
    ).toBe(true);
  });

  it("stays silent on localhost, which browsers treat as trustworthy", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(
        shouldWarnInsecureCookie({ secure: true, forwardedProto: null, host }),
        `${host} should not warn`
      ).toBe(false);
    }
  });

  it("stays silent when a proxy reports the original request was HTTPS", () => {
    // Chained proxies append, so the client-facing value is the first one.
    for (const proto of ["https", "https, http"]) {
      expect(
        shouldWarnInsecureCookie({ secure: true, forwardedProto: proto, host: "books.example.com" }),
        `${proto} should not warn`
      ).toBe(false);
    }
  });

  it("stays silent when the cookie is not Secure", () => {
    // Development: the cookie has no Secure flag, so plain HTTP works fine.
    expect(
      shouldWarnInsecureCookie({ secure: false, forwardedProto: null, host: "192.168.1.50:3000" })
    ).toBe(false);
  });

  it("stays silent when the host is unknown rather than guessing", () => {
    expect(shouldWarnInsecureCookie({ secure: true, forwardedProto: null, host: null })).toBe(false);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, sessions, users } from "../../db/schema";
import { hashPassword } from "../helpers/password";
import { generateApiKey, hashApiKey } from "../helpers/api-keys";
import { db, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { startHttpTestServer } from "../helpers/http-parity";

describe("auth HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ REGISTRATION_ENABLED: "true" }));
  }, 120_000);
  beforeEach(resetTestDatabase);
  afterAll(async () => { await stop?.(); });

  const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, init);
  const json = (method: string, body: unknown, cookie?: string): RequestInit => ({
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

  it("registers, sets a session cookie, reads identity, and logs out", async () => {
    expect(await (await request("/api/auth/registration-open")).json()).toEqual({ open: true });
    const invalid = await request("/api/auth/register", json("POST", { username: "ab", password: "password123" }));
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: "Username must be at least 3 characters" }]);
    const registered = await request("/api/auth/register", json("POST", { username: "alice", password: "password123" }));
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ username: "alice" });
    const cookie = registered.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^counterpoise_session=[a-f0-9]{64}$/);
    const setCookie = registered.headers.get("set-cookie")!;
    expect(setCookie).toContain("; Secure");
    expect(setCookie).toContain("; HttpOnly");
    expect(setCookie).toContain("; Expires=");
    expect(setCookie).toContain("; Max-Age=2592000");
    expect(setCookie).toMatch(/; SameSite=lax/i);
    expect(await (await request("/api/auth/me", { headers: { cookie: cookie! } })).json()).toMatchObject({ username: "alice" });
    const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie: cookie! } });
    expect(await logout.json()).toEqual({ success: true });
    expect((await request("/api/auth/me", { headers: { cookie: cookie! } })).status).toBe(401);
  });

  it("authenticates an existing Node password hash and keeps cookie-only credential routes", async () => {
    await db.update(users).set({ passwordHash: await hashPassword("oldpassword") }).where(eq(users.id, 1));
    const wrong = await request("/api/auth/login", json("POST", { username: "testuser", password: "wrong" }));
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: "Invalid username or password" }]);
    const login = await request("/api/auth/login", json("POST", { username: "testuser", password: "oldpassword" }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const unauthenticated = await request("/api/auth/api-keys", { headers: { authorization: "Bearer cpk_fake" } });
    expect(unauthenticated.status).toBe(401);
    const changed = await request("/api/auth/password", json("PUT", { currentPassword: "oldpassword", newPassword: "newpassword" }, cookie));
    expect(await changed.json()).toEqual({ success: true });
    const oldLogin = await request("/api/auth/login", json("POST", { username: "testuser", password: "oldpassword" }));
    expect(oldLogin.status).toBe(401);
    const newLogin = await request("/api/auth/login", json("POST", { username: "testuser", password: "newpassword" }));
    expect(newLogin.status).toBe(200);
  });

  it("mints, lists, uses, and revokes an API key", async () => {
    const login = await request("/api/auth/register", json("POST", { username: "alice", password: "password123" }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const minted = await request("/api/auth/api-keys", json("POST", { name: " Phone " }, cookie));
    expect(minted.status).toBe(200);
    const key = await minted.json() as { id: number; key: string; name: string; keyPrefix: string };
    expect(key).toMatchObject({ name: "Phone", keyPrefix: key.key.slice(0, 8) });
    expect(key.key).toMatch(/^cpk_[a-f0-9]{48}$/);
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, key.id)))[0].keyHash).not.toContain(key.key);
    const listed = await request("/api/auth/api-keys", { headers: { cookie } });
    expect(await listed.json()).toMatchObject([{ id: key.id, name: "Phone", keyPrefix: key.keyPrefix }]);
    const whitespaceName = await request("/api/auth/api-keys", json("POST", { name: "\uFEFF" }, cookie));
    expect([whitespaceName.status, await whitespaceName.json()]).toEqual([400, { error: "Name is required" }]);
    const oversizedId = await request("/api/auth/api-keys/99999999999", { method: "DELETE", headers: { cookie } });
    expect([oversizedId.status, await oversizedId.json()]).toEqual([500, { error: "Failed to delete API key" }]);
    const bearer = { authorization: `Bearer ${key.key}` };
    expect((await request("/api/auth/me", { headers: bearer })).status).toBe(200);
    expect((await request("/api/auth/api-keys", { headers: bearer })).status).toBe(401);
    const revoked = await request(`/api/auth/api-keys/+${key.id}`, { method: "DELETE", headers: { cookie } });
    expect(await revoked.json()).toEqual({ success: true });
    expect((await request("/api/auth/me", { headers: bearer })).status).toBe(401);
    expect((await db.select().from(sessions)).length).toBe(1);
  });

  it("accepts existing Node session tokens and API key hashes", async () => {
    const token = randomBytes(32).toString("hex");
    await db.insert(sessions).values({
      userId: 1, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cookie = `counterpoise_session=${token}`;
    expect(await (await request("/api/auth/me", { headers: { cookie } })).json()).toMatchObject({ id: 1, username: "testuser" });
    const key = generateApiKey();
    await db.insert(apiKeys).values({ userId: 1, name: "Existing", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8) });
    expect(await (await request("/api/auth/me", { headers: { authorization: `Bearer ${key}` } })).json()).toMatchObject({ id: 1, username: "testuser" });
  });

  it("uses the last valid decoded duplicate session cookie for identity and logout", async () => {
    const token = randomBytes(32).toString("hex");
    await db.insert(sessions).values({
      userId: 1, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const encoded = `%${token.charCodeAt(0).toString(16)}${token.slice(1)}`;
    const cookie = `counterpoise_session=stale; counterpoise_session=${encoded}`;
    expect(await (await request("/api/auth/me", { headers: { cookie } })).json()).toMatchObject({ id: 1 });
    const logout = await request("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect(await logout.json()).toEqual({ success: true });
    expect((await request("/api/auth/me", { headers: { cookie: `counterpoise_session=${token}` } })).status).toBe(401);
  });

  it("keeps auth validation, rate limits, and ownership errors on their current status codes", async () => {
    const malformed = await request("/api/auth/login", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect([malformed.status, await malformed.json()]).toEqual([500, { error: "Failed to log in" }]);
    const invalid = await request("/api/auth/login", json("POST", { username: {}, password: "password123" }));
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: "Username and password must be strings" }]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request("/api/auth/login", json("POST", { username: "nobody", password: "password123" }));
      expect(response.status).toBe(401);
    }
    const limited = await request("/api/auth/login", json("POST", { username: "nobody", password: "password123" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const invalidName = await request("/api/auth/api-keys", json("POST", { name: "  " }));
    expect(invalidName.status).toBe(401); // Cookie check precedes body validation.
    const badId = await request("/api/auth/api-keys/nope", { method: "DELETE" });
    expect(badId.status).toBe(401);
  });

  // A client that connects directly can write any X-Forwarded-For value. The
  // server uses the header only when a proxy is trusted: this server listens on
  // loopback, so by default it is. With TRUST_PROXY=false the IP bucket is the
  // TCP peer, and a new header value does not give a new bucket.
  it("keys the IP bucket on the TCP peer unless the proxy is trusted", async () => {
    const attempt = (base: string, i: number) => fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i}` },
      body: JSON.stringify({ username: `spray${i}`, password: "password123" }),
    });
    const direct = await startHttpTestServer({ TRUST_PROXY: "false" });
    try {
      for (let i = 0; i < 20; i++) expect((await attempt(direct.baseUrl, i)).status).toBe(401);
      const limited = await attempt(direct.baseUrl, 20);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
    } finally {
      await direct.stop();
    }
    for (let i = 100; i < 121; i++) expect((await attempt(baseUrl, i)).status).toBe(401);
  }, 120_000);

  it("closes registration when configured and still validates the body first", async () => {
    const closedServer = await startHttpTestServer({ REGISTRATION_ENABLED: "false" });
    try {
      const status = await fetch(`${closedServer.baseUrl}/api/auth/registration-open`);
      expect(await status.json()).toEqual({ open: false });
      const invalid = await fetch(`${closedServer.baseUrl}/api/auth/register`, json("POST", { username: "ab", password: "password123" }));
      expect([invalid.status, await invalid.json()]).toEqual([400, { error: "Username must be at least 3 characters" }]);
      const denied = await fetch(`${closedServer.baseUrl}/api/auth/register`, json("POST", { username: "alice", password: "password123" }));
      expect([denied.status, await denied.json()]).toEqual([403, { error: "Registration is closed" }]);
    } finally {
      await closedServer.stop();
    }
  });

  it("serializes bootstrap registration so only one first account can be created", async () => {
    await db.delete(users);
    const bootstrap = await startHttpTestServer({ REGISTRATION_ENABLED: "" });
    try {
      const responses = await Promise.all(["alice", "bob"].map((username) =>
        fetch(`${bootstrap.baseUrl}/api/auth/register`, json("POST", { username, password: "password123" }))
      ));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
      expect((await db.select().from(users)).length).toBe(1);
      expect(await (await fetch(`${bootstrap.baseUrl}/api/auth/registration-open`)).json()).toEqual({ open: false });
    } finally {
      await bootstrap.stop();
    }
  });
});

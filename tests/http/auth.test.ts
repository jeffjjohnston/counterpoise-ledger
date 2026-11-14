import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "../helpers/password";
import { generateApiKey, hashApiKey } from "../helpers/api-keys";
import { addBookMember, createBook, createUser, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { count, exec, insert, scalar } from "../helpers/sql";
import { onWorker, startHttpTestServer } from "../helpers/http-parity";

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

  it("marks the login cookie Secure, HttpOnly and SameSite", async () => {
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("password123"), 1]);
    const login = await request("/api/auth/login", json("POST", { username: "testuser", password: "password123" }));
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("; Secure");
    expect(setCookie).toContain("; HttpOnly");
    expect(setCookie).toMatch(/; SameSite=lax/i);
  });

  // A deployed Worker sets no NODE_ENV, and the suite's Worker gets none
  // either. Whatever NODE_ENV says, the Worker's cookie is Secure; only the
  // native server leaves Secure off outside production, for plain-HTTP
  // development.
  it("leaves Secure off only on the native server outside production", async () => {
    const other = await startHttpTestServer({ REGISTRATION_ENABLED: "true", NODE_ENV: "development" });
    try {
      const registered = await fetch(`${other.baseUrl}/api/auth/register`, json("POST", { username: "devuser", password: "password123" }));
      expect(registered.status).toBe(200);
      const setCookie = registered.headers.get("set-cookie")!;
      expect(setCookie).toContain("; HttpOnly");
      if (onWorker) expect(setCookie).toContain("; Secure");
      else expect(setCookie).not.toContain("; Secure");
    } finally {
      await other.stop();
    }
  }, 120_000);

  it("authenticates an existing Node password hash and keeps cookie-only credential routes", async () => {
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("oldpassword"), 1]);
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

  // A login with the old password can run while the password changes. A
  // trigger gives each test that login at an exact moment: SQLite runs the
  // trigger inside the statement that the route sends.
  const withTrigger = async (body: string, run: () => Promise<void>) => {
    await exec(`CREATE TRIGGER test_auth_race ${body}`);
    try {
      await run();
    } finally {
      await exec("DROP TRIGGER test_auth_race");
    }
  };

  it("leaves no session from the old password when the password changes", async () => {
    const oldHash = await hashPassword("oldpassword");
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [oldHash, 1]);
    const login = () => request("/api/auth/login", json("POST", { username: "testuser", password: "oldpassword" }));
    const cookie = (await login()).headers.get("set-cookie")!.split(";")[0];
    const other = (await login()).headers.get("set-cookie")!.split(";")[0];
    // The trigger is a login with the old password at the moment when the
    // route deletes the other sessions. That login gets a session only
    // while the stored hash is still the old one.
    await withTrigger(
      `AFTER DELETE ON sessions BEGIN
         INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
         SELECT 'raced', OLD.user_id, '2999-01-01 00:00:00', '2026-01-01 00:00:00'
         WHERE (SELECT password_hash FROM users WHERE id = OLD.user_id) = '${oldHash}';
       END`,
      async () => {
        const changed = await request("/api/auth/password", json("PUT", { currentPassword: "oldpassword", newPassword: "newpassword" }, cookie));
        expect(await changed.json()).toEqual({ success: true });
      }
    );
    expect(await count("sessions", "token_hash = 'raced'")).toBe(0);
    expect(await count("sessions")).toBe(1);
    expect((await request("/api/auth/me", { headers: { cookie } })).status).toBe(200);
    expect((await request("/api/auth/me", { headers: { cookie: other } })).status).toBe(401);
  });

  it("keeps the other sessions when the new password cannot be stored", async () => {
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("oldpassword"), 1]);
    const login = () => request("/api/auth/login", json("POST", { username: "testuser", password: "oldpassword" }));
    const cookie = (await login()).headers.get("set-cookie")!.split(";")[0];
    const other = (await login()).headers.get("set-cookie")!.split(";")[0];
    await withTrigger(
      "BEFORE UPDATE OF password_hash ON users BEGIN SELECT RAISE(ABORT, 'the test refuses the write'); END",
      async () => {
        const changed = await request("/api/auth/password", json("PUT", { currentPassword: "oldpassword", newPassword: "newpassword" }, cookie));
        expect(changed.status).toBe(500);
      }
    );
    // The hash update and the session delete are one transaction: the
    // failed change removes no session.
    expect((await request("/api/auth/me", { headers: { cookie: other } })).status).toBe(200);
    expect((await login()).status).toBe(200);
  });

  it("gives no session to a login when the password changes during the login", async () => {
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("oldpassword"), 1]);
    // The login deletes the expired sessions after it verifies the password
    // and before it stores its session. The trigger changes the password at
    // that moment, as a password change in another request does.
    await exec(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ('expired', 1, '2000-01-01 00:00:00', '2000-01-01 00:00:00')"
    );
    await withTrigger(
      `AFTER DELETE ON sessions WHEN OLD.token_hash = 'expired' BEGIN
         UPDATE users SET password_hash = 'changed' WHERE id = OLD.user_id;
       END`,
      async () => {
        const login = await request("/api/auth/login", json("POST", { username: "testuser", password: "oldpassword" }));
        expect([login.status, await login.json()]).toEqual([401, { error: "Invalid username or password" }]);
        expect(login.headers.get("set-cookie")).toBeNull();
      }
    );
    expect(await scalar<string>("SELECT password_hash FROM users WHERE id = $1", [1])).toBe("changed");
    expect(await count("sessions")).toBe(0);
  });

  it("changes the username with the current password and keeps the session and API keys", async () => {
    await exec("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("password123"), 1]);
    await createUser({ username: "taken" });
    const login = await request("/api/auth/login", json("POST", { username: "testuser", password: "password123" }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const minted = await request("/api/auth/api-keys", json("POST", { name: "Phone" }, cookie));
    const { key } = await minted.json() as { key: string };
    const bearer = { authorization: `Bearer ${key}` };

    const rename = (body: unknown, headers?: string) => request("/api/auth/username", json("PUT", body, headers));
    const refused = async (response: Response) => [response.status, await response.json()];
    expect(await refused(await rename({ username: "jeff", currentPassword: "password123" }))).toEqual([401, { error: "Not authenticated" }]);
    // A bearer key is not a cookie session, so it cannot rename the user.
    const viaKey = await request("/api/auth/username", { method: "PUT", headers: { "content-type": "application/json", ...bearer }, body: JSON.stringify({ username: "jeff", currentPassword: "password123" }) });
    expect(await refused(viaKey)).toEqual([401, { error: "Not authenticated" }]);
    expect(await refused(await rename({ username: "jeff" }, cookie))).toEqual([400, { error: "New username and current password are required" }]);
    expect(await refused(await rename({ username: "ab", currentPassword: "password123" }, cookie))).toEqual([400, { error: "Username must be at least 3 characters" }]);
    expect(await refused(await rename({ username: "jeff", currentPassword: "wrong-password" }, cookie))).toEqual([401, { error: "Current password is incorrect" }]);
    expect(await refused(await rename({ username: "testuser", currentPassword: "password123" }, cookie))).toEqual([400, { error: "New username must be different from current username" }]);
    expect(await refused(await rename({ username: "taken", currentPassword: "password123" }, cookie))).toEqual([409, { error: "Username already taken" }]);
    expect(await scalar<string>("SELECT username FROM users WHERE id = $1", [1])).toBe("testuser");

    const renamed = await rename({ username: "jeff", currentPassword: "password123" }, cookie);
    expect([renamed.status, await renamed.json()]).toEqual([200, { id: 1, username: "jeff" }]);
    expect(await (await request("/api/auth/me", { headers: { cookie } })).json()).toEqual({ id: 1, username: "jeff" });
    expect(await (await request("/api/auth/me", { headers: bearer })).json()).toEqual({ id: 1, username: "jeff" });
    expect((await request("/api/b/1/accounts", { headers: { cookie } })).status).toBe(200);
    const oldName = await request("/api/auth/login", json("POST", { username: "testuser", password: "password123" }));
    expect(oldName.status).toBe(401);
    const newName = await request("/api/auth/login", json("POST", { username: "jeff", password: "password123" }));
    expect([newName.status, await newName.json()]).toEqual([200, { id: 1, username: "jeff" }]);
  });

  it("mints, lists, uses, and revokes an API key", async () => {
    const login = await request("/api/auth/register", json("POST", { username: "alice", password: "password123" }));
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const minted = await request("/api/auth/api-keys", json("POST", { name: " Phone " }, cookie));
    expect(minted.status).toBe(200);
    const key = await minted.json() as { id: number; key: string; name: string; keyPrefix: string };
    expect(key).toMatchObject({ name: "Phone", keyPrefix: key.key.slice(0, 8) });
    expect(key.key).toMatch(/^cpk_[a-f0-9]{48}$/);
    expect(await scalar<string>("SELECT key_hash FROM api_keys WHERE id = $1", [key.id])).not.toContain(key.key);
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
    expect(await count("sessions")).toBe(1);
  });

  it("gives an API key the book role of its user", async () => {
    const viewer = await createUser({ username: "viewer" });
    await addBookMember({ bookId: 1, userId: viewer.id, role: "viewer" });
    const other = await createBook({ name: "Other" });
    const key = generateApiKey();
    await insert("api_keys", { userId: viewer.id, name: "Viewer", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8) });
    const asViewer = (path: string, init: RequestInit = {}) =>
      request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } });

    const read = await asViewer("/api/b/1/accounts");
    expect([read.status, await read.json()]).toEqual([200, []]);
    const write = await asViewer("/api/b/1/accounts", json("POST", { name: "Denied", type: "asset" }));
    expect([write.status, await write.json()]).toEqual([403, { error: "You have read-only access to this book" }]);
    const ownerOnly = await asViewer("/api/books/1", json("PUT", { name: "Denied" }));
    expect([ownerOnly.status, await ownerOnly.json()]).toEqual([403, { error: "Only an owner can do this" }]);
    const notMember = await asViewer(`/api/b/${other.id}/accounts`);
    expect([notMember.status, await notMember.json()]).toEqual([404, { error: "Book not found" }]);
    // A key that no row has passes the gate, and the route refuses it.
    const unknown = await request("/api/b/1/accounts", { headers: { authorization: `Bearer cpk_${"0".repeat(48)}` } });
    expect([unknown.status, await unknown.json()]).toEqual([401, { error: "Not authenticated" }]);
    expect(await count("accounts")).toBe(0);
  });

  // The lockout bucket is the client IP plus the first 8 characters of the
  // key. Thus an attacker who guesses keys from one IP locks out only that
  // prefix from that IP. The same user can still use a key with another
  // prefix, and the same key still works from another IP.
  it("locks out a failing API key prefix from one IP only", async () => {
    const key = generateApiKey();
    let otherKey = generateApiKey();
    while (otherKey.slice(0, 8) === key.slice(0, 8)) otherKey = generateApiKey();
    for (const [name, value] of [["Phone", key], ["Laptop", otherKey]]) {
      await insert("api_keys", { userId: 1, name, keyHash: await hashApiKey(value), keyPrefix: value.slice(0, 8) });
    }
    // The Worker reads the client IP from CF-Connecting-IP, which
    // Cloudflare sets; the native server behind a trusted proxy reads
    // X-Forwarded-For.
    const ipHeader = onWorker ? "cf-connecting-ip" : "x-forwarded-for";
    const fromIp = (bearer: string, ip: string) =>
      request("/api/b/1/accounts", { headers: { authorization: `Bearer ${bearer}`, [ipHeader]: ip } });

    // Two real hash mismatches, then malformed keys with the same prefix.
    // The malformed keys reach the limit without 20 serial scrypt runs.
    const wrongSamePrefix = `${key.slice(0, 8)}${key[8] === "0" ? "1" : "0"}${key.slice(9)}`;
    const malformedSamePrefix = `${key.slice(0, 8)}g${key.slice(9)}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      const denied = await fromIp(attempt < 2 ? wrongSamePrefix : malformedSamePrefix, "198.51.100.9");
      expect([denied.status, await denied.json()]).toEqual([401, { error: "Not authenticated" }]);
    }
    const locked = await fromIp(key, "198.51.100.9");
    expect([locked.status, await locked.json()], "the valid key from the locked IP").toEqual([401, { error: "Not authenticated" }]);
    const otherPrefix = await fromIp(otherKey, "198.51.100.9");
    expect([otherPrefix.status, await otherPrefix.json()], "another prefix from the locked IP").toEqual([200, []]);
    const otherIp = await fromIp(key, "198.51.100.10");
    expect([otherIp.status, await otherIp.json()], "the same key from another IP").toEqual([200, []]);
  });

  it("accepts existing Node session tokens and API key hashes", async () => {
    const token = randomBytes(32).toString("hex");
    await insert("sessions", {
      userId: 1, tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const cookie = `counterpoise_session=${token}`;
    expect(await (await request("/api/auth/me", { headers: { cookie } })).json()).toMatchObject({ id: 1, username: "testuser" });
    const key = generateApiKey();
    await insert("api_keys", { userId: 1, name: "Existing", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8) });
    expect(await (await request("/api/auth/me", { headers: { authorization: `Bearer ${key}` } })).json()).toMatchObject({ id: 1, username: "testuser" });
  });

  it("uses the last valid decoded duplicate session cookie for identity and logout", async () => {
    const token = randomBytes(32).toString("hex");
    await insert("sessions", {
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
    // An absent user gets the same body as a wrong password.
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request("/api/auth/login", json("POST", { username: "nobody", password: "password123" }));
      expect([response.status, await response.json()]).toEqual([401, { error: "Invalid username or password" }]);
    }
    const limited = await request("/api/auth/login", json("POST", { username: "nobody", password: "password123" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: "Too many attempts. Try again in 60s." });
    const invalidName = await request("/api/auth/api-keys", json("POST", { name: "  " }));
    expect(invalidName.status).toBe(401); // Cookie check precedes body validation.
    const badId = await request("/api/auth/api-keys/nope", { method: "DELETE" });
    expect(badId.status).toBe(401);
  });

  // A client that connects directly can write any X-Forwarded-For value. The
  // server uses the header only when a proxy is trusted: this server listens on
  // loopback, so by default it is. With TRUST_PROXY=false the IP bucket is the
  // TCP peer, and a new header value does not give a new bucket.
  it.skipIf(onWorker)("keys the IP bucket on the TCP peer unless the proxy is trusted", async () => {
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

  // A Worker has no proxy to trust: Cloudflare sets CF-Connecting-IP on
  // each request, over any value the client sent, and a client can write
  // any X-Forwarded-For.
  it.runIf(onWorker)("keys the IP bucket on CF-Connecting-IP and ignores X-Forwarded-For", async () => {
    const attempt = (i: number, ip: string) => fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-forwarded-for": `203.0.113.${i}` },
      body: JSON.stringify({ username: `spray${i}`, password: "password123" }),
    });
    for (let i = 0; i < 20; i++) expect((await attempt(i, "192.0.2.1")).status).toBe(401);
    const limited = await attempt(20, "192.0.2.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await attempt(21, "192.0.2.2")).status).toBe(401);
  });

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
    await exec("DELETE FROM users");
    const bootstrap = await startHttpTestServer({ REGISTRATION_ENABLED: "" });
    try {
      const responses = await Promise.all(["alice", "bob"].map((username) =>
        fetch(`${bootstrap.baseUrl}/api/auth/register`, json("POST", { username, password: "password123" }))
      ));
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
      expect(await count("users")).toBe(1);
      expect(await (await fetch(`${bootstrap.baseUrl}/api/auth/registration-open`)).json()).toEqual({ open: false });
    } finally {
      await bootstrap.stop();
    }
  });
});

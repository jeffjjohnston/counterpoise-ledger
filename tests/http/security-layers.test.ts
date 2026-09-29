import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiKeys } from "../../db/schema";
import { generateApiKey, hashApiKey } from "../helpers/api-keys";
import { db, resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

const CRON_SECRET = "test-cron-secret";
const EVIL = "https://evil.example";

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

/**
 * The security layers of the Rust server (rust-api/server/src/security.rs),
 * sent to the real binary. They came from the proxy.ts of the Next server,
 * with the same rules and responses. Where a layer lets a request through, the
 * route answers, so these cases check the route's own answer and not a bare
 * 200.
 */
describe("security layers HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let key: string;

  // No redirect is followed: the redirect itself is under test.
  const anonymous = (path: string, init: RequestInit = {}) =>
    client.anonymous(path, { redirect: "manual", ...init });
  const withSession = (path: string, init: RequestInit = {}) =>
    client.request(path, { redirect: "manual", ...init });
  const status = async (response: Promise<Response>) => (await response).status;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ CRON_SECRET, ENABLE_HSTS: "" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    key = generateApiKey();
    await db.insert(apiKeys).values({
      userId: 1, name: "Security layers", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8),
    });
  });
  afterAll(async () => {
    await stop?.();
  });

  describe("auth gate", () => {
    it("lets the container healthcheck reach /api/health without a session", async () => {
      expect(await status(anonymous("/api/health"))).toBe(200);
    });

    it("still gates job status behind a session", async () => {
      expect(await status(anonymous("/api/system/status"))).toBe(401);
      expect(await status(withSession("/api/system/status"))).toBe(200);
    });

    it("does not open paths that merely begin with a public route's name", async () => {
      for (const path of ["/api/healthcheck-internal", "/api/versions"]) {
        const response = await anonymous(path);
        expect(response.status, path).toBe(401);
        expect(await response.json(), path).toEqual({ error: "Unauthorized" });
      }
    });

    it("answers 404 to an unknown API path that has a session or a key", async () => {
      expect(await status(withSession("/api/versions"))).toBe(404);
      expect(await status(anonymous("/api/versions", { headers: { authorization: `Bearer ${key}` } }))).toBe(404);
    });

    it("keeps /api/version public", async () => {
      expect(await status(anonymous("/api/version"))).toBe(200);
    });

    it("keeps auth and cron routes public", async () => {
      // The login route answers for itself: a body without credentials is a
      // validation error, not the gate's 401.
      const login = await anonymous("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(login.status).toBe(400);
      expect(await login.json()).toEqual({ error: "Username and password are required" });
      expect(await status(anonymous("/api/cron/recurring", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }))).toBe(200);
    });

    it("lets an API request through with a bearer key and no cookie", async () => {
      const response = await anonymous("/api/b/1/accounts", { headers: { authorization: `Bearer ${key}` } });
      expect(response.status).toBe(200);
    });

    it("refuses an API request with neither a session nor a key", async () => {
      expect(await status(anonymous("/api/b/1/accounts"))).toBe(401);
    });

    it("refuses a wrong method without credentials before the router answers 405", async () => {
      for (const method of ["GET", "PATCH", "OPTIONS"]) {
        const response = await anonymous("/api/b/1/accounts", { method });
        expect(response.status, method).toBe(401);
        expect(await response.json(), method).toEqual({ error: "Unauthorized" });
      }
      expect(await status(withSession("/api/b/1/accounts", { method: "PATCH" }))).toBe(405);
    });

    it("redirects a page request without a session to /login", async () => {
      const response = await anonymous("/b/1");
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/login");
    });

    it("still redirects a page request that carries only a bearer header", async () => {
      const response = await anonymous("/b/1", { headers: { authorization: `Bearer ${key}` } });
      expect(response.status).toBe(307);
    });

    it("lets a page request with a session through to the page service", async () => {
      // The Rust server serves no pages yet, so the page service answers 404.
      for (const path of ["/", "/b/1", "/b/1/transactions", "/account"]) {
        expect(await status(withSession(path)), path).toBe(404);
      }
    });

    it("keeps the login and register pages and the client chunks public", async () => {
      for (const path of ["/login", "/register", "/assets/index-abc123.js", "/favicon.ico"]) {
        expect(await status(anonymous(path)), path).not.toBe(307);
      }
    });
  });

  describe("cross-origin write rejection", () => {
    it("rejects a POST from another origin", async () => {
      const response = await withSession("/api/b/1/transactions", {
        method: "POST",
        headers: { origin: EVIL },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin request rejected" });
    });

    it("rejects when Sec-Fetch-Site says cross-site or same-site", async () => {
      for (const site of ["cross-site", "same-site"]) {
        const response = await withSession("/api/b/1/transactions", {
          method: "POST",
          headers: { "sec-fetch-site": site },
        });
        expect(response.status, site).toBe(403);
      }
    });

    it("allows a same-origin POST", async () => {
      const response = await withSession("/api/b/1/transactions", {
        method: "POST",
        headers: { origin: baseUrl, "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: "{}",
      });
      // The route answers: the body is not a transaction.
      expect(response.status).toBe(400);
    });

    it("allows a POST whose Origin names the host that a reverse proxy forwards", async () => {
      const allowed = await withSession("/api/b/1/transactions", {
        method: "POST",
        headers: { origin: "https://books.example", "x-forwarded-host": "books.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(allowed.status).toBe(400);
      const refused = await withSession("/api/b/1/transactions", {
        method: "POST",
        headers: { origin: EVIL, "x-forwarded-host": "books.example" },
      });
      expect(refused.status).toBe(403);
    });

    it("allows a cross-origin GET", async () => {
      const response = await withSession("/api/b/1/accounts", { headers: { origin: EVIL } });
      expect(response.status).toBe(200);
    });

    it("allows a POST carrying neither Origin nor Sec-Fetch-Site", async () => {
      // The cron calls of the scheduler, and any client that is not a
      // browser. Browsers always send Origin on a cross-origin write.
      const response = await withSession("/api/b/1/transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
    });

    it("rejects a cross-origin POST to the login endpoint", async () => {
      // /api/auth/ is public, and login is where a cross-site request forgery
      // goes, so the check must come before the route.
      const response = await anonymous("/api/auth/login", {
        method: "POST",
        headers: { origin: EVIL, "content-type": "application/json" },
        body: JSON.stringify({ username: "testuser", password: "wrong" }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-origin request rejected" });
    });

    it("rejects a cross-site MCP call before the key check", async () => {
      const response = await anonymous("/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "sec-fetch-site": "cross-site" },
      });
      expect(response.status).toBe(403);
    });
  });

  describe("static asset detection", () => {
    it("auth-gates a page path that merely contains a dot", async () => {
      for (const path of ["/b/1.0/transactions", "/b/1/securities/2.json", "/b/1/transactions/5.txt", "/b/1.json"]) {
        const response = await anonymous(path);
        expect(response.status, path).toBe(307);
        expect(response.headers.get("location"), path).toBe("/login");
      }
    });

    it("never redirects a file that actually exists in public/", async () => {
      // Read from the real directory: see the same test in
      // tests/lib/proxy.test.ts. The Rust server serves no files yet, so each
      // gets past the gate to the 404 of the page service.
      const root = join(process.cwd(), "public");
      const paths: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
          else paths.push(`/${prefix}${entry.name}`);
        }
      };
      walk(root, "");
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(await status(anonymous(path)), path).toBe(404);
      }
    });

    it("lets real asset shapes through without a session", async () => {
      for (const path of ["/logo.svg", "/styles.css", "/app.js", "/font.woff2", "/site.webmanifest"]) {
        expect(await status(anonymous(path)), path).toBe(404);
      }
    });

    it("never treats an /api/ path as a static asset", async () => {
      for (const path of ["/api/b/1/transactions/5.json", "/api/b/1/securities/2.txt", "/api/b/1/accounts.json"]) {
        expect(await status(anonymous(path)), path).toBe(401);
      }
    });
  });

  describe("security headers", () => {
    const expectHeaders = (response: Response, hsts: boolean) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name), `${response.url} ${name}`).toBe(value);
      }
      if (hsts) {
        expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      } else {
        expect(response.headers.get("strict-transport-security")).toBeNull();
      }
    };

    const everyKindOfResponse = (target: string) => [
      fetch(new URL("/health", target)),
      fetch(new URL("/api/health", target)),
      fetch(new URL("/api/version", target)),
      fetch(new URL("/api/version", target), { method: "POST" }),
      fetch(new URL("/api/b/1/accounts", target)),
      fetch(new URL("/api/versions", target)),
      fetch(new URL("/b/1", target), { redirect: "manual" }),
      fetch(new URL("/api/auth/login", target), { method: "POST", headers: { origin: EVIL } }),
    ];

    it("sends the security headers on every response, without HSTS by default", async () => {
      const responses = await Promise.all([
        ...everyKindOfResponse(baseUrl),
        withSession("/api/b/1/accounts"),
        withSession("/b/1"),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 405, 401, 401, 307, 403, 200, 404]);
      for (const response of responses) expectHeaders(response, false);
    });

    it("adds HSTS when ENABLE_HSTS=true", async () => {
      const hsts = await startHttpTestServer({ ENABLE_HSTS: "true" });
      try {
        for (const response of await Promise.all(everyKindOfResponse(hsts.baseUrl))) {
          expectHeaders(response, true);
        }
      } finally {
        await hsts.stop();
      }
    }, 120_000);

    it("sends no HSTS for any other ENABLE_HSTS value", async () => {
      const other = await startHttpTestServer({ ENABLE_HSTS: "1" });
      try {
        expectHeaders(await fetch(new URL("/api/version", other.baseUrl)), false);
      } finally {
        await other.stop();
      }
    }, 120_000);
  });
});

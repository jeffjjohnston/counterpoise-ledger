import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function request(
  path: string,
  session?: string,
  init?: { method?: string; headers?: Record<string, string> }
) {
  const req = new NextRequest(new URL(`http://localhost${path}`), {
    method: init?.method ?? "GET",
    headers: init?.headers,
  });
  if (session) req.cookies.set("counterpoise_session", session);
  return req;
}

/**
 * These exercise the gate itself rather than the route handlers. The handler
 * tests call route functions directly, so they proved /api/health is
 * unauthenticated while the endpoint was in fact returning 401 from here —
 * which left the container HEALTHCHECK failing in production.
 */
describe("proxy auth gate", () => {
  it("lets the container healthcheck reach /api/health without a session", () => {
    expect(proxy(request("/api/health")).status).toBe(200);
  });

  it("still gates job status behind a session", () => {
    expect(proxy(request("/api/system/status")).status).toBe(401);
  });

  it("allows job status through with a session cookie", () => {
    expect(proxy(request("/api/system/status", "token")).status).toBe(200);
  });

  it("does not open paths that merely begin with the health route's name", () => {
    expect(proxy(request("/api/healthcheck-internal")).status).toBe(401);
  });

  it("keeps auth and cron routes public", () => {
    expect(proxy(request("/api/auth/login")).status).toBe(200);
    expect(proxy(request("/api/cron/recurring")).status).toBe(200);
  });
});

describe("cross-origin write rejection", () => {
  it("rejects a POST from another origin", () => {
    const response = proxy(
      request("/api/b/1/transactions", "abc", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    );

    expect(response.status).toBe(403);
  });

  it("rejects when Sec-Fetch-Site says cross-site", () => {
    const response = proxy(
      request("/api/b/1/transactions", "abc", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      })
    );

    expect(response.status).toBe(403);
  });

  it("allows a same-origin POST", () => {
    const response = proxy(
      request("/api/b/1/transactions", "abc", {
        method: "POST",
        headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
      })
    );

    expect(response.status).not.toBe(403);
  });

  it("allows a cross-origin GET", () => {
    const response = proxy(
      request("/api/b/1/transactions", "abc", {
        method: "GET",
        headers: { origin: "https://evil.example" },
      })
    );

    expect(response.status).not.toBe(403);
  });

  it("allows a POST carrying neither Origin nor Sec-Fetch-Site", () => {
    // The scheduler's wget cron calls. Browsers always send Origin on
    // cross-origin writes, so header-less means a non-browser client, which
    // has no ambient cookie for an attacker to ride.
    const response = proxy(request("/api/cron/recurring", undefined, { method: "POST" }));

    expect(response.status).not.toBe(403);
  });

  it("rejects a cross-origin POST to the login endpoint", () => {
    // Regression guard for ordering: /api/auth/ is in PUBLIC_API_PREFIXES, so
    // an origin check placed after that early return would exempt exactly the
    // endpoint login-CSRF targets.
    const response = proxy(
      request("/api/auth/login", undefined, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      })
    );

    expect(response.status).toBe(403);
  });
});

describe("static asset detection", () => {
  it("auth-gates a page path that merely contains a dot", () => {
    // No session cookie, so a gated path must redirect.
    const response = proxy(request("/b/1.0/transactions"));

    expect(response.status).toBe(307); // redirect to /login
  });

  it("never treats a nested route path as a static asset", () => {
    // Dynamic segments match dotted text, so /b/1/securities/2.json is a page
    // route, not a file. Pages carry no auth of their own — no getSession, no
    // layout guard — so for them this gate IS the authentication.
    for (const path of [
      "/b/1/securities/2.json",
      "/b/1/transactions/5.txt",
      "/b/1.json",
    ]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(307); // redirect to /login
    }
  });

  it("serves every file that actually exists in public/", () => {
    // Driven by the real directory rather than a hand-written list: the asset
    // pattern is anchored to the shape of today's public/ tree, so adding an
    // asset directory would otherwise silently start redirecting those files
    // to /login. This fails instead, pointing at STATIC_ASSET_RE.
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
      expect(proxy(request(path)).status, path).toBe(200);
    }
  });

  it("never treats an /api/ path as a static asset", () => {
    // A dynamic [id] segment matches any non-slash text, so /transactions/5.json
    // reaches the transactions handler. The asset allowlist includes .json, so
    // without an /api/ exclusion these would skip the session gate below.
    // Every data route authenticates again on its own, but the gate is supposed
    // to be total for /api/ — a future route that forgets would be exposed.
    for (const path of [
      "/api/b/1/transactions/5.json",
      "/api/b/1/securities/2.txt",
      "/api/b/1/accounts.json",
    ]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(401);
    }
  });

  it("lets real assets through without a session", () => {
    for (const path of ["/logo.svg", "/styles.css", "/app.js", "/font.woff2", "/site.webmanifest"]) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(200);
    }
  });
});

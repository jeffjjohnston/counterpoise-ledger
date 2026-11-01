import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase } from "../helpers/db-utils";
import { onWorker, startHttpTestServer } from "../helpers/http-parity";

// Cloudflare Access forwards its token in this header. Only a server behind
// Access gets it; here the test sends it as Access would.
const TOKEN = "header.payload.signature";
const STATE = "aB3-_xYz0123456789";

describe("access hand-off HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);

  afterAll(async () => {
    await stop?.();
  });

  function handoff(state: string | null, headers: Record<string, string> = {}) {
    const url = new URL("/api/auth/access-handoff", baseUrl);
    if (state !== null) url.searchParams.set("state", state);
    // The callback is the app's scheme: read the redirect, never follow it.
    return fetch(url, { headers, redirect: "manual" });
  }

  it("answers 404 to a request that did not come through Access", async () => {
    expect((await handoff(STATE)).status).toBe(404);
  });

  it.skipIf(onWorker)("answers 404 on the native server, whatever the request sends", async () => {
    expect((await handoff(STATE, { "cf-access-jwt-assertion": TOKEN })).status).toBe(404);
  });

  it.runIf(onWorker)("hands the Access token and the state to the app's callback", async () => {
    const response = await handoff(STATE, { "cf-access-jwt-assertion": TOKEN });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`counterpoise://access?token=${TOKEN}&state=${STATE}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
  });

  it.runIf(onWorker)("refuses a missing or malformed state", async () => {
    for (const state of [null, "short", "0123456789abcdef&token=x"]) {
      const response = await handoff(state, { "cf-access-jwt-assertion": TOKEN });
      expect([response.status, await response.json()], String(state)).toEqual([400, { error: "Invalid state" }]);
    }
  });

  it.runIf(onWorker)("refuses a header that is not shaped like a token", async () => {
    expect((await handoff(STATE, { "cf-access-jwt-assertion": "not a token" })).status).toBe(404);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { getPlaidConfig } from "@/lib/plaid";

const ORIGINAL_ENV = { ...process.env };

function configurePlaidEnv() {
  process.env.PLAID_CLIENT_ID = "client-id";
  process.env.PLAID_SECRET = "secret";
  process.env.PLAID_ENV = "sandbox";
  delete process.env.PLAID_API_URL;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// The Plaid client of the server is rust-api/server/src/plaid.rs. This module
// keeps only the settings that `npm run plaid:link` reads.
describe("getPlaidConfig", () => {
  it("uses the origin of the configured Plaid environment", () => {
    configurePlaidEnv();
    expect(getPlaidConfig()).toEqual({
      clientId: "client-id",
      secret: "secret",
      baseUrl: "https://sandbox.plaid.com",
      env: "sandbox",
    });
  });

  it("uses the PLAID_API_URL origin when it is set", () => {
    configurePlaidEnv();
    process.env.PLAID_API_URL = "http://127.0.0.1:9";
    expect(getPlaidConfig().baseUrl).toBe("http://127.0.0.1:9");
  });

  it("throws when the Plaid variables are missing", () => {
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    delete process.env.PLAID_ENV;
    expect(() => getPlaidConfig()).toThrow("PLAID_CLIENT_ID environment variable not configured");
  });
});

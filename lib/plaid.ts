// Plaid retired the Development environment; Sandbox and Production are the
// only ones that still resolve. Keeping "development" in this union would let
// PLAID_ENV=development pass validation and then fail at the socket.
type PlaidEnv = "sandbox" | "production";

const PLAID_BASE_URLS: Record<PlaidEnv, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export type PlaidConfig = {
  clientId: string;
  secret: string;
  baseUrl: string;
  /** Which Plaid environment `baseUrl` points at, for callers that report it. */
  env: PlaidEnv;
};

function parsePlaidEnv(value: string | undefined): PlaidEnv | null {
  if (!value) return null;
  if (value === "sandbox" || value === "production") {
    return value;
  }
  return null;
}

/**
 * Reads and validates the Plaid credentials from the environment, for
 * `scripts/plaid-link.ts`.
 *
 * The server reads the same settings in `rust-api/server/src/plaid.rs`. A
 * token made against one base URL does not work against another, so the two
 * must agree about what each PLAID_ENV value means.
 */
export function getPlaidConfig(): PlaidConfig {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const plaidEnv = parsePlaidEnv(process.env.PLAID_ENV);

  if (!clientId) {
    throw new Error("PLAID_CLIENT_ID environment variable not configured");
  }

  if (!secret) {
    throw new Error("PLAID_SECRET environment variable not configured");
  }

  if (!plaidEnv) {
    throw new Error(
      "PLAID_ENV environment variable must be one of sandbox or production"
    );
  }

  return {
    clientId,
    secret,
    // PLAID_API_URL replaces the origin of the selected environment. A test
    // points it at a local mock, so no test calls Plaid.
    baseUrl: process.env.PLAID_API_URL || PLAID_BASE_URLS[plaidEnv],
    env: plaidEnv,
  };
}

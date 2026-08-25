import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchPlaidAccounts,
  fetchPlaidTransactionsSync,
} from "@/lib/plaid";

const ORIGINAL_ENV = { ...process.env };

function configurePlaidEnv() {
  process.env.PLAID_CLIENT_ID = "client-id";
  process.env.PLAID_SECRET = "secret";
  process.env.PLAID_ENV = "sandbox";
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchPlaidAccounts", () => {
  it("returns accounts from the configured Plaid environment", async () => {
    configurePlaidEnv();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accounts: [
          {
            account_id: "acc-1",
            name: "Checking",
            official_name: "Main Checking",
            mask: "1234",
            type: "depository",
            subtype: "checking",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPlaidAccounts("access-token")).resolves.toEqual([
      expect.objectContaining({ account_id: "acc-1", name: "Checking" }),
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox.plaid.com/accounts/get",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("surfaces Plaid API errors with the returned error code", async () => {
    configurePlaidEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error_message: "bad token",
          error_code: "INVALID_ACCESS_TOKEN",
        }),
      }))
    );

    await expect(fetchPlaidAccounts("bad-token")).rejects.toThrow(
      "Plaid /accounts/get request failed: bad token (INVALID_ACCESS_TOKEN)"
    );
  });
});

describe("fetchPlaidTransactionsSync", () => {
  it("filters invalid sync items while preserving valid data", async () => {
    configurePlaidEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          added: [
            {
              transaction_id: "txn-1",
              account_id: "acc-1",
              amount: 12.34,
              iso_currency_code: "USD",
              unofficial_currency_code: null,
              category: ["Food"],
              personal_finance_category: null,
              pending: false,
              pending_transaction_id: null,
              authorized_date: null,
              date: "2025-01-10",
              name: "Groceries",
              merchant_name: "Market",
              original_description: "Groceries",
            },
            { transaction_id: 123 },
          ],
          modified: [{ bogus: true }],
          removed: [{ transaction_id: "txn-2" }],
          has_more: true,
          next_cursor: "cursor-2",
        }),
      }))
    );

    await expect(
      fetchPlaidTransactionsSync({
        accessToken: "access-token",
        cursor: "cursor-1",
        count: 50,
        daysRequested: 30,
      })
    ).resolves.toEqual({
      added: [expect.objectContaining({ transaction_id: "txn-1" })],
      modified: [],
      removed: [{ transaction_id: "txn-2" }],
      hasMore: true,
      nextCursor: "cursor-2",
    });
  });

  it("throws when Plaid returns an invalid has_more value", async () => {
    configurePlaidEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          added: [],
          modified: [],
          removed: [],
          has_more: "yes",
          next_cursor: null,
        }),
      }))
    );

    await expect(
      fetchPlaidTransactionsSync({ accessToken: "access-token" })
    ).rejects.toThrow("Plaid /transactions/sync returned invalid has_more");
  });

  it("throws when Plaid env variables are missing", async () => {
    delete process.env.PLAID_CLIENT_ID;
    delete process.env.PLAID_SECRET;
    delete process.env.PLAID_ENV;

    await expect(
      fetchPlaidTransactionsSync({ accessToken: "access-token" })
    ).rejects.toThrow("PLAID_CLIENT_ID environment variable not configured");
  });
});

describe("plaid error formatting", () => {
  it("never puts the access token in a thrown message", async () => {
    configurePlaidEnv();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error_message: "the login details of this item have changed",
          error_code: "ITEM_LOGIN_REQUIRED",
        }),
      })
    );

    // syncToken's catch writes error.message straight into
    // plaidTokens.lastError, and get_plaid_status hands lastError to a model.
    // The whole reason that is safe: the message is built from Plaid's
    // error_message and error_code, never from the request body that carries
    // the access token.
    await expect(fetchPlaidAccounts("access-sandbox-SECRET-VALUE")).rejects.toThrow(
      "Plaid /accounts/get request failed: the login details of this item have changed (ITEM_LOGIN_REQUIRED)"
    );

    await expect(fetchPlaidAccounts("access-sandbox-SECRET-VALUE")).rejects.not.toThrow(
      /access-sandbox-SECRET-VALUE/
    );
  });
});

import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { syncToken, isPlaidConfigured, isPlaidConfigurationError, SyncTokenError } from "@/lib/plaid-sync";
import { fetchPlaidTransactionsSync } from "@/lib/plaid";
import { getDb } from "@/db";
import { plaidTokens, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createAccount,
  createPayee,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db";

vi.mock("@/lib/plaid", () => ({
  fetchPlaidTransactionsSync: vi.fn(),
}));

describe("plaid-sync", () => {
  it("exports syncToken function", () => {
    expect(typeof syncToken).toBe("function");
  });

  it("exports isPlaidConfigured function", () => {
    expect(typeof isPlaidConfigured).toBe("function");
  });

  it("exports isPlaidConfigurationError function", () => {
    expect(typeof isPlaidConfigurationError).toBe("function");
  });

  it("SyncTokenError has status and message", () => {
    const err = new SyncTokenError(404, "Token not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Token not found");
    expect(err.name).toBe("SyncTokenError");
  });

  it("SyncTokenError is an instance of Error", () => {
    const err = new SyncTokenError(400, "Bad request");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SyncTokenError);
  });

  describe("isPlaidConfigured", () => {
    it("returns false when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.PLAID_CLIENT_ID;
      delete process.env.PLAID_SECRET;
      delete process.env.PLAID_ENV;
      expect(isPlaidConfigured()).toBe(false);
      Object.assign(process.env, original);
    });
  });

  describe("isPlaidConfigurationError", () => {
    it("detects PLAID_CLIENT_ID errors", () => {
      expect(isPlaidConfigurationError("PLAID_CLIENT_ID environment variable not configured")).toBe(true);
    });

    it("detects PLAID_SECRET errors", () => {
      expect(isPlaidConfigurationError("PLAID_SECRET environment variable not configured")).toBe(true);
    });

    it("detects PLAID_ENV errors", () => {
      expect(isPlaidConfigurationError("PLAID_ENV must be one of sandbox or production")).toBe(true);
    });

    it("returns false for non-config errors", () => {
      expect(isPlaidConfigurationError("Some other error")).toBe(false);
    });
  });
});

describe("syncToken - lastError", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(fetchPlaidTransactionsSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records why a sync failed", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-err",
      accessToken: "tok-err",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-err",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });

    vi.mocked(fetchPlaidTransactionsSync).mockRejectedValueOnce(
      new Error("ITEM_LOGIN_REQUIRED")
    );

    await expect(syncToken(db, 1, token.id)).rejects.toThrow("ITEM_LOGIN_REQUIRED");

    const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(row.lastError).toContain("ITEM_LOGIN_REQUIRED");
  });

  it("refuses a demo connection without recording it as a failure", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase Bank",
      itemId: "demo_item_chase_2",
      accessToken: "demo_access_token_chase_2",
      isDemo: true,
    });
    const card = await createAccount({ name: "Demo Card", type: "liability" });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "demo_acct_chase_sapphire_2",
      name: "Chase Sapphire",
      type: "credit",
      counterpoiseAccountId: card.id,
    });

    await expect(syncToken(db, 1, token.id)).rejects.toMatchObject({ status: 400 });

    // lastError staying null is the point of the guard's placement. The Sync
    // page renders that column as "Last sync failed", and a demo connection
    // must not look like a broken one.
    const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(row.lastError).toBeNull();
    expect(fetchPlaidTransactionsSync).not.toHaveBeenCalled();
  });

  it("auto-matches a staged transaction instead of failing the sync", async () => {
    // syncToken runs on a reserved connection so its advisory lock keeps the
    // session that took it. Auto-match claims each row in a transaction, so a
    // reserved connection that cannot open one fails every sync that has
    // anything to match — and, because the cursor is already committed by then,
    // fails it after the work that would have found the match again.
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-auto",
      accessToken: "tok-auto",
      // An established connection, so the fixed dates below are not dropped by
      // the initial sync's 7-day cutoff.
      syncCursor: "cursor-before",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const link = await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-auto",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });

    // A previously matched row is what teaches the matcher this payee.
    const payee = await createPayee({ name: "Blue Bottle" });
    const history = await createTransactionWithSplits({
      date: "2026-02-15",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -400 },
        { accountId: groceries.id, amount: 400 },
      ],
    });
    await createPlaidReconciliation({
      plaidAccountLinkId: link.id,
      plaidTransactionId: "ptx-history",
      date: "2026-02-15",
      amountCents: 400,
      name: "BLUE BOTTLE COFFEE",
      merchantName: "Blue Bottle Coffee",
      resolutionStatus: "matched",
      matchedTransactionId: history.id,
    });

    // The transaction the incoming Plaid item should attach itself to.
    const entered = await createTransactionWithSplits({
      date: "2026-03-10",
      description: "Blue Bottle",
      payeeId: payee.id,
      splits: [
        { accountId: checking.id, amount: -500 },
        { accountId: groceries.id, amount: 500 },
      ],
    });

    vi.mocked(fetchPlaidTransactionsSync).mockResolvedValueOnce({
      added: [
        {
          transaction_id: "ptx-auto",
          account_id: "pa-auto",
          amount: 5,
          iso_currency_code: "USD",
          unofficial_currency_code: null,
          category: null,
          personal_finance_category: null,
          pending: false,
          pending_transaction_id: null,
          authorized_date: "2026-03-10",
          date: "2026-03-10",
          name: "BLUE BOTTLE COFFEE",
          merchant_name: "Blue Bottle Coffee",
          original_description: null,
        },
      ],
      modified: [],
      removed: [],
      hasMore: false,
      nextCursor: "cursor-auto",
    });

    const result = await syncToken(db, 1, token.id);

    expect(result.autoMatched).toBe(1);
    expect(result.pendingCount).toBe(0);

    const [reconciled] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, entered.id));
    expect(reconciled.isReconciled).toBe(true);

    const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(row.lastError).toBeNull();
  });

  it("clears the error once a sync succeeds", async () => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: "item-clr",
      accessToken: "tok-clr",
    });
    const checking = await createAccount({ name: "Checking", type: "asset" });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: "pa-clr",
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    await db
      .update(plaidTokens)
      .set({ lastError: "stale failure" })
      .where(eq(plaidTokens.id, token.id));

    vi.mocked(fetchPlaidTransactionsSync).mockResolvedValueOnce({
      added: [],
      modified: [],
      removed: [],
      hasMore: false,
      nextCursor: "cursor-1",
    });

    await syncToken(db, 1, token.id);

    const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(row.lastError).toBeNull();
  });
});

describe("syncToken - concurrency", () => {
  const db = getDb();

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    vi.mocked(fetchPlaidTransactionsSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seedToken = async (suffix: string) => {
    const token = await createPlaidToken({
      financialInstitution: "Chase",
      itemId: `item-${suffix}`,
      accessToken: `tok-${suffix}`,
    });
    const checking = await createAccount({ name: `Checking ${suffix}`, type: "asset" });
    await createPlaidAccount({
      tokenId: token.id,
      plaidAccountId: `pa-${suffix}`,
      name: "Plaid Checking",
      type: "depository",
      counterpoiseAccountId: checking.id,
    });
    return token;
  };

  // The hourly cron and a manual "Sync" click can overlap. Staging is
  // idempotent so the books survive it, but both runs pay for the same Plaid
  // page fetches.
  it("refuses a second sync while one is already running for the token", async () => {
    const token = await seedToken("lock");

    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchStarted!: () => void;
    const fetchHasStarted = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    vi.mocked(fetchPlaidTransactionsSync).mockImplementation(async () => {
      fetchStarted();
      await fetchReleased;
      return {
        added: [],
        modified: [],
        removed: [],
        hasMore: false,
        nextCursor: "cursor-1",
      };
    });

    const inFlight = syncToken(db, 1, token.id);
    await fetchHasStarted;

    await expect(syncToken(db, 1, token.id)).rejects.toMatchObject({
      status: 409,
    });

    releaseFetch();
    await inFlight;

    // The point of the lock: the second caller did no Plaid work.
    expect(vi.mocked(fetchPlaidTransactionsSync)).toHaveBeenCalledTimes(1);

    // A refusal is not a sync failure, so it must not show up on the sync page.
    const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
    expect(row.lastError).toBeNull();
  });

  it("locks per token, so a different token syncs concurrently", async () => {
    const first = await seedToken("a");
    const second = await seedToken("b");

    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchStarted!: () => void;
    const fetchHasStarted = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    vi.mocked(fetchPlaidTransactionsSync)
      .mockImplementationOnce(async () => {
        fetchStarted();
        await fetchReleased;
        return { added: [], modified: [], removed: [], hasMore: false, nextCursor: "c-a" };
      })
      .mockResolvedValue({
        added: [],
        modified: [],
        removed: [],
        hasMore: false,
        nextCursor: "c-b",
      });

    const inFlight = syncToken(db, 1, first.id);
    await fetchHasStarted;

    await expect(syncToken(db, 1, second.id)).resolves.toBeTruthy();

    releaseFetch();
    await inFlight;
  });
});

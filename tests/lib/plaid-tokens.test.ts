import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createBook,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
} from "@/tests/helpers/db-utils";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { books, plaidAccounts, plaidTokens, plaidTransactionReconciliation } from "@/db/schema";
import {
  clearSyncData,
  deletePlaidToken,
  getAssignedAccounts,
  getPlaidStatus,
  listTokenAccounts,
  listTokens,
  PlaidTokenNotFoundError,
  PlaidTokenValidationError,
  setTokenAccounts,
  updatePlaidToken,
} from "@/lib/plaid-tokens";

describe("plaid-tokens shared logic", () => {
  let bookId: number;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    const db = getDb();
    const [book] = await db.select().from(books).limit(1);
    bookId = book.id;
  });

  describe("getPlaidStatus", () => {
    it("masks the access token and never returns the raw one", async () => {
      const db = getDb();
      await createPlaidToken({
        bookId, financialInstitution: "Test Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });

      const status = await getPlaidStatus(db, bookId);

      expect(status.tokens).toHaveLength(1);
      expect(status.tokens[0].accessTokenMasked).toMatch(/^acce\*+mnop$/);
      // The whole point: the raw credential must not appear anywhere.
      expect(JSON.stringify(status)).not.toContain("access-sandbox-abcdefghijklmnop");
    });

    it("returns an empty shape for a book with no connections", async () => {
      const db = getDb();

      const status = await getPlaidStatus(db, bookId);

      expect(status.tokens).toEqual([]);
      expect(status.pendingCount).toBe(0);
      expect(status.staleUnmatched.totalCount).toBe(0);
      expect(status.assignedAccounts).toEqual([]);
    });

    it("does not report another book's connections", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      await createPlaidToken({
        bookId: other.id, financialInstitution: "Their Bank", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });
      await createPlaidToken({
        bookId, financialInstitution: "My Bank", itemId: "item-mine",
        accessToken: "access-sandbox-mine",
      });

      const status = await getPlaidStatus(db, bookId);

      expect(status.tokens.map((t) => t.itemId)).toEqual(["item-mine"]);
    });
  });

  describe("getAssignedAccounts", () => {
    it("returns the Plaid account mask on each assigned account", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", mask: "4567",
        counterpoiseAccountId: account.id,
      });

      const rows = await getAssignedAccounts(db, bookId);

      expect(rows[0].plaidAccountMask).toBe("4567");
    });

    it("returns null for an assigned account with no mask", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "No Mask", type: "depository", mask: null,
        counterpoiseAccountId: account.id,
      });

      const rows = await getAssignedAccounts(db, bookId);

      expect(rows.find((r) => r.plaidAccountName === "No Mask")?.plaidAccountMask).toBeNull();
    });
  });

  describe("listTokens", () => {
    it("counts mapped and total accounts per connection", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const savings = await createAccount({ bookId, name: "Savings", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Checking", type: "depository", counterpoiseAccountId: checking.id,
      });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-2",
        name: "Savings", type: "depository", counterpoiseAccountId: savings.id,
      });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-3",
        name: "Unmapped", type: "depository", counterpoiseAccountId: null,
      });

      const tokens = await listTokens(db, bookId);

      expect(tokens[0].totalAccountCount).toBe(3);
      expect(tokens[0].mappedAccountCount).toBe(2);
    });

    it("reports zero counts for a connection with no Plaid accounts at all", async () => {
      const db = getDb();
      await createPlaidToken({
        bookId, financialInstitution: "Bare Bank", itemId: "item-bare",
        accessToken: "access-sandbox-bare",
      });

      const tokens = await listTokens(db, bookId);

      const bare = tokens.find((t) => t.financialInstitution === "Bare Bank");
      expect(bare?.totalAccountCount).toBe(0);
      expect(bare?.mappedAccountCount).toBe(0);
    });
  });

  describe("listTokenAccounts", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns the token's mapped accounts without touching Plaid when refresh is off", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", counterpoiseAccountId: account.id,
      });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const rows = await listTokenAccounts(db, bookId, token.id);

      expect(rows).toHaveLength(1);
      expect(rows[0].plaidAccountId).toBe("plaid-acct-1");
      // No refresh means no outbound call at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("throws PlaidTokenNotFoundError for a token in another book, and reads nothing", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Their Bank", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });

      await expect(listTokenAccounts(db, bookId, theirs.id)).rejects.toThrow(
        PlaidTokenNotFoundError
      );
    });
  });

  describe("updatePlaidToken", () => {
    it("replaces the institution and itemId and keeps the access token when none is given", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Old Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });

      const updated = await updatePlaidToken(db, bookId, token.id, {
        financialInstitution: "New Bank",
        itemId: "item-2",
      });

      expect(updated.financialInstitution).toBe("New Bank");
      expect(updated.itemId).toBe("item-2");
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
      expect(row.accessToken).toBe("access-sandbox-abcdefghijklmnop");
    });

    it("refuses an itemId already used by another connection in the book", async () => {
      const db = getDb();
      const first = await createPlaidToken({
        bookId, financialInstitution: "A", itemId: "item-taken",
        accessToken: "access-sandbox-aaaaaaaaaaaaaaaa",
      });
      const second = await createPlaidToken({
        bookId, financialInstitution: "B", itemId: "item-free",
        accessToken: "access-sandbox-bbbbbbbbbbbbbbbb",
      });

      await expect(
        updatePlaidToken(db, bookId, second.id, {
          financialInstitution: "B", itemId: "item-taken",
        })
      ).rejects.toThrow(PlaidTokenValidationError);

      // And the row is untouched.
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, second.id));
      expect(row.itemId).toBe("item-free");
      expect(first.id).not.toBe(second.id);
    });

    it("throws PlaidTokenNotFoundError for a token in another book and leaves it unchanged", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs-000",
      });

      await expect(
        updatePlaidToken(db, bookId, theirs.id, {
          financialInstitution: "Hijacked", itemId: "item-theirs",
        })
      ).rejects.toThrow(PlaidTokenNotFoundError);

      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(row.financialInstitution).toBe("Theirs");
    });
  });

  describe("deletePlaidToken", () => {
    it("deletes the connection", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });

      await deletePlaidToken(db, bookId, token.id);

      const rows = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
      expect(rows).toHaveLength(0);
    });

    it("throws for a token in another book and leaves it in place", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs-000",
      });

      await expect(deletePlaidToken(db, bookId, theirs.id)).rejects.toThrow(
        PlaidTokenNotFoundError
      );

      const rows = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("setTokenAccounts", () => {
    it("refuses a plaidAccountId that does not belong to this connection, and writes nothing", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      const link = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", counterpoiseAccountId: null,
      });

      await expect(
        setTokenAccounts(db, bookId, token.id, [
          { plaidAccountId: "plaid-acct-does-not-exist", counterpoiseAccountId: account.id },
        ])
      ).rejects.toThrow(/Unknown plaidAccountId/);

      const [row] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, link.id));
      expect(row.counterpoiseAccountId).toBeNull();
    });

    it("refuses an account that is not an asset or a liability, and writes nothing", async () => {
      // syncToken() rejects any link whose account is not an asset or liability,
      // so without this check the mapping saves and every later sync fails with
      // the error surfacing far from the call that caused it. The web UI cannot
      // produce this — its dropdown is filtered to bank and credit-card
      // subtypes — but MCP takes a bare integer.
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const groceries = await createAccount({ bookId, name: "Groceries", type: "expense" });
      const link = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", counterpoiseAccountId: null,
      });

      await expect(
        setTokenAccounts(db, bookId, token.id, [
          { plaidAccountId: "plaid-acct-1", counterpoiseAccountId: groceries.id },
        ])
      ).rejects.toThrow(/Only asset or liability/);

      const [row] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, link.id));
      expect(row.counterpoiseAccountId).toBeNull();
    });

    it("accepts a liability account, not only an asset", async () => {
      // The rule is asset OR liability — a credit card is the common case and
      // must not be caught by the check above.
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const card = await createAccount({
        bookId, name: "Visa", type: "liability", subtype: "credit_card",
      });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Card", type: "credit", counterpoiseAccountId: null,
      });

      const rows = await setTokenAccounts(db, bookId, token.id, [
        { plaidAccountId: "plaid-acct-1", counterpoiseAccountId: card.id },
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0].counterpoiseAccountId).toBe(card.id);
    });

    it("refuses a Counterpoise account already mapped to a different Plaid account", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "First", type: "depository", counterpoiseAccountId: account.id,
      });
      const second = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-2",
        name: "Second", type: "depository", counterpoiseAccountId: null,
      });

      await expect(
        setTokenAccounts(db, bookId, token.id, [
          { plaidAccountId: "plaid-acct-2", counterpoiseAccountId: account.id },
        ])
      ).rejects.toThrow(/already mapped/);

      const [row] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, second.id));
      expect(row.counterpoiseAccountId).toBeNull();
    });

    it("writes the mapping and returns the updated list", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", counterpoiseAccountId: null,
      });

      const rows = await setTokenAccounts(db, bookId, token.id, [
        { plaidAccountId: "plaid-acct-1", counterpoiseAccountId: account.id },
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0].counterpoiseAccountId).toBe(account.id);
    });

    it("leaves a plaidAccountId this connection has but the request omits untouched", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop",
      });
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const savingsAccount = await createAccount({ bookId, name: "Savings", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-checking",
        name: "Checking", type: "depository", counterpoiseAccountId: checking.id,
      });
      const savingsLink = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-savings",
        name: "Savings", type: "depository", counterpoiseAccountId: savingsAccount.id,
      });

      // Only re-assigns the checking link; the savings link is not in this
      // request at all.
      const rows = await setTokenAccounts(db, bookId, token.id, [
        { plaidAccountId: "plaid-acct-checking", counterpoiseAccountId: null },
      ]);

      expect(rows.find((r) => r.plaidAccountId === "plaid-acct-checking")?.counterpoiseAccountId).toBeNull();
      expect(rows.find((r) => r.plaidAccountId === "plaid-acct-savings")?.counterpoiseAccountId).toBe(
        savingsAccount.id
      );

      const [row] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, savingsLink.id));
      expect(row.counterpoiseAccountId).toBe(savingsAccount.id);
    });

    it("throws PlaidTokenNotFoundError for a token in another book, and writes nothing", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs",
      });
      const theirAccount = await createAccount({ bookId: other.id, name: "Checking", type: "asset" });
      const theirLink = await createPlaidAccount({
        bookId: other.id, tokenId: theirs.id, plaidAccountId: "plaid-acct-1",
        name: "Checking", type: "depository", counterpoiseAccountId: null,
      });

      await expect(
        setTokenAccounts(db, bookId, theirs.id, [
          { plaidAccountId: "plaid-acct-1", counterpoiseAccountId: theirAccount.id },
        ])
      ).rejects.toThrow(PlaidTokenNotFoundError);

      const [row] = await db.select().from(plaidAccounts).where(eq(plaidAccounts.id, theirLink.id));
      expect(row.counterpoiseAccountId).toBeNull();
    });

    it("swaps two mappings without tripping the unique index", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-swap",
        accessToken: "access-sandbox-swap",
      });
      const checking = await createAccount({ bookId, name: "Checking", type: "asset" });
      const savings = await createAccount({ bookId, name: "Savings", type: "asset" });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-a",
        name: "Plaid A", type: "depository", counterpoiseAccountId: checking.id,
      });
      await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-b",
        name: "Plaid B", type: "depository", counterpoiseAccountId: savings.id,
      });

      const rows = await setTokenAccounts(db, bookId, token.id, [
        { plaidAccountId: "plaid-acct-a", counterpoiseAccountId: savings.id },
        { plaidAccountId: "plaid-acct-b", counterpoiseAccountId: checking.id },
      ]);

      expect(rows.find((r) => r.plaidAccountId === "plaid-acct-a")?.counterpoiseAccountId).toBe(
        savings.id
      );
      expect(rows.find((r) => r.plaidAccountId === "plaid-acct-b")?.counterpoiseAccountId).toBe(
        checking.id
      );
    });
  });

  describe("clearSyncData", () => {
    it("removes the connection's staged rows and clears its cursor", async () => {
      const db = getDb();
      const token = await createPlaidToken({
        bookId, financialInstitution: "Bank", itemId: "item-1",
        accessToken: "access-sandbox-abcdefghijklmnop", syncCursor: "cursor-abc",
      });
      const account = await createAccount({ bookId, name: "Checking", type: "asset" });
      const link = await createPlaidAccount({
        bookId, tokenId: token.id, plaidAccountId: "plaid-acct-1",
        name: "Bank Checking", type: "depository", counterpoiseAccountId: account.id,
      });
      await createPlaidReconciliation({
        bookId, plaidAccountLinkId: link.id,
        plaidTransactionId: "plaid-txn-1", date: "2026-02-01",
        amountCents: -4200, name: "Coffee Shop",
        resolutionStatus: "pending",
      });

      await clearSyncData(db, bookId, token.id);

      const staged = await db
        .select()
        .from(plaidTransactionReconciliation)
        .where(eq(plaidTransactionReconciliation.plaidAccountLinkId, link.id));
      expect(staged).toHaveLength(0);
      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, token.id));
      expect(row.syncCursor).toBeNull();
    });

    it("throws for a connection in another book and clears nothing", async () => {
      const db = getDb();
      const other = await createBook({ name: "Other Book" });
      const theirs = await createPlaidToken({
        bookId: other.id, financialInstitution: "Theirs", itemId: "item-theirs",
        accessToken: "access-sandbox-theirs-000", syncCursor: "cursor-theirs",
      });

      await expect(clearSyncData(db, bookId, theirs.id)).rejects.toThrow(
        PlaidTokenNotFoundError
      );

      const [row] = await db.select().from(plaidTokens).where(eq(plaidTokens.id, theirs.id));
      expect(row.syncCursor).toBe("cursor-theirs");
    });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  PlaidTransactionReconciliation, Transaction, TransactionSplit, TypeSafeDecision, TypeSafeEvaluation,
} from "../../types/db";
import {
  addBookMember, createAccount, createBook, createInvestmentSplit, createPayee, createPlaidAccount,
  createPlaidReconciliation, createPlaidToken, createSecurity, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { count, exec, insert, row, rows, scalar, script } from "../helpers/sql";

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function expectError(client: Client, path: string, init: RequestInit, status: number, error: string) {
  const response = await client.request(path, init);
  expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
  expect(await response.json()).toEqual({ error });
}

async function ok(client: Client, path: string, init?: RequestInit) {
  const response = await client.request(path, init);
  expect(response.status, `${init?.method ?? "GET"} ${path} ${String(init?.body)}`).toBe(200);
  return response.json();
}

/**
 * A book with two synced accounts, one mapping to an expense account, local
 * transactions around the bank dates, and a queue of staged rows. Every date
 * and timestamp is fixed, so the responses can be compared as snapshots.
 */
async function fixture() {
  const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
  const card = await createAccount({ name: "Card", type: "liability", subtype: "credit_card" });
  const food = await createAccount({ name: "Food", type: "expense" });
  const rent = await createAccount({ name: "Rent", type: "expense" });
  const savings = await createAccount({ name: "Savings", type: "asset" });
  const coffee = await createPayee({ name: "Blue Bottle" });
  const landlord = await createPayee({ name: "Landlord" });
  const token = await createPlaidToken({ financialInstitution: "Chase", itemId: "item-1", accessToken: "t" });
  const link = (plaidAccountId: string, counterpoiseAccountId: number) =>
    createPlaidAccount({ tokenId: token.id, plaidAccountId, name: plaidAccountId, type: "depository", counterpoiseAccountId });
  const checkingLink = await link("pa-checking", checking.id);
  const cardLink = await link("pa-card", card.id);
  const expenseLink = await link("pa-food", food.id);

  const spend = (date: string, amount: number, payeeId: number | null, counter = food.id, description: string | null = null) =>
    createTransactionWithSplits({ date, payeeId, description, splits: [{ accountId: checking.id, amount: -amount }, { accountId: counter, amount }] });
  const coffeeSameDay = await spend("2025-03-09", 450, coffee.id, food.id, "Coffee");
  const coffeeLater = await spend("2025-03-12", 460, coffee.id);
  const coffeeFar = await spend("2025-03-20", 450, coffee.id);
  const rentPaid = await spend("2025-03-01", 150000, landlord.id, rent.id, "March rent");
  await spend("2025-02-01", 150000, landlord.id, rent.id);
  await spend("2025-01-01", 149000, landlord.id, food.id);
  const transfer = await createTransactionWithSplits({
    date: "2025-03-10", description: "To savings",
    splits: [{ accountId: checking.id, amount: -5000 }, { accountId: savings.id, amount: 5000 }],
  });

  const stage = async (linkId: number, plaidTransactionId: string, fields: Partial<Parameters<typeof createPlaidReconciliation>[0]>, seen: string) => {
    const staged = await createPlaidReconciliation({
      plaidAccountLinkId: linkId, plaidTransactionId, date: "2025-03-10", amountCents: 100, name: plaidTransactionId, ...fields,
    });
    await exec(
      "UPDATE plaid_transaction_reconciliation SET first_seen_at = $1, last_seen_at = $2, raw_json = $3 WHERE id = $4",
      [new Date("2025-03-01T00:00:00.000Z"), new Date(seen), "{}", staged.id],
    );
    return staged;
  };
  const coffeeRow = await stage(checkingLink.id, "coffee", { amountCents: 450, name: "SQ *BLUE BOTTLE", merchantName: "Blue Bottle", authorizedDate: "2025-03-09" }, "2025-03-10T10:00:00.000Z");
  const rentRow = await stage(checkingLink.id, "rent", { amountCents: 150500, name: "LANDLORD LLC", merchantName: "Landlord", date: "2025-03-02" }, "2025-03-11T10:00:00.000Z");
  const transferRow = await stage(checkingLink.id, "transfer", { amountCents: 5000, name: "Online transfer" }, "2025-03-09T10:00:00.000Z");
  const reviewRow = await stage(checkingLink.id, "review", { amountCents: 460, name: "Changed", resolutionStatus: "matched", reviewReason: "plaid_modified", matchedTransactionId: coffeeLater.id }, "2025-03-01T10:00:00.000Z");
  await stage(checkingLink.id, "done", { resolutionStatus: "matched", matchedTransactionId: coffeeFar.id }, "2025-03-15T10:00:00.000Z");
  await stage(checkingLink.id, "ignored", { resolutionStatus: "ignored" }, "2025-03-15T10:00:00.000Z");
  const cardRow = await stage(cardLink.id, "card", { amountCents: -2500, name: "REFUND", date: "2025-03-11", authorizedDate: "2025-03-08" }, "2025-03-12T10:00:00.000Z");
  await stage(expenseLink.id, "expense", {}, "2025-03-12T10:00:00.000Z");
  return {
    checking, card, food, rent, savings, coffee, landlord, token, checkingLink, cardLink, expenseLink,
    coffeeSameDay, coffeeLater, coffeeFar, rentPaid, transfer, coffeeRow, rentRow, transferRow, reviewRow, cardRow,
  };
}

beforeAll(async () => {
  await setupTestDatabase();
}, 120_000);

describe("Plaid reconciliation HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    ({ baseUrl, stop } = await startHttpTestServer({ TYPESAFE_ENABLED: "true", TYPESAFE_CLEF_ACCOUNT_ID: "abc123", TYPESAFE_CLEF_API_TOKEN: "test-token" }));
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  it("lists the queue of one link with ranked candidates and a suggested account", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    expect(await ok(client, path)).toMatchSnapshot("link queue");
    expect(await ok(client, `${path}?limit=2&offset=1`)).toMatchSnapshot("link queue page");
    const all = await ok(client, `${path}?limit=abc&offset=-5`);
    expect([all.limit, all.offset, all.totalCount, all.hasMore]).toEqual([25, 0, 4, false]);
    const hex = await ok(client, `${path}?limit=0x2&offset=3&limit=9`);
    expect([hex.limit, hex.offset, hex.items.length, hex.hasMore]).toEqual([2, 3, 1, false]);
    const card = await ok(client, `/api/b/1/sync/accounts/${f.cardLink.id}/reconcile?limit=500`);
    expect(card.limit).toBe(500);
    expect(card.items.map((item: { id: number }) => item.id)).toEqual([f.cardRow.id]);
  });

  it("lists the queue of the whole book, newest bank date first", async () => {
    const f = await fixture();
    expect(await ok(client, "/api/b/1/sync/reconcile")).toMatchSnapshot("book queue");
    const capped = await ok(client, "/api/b/1/sync/reconcile?limit=500&offset=-0");
    expect([capped.limit, capped.offset, capped.totalCount]).toEqual([100, 0, 5]);
    const card = await ok(client, `/api/b/1/sync/reconcile?linkId=%20${f.cardLink.id}%20&limit=1`);
    expect([card.totalCount, card.items.map((item: { id: number }) => item.id)]).toEqual([1, [f.cardRow.id]]);
    for (const value of ["abc", "0", "-1", "1.5", "Infinity"]) {
      await expectError(client, `/api/b/1/sync/reconcile?linkId=${value}`, {}, 400, "Invalid linkId");
    }
    expect((await ok(client, "/api/b/1/sync/reconcile?linkId=")).totalCount).toBe(5);
    await expectError(client, `/api/b/1/sync/reconcile?linkId=${f.expenseLink.id}`, {}, 400, "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions");
    await expectError(client, "/api/b/1/sync/reconcile?linkId=999", {}, 404, "Linked sync account not found");
    await expectError(client, "/api/b/1/sync/reconcile?linkId=3000000000", {}, 500, "Failed to load reconciliation queue");
  });

  it("refuses a link that is missing, in another book, or not reconcilable", async () => {
    const f = await fixture();
    const stranger = await createUser({ username: "stranger" });
    const other = await createBook({ name: "Other", userId: stranger.id });
    const foreignAccount = await createAccount({ name: "Foreign", type: "asset", bookId: other.id });
    const foreignToken = await createPlaidToken({ financialInstitution: "F", itemId: "item-f", accessToken: "t", bookId: other.id });
    const foreignLink = await createPlaidAccount({ tokenId: foreignToken.id, plaidAccountId: "pa-f", name: "F", type: "depository", counterpoiseAccountId: foreignAccount.id, bookId: other.id });
    const body = json("POST", { reconciliationId: f.coffeeRow.id, action: "ignore" });
    for (const method of ["GET", "POST"] as const) {
      const init = method === "GET" ? {} : body;
      await expectError(client, `/api/b/1/sync/accounts/${foreignLink.id}/reconcile`, init, 404, "Linked sync account not found");
      await expectError(client, `/api/b/1/sync/accounts/${f.expenseLink.id}/reconcile`, init, 400, "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions");
      await expectError(client, "/api/b/1/sync/accounts/nope/reconcile", init, 400, "Invalid linked account id");
    }
    // The link is checked before the body is read.
    await expectError(client, `/api/b/1/sync/accounts/${f.expenseLink.id}/reconcile`, { method: "POST", body: "{" }, 400, "Only asset or liability Counterpoise accounts can be reconciled against Plaid transactions");
    const viewer = await createBook({ name: "Shared", userId: stranger.id });
    await addBookMember({ bookId: viewer.id, userId: 1, role: "viewer" });
    await expectError(client, `/api/b/${viewer.id}/sync/accounts/1/reconcile`, body, 403, "You have read-only access to this book");
    await expectError(client, `/api/b/${viewer.id}/sync/accounts/1/reconcile`, {}, 404, "Linked sync account not found");
  });

  it("refuses a malformed decision with the first schema issue", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    for (const [body, error] of [
      [null, "reconciliationId is required"],
      [[], "reconciliationId is required"],
      [{}, "reconciliationId is required"],
      [{ reconciliationId: "1", action: "match" }, "reconciliationId is required"],
      [{ reconciliationId: 1.5, action: "bogus" }, "reconciliationId is required"],
      [{ reconciliationId: 2 ** 53, action: "ignore" }, "reconciliationId is required"],
      [{ reconciliationId: 1 }, "Invalid action"],
      [{ reconciliationId: 1, action: "bogus", transactionId: "x" }, "Invalid action"],
      [{ reconciliationId: 1, action: "match" }, "transactionId is required for match"],
      [{ reconciliationId: 1, action: "match", transactionId: "5" }, "transactionId is required for match"],
      [{ reconciliationId: 1, action: "match_update_amount", transactionId: 1.5 }, "transactionId is required for match_update_amount"],
      [{ reconciliationId: 1, action: "create", counterAccountId: 0 }, "counterAccountId is required for create"],
      [{ reconciliationId: 1, action: "create" }, "counterAccountId is required for create"],
    ] as const) {
      await expectError(client, path, json("POST", body), 400, error);
    }
    // The action rule comes before the row lookup.
    await expectError(client, path, json("POST", { reconciliationId: 999999, action: "match" }), 400, "transactionId is required for match");
    await expectError(client, path, json("POST", { reconciliationId: 999999, action: "ignore" }), 404, "Reconciliation row not found");
    await expectError(client, path, json("POST", { reconciliationId: f.cardRow.id, action: "ignore" }), 404, "Reconciliation row not found");
  });

  it("matches a transaction and keeps its date, and refuses a second link", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const item = await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: f.coffeeSameDay.id }));
    expect(item).toMatchSnapshot("matched item");
    const local = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [f.coffeeSameDay.id]);
    expect(local).toMatchObject({ isReconciled: true, date: "2025-03-09", updatedBy: 1 });
    await expectError(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: f.coffeeLater.id }), 400, `This bank transaction is already linked to transaction #${f.coffeeSameDay.id} — unlink it first`);
    await expectError(client, path, json("POST", { reconciliationId: f.rentRow.id, action: "match", transactionId: f.coffeeSameDay.id }), 400, "This transaction is already linked to a different Plaid transaction for the same account");
    const other = await createTransactionWithSplits({ date: "2025-03-10", splits: [{ accountId: f.food.id, amount: 1 }, { accountId: f.rent.id, amount: -1 }] });
    await expectError(client, path, json("POST", { reconciliationId: f.rentRow.id, action: "match", transactionId: other.id }), 400, "Selected transaction does not include the linked account");
    // Node repeats the Drizzle message of the failed query; guides list it.
    const outOfRange = await client.request(path, json("POST", { reconciliationId: f.rentRow.id, action: "match", transactionId: 3_000_000_000 }));
    expect(outOfRange.status).toBe(500);
  });

  it("settles a floating transaction with the matched date", async () => {
    const f = await fixture();
    const floating = await createTransactionWithSplits({ date: "2025-01-15", isFloating: true, splits: [{ accountId: f.checking.id, amount: -2500 }, { accountId: f.food.id, amount: 2500 }] });
    await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: floating.id }));
    const local = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [floating.id]);
    expect(local).toMatchObject({ isReconciled: true, isFloating: false, date: "2025-03-09" });
  });

  // Lots are derived from the effective date. A match that settles a floating
  // trade changes that date, so the write must rebuild the pair.
  it("rebuilds the lots of a floating investment transaction that it settles", async () => {
    const f = await fixture();
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const security = await createSecurity({ name: "Fund", symbol: "FND", securityType: "stock" });
    const trade = await createTransactionWithSplits({ date: "2025-01-15", isFloating: true, splits: [{ accountId: f.checking.id, amount: -450 }, { accountId: brokerage.id, amount: 450 }] });
    await createInvestmentSplit({ transactionId: trade.id, accountId: brokerage.id, securityId: security.id, action: "buy", sharesMicros: 1_000_000, priceMicros: 4_500_000 });
    // The stale lot of an earlier rebuild, made while the trade was floating.
    await insert("investment_lots", {
      book_id: 1, security_id: security.id, account_id: brokerage.id, opened_transaction_id: trade.id, created_at: "2025-01-15 00:00:00",
      acquired_date: "2025-02-20", original_shares_micros: 1_000_000, original_basis_cents: 450, remaining_shares_micros: 1_000_000, remaining_basis_cents: 450,
    });
    await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: trade.id }));
    const lots = await rows<{ acquiredDate: string; remainingSharesMicros: number }>("SELECT acquired_date, remaining_shares_micros FROM investment_lots WHERE account_id = $1", [brokerage.id]);
    expect(lots).toEqual([{ acquiredDate: "2025-03-09", remainingSharesMicros: 1_000_000 }]);
  });

  it("matches and rewrites the amount of a two-split transaction", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const body = (transactionId: number) => json("POST", { reconciliationId: f.rentRow.id, action: "match_update_amount", transactionId });
    const three = await createTransactionWithSplits({ date: "2025-03-02", splits: [{ accountId: f.checking.id, amount: -3 }, { accountId: f.food.id, amount: 1 }, { accountId: f.rent.id, amount: 2 }] });
    await expectError(client, path, body(three.id), 400, "Amount update is only supported for transactions with exactly 2 splits");
    const selfTransfer = await createTransactionWithSplits({ date: "2025-03-02", splits: [{ accountId: f.checking.id, amount: -3 }, { accountId: f.checking.id, amount: 3 }] });
    await expectError(client, path, body(selfTransfer.id), 400, "Transaction has no counterpart split on a different account");
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const security = await createSecurity({ name: "Fund", symbol: "FND", securityType: "stock" });
    const trade = await createTransactionWithSplits({ date: "2025-03-02", splits: [{ accountId: f.checking.id, amount: -100 }, { accountId: brokerage.id, amount: 100 }] });
    await createInvestmentSplit({ transactionId: trade.id, accountId: brokerage.id, securityId: security.id, action: "buy", sharesMicros: 1_000_000, priceMicros: 100_000_000 });
    await expectError(client, path, body(trade.id), 400, "Amount update is not supported for investment transactions");
    // The candidate says so, and the client then offers no amount update.
    const queued = (await ok(client, path)).items.find((entry: { id: number }) => entry.id === f.rentRow.id);
    const flags = Object.fromEntries(queued.candidates.map((entry: { transactionId: number; isInvestment: boolean }) => [entry.transactionId, entry.isInvestment]));
    expect([flags[trade.id], flags[three.id]]).toEqual([true, false]);
    const offAccount = await createTransactionWithSplits({ date: "2025-03-02", splits: [{ accountId: f.food.id, amount: -3 }, { accountId: f.rent.id, amount: 3 }] });
    await expectError(client, path, body(offAccount.id), 400, "Selected transaction does not include the linked account");

    expect(await ok(client, path, body(f.rentPaid.id))).toMatchSnapshot("amount updated item");
    const splits = await rows<TransactionSplit>("SELECT * FROM transaction_splits WHERE transaction_id = $1 ORDER BY id", [f.rentPaid.id]);
    expect(splits.map((split) => [split.accountId, split.amount])).toEqual([[f.checking.id, -150500], [f.rent.id, 150500]]);
  });

  it("refuses a bank amount whose negation does not fit a split, before any write", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const error = "The bank amount is out of range for a transaction split";
    // -2147483648 fits a 32-bit integer; its negation does not. SQLite would
    // store it, and every later read of the split would fail.
    await exec("UPDATE plaid_transaction_reconciliation SET amount_cents = $1 WHERE id IN ($2, $3)", [-2147483648, f.coffeeRow.id, f.rentRow.id]);
    const transactions = await count("transactions");
    const splitsBefore = await rows<TransactionSplit>("SELECT * FROM transaction_splits ORDER BY id");

    await expectError(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.food.id }), 400, error);
    await expectError(client, path, json("POST", { reconciliationId: f.rentRow.id, action: "match_update_amount", transactionId: f.rentPaid.id }), 400, error);

    expect(await count("transactions")).toBe(transactions);
    expect(await rows<TransactionSplit>("SELECT * FROM transaction_splits ORDER BY id")).toEqual(splitsBefore);
    const staged = await rows<PlaidTransactionReconciliation>("SELECT * FROM plaid_transaction_reconciliation WHERE id IN ($1, $2) ORDER BY id", [f.coffeeRow.id, f.rentRow.id]);
    expect(staged.map((item) => [item.resolutionStatus, item.matchedTransactionId])).toEqual([["pending", null], ["pending", null]]);
    // The register of the account still reads.
    await ok(client, `/api/b/1/transactions?accountId=${f.checking.id}`);
  });

  it("creates a transaction with a resolved or new payee", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    await expectError(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.checking.id }), 400, "Counter account must be different from linked account");
    await expectError(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: 999999 }), 400, "Counter account not found");

    const created = await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.food.id, payeeName: "  blue   BOTTLE " }));
    expect(created).toMatchSnapshot("created item");
    const local = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [created.matchedTransactionId]);
    expect(local).toMatchObject({ date: "2025-03-09", description: "SQ *BLUE BOTTLE", payeeId: f.coffee.id, isReconciled: true, isFloating: false, createdBy: 1, updatedBy: 1 });
    const splits = await rows<TransactionSplit>("SELECT * FROM transaction_splits WHERE transaction_id = $1 ORDER BY id", [local.id]);
    expect(splits.map((split) => [split.accountId, split.amount])).toEqual([[f.checking.id, -450], [f.food.id, 450]]);

    // A payee name that is not a string falls back to the bank's name.
    const refund = await ok(client, `/api/b/1/sync/accounts/${f.cardLink.id}/reconcile`, json("POST", { reconciliationId: f.cardRow.id, action: "create", counterAccountId: f.food.id, payeeName: 5 }));
    const refundTxn = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [refund.matchedTransactionId]);
    const newPayee = await scalar("SELECT name FROM payees WHERE id = $1", [refundTxn.payeeId]);
    expect([refundTxn.date, newPayee]).toEqual(["2025-03-08", "REFUND"]);
  });

  it("rolls back a create when a write after the new transaction fails", async () => {
    const f = await fixture();
    // The resolution update comes after the transaction insert. Make it fail.
    await script(`CREATE TRIGGER fail_resolution BEFORE UPDATE ON plaid_transaction_reconciliation
      WHEN NEW.resolution_status = 'created' BEGIN SELECT RAISE(ABORT, 'resolution refused'); END;`);
    try {
      const before = await count("transactions");
      const response = await client.request(`/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.food.id }));
      expect(response.status).toBe(500);
      expect(await count("transactions")).toBe(before);
      const stored = await row<PlaidTransactionReconciliation>("SELECT * FROM plaid_transaction_reconciliation WHERE id = $1", [f.coffeeRow.id]);
      expect(stored).toMatchObject({ resolutionStatus: "pending", matchedTransactionId: null });
    } finally {
      await script("DROP TRIGGER fail_resolution");
    }
  });

  it("reuses a payee whose name differs only in a final sigma", async () => {
    const f = await fixture();
    // PostgreSQL lowercased the final sigma as σ and JavaScript as ς, so the
    // lookup missed the payee and the insert hit the unique index. The lookup
    // now compares name_fold, the Rust lowercase, so it finds the payee.
    const payee = await createPayee({ name: "ΟΔΟΣ" });
    await exec(
      "UPDATE plaid_transaction_reconciliation SET merchant_name = $1, merchant_key = $2 WHERE id = $3",
      ["ΟΔΟΣ", "ΟΔΟΣ".toLowerCase(), f.coffeeRow.id],
    );
    const created = await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`, json("POST", { reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.food.id }));
    const transaction = await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [created.matchedTransactionId]);
    expect(transaction.payeeId).toBe(payee.id);
    expect(await count("payees", "name = $1", ["ΟΔΟΣ"])).toBe(1);
  });

  it("ignores a row, keeps the local side of a review, and unlinks", async () => {
    const f = await fixture();
    const checkingPath = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    expect(await ok(client, checkingPath, json("POST", { reconciliationId: f.transferRow.id, action: "ignore" }))).toMatchObject({ resolutionStatus: "ignored", matchedTransactionId: null });
    const kept = await ok(client, checkingPath, json("POST", { reconciliationId: f.reviewRow.id, action: "keep_local" }));
    expect(kept).toMatchObject({ resolutionStatus: "matched", reviewReason: null, matchedTransactionId: f.coffeeLater.id });

    // A transfer matched on both links stays reconciled until both unlink.
    const savingsLink = await createPlaidAccount({ tokenId: f.token.id, plaidAccountId: "pa-savings", name: "S", type: "depository", counterpoiseAccountId: f.savings.id });
    const incoming = await createPlaidReconciliation({ plaidAccountLinkId: savingsLink.id, plaidTransactionId: "in", date: "2025-03-10", amountCents: -5000, name: "in", resolutionStatus: "matched", matchedTransactionId: f.transfer.id });
    await exec("UPDATE plaid_transaction_reconciliation SET resolution_status = $1 WHERE id = $2", ["pending", f.transferRow.id]);
    await ok(client, checkingPath, json("POST", { reconciliationId: f.transferRow.id, action: "match", transactionId: f.transfer.id }));
    const reconciled = async () => (await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [f.transfer.id])).isReconciled;
    expect(await reconciled()).toBe(true);
    const unlinked = await ok(client, checkingPath, json("POST", { reconciliationId: f.transferRow.id, action: "unlink" }));
    expect(unlinked).toMatchObject({ resolutionStatus: "pending", matchedTransactionId: null, reviewReason: null });
    expect(await reconciled()).toBe(true);
    await ok(client, `/api/b/1/sync/accounts/${savingsLink.id}/reconcile`, json("POST", { reconciliationId: incoming.id, action: "unlink" }));
    expect(await reconciled()).toBe(false);
  });

  // Production, book 2: a row flagged as modified was resolved with Create.
  // The old transaction stayed reconciled with no link, a duplicate charge.
  it("clears the old transaction when a row flagged for review is linked again", async () => {
    const reconciled = async (id: number) => (await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [id])).isReconciled;
    const decisions = [
      (f: Awaited<ReturnType<typeof fixture>>) => ({ action: "create", counterAccountId: f.food.id }),
      (f: Awaited<ReturnType<typeof fixture>>) => ({ action: "match", transactionId: f.coffeeSameDay.id }),
      (f: Awaited<ReturnType<typeof fixture>>) => ({ action: "match_update_amount", transactionId: f.coffeeSameDay.id }),
    ];
    for (const decision of decisions) {
      await resetTestDatabase();
      client = await sessionHttpClient(baseUrl);
      const f = await fixture();
      await exec("UPDATE transactions SET is_reconciled = true WHERE id = $1", [f.coffeeLater.id]);
      const body = decision(f);
      const item = await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`, json("POST", { reconciliationId: f.reviewRow.id, ...body }));
      expect(item.matchedTransactionId, body.action).not.toBe(f.coffeeLater.id);
      expect(await reconciled(item.matchedTransactionId), body.action).toBe(true);
      expect(await reconciled(f.coffeeLater.id), body.action).toBe(false);
    }
  });

  // Ignore removes the link of a row flagged for review too, so it releases
  // the old transaction under the same rule as Match and Create.
  it("clears the old transaction when a linked row flagged for review is ignored", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const reconciled = async (id: number) => (await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [id])).isReconciled;
    await exec("UPDATE transactions SET is_reconciled = true WHERE id = $1", [f.coffeeLater.id]);
    const item = await ok(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "ignore" }));
    expect(item).toMatchObject({ resolutionStatus: "ignored", matchedTransactionId: null, reviewReason: null });
    expect(await reconciled(f.coffeeLater.id)).toBe(false);
  });

  it("keeps the old transaction reconciled on Ignore when another row still links it", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const reconciled = async (id: number) => (await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [id])).isReconciled;
    const savingsLink = await createPlaidAccount({ tokenId: f.token.id, plaidAccountId: "pa-savings", name: "S", type: "depository", counterpoiseAccountId: f.savings.id });
    await createPlaidReconciliation({ plaidAccountLinkId: savingsLink.id, plaidTransactionId: "in", date: "2025-03-10", amountCents: -5000, name: "in", resolutionStatus: "matched", matchedTransactionId: f.transfer.id });
    await exec("UPDATE plaid_transaction_reconciliation SET matched_transaction_id = $1 WHERE id = $2", [f.transfer.id, f.reviewRow.id]);
    await exec("UPDATE transactions SET is_reconciled = true WHERE id = $1", [f.transfer.id]);
    await ok(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "ignore" }));
    expect(await reconciled(f.transfer.id)).toBe(true);
  });

  it("keeps the old transaction reconciled when another row still links it, or when it is linked again", async () => {
    const f = await fixture();
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    const reconciled = async (id: number) => (await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [id])).isReconciled;
    // A transfer is matched on both of its links.
    const savingsLink = await createPlaidAccount({ tokenId: f.token.id, plaidAccountId: "pa-savings", name: "S", type: "depository", counterpoiseAccountId: f.savings.id });
    await createPlaidReconciliation({ plaidAccountLinkId: savingsLink.id, plaidTransactionId: "in", date: "2025-03-10", amountCents: -5000, name: "in", resolutionStatus: "matched", matchedTransactionId: f.transfer.id });
    await exec("UPDATE plaid_transaction_reconciliation SET matched_transaction_id = $1 WHERE id = $2", [f.transfer.id, f.reviewRow.id]);
    await exec("UPDATE transactions SET is_reconciled = true WHERE id IN ($1, $2)", [f.transfer.id, f.coffeeLater.id]);
    await ok(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "match", transactionId: f.coffeeSameDay.id }));
    expect(await reconciled(f.transfer.id)).toBe(true);

    // The same transaction again stays reconciled.
    await exec("UPDATE plaid_transaction_reconciliation SET review_reason = 'plaid_modified' WHERE id = $1", [f.reviewRow.id]);
    await ok(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "match", transactionId: f.coffeeSameDay.id }));
    expect(await reconciled(f.coffeeSameDay.id)).toBe(true);
  });

  // The transition table in guides/plaid-sync.md. Each
  // refusal here was a decision that the route applied in any state.
  describe("the transition table", () => {
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    const staged = async (id: number) => row<PlaidTransactionReconciliation>("SELECT * FROM plaid_transaction_reconciliation WHERE id = $1", [id]);
    const idOf = async (plaidTransactionId: string) => Number(await scalar("SELECT id FROM plaid_transaction_reconciliation WHERE plaid_transaction_id = $1", [plaidTransactionId]));
    const flag = (id: number, reason: string | null) =>
      exec("UPDATE plaid_transaction_reconciliation SET review_reason = $1, review_metadata_json = $2 WHERE id = $3", [reason, reason && "{\"event\":\"x\"}", id]);
    const decide = (f: Fixture, reconciliationId: number, body: Record<string, unknown>) =>
      json("POST", { reconciliationId, ...body });
    const pathOf = (f: Fixture) => `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;

    it("refuses Keep local and Unlink on a pending row that the bank removed", async () => {
      const f = await fixture();
      await flag(f.coffeeRow.id, "plaid_removed");
      await expectError(client, pathOf(f), decide(f, f.coffeeRow.id, { action: "keep_local" }), 400, "Keep local does not apply: the bank removed this transaction");
      await expectError(client, pathOf(f), decide(f, f.coffeeRow.id, { action: "unlink" }), 400, "This bank transaction is not linked to a transaction");
      // The flag stays, so the auto-matcher does not take a row that the bank deleted.
      expect(await staged(f.coffeeRow.id)).toMatchObject({ resolutionStatus: "pending", reviewReason: "plaid_removed", reviewMetadataJson: "{\"event\":\"x\"}" });
      // Ignore is the way out.
      expect(await ok(client, pathOf(f), decide(f, f.coffeeRow.id, { action: "ignore" }))).toMatchObject({ resolutionStatus: "ignored", reviewReason: null });
    });

    it("refuses Keep local on a linked row that the bank removed, and Unlink keeps the flag", async () => {
      const f = await fixture();
      await flag(f.reviewRow.id, "plaid_removed");
      await exec("UPDATE transactions SET is_reconciled = true WHERE id = $1", [f.coffeeLater.id]);
      await expectError(client, pathOf(f), decide(f, f.reviewRow.id, { action: "keep_local" }), 400, "Keep local does not apply: the bank removed this transaction");
      expect(await staged(f.reviewRow.id)).toMatchObject({ resolutionStatus: "matched", reviewReason: "plaid_removed", matchedTransactionId: f.coffeeLater.id });
      const unlinked = await ok(client, pathOf(f), decide(f, f.reviewRow.id, { action: "unlink" }));
      expect(unlinked).toMatchObject({ resolutionStatus: "pending", reviewReason: "plaid_removed", matchedTransactionId: null });
      expect((await staged(f.reviewRow.id)).reviewMetadataJson).toBe("{\"event\":\"x\"}");
      expect((await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [f.coffeeLater.id])).isReconciled).toBe(false);
    });

    it("keeps the removed flag when the transaction route unlinks, and clears a modified flag", async () => {
      const f = await fixture();
      const done = await idOf("done");
      await flag(done, "plaid_removed");
      await ok(client, `/api/b/1/transactions/${f.coffeeFar.id}/plaid/unlink`, { method: "POST" });
      expect(await staged(done)).toMatchObject({ resolutionStatus: "pending", reviewReason: "plaid_removed", matchedTransactionId: null, resolvedAt: null });
      await ok(client, `/api/b/1/transactions/${f.coffeeLater.id}/plaid/unlink`, { method: "POST" });
      expect(await staged(f.reviewRow.id)).toMatchObject({ resolutionStatus: "pending", reviewReason: null, reviewMetadataJson: null, matchedTransactionId: null });
    });

    it("refuses every decision on an ignored row", async () => {
      const f = await fixture();
      const ignored = await idOf("ignored");
      const transactions = await count("transactions");
      const refused = "This bank transaction is ignored and cannot be changed";
      for (const body of [
        { action: "match", transactionId: f.coffeeSameDay.id },
        { action: "match_update_amount", transactionId: f.coffeeSameDay.id },
        { action: "create", counterAccountId: f.food.id },
        { action: "ignore" },
        { action: "keep_local" },
        { action: "unlink" },
      ]) {
        await expectError(client, pathOf(f), decide(f, ignored, body), 400, refused);
      }
      expect(await staged(ignored)).toMatchObject({ resolutionStatus: "ignored", matchedTransactionId: null });
      expect(await count("transactions")).toBe(transactions);
      expect((await row<Transaction>("SELECT * FROM transactions WHERE id = $1", [f.coffeeSameDay.id])).isReconciled).toBe(false);
    });

    it("refuses Ignore and Keep local on a linked row with no flag, and allows Unlink", async () => {
      const f = await fixture();
      const done = await idOf("done");
      const linked = `This bank transaction is already linked to transaction #${f.coffeeFar.id} — unlink it first`;
      await expectError(client, pathOf(f), decide(f, done, { action: "ignore" }), 400, linked);
      await expectError(client, pathOf(f), decide(f, done, { action: "keep_local" }), 400, "Keep local applies only to a bank transaction that the bank changed");
      expect(await staged(done)).toMatchObject({ resolutionStatus: "matched", matchedTransactionId: f.coffeeFar.id });
      expect(await ok(client, pathOf(f), decide(f, done, { action: "unlink" }))).toMatchObject({ resolutionStatus: "pending", matchedTransactionId: null });
    });

    it("refuses Keep local and Unlink on a pending row with no flag", async () => {
      const f = await fixture();
      await expectError(client, pathOf(f), decide(f, f.coffeeRow.id, { action: "keep_local" }), 400, "Keep local applies only to a bank transaction that the bank changed");
      await expectError(client, pathOf(f), decide(f, f.coffeeRow.id, { action: "unlink" }), 400, "This bank transaction is not linked to a transaction");
    });

    it("lets Keep local clear the flag of a changed row whose transaction was deleted", async () => {
      const f = await fixture();
      // The delete of a linked transaction sets its row to pending and keeps the flag.
      await ok(client, `/api/b/1/transactions/${f.coffeeLater.id}`, { method: "DELETE" });
      expect(await staged(f.reviewRow.id)).toMatchObject({ resolutionStatus: "pending", reviewReason: "plaid_modified", matchedTransactionId: null });
      expect(await ok(client, pathOf(f), decide(f, f.reviewRow.id, { action: "keep_local" }))).toMatchObject({ resolutionStatus: "pending", reviewReason: null });
    });

    it("cannot store a status that is not one of the four", async () => {
      const f = await fixture();
      // The CHECK of migration 0019 refuses the value, so the route never
      // reads a status that it does not know.
      await expect(
        exec("UPDATE plaid_transaction_reconciliation SET resolution_status = $1 WHERE id = $2", ["bogus", f.coffeeRow.id]),
      ).rejects.toThrow(/CHECK constraint failed/);
      expect((await staged(f.coffeeRow.id)).resolutionStatus).toBe("pending");
    });
  });

  it("records the TypeSafe observation of a decision", async () => {
    const f = await fixture();
    await exec("UPDATE books SET typesafe_reconciliation_enabled = $1, typesafe_revision = $2 WHERE id = $3", [true, 3, 1]);
    const shown = new Date("2025-03-10T00:00:00.000Z");
    const evaluation = async (reconciliationId: number, fingerprint: string, revision = 3) => insert<TypeSafeEvaluation>("typesafe_evaluations", {
      bookId: 1, reconciliationId, linkId: f.checkingLink.id, revision, fingerprint, attempt: fingerprint, status: "ready",
      startedAt: shown, completedAt: shown, displayedAt: shown,
      snapshot: {
        payeeOptions: [{ label: "P1", payeeId: f.coffee.id, name: "Blue Bottle", source: "existing" }],
        categoryOptions: [{ label: "C1", accountId: f.food.id, name: "Food", kind: "expense" }],
      },
      answers: { match: { choice: "none", probabilities: {}, confidence: 1 }, payee: { choice: "P1", probabilities: {}, confidence: 1 }, category: { choice: "C1", probabilities: {}, confidence: 1 } },
    });
    const coffeeEvaluation = await evaluation(f.coffeeRow.id, "coffee");
    await evaluation(f.coffeeRow.id, "old-revision", 2);
    const transferEvaluation = await evaluation(f.transferRow.id, "transfer");
    const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
    await ok(client, path, json("POST", {
      reconciliationId: f.coffeeRow.id, action: "create", counterAccountId: f.food.id, payeeName: " BLUE bottle",
      typesafe: { evaluationId: coffeeEvaluation.id, suggestionVisible: true, activeReviewMs: 1200, acceptedSuggestion: true },
    }));
    await ok(client, path, json("POST", {
      reconciliationId: f.transferRow.id, action: "ignore", transactionId: 7,
      typesafe: { evaluationId: transferEvaluation.id, suggestionVisible: true, activeReviewMs: -1 },
    }));
    // No evaluation of this row: nothing to record.
    await ok(client, path, json("POST", { reconciliationId: f.rentRow.id, action: "ignore" }));
    const decisions = await rows<TypeSafeDecision>("SELECT * FROM typesafe_decisions ORDER BY id");
    expect(decisions.map(({ decidedAt, ...decision }) => ({ ...decision, recent: Math.abs(decidedAt.getTime() - Date.now()) < 60_000 }))).toEqual([
      {
        id: 1, bookId: 1, reconciliationId: f.coffeeRow.id, evaluationId: coffeeEvaluation.id, action: "create", transactionId: null,
        suggestionVisible: true, acceptedSuggestion: false, proposalPayeeKept: true, proposalCategoryKept: true, activeReviewMs: 1200, recent: true,
      },
      {
        id: 2, bookId: 1, reconciliationId: f.transferRow.id, evaluationId: transferEvaluation.id, action: "ignore", transactionId: 7,
        suggestionVisible: false, acceptedSuggestion: false, proposalPayeeKept: null, proposalCategoryKept: null, activeReviewMs: null, recent: true,
      },
    ]);
  });

  describe("a link always joins equal amounts", () => {
    const splitsOf = (transactionId: number) =>
      rows<TransactionSplit>("SELECT * FROM transaction_splits WHERE transaction_id = $1 ORDER BY id", [transactionId]);

    it("changes the amount to the bank amount on a plain match", async () => {
      const f = await fixture();
      const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
      // The bank row is $1,505.00 and the transaction is $1,500.00.
      await ok(client, path, json("POST", { reconciliationId: f.rentRow.id, action: "match", transactionId: f.rentPaid.id }));
      expect((await splitsOf(f.rentPaid.id)).map((split) => [split.accountId, split.amount])).toEqual([
        [f.checking.id, -150500], [f.rent.id, 150500],
      ]);
    });

    it("refuses a match with a different amount that it cannot change", async () => {
      const f = await fixture();
      const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
      const split = await createTransactionWithSplits({
        date: "2025-03-09",
        splits: [{ accountId: f.checking.id, amount: -500 }, { accountId: f.food.id, amount: 300 }, { accountId: f.rent.id, amount: 200 }],
      });
      await expectError(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: split.id }), 400,
        "The amounts are different, and the amount cannot be changed here because the transaction has more than 2 splits. " +
        "Change the amount on this account to the bank amount (-$4.50) first, then match");
      expect((await splitsOf(split.id)).map((s) => s.amount)).toEqual([-500, 300, 200]);
      expect(await scalar("SELECT resolution_status FROM plaid_transaction_reconciliation WHERE id = $1", [f.coffeeRow.id])).toBe("pending");
      // With the amounts equal, the same transaction matches.
      await exec("UPDATE transaction_splits SET amount = amount + 50 WHERE transaction_id = $1 AND account_id = $2", [split.id, f.checking.id]);
      await exec("UPDATE transaction_splits SET amount = amount - 50 WHERE transaction_id = $1 AND account_id = $2", [split.id, f.food.id]);
      await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: split.id }));
    });

    it("refuses Keep when the bank changed the amount", async () => {
      const f = await fixture();
      const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
      await exec("UPDATE plaid_transaction_reconciliation SET amount_cents = 470 WHERE id = $1", [f.reviewRow.id]);
      await expectError(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "keep_local" }), 400,
        "The bank amount is now -$4.70, and Keep cannot keep a link with a different amount. Update the amount to the bank amount, or unlink");
      expect(await scalar("SELECT review_reason FROM plaid_transaction_reconciliation WHERE id = $1", [f.reviewRow.id])).toBe("plaid_modified");
      await ok(client, path, json("POST", { reconciliationId: f.reviewRow.id, action: "match_update_amount", transactionId: f.coffeeLater.id }));
      expect((await splitsOf(f.coffeeLater.id)).map((s) => s.amount)).toEqual([-470, 470]);
    });

    it("refuses a transaction edit that changes a linked amount", async () => {
      const f = await fixture();
      await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`,
        json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: f.coffeeSameDay.id }));
      const edit = (amount: number, counter = f.food.id) => json("PUT", {
        splits: [{ accountId: f.checking.id, amount: -amount }, { accountId: counter, amount }],
      });
      await expectError(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, edit(500), 400,
        "This transaction is linked to a bank transaction for -$4.50. Change the amount on the linked account to that amount, or unlink the bank transaction first");
      expect((await splitsOf(f.coffeeSameDay.id)).map((s) => s.amount)).toEqual([-450, 450]);
      // Another account, the same amount: allowed.
      await ok(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, edit(450, f.rent.id));
      // A link from before this rule: an edit that keeps the amount, or
      // corrects it, is allowed. One that changes it to another wrong amount
      // is refused.
      await exec("UPDATE transaction_splits SET amount = CASE WHEN amount < 0 THEN -460 ELSE 460 END WHERE transaction_id = $1", [f.coffeeSameDay.id]);
      await ok(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, edit(460, f.food.id));
      await expectError(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, edit(470), 400,
        "This transaction is linked to a bank transaction for -$4.50. Change the amount on the linked account to that amount, or unlink the bank transaction first");
      await ok(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, edit(450));
      // An edit that moves the transaction off the linked account cannot be
      // corrected with an amount: the message tells the user to unlink.
      await expectError(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`,
        json("PUT", { splits: [{ accountId: f.rent.id, amount: -450 }, { accountId: f.food.id, amount: 450 }] }), 400,
        "This transaction is linked to a bank transaction for -$4.50 on the account that the edit removes. Unlink the bank transaction first, or keep a split on that account");
    });

    it("refuses a rewrite that would break the transfer's link on its other account", async () => {
      const f = await fixture();
      const savingsLink = await createPlaidAccount({
        tokenId: f.token.id, plaidAccountId: "pa-savings", name: "pa-savings", type: "depository", counterpoiseAccountId: f.savings.id,
      });
      // The withdrawal is matched on checking: $50.00 = $50.00.
      await ok(client, `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`,
        json("POST", { reconciliationId: f.transferRow.id, action: "match", transactionId: f.transfer.id }));
      // The deposit at the bank is $50.10.
      const deposit = await createPlaidReconciliation({
        plaidAccountLinkId: savingsLink.id, plaidTransactionId: "deposit", date: "2025-03-10", amountCents: -5010, name: "Deposit",
      });
      const refusal =
        "The amounts are different, and this transaction is also linked to a bank transaction for -$50.00 on its other account. " +
        "Changing the amount would break that link. Unlink it first, or match another transaction";
      for (const action of ["match", "match_update_amount"]) {
        await expectError(client, `/api/b/1/sync/accounts/${savingsLink.id}/reconcile`,
          json("POST", { reconciliationId: deposit.id, action, transactionId: f.transfer.id }), 400, refusal);
      }
      expect((await splitsOf(f.transfer.id)).map((s) => s.amount)).toEqual([-5000, 5000]);
      expect(await scalar("SELECT resolution_status FROM plaid_transaction_reconciliation WHERE id = $1", [deposit.id])).toBe("pending");
    });

    it("leaves out a bank account with no Counterpoise account", async () => {
      const f = await fixture();
      // The "done" row links coffeeFar with a different amount.
      await exec("UPDATE plaid_accounts SET counterpoise_account_id = NULL WHERE id = $1", [f.checkingLink.id]);
      expect((await ok(client, "/api/b/1/sync/stale-unmatched")).mismatchedLinks).toEqual([]);
      await ok(client, `/api/b/1/transactions/${f.coffeeFar.id}`, json("PUT", {
        splits: [{ accountId: f.checking.id, amount: -999 }, { accountId: f.food.id, amount: 999 }],
      }));
    });

    it("compares the total on the linked account for a candidate", async () => {
      const f = await fixture();
      const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
      const twoLegs = await createTransactionWithSplits({
        date: "2025-03-09",
        splits: [{ accountId: f.checking.id, amount: -300 }, { accountId: f.checking.id, amount: -150 }, { accountId: f.food.id, amount: 450 }],
      });
      const queue = await ok(client, path);
      const item = queue.items.find((entry: { id: number }) => entry.id === f.coffeeRow.id);
      const candidate = item.candidates.find((entry: { transactionId: number }) => entry.transactionId === twoLegs.id);
      expect([candidate.linkedSplitAmount, candidate.amountDelta]).toEqual([-450, 0]);
      await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: twoLegs.id }));
      expect((await splitsOf(twoLegs.id)).map((s) => s.amount)).toEqual([-300, -150, 450]);
    });

    // A link records the account that it was made on. A remap of the bank
    // account to another account must not make the old links "no split".
    it("compares a link on its own account after the bank account is remapped", async () => {
      const f = await fixture();
      const path = `/api/b/1/sync/accounts/${f.checkingLink.id}/reconcile`;
      await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "match", transactionId: f.coffeeSameDay.id }));
      expect(await scalar("SELECT linked_account_id FROM plaid_transaction_reconciliation WHERE id = $1", [f.coffeeRow.id])).toBe(f.checking.id);

      const newChecking = await createAccount({ name: "New Checking", type: "asset", subtype: "bank" });
      await exec("UPDATE plaid_accounts SET counterpoise_account_id = $1 WHERE id = $2", [newChecking.id, f.checkingLink.id]);
      const mismatched = (await ok(client, "/api/b/1/sync/stale-unmatched")).mismatchedLinks;
      expect(mismatched.filter((entry: { transactionId: number }) => entry.transactionId === f.coffeeSameDay.id)).toEqual([]);
      // The edit check still protects the link, on the old account.
      await expectError(client, `/api/b/1/transactions/${f.coffeeSameDay.id}`, json("PUT", {
        splits: [{ accountId: f.checking.id, amount: -500 }, { accountId: f.food.id, amount: 500 }],
      }), 400, "This transaction is linked to a bank transaction for -$4.50. Change the amount on the linked account to that amount, or unlink the bank transaction first");

      // Unlink clears the stored account.
      await ok(client, path, json("POST", { reconciliationId: f.coffeeRow.id, action: "unlink" }));
      expect(await scalar("SELECT linked_account_id FROM plaid_transaction_reconciliation WHERE id = $1", [f.coffeeRow.id])).toBeNull();
    });

    it("lists the links whose amounts are different", async () => {
      const f = await fixture();
      // The fixture's "done" row (bank $1.00) links coffeeFar ($4.50).
      expect((await ok(client, "/api/b/1/sync/stale-unmatched")).mismatchedLinks).toEqual([
        { transactionId: f.coffeeFar.id, accountId: f.checking.id, bankAmount: -100, linkedAmount: -450 },
      ]);
      await exec("UPDATE plaid_transaction_reconciliation SET amount_cents = 450 WHERE plaid_transaction_id = 'done'", []);
      expect((await ok(client, "/api/b/1/sync/stale-unmatched")).mismatchedLinks).toEqual([]);
      await exec("UPDATE plaid_transaction_reconciliation SET amount_cents = 447 WHERE plaid_transaction_id = 'done'", []);
      expect((await ok(client, "/api/b/1/sync/stale-unmatched")).mismatchedLinks).toEqual([
        { transactionId: f.coffeeFar.id, accountId: f.checking.id, bankAmount: -447, linkedAmount: -450 },
      ]);
    });
  });
});

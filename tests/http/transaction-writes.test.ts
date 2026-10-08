import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDateString } from "../../lib/formatters";
import {
  addBookMember, createAccount, createBook, createPayee, createPlaidAccount, createPlaidReconciliation,
  createPlaidToken, createSecurity, createTransactionWithSplits, createUser, resetTestDatabase,
  setupTestDatabase,
} from "../helpers/db-utils";
import { exec, row, rows } from "../helpers/sql";
import type { PlaidTransactionReconciliation } from "../../types/db";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

type TransactionBody = {
  id: number;
  updatedAt: string;
  payeeId: number | null;
  splits: { accountId: number; amount: number }[];
  investmentSplits: { accountId: number | null; sharesMicros: number }[];
  [field: string]: unknown;
};
const transactionSchema = contract<TransactionBody>("Transaction");

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Timestamps and today's date differ between runs, so snapshots replace them. */
function normalized(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(toDateString(new Date()), "<today>")
      .replace(/"(createdAt|updatedAt|resolvedAt)":"[^"]+"/g, '"$1":"<timestamp>"')
  );
}

/** The derived lot rows, which the server rebuilds with each write. */
async function lotRows() {
  return normalized({
    lots: await rows("SELECT * FROM investment_lots ORDER BY id"),
    allocations: await rows("SELECT * FROM investment_lot_allocations ORDER BY id"),
  });
}

// Transaction CRUD: the create and update rules, the conflict check, the
// Plaid reset on delete, and the lot rebuild in the same transaction. Full
// bodies and lot rows are snapshots, recorded while Node and Rust wrote the
// same rows.
describe("transaction write HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  let a: Record<string, number>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const cash = await createAccount({ name: "Wallet", type: "asset", subtype: "cash" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const brokerageCash = await createAccount({
      name: "Brokerage Cash", type: "asset", subtype: "cash", parentId: brokerage.id, isInvestmentCash: true,
    });
    const dividends = await createAccount({ name: "Dividends", type: "income" });
    const vti = await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf" });
    const ikea = await createPayee({ name: "IKEA" });
    const other = await createBook({ name: "Other" });
    const otherAccount = await createAccount({ name: "Other", type: "asset", bookId: other.id });
    const otherSecurity = await createSecurity({ name: "Other", symbol: "OTH", securityType: "stock", bookId: other.id });
    const otherTransaction = await createTransactionWithSplits({
      date: "2025-01-01", bookId: other.id,
      splits: [{ accountId: otherAccount.id, amount: 1 }, { accountId: otherAccount.id, amount: -1 }],
    });
    a = {
      checking: checking.id, cash: cash.id, groceries: groceries.id, brokerage: brokerage.id,
      brokerageCash: brokerageCash.id, dividends: dividends.id, vti: vti.id, ikea: ikea.id,
      otherAccount: otherAccount.id, otherSecurity: otherSecurity.id, otherTransaction: otherTransaction.id,
    };
  });
  afterAll(async () => { await stop?.(); });

  const spend = (amount = 500, from = () => a.checking) => [
    { accountId: from(), amount: -amount }, { accountId: a.groceries, amount },
  ];

  async function ok(path: string, init?: RequestInit) {
    const response = await client.request(path, init);
    expect(response.status, `${init?.method ?? "GET"} ${path}`).toBe(200);
    return response.json();
  }

  async function expectError(path: string, init: RequestInit, status: number, message: string) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method ?? "GET"} ${path} ${String(init.body)}`).toBe(status);
    expect(await response.json(), String(init.body)).toEqual({ error: message });
  }

  async function create(body: Record<string, unknown>) {
    return transactionSchema.parse(await ok("/api/b/1/transactions", json("POST", body)));
  }

  it("creates a transaction with the Node field defaults and resolves the payee", async () => {
    const created = await create({
      date: "2025-03-01", description: "", notes: "", payeeName: "  Corner  Store’s ",
      checkNumber: " 101 ", isFloating: true, splits: spend(), bookId: 99, id: 5,
    });
    expect(created).toMatchObject({
      bookId: 1, description: null, notes: "", checkNumber: "101", isFloating: true,
      isReconciled: false, createdBy: 1, updatedBy: 1, payee: { name: "Corner Store's" },
    });
    expect(normalized(created)).toMatchSnapshot();

    const reused = await create({ date: "2025-03-02", payeeName: "ikea", isReconciled: true, splits: spend() });
    expect(reused.payeeId).toBe(a.ikea);
    const blank = await create({ date: "2025-03-03", payeeName: " ﻿ ", splits: spend() });
    expect(blank.payee).toBeNull();
    expect(await rows("SELECT * FROM payees")).toHaveLength(2);
  });

  it("creates investment splits on the derived account and rebuilds the lots", async () => {
    const buy = await create({
      date: "2025-01-10", description: "Buy",
      splits: [{ accountId: a.brokerage, amount: 10_005 }, { accountId: a.checking, amount: -10_005 }],
      investmentSplits: [{ securityId: a.vti, action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000, feesCents: 5 }],
    });
    expect(buy.investmentSplits[0].accountId).toBe(a.brokerage);
    const dividend = await create({
      date: "2025-02-10", description: "Dividend",
      splits: [{ accountId: a.brokerageCash, amount: 500 }, { accountId: a.dividends, amount: -500 }],
      investmentSplits: [{ securityId: a.vti, action: "dividend", sharesMicros: 0, priceMicros: 0 }],
    });
    // The investment-cash leg resolves to its brokerage parent.
    expect(dividend.investmentSplits[0].accountId).toBe(a.brokerage);
    const split = await create({
      date: "2025-03-10", description: "Split",
      splits: [{ accountId: a.brokerage, amount: 0 }, { accountId: a.brokerage, amount: 0 }],
      investmentSplits: [{ securityId: a.vti, action: "split", sharesMicros: 0, priceMicros: 0, splitNumerator: 2, splitDenominator: 1 }],
    });
    expect(split.investmentSplits[0].accountId).toBeNull();
    const sell = await create({
      date: "2025-04-10", description: "Sell",
      splits: [{ accountId: a.checking, amount: 3_000 }, { accountId: a.brokerage, amount: -3_000 }],
      investmentSplits: [{ securityId: a.vti, action: "sell", sharesMicros: 1_000_000, priceMicros: 30_000_000 }],
    });
    expect(normalized({ buy, dividend, split, sell })).toMatchSnapshot();
    expect(await lotRows()).toMatchSnapshot();
  });

  it("refuses invalid creates with the Node bodies and writes nothing", async () => {
    const buy = { securityId: a.vti, action: "buy", sharesMicros: 1_000_000, priceMicros: 10_000_000 };
    const brokerageSplits = [{ accountId: a.brokerage, amount: 1_000 }, { accountId: a.checking, amount: -1_000 }];
    const cases: Array<[unknown, number, string]> = [
      [null, 400, "Date and at least 2 splits are required, even for stock splits"],
      [[], 400, "Date and at least 2 splits are required, even for stock splits"],
      [{}, 400, "Date must be in YYYY-MM-DD format"],
      [{ date: "2025-02-30", splits: spend() }, 400, "Date must be in YYYY-MM-DD format"],
      // Zod accepts year 0099; isValidDateString does not.
      [{ date: "0099-01-01", splits: spend() }, 400, "Date must be in YYYY-MM-DD format"],
      [{ date: "2025-01-01", splits: [spend()[0]] }, 400, "Date and at least 2 splits are required, even for stock splits"],
      [{ date: "2025-01-01", splits: [{ accountId: "1", amount: 1 }] }, 400, "Invalid input: expected number, received string"],
      [{ date: "2025-01-01", splits: spend(), description: 5 }, 400, "Invalid input: expected string, received number"],
      [{ date: "2025-01-01", splits: spend(), checkNumber: 7 }, 400, "checkNumber must be a string when provided"],
      [{ date: "2025-01-01", splits: spend(), investmentSplits: {} }, 400, "investmentSplits must be an array when provided"],
      [{ date: "2025-01-01", splits: spend(), investmentSplits: [{ ...buy, action: "hold" }] }, 400, 'Invalid option: expected one of "buy"|"sell"|"dividend"|"capGain"|"fee"|"split"'],
      [{ date: "2025-01-01", splits: [{ accountId: a.checking, amount: 5 }, { accountId: a.groceries, amount: -4 }] }, 400, "Transaction splits must sum to zero (debits = credits)"],
      [{ date: "2025-01-01", splits: spend(3_000_000_000) }, 400, "Transaction splits must sum to zero (debits = credits)"],
      [{ date: "2025-01-01", splits: spend(500, () => a.otherAccount) }, 400, "One or more split accounts do not belong to this book"],
      [{ date: "2025-01-01", splits: spend(500, () => 99_999_999_999) }, 500, "Failed to create transaction"],
      [{ date: "2025-01-01", splits: spend(500, () => a.cash), checkNumber: "12" }, 400, "Check number can only be set for transactions involving bank accounts"],
      [{ date: "2025-01-01", splits: spend(500, () => a.cash), checkNumber: "  " }, 200, ""],
      [{ date: "2025-01-01", splits: brokerageSplits }, 400, "Investment transactions require investmentSplits"],
      [{ date: "2025-01-01", splits: brokerageSplits, investmentSplits: [] }, 400, "Investment transactions require investmentSplits"],
      [{ date: "2025-01-01", splits: brokerageSplits, investmentSplits: [{ ...buy, action: "split" }] }, 400, "Invalid investment split values"],
      [{ date: "2025-01-01", splits: brokerageSplits, investmentSplits: [{ ...buy, priceMicros: 0 }] }, 400, "Invalid investment actions"],
      [{ date: "2025-01-01", splits: brokerageSplits, investmentSplits: [{ ...buy, securityId: a.otherSecurity }] }, 400, "One or more investment split securities do not belong to this book"],
      [{ date: "2025-01-01", splits: brokerageSplits, investmentSplits: [{ ...buy, securityId: 99_999_999_999 }] }, 500, "Failed to create transaction"],
      [{ date: "2025-01-01", splits: spend(1_000), investmentSplits: [buy] }, 400, "Investment splits require a transaction split on an investment account"],
      // Valid until the insert, which PostgreSQL refuses; the payee rolls back.
      [{ date: "2025-01-01", payeeName: "Rolled Back", splits: brokerageSplits, investmentSplits: [{ ...buy, action: "split", splitNumerator: 3_000_000_000, splitDenominator: 1 }] }, 500, "Failed to create transaction"],
    ];
    for (const [body, status, message] of cases) {
      if (status === 200) {
        expect((await create(body as Record<string, unknown>)).checkNumber).toBeNull();
        continue;
      }
      await expectError("/api/b/1/transactions", json("POST", body), status, message);
    }
    await expectError("/api/b/1/transactions", { method: "POST", body: "{" }, 500, "Failed to create transaction");
    expect(await rows("SELECT * FROM transactions WHERE book_id = $1", [1])).toHaveLength(1);
    expect(await rows("SELECT * FROM payees WHERE name = $1", ["Rolled Back"])).toHaveLength(0);
  });

  it("reads one transaction by a parseInt ID", async () => {
    const created = await create({ date: "2025-01-01", payeeName: "IKEA", splits: spend() });
    const read = transactionSchema.parse(await ok(`/api/b/1/transactions/${created.id}`));
    expect(read).toEqual(created);
    // parseInt without a radix reads hexadecimal and ignores a trailing tail.
    expect(await ok(`/api/b/1/transactions/0x${created.id.toString(16)}`)).toEqual(created);
    expect(await ok(`/api/b/1/transactions/${created.id}abc`)).toEqual(created);
    for (const [id, status, message] of [
      ["999999", 404, "Transaction not found"],
      [String(a.otherTransaction), 404, "Transaction not found"],
      ["abc", 500, "Failed to fetch transaction"],
      ["99999999999", 500, "Failed to fetch transaction"],
    ] as const) {
      await expectError(`/api/b/1/transactions/${id}`, {}, status, message);
    }
  });

  it("updates fields, the payee, and the splits, and stamps updatedBy", async () => {
    const created = await create({
      date: "2025-01-01", description: "Old", notes: "note", checkNumber: "7", payeeName: "Store", splits: spend(),
    });
    const path = `/api/b/1/transactions/${created.id}`;
    const updated = transactionSchema.parse(await ok(path, json("PUT", {
      date: "2025-01-05", description: "", notes: null, checkNumber: "  ", payeeName: "ikea",
      isReconciled: true, isFloating: false, splits: spend(900, () => a.cash), bookId: 2,
    })));
    expect(updated).toMatchObject({
      date: "2025-01-05", description: "", notes: null, checkNumber: null, payeeId: a.ikea,
      isReconciled: true, updatedBy: 1,
    });
    expect(updated.splits.map((split) => [split.accountId, split.amount])).toEqual([[a.cash, -900], [a.groceries, 900]]);
    expect(normalized(updated)).toMatchSnapshot();
    expect((await ok(path, json("PUT", { payeeName: "" }))).payeeId).toBeNull();
    await ok(path, json("PUT", { payeeName: "IKEA" }));
    expect((await ok(path, json("PUT", { payeeName: null }))).payee).toBeNull();
    // A single-field body leaves every other field alone.
    const reconciled = await ok(path, json("PUT", { isReconciled: false }));
    expect(reconciled).toMatchObject({ date: "2025-01-05", description: "", isReconciled: false });
  });

  it("replaces and clears investment splits and rebuilds lots after a date change", async () => {
    const buy = await create({
      date: "2025-01-10",
      splits: [{ accountId: a.brokerage, amount: 10_000 }, { accountId: a.checking, amount: -10_000 }],
      investmentSplits: [{ securityId: a.vti, action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000 }],
    });
    const sell = await create({
      date: "2025-04-10",
      splits: [{ accountId: a.checking, amount: 6_000 }, { accountId: a.brokerage, amount: -6_000 }],
      investmentSplits: [{ securityId: a.vti, action: "sell", sharesMicros: 1_000_000, priceMicros: 60_000_000 }],
    });
    // Moving the sell before the buy leaves it with no lot to consume.
    await ok(`/api/b/1/transactions/${sell.id}`, json("PUT", { date: "2025-01-01" }));
    const movedLots = await lotRows();
    expect(movedLots).toMatchSnapshot();
    // Brokerage splits with no new investment splits keep the existing ones.
    await ok(`/api/b/1/transactions/${buy.id}`, json("PUT", {
      splits: [{ accountId: a.brokerage, amount: 12_000 }, { accountId: a.checking, amount: -12_000 }],
    }));
    const replaced = transactionSchema.parse(await ok(`/api/b/1/transactions/${buy.id}`, json("PUT", {
      investmentSplits: [{ securityId: a.vti, action: "buy", sharesMicros: 3_000_000, priceMicros: 40_000_000 }],
    })));
    expect(replaced.investmentSplits.map((split) => [split.accountId, split.sharesMicros])).toEqual([[a.brokerage, 3_000_000]]);
    expect(await lotRows()).toMatchSnapshot();
    const cleared = await ok(`/api/b/1/transactions/${buy.id}`, json("PUT", { investmentSplits: [] }));
    expect(cleared.investmentSplits).toEqual([]);
    expect(await lotRows()).toMatchSnapshot();
  });

  it("refuses invalid updates with the Node bodies", async () => {
    const created = await create({ date: "2025-01-01", splits: spend(500, () => a.cash) });
    const single = await createTransactionWithSplits({ date: "2025-01-01", splits: [{ accountId: a.brokerage, amount: 0 }] });
    const noInvestments = await createTransactionWithSplits({ date: "2025-01-01", splits: spend() });
    const path = `/api/b/1/transactions/${created.id}`;
    const dividend = { securityId: a.vti, action: "dividend", sharesMicros: 0, priceMicros: 0 };
    const cases: Array<[string, unknown, number, string]> = [
      [path, null, 400, "Invalid input: expected object, received null"],
      [path, { splits: [] }, 400, "At least 2 splits are required, even for stock splits"],
      [path, { date: "2025-13-01" }, 400, "Date must be in YYYY-MM-DD format"],
      [path, { date: "0001-01-01" }, 400, "Date must be in YYYY-MM-DD format"],
      [path, { notes: 5 }, 400, "Invalid input: expected string, received number"],
      [path, { checkNumber: null }, 400, "checkNumber must be a string when provided"],
      [path, { expectedUpdatedAt: "2025-01-01" }, 400, "expectedUpdatedAt must be an ISO timestamp"],
      [path, { splits: spend(4, () => a.checking).map((split, index) => ({ ...split, amount: split.amount + index })) }, 400, "Transaction splits must sum to zero (debits = credits)"],
      [path, { checkNumber: "12" }, 400, "Check number can only be set for transactions involving bank accounts"],
      [path, { splits: spend(500, () => a.otherAccount) }, 400, "One or more split accounts do not belong to this book"],
      [path, { splits: spend(500, () => 99_999_999_999) }, 500, "Failed to update transaction"],
      [path, { splits: [{ accountId: a.brokerage, amount: 1 }, { accountId: a.checking, amount: -1 }] }, 400, "Investment transactions require investmentSplits"],
      [path, { investmentSplits: [{ ...dividend, securityId: a.otherSecurity }] }, 400, "One or more investment split securities do not belong to this book"],
      [`/api/b/1/transactions/${single.id}`, { investmentSplits: [dividend] }, 400, "At least 2 splits are required, even for stock splits"],
      [`/api/b/1/transactions/${noInvestments.id}`, { investmentSplits: [{ ...dividend, action: "buy", sharesMicros: 1_000_000, priceMicros: 1_000_000 }] }, 400, "Investment splits require a transaction split on an investment account"],
      // A missing row: 404 without a split write, 500 when the split insert
      // fails its foreign key.
      ["/api/b/1/transactions/999999", { description: "x" }, 404, "Transaction not found"],
      ["/api/b/1/transactions/999999", { expectedUpdatedAt: "2025-01-01T00:00:00Z" }, 404, "Transaction not found"],
      ["/api/b/1/transactions/999999", { splits: spend() }, 500, "Failed to update transaction"],
      ["/api/b/1/transactions/999999", { checkNumber: "5" }, 400, "Check number can only be set for transactions involving bank accounts"],
      [`/api/b/1/transactions/${a.otherTransaction}`, { description: "x" }, 404, "Transaction not found"],
      [`/api/b/1/transactions/${a.otherTransaction}`, { splits: spend() }, 500, "Failed to update transaction"],
      // The body is validated before an unusable ID fails at the database.
      ["/api/b/1/transactions/abc", { date: "x" }, 400, "Date must be in YYYY-MM-DD format"],
      ["/api/b/1/transactions/abc", { description: "x" }, 500, "Failed to update transaction"],
      ["/api/b/1/transactions/99999999999", {}, 500, "Failed to update transaction"],
    ];
    for (const [target, body, status, message] of cases) {
      await expectError(target, json("PUT", body), status, message);
    }
    await expectError(path, { method: "PUT", body: "[" }, 500, "Failed to update transaction");
    expect(await ok(path)).toMatchObject({ date: "2025-01-01", checkNumber: null, notes: null });
    expect(await rows("SELECT * FROM payees")).toHaveLength(1);
  });

  it("checks expectedUpdatedAt on update and delete", async () => {
    const created = await create({ date: "2025-01-01", splits: spend() });
    const path = `/api/b/1/transactions/${created.id}`;
    const loaded = await ok(path, json("PUT", { expectedUpdatedAt: created.updatedAt, description: "First" }));
    expect(loaded.description).toBe("First");
    await expectError(path, json("PUT", { expectedUpdatedAt: created.updatedAt, description: "Stale" }), 409,
      "Another user changed this transaction. Showing the latest version.");
    await expectError(`${path}?expectedUpdatedAt=${encodeURIComponent(created.updatedAt)}`, { method: "DELETE" }, 409,
      "Another user changed this transaction. Showing the latest version.");
    for (const value of ["", "2025-01-01", "2025-01-01T00:00:00+00:00"]) {
      await expectError(`${path}?expectedUpdatedAt=${encodeURIComponent(value)}`, { method: "DELETE" }, 400,
        "expectedUpdatedAt must be an ISO timestamp");
    }
    // Extra fraction digits are truncated, as JavaScript Date parsing does.
    const precise = loaded.updatedAt.replace("Z", "999Z");
    expect(await ok(`${path}?expectedUpdatedAt=${precise}`, { method: "DELETE" })).toEqual({ success: true });
    await expectError(path, {}, 404, "Transaction not found");
  });

  it("deletes a transaction, resets Plaid rows, and rebuilds lots", async () => {
    const buy = await create({
      date: "2025-01-10",
      splits: [{ accountId: a.brokerage, amount: 10_000 }, { accountId: a.checking, amount: -10_000 }],
      investmentSplits: [{ securityId: a.vti, action: "buy", sharesMicros: 2_000_000, priceMicros: 50_000_000 }],
    });
    await create({
      date: "2025-04-10",
      splits: [{ accountId: a.checking, amount: 6_000 }, { accountId: a.brokerage, amount: -6_000 }],
      investmentSplits: [{ securityId: a.vti, action: "sell", sharesMicros: 1_000_000, priceMicros: 60_000_000 }],
    });
    const token = await createPlaidToken({ financialInstitution: "Bank", itemId: "item", accessToken: "token" });
    const link = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "pa", name: "Plaid", type: "depository", counterpoiseAccountId: a.checking });
    const matched = await createPlaidReconciliation({
      plaidAccountLinkId: link.id, plaidTransactionId: "matched", date: "2025-01-10", amountCents: -10_000,
      name: "Buy", resolutionStatus: "matched", matchedTransactionId: buy.id,
    });
    const stranded = await createPlaidReconciliation({
      plaidAccountLinkId: link.id, plaidTransactionId: "stranded", date: "2025-01-10", amountCents: -1,
      name: "Stranded", resolutionStatus: "matched", matchedTransactionId: null,
    });

    expect(await ok(`/api/b/1/transactions/${buy.id}`, { method: "DELETE" })).toEqual({ success: true });
    await expectError(`/api/b/1/transactions/${buy.id}`, {}, 404, "Transaction not found");
    expect(await rows("SELECT * FROM transaction_splits WHERE transaction_id = $1", [buy.id])).toEqual([]);
    const reconciliations = await rows<PlaidTransactionReconciliation>(
      "SELECT * FROM plaid_transaction_reconciliation ORDER BY id",
    );
    expect(reconciliations.map((row) => [row.id, row.resolutionStatus, row.matchedTransactionId, row.resolvedAt])).toEqual([
      [matched.id, "pending", null, null], [stranded.id, "pending", null, null],
    ]);
    // The sell now has no lot to consume.
    expect(await lotRows()).toMatchSnapshot();

    // A missing row is a 404, but the sweep still commits.
    await exec("UPDATE plaid_transaction_reconciliation SET resolution_status = $1 WHERE id = $2", ["matched", stranded.id]);
    for (const [id, status, message] of [
      ["999999", 404, "Transaction not found"],
      [String(a.otherTransaction), 404, "Transaction not found"],
      ["abc", 500, "Failed to delete transaction"],
      ["99999999999", 500, "Failed to delete transaction"],
    ] as const) {
      await expectError(`/api/b/1/transactions/${id}`, { method: "DELETE" }, status, message);
    }
    const swept = await row<PlaidTransactionReconciliation>(
      "SELECT * FROM plaid_transaction_reconciliation WHERE id = $1", [stranded.id],
    );
    expect(swept.resolutionStatus).toBe("pending");
    // The query string is validated before an unusable ID fails.
    await expectError("/api/b/1/transactions/abc?expectedUpdatedAt=x", { method: "DELETE" }, 400,
      "expectedUpdatedAt must be an ISO timestamp");
    await expectError("/api/b/1/transactions/999999?expectedUpdatedAt=2025-01-01T00:00:00Z", { method: "DELETE" }, 404,
      "Transaction not found");
  });

  it("answers 404 for a book of which the user is not a member", async () => {
    const stranger = await createUser({ username: "stranger" });
    const book = await createBook({ name: "Private", userId: stranger.id });
    const buy = { securityId: a.vti, action: "buy", sharesMicros: 1_000_000, priceMicros: 1_000_000 };
    await expectError(`/api/b/${book.id}/transactions`, json("POST", { date: "2025-01-01", splits: spend(), investmentSplits: [buy] }), 404, "Book not found");
    await expectError(`/api/b/${book.id}/transactions/1`, json("PUT", { investmentSplits: [buy] }), 404, "Book not found");
  });

  it("lets a viewer read and refuses a viewer's writes", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const account = await createAccount({ name: "A", type: "asset", bookId: shared.id });
    const expense = await createAccount({ name: "B", type: "expense", bookId: shared.id });
    const transaction = await createTransactionWithSplits({
      date: "2025-01-01", bookId: shared.id,
      splits: [{ accountId: account.id, amount: -1 }, { accountId: expense.id, amount: 1 }],
    });
    expect(await ok(`/api/b/${shared.id}/transactions`)).toHaveLength(1);
    expect((await ok(`/api/b/${shared.id}/transactions/${transaction.id}`)).id).toBe(transaction.id);
    const denied = "You have read-only access to this book";
    await expectError(`/api/b/${shared.id}/transactions`, json("POST", {}), 403, denied);
    await expectError(`/api/b/${shared.id}/transactions/${transaction.id}`, json("PUT", {}), 403, denied);
    await expectError(`/api/b/${shared.id}/transactions/${transaction.id}`, { method: "DELETE" }, 403, denied);
    await expectError("/api/b/99999999999/transactions", json("POST", {}), 500, "Failed to create transaction");
    expect((await client.anonymous("/api/b/1/transactions", json("POST", {}))).status).toBe(401);
  });
});

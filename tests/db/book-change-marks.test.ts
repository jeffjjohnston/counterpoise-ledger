import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount,
  createPlaidAccount,
  createPlaidReconciliation,
  createPlaidToken,
  createTransactionWithSplits,
  resetTestDatabase,
  setupTestDatabase,
} from "@/tests/helpers/db-utils";
import { exec, rows, scalar, transaction } from "@/tests/helpers/sql";

/**
 * The live-update hints. A trigger on each table that an open page shows adds
 * one to `change_marks` for each (book, table) that a write touches. The
 * server reads the counters and tells the page which tables changed. These
 * cases hold the triggers to the rules that the server depends on.
 */

type Marks = Map<string, number>;

async function marks(): Promise<Marks> {
  const all = await rows<{ bookId: number; tableName: string; version: number }>(
    "SELECT book_id, table_name, version FROM change_marks"
  );
  return new Map(all.map((m) => [`${m.bookId}:${m.tableName}`, m.version]));
}

/** The (book, table) keys whose counter moved since `before`, sorted. */
async function changedSince(before: Marks): Promise<string[]> {
  const after = await marks();
  return [...after]
    .filter(([key, version]) => version !== (before.get(key) ?? 0))
    .map(([key]) => key)
    .sort();
}

const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

describe("book change marks", () => {
  beforeAll(setupTestDatabase);
  beforeEach(resetTestDatabase);

  it("counts committed changes and keeps no count for a rolled back write", async () => {
    let before = await marks();
    await exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
      INSERT INTO transactions (book_id, date, created_at, updated_at)
      SELECT 1, '2026-09-20', ${NOW}, ${NOW} FROM n`);
    expect(await changedSince(before)).toEqual(["1:transactions"]);

    before = await marks();
    await expect(transaction(async (tx) => {
      await tx.exec("UPDATE transactions SET description = 'rolled back'");
      throw new Error("deliberate rollback after write");
    })).rejects.toThrow("deliberate rollback after write");
    expect(await changedSince(before)).toEqual([]);
    expect(await scalar("SELECT COUNT(*) FROM transactions WHERE description IS NOT NULL")).toBe(0);
  });

  it("marks both books on a move and the old book on deletion", async () => {
    await exec(`INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (2, 1, 'Other book', ${NOW}, ${NOW})`);
    await exec(`INSERT INTO transactions (book_id, date, created_at, updated_at) VALUES (1, '2026-09-20', ${NOW}, ${NOW})`);
    let before = await marks();
    await exec("UPDATE transactions SET book_id = 2");
    expect(await changedSince(before)).toEqual(["1:transactions", "2:transactions"]);
    before = await marks();
    await exec("DELETE FROM transactions");
    expect(await changedSince(before)).toEqual(["2:transactions"]);
  });

  it("marks child-only split and Plaid queue and account changes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });
    await createTransactionWithSplits({ date: "2026-09-20", splits: [
      { accountId: checking.id, amount: -100 }, { accountId: expense.id, amount: 100 },
    ] });
    const token = await createPlaidToken({ financialInstitution: "Test", itemId: "item", accessToken: "synthetic" });
    const account = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "account", name: "Checking", type: "depository", counterpoiseAccountId: checking.id });
    await createPlaidReconciliation({ plaidAccountLinkId: account.id, plaidTransactionId: "pending", date: "2026-09-20", amountCents: 100, name: "Pending" });

    let before = await marks();
    await exec("UPDATE transaction_splits SET amount = amount * 2 WHERE book_id = 1");
    expect(await changedSince(before)).toEqual(["1:transaction_splits"]);
    before = await marks();
    await exec("UPDATE plaid_transaction_reconciliation SET resolution_status = 'ignored' WHERE book_id = 1");
    expect(await changedSince(before)).toEqual(["1:plaid_transaction_reconciliation"]);
    before = await marks();
    await exec("UPDATE plaid_accounts SET counterpoise_account_id = NULL WHERE book_id = 1");
    expect(await changedSince(before)).toEqual(["1:plaid_accounts"]);
  });

  it("marks the book for its settings and its owner row", async () => {
    let before = await marks();
    await exec(`INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (2, 1, 'Other book', ${NOW}, ${NOW})`);
    expect(await changedSince(before)).toEqual(["2:book_members", "2:books"]);

    before = await marks();
    await exec("UPDATE books SET upcoming_days = 60 WHERE id = 2");
    expect(await changedSince(before)).toEqual(["2:books"]);

    before = await marks();
    await expect(transaction(async (tx) => {
      await tx.exec("UPDATE books SET upcoming_days = 90 WHERE id = 2");
      throw new Error("rolled back settings");
    })).rejects.toThrow("rolled back settings");
    expect(await changedSince(before)).toEqual([]);
    expect(await scalar("SELECT upcoming_days FROM books WHERE id = 2")).toBe(60);

    before = await marks();
    await exec("DELETE FROM books WHERE id = 2");
    expect(await changedSince(before)).toEqual(["2:book_members", "2:books"]);
  });

  it("installs insert, update and delete marks on every table a page shows", async () => {
    const triggers = await rows<{ tblName: string; name: string }>(
      "SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_mark' ESCAPE '\\' ORDER BY tbl_name, name"
    );
    const tables = [
      "accounts", "book_members", "books", "investment_lots", "investment_splits", "payees", "plaid_accounts",
      "plaid_transaction_reconciliation", "recurring_rules", "recurring_template_splits",
      "securities", "security_prices", "transaction_splits", "transactions",
    ];
    expect(triggers).toEqual(
      tables.flatMap((table) =>
        ["delete", "insert", "update"].map((op) => ({ tblName: table, name: `${table}_${op}_mark` }))
      )
    );
  });
});

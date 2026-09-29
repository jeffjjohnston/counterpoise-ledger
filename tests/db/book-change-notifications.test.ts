import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, resetTestDatabase, createAccount, createTransactionWithSplits, createPlaidToken, createPlaidAccount, createPlaidReconciliation } from "@/tests/helpers/db";
import { workerDatabaseUrl } from "@/tests/helpers/database-safety";

describe("book change triggers", () => {
  let reader: ReturnType<typeof postgres>;
  let writer: ReturnType<typeof postgres>;
  let messages: unknown[] = [];
  let reached: (() => void) | undefined;

  // A notification on the same listening connection is a delivery barrier,
  // not a sleep that assumes the driver has processed previous commits.
  async function barrier() {
    const delivered = new Promise<void>((resolve) => { reached = resolve; });
    await reader.notify("test_change_barrier", "barrier");
    await delivered;
  }

  beforeAll(async () => {
    await setupTestDatabase();
    reader = postgres(workerDatabaseUrl(), { max: 1 });
    writer = postgres(workerDatabaseUrl(), { max: 1 });
    await reader.listen("counterpoise_changes", (payload) => messages.push(JSON.parse(payload)));
    await reader.listen("test_change_barrier", () => reached?.());
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await barrier();
    messages = [];
  });
  afterAll(async () => { await Promise.all([reader?.end(), writer?.end()]); });

  it("publishes only committed changes and collapses identical payloads", async () => {
    await writer.begin(async (tx) => {
      await tx`insert into transactions (book_id, date, created_at, updated_at)
        select 1, '2026-09-20', now(), now() from generate_series(1, 2000)`;
      await barrier();
      expect(messages).toEqual([]);
    });
    await barrier();
    expect(messages).toEqual([{ bookId: 1, table: "transactions" }]);

    messages = [];
    await expect(writer.begin(async (tx) => {
      await tx`update transactions set description = 'rolled back'`;
      throw new Error("deliberate rollback after write");
    })).rejects.toThrow("deliberate rollback after write");
    await barrier();
    expect(messages).toEqual([]);
    expect((await writer`select count(*)::int as n from transactions where description is not null`)[0].n).toBe(0);
  });

  it("notifies both books on a move and the old book on deletion", async () => {
    await writer`insert into books (id, user_id, name, created_at, updated_at)
      values (2, 1, 'Other book', now(), now())`;
    await writer`insert into transactions (book_id, date, created_at, updated_at)
      values (1, '2026-09-20', now(), now())`;
    await barrier();
    messages = [];
    await writer`update transactions set book_id = 2`;
    await barrier();
    expect(messages).toEqual([{ bookId: 1, table: "transactions" }, { bookId: 2, table: "transactions" }]);
    messages = [];
    await writer`delete from transactions`;
    await barrier();
    expect(messages).toEqual([{ bookId: 2, table: "transactions" }]);
  });

  it("notifies for child-only split and Plaid queue/account changes", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Expense", type: "expense" });
    await createTransactionWithSplits({ date: "2026-09-20", splits: [
      { accountId: checking.id, amount: -100 }, { accountId: expense.id, amount: 100 },
    ] });
    const token = await createPlaidToken({ financialInstitution: "Test", itemId: "item", accessToken: "synthetic" });
    const account = await createPlaidAccount({ tokenId: token.id, plaidAccountId: "account", name: "Checking", type: "depository", counterpoiseAccountId: checking.id });
    await createPlaidReconciliation({ plaidAccountLinkId: account.id, plaidTransactionId: "pending", date: "2026-09-20", amountCents: 100, name: "Pending" });
    await barrier(); messages = [];
    await writer`update transaction_splits set amount = amount * 2 where book_id = 1`;
    await barrier();
    expect(messages).toEqual([{ bookId: 1, table: "transaction_splits" }]);
    messages = [];
    await writer`update plaid_transaction_reconciliation set resolution_status = 'ignored' where book_id = 1`;
    await barrier();
    expect(messages).toEqual([{ bookId: 1, table: "plaid_transaction_reconciliation" }]);
    messages = [];
    await writer`update plaid_accounts set counterpoise_account_id = null where book_id = 1`;
    await barrier();
    expect(messages).toEqual([{ bookId: 1, table: "plaid_accounts" }]);
  });

  it("notifies the book id for projection settings only after commit", async () => {
    await writer`insert into books (id, user_id, name, created_at, updated_at)
      values (2, 1, 'Other book', now(), now())`;
    await barrier();
    // Triggers on the same table fire in name order. book_creator_owner
    // fires before counterpoise_changes. Its book_members notification
    // arrives first.
    expect(messages).toEqual([{ bookId: 2, table: "book_members" }, { bookId: 2, table: "books" }]);
    messages = [];
    await writer.begin(async (tx) => {
      await tx`update books set upcoming_days = 60 where id = 2`;
      await barrier();
      expect(messages).toEqual([]);
    });
    await barrier();
    expect(messages).toEqual([{ bookId: 2, table: "books" }]);
    messages = [];
    await expect(writer.begin(async (tx) => {
      await tx`update books set upcoming_days = 90 where id = 2`;
      throw new Error("rolled back settings");
    })).rejects.toThrow("rolled back settings");
    await barrier();
    expect(messages).toEqual([]);
    expect((await writer`select upcoming_days from books where id = 2`)[0].upcoming_days).toBe(60);
    await writer`delete from books where id = 2`;
    await barrier();
    // The books delete trigger fires first. The FK cascade to book_members
    // runs after it. Its notification arrives second.
    expect(messages).toEqual([{ bookId: 2, table: "books" }, { bookId: 2, table: "book_members" }]);
  });

  it("installs triggers on every source used by the first consumers", async () => {
    const rows = await writer`select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = 'counterpoise_changes' and not t.tgisinternal order by c.relname`;
    expect(rows.map((r) => r.relname)).toEqual([
      "accounts", "book_members", "books", "investment_lots", "investment_splits", "payees", "plaid_accounts",
      "plaid_transaction_reconciliation", "recurring_rules", "recurring_template_splits",
      "securities", "security_prices", "transaction_splits", "transactions",
    ]);
  });
});

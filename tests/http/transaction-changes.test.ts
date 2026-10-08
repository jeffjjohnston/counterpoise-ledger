import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAccount, createBook, createInvestmentSplit, createSecurity, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { exec, scalar } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

type TransactionBody = { id: number; description: string | null; [field: string]: unknown };
type ChangesBody = { cursor: number; transactions: TransactionBody[]; deletedIds: number[]; hasMore: boolean };
const changesSchema = contract<ChangesBody>("TransactionChanges");
const errorSchema = contract<{ error: string }>("ApiError");

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// GET /transactions/changes: the delta sync of a native client. Full mode
// pages the book by ID. Delta mode reads the change log that the triggers of
// migration 0003 write.
describe("transaction changes HTTP contract", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  let a: Record<string, number>;
  let ids: number[];

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    const checking = await createAccount({ name: "Checking", type: "asset", subtype: "bank" });
    const groceries = await createAccount({ name: "Groceries", type: "expense" });
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const vti = await createSecurity({ name: "Total Market", symbol: "VTI", securityType: "etf" });
    const other = await createBook({ name: "Other" });
    const otherAccount = await createAccount({ name: "Other", type: "asset", bookId: other.id });
    a = { checking: checking.id, groceries: groceries.id, brokerage: brokerage.id, vti: vti.id };
    a.other = other.id;
    a.otherAccount = otherAccount.id;
    ids = [];
    for (let day = 1; day <= 5; day++) {
      const transaction = await createTransactionWithSplits({
        date: `2025-01-0${day}`, description: `Spend ${day}`,
        splits: [{ accountId: checking.id, amount: -day * 100 }, { accountId: groceries.id, amount: day * 100 }],
      });
      ids.push(transaction.id);
    }
    await createTransactionWithSplits({
      date: "2025-01-01", description: "Other book", bookId: other.id,
      splits: [{ accountId: otherAccount.id, amount: 1 }, { accountId: otherAccount.id, amount: -1 }],
    });
  });
  afterAll(async () => {
    await stop?.();
  });

  async function changes(query = "", bookId = 1): Promise<ChangesBody> {
    const response = await client.request(`/api/b/${bookId}/transactions/changes${query}`);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return changesSchema.parse(body);
  }

  async function expectError(query: string, status: number, message?: string, bookId = 1) {
    const response = await client.request(`/api/b/${bookId}/transactions/changes${query}`);
    const body = errorSchema.parse(await response.json());
    expect(response.status, JSON.stringify(body)).toBe(status);
    if (message !== undefined) expect(body.error).toBe(message);
  }

  /** The log's newest sequence number, as the server must report it. */
  async function maxSeq(): Promise<number> {
    return Number(await scalar("SELECT coalesce(max(seq), 0) AS seq FROM transaction_changes"));
  }

  async function create(description: string): Promise<TransactionBody> {
    const response = await client.request("/api/b/1/transactions", json("POST", {
      date: "2025-02-01", description,
      splits: [{ accountId: a.checking, amount: -50 }, { accountId: a.groceries, amount: 50 }],
    }));
    expect(response.status).toBe(200);
    return response.json();
  }

  it("reports cursor 0 and no rows when the log and the book are empty", async () => {
    await exec("DELETE FROM transactions");
    await exec("DELETE FROM transaction_changes");
    expect(await changes()).toEqual({ cursor: 0, transactions: [], deletedIds: [], hasMore: false });
  });

  it("round-trips a cursor from the migration's floor marker", async () => {
    // resetTestDatabase clears the log. A migrated database starts it with a
    // floor marker at the time of migration 0003 in microseconds: 16 digits.
    await exec("DELETE FROM transaction_changes");
    await exec(
      "INSERT INTO transaction_changes (seq, book_id, transaction_id) VALUES (unixepoch() * 1000000, 0, 0)"
    );
    const { cursor } = await changes();
    expect(String(cursor)).toHaveLength(16);
    const created = await create("After the migration");
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions).toEqual([created]);
    expect(delta.cursor).toBeGreaterThan(cursor);
  });

  it("pages the full book by ID with the DTOs of listTransactions", async () => {
    const cursor = await maxSeq();
    expect(cursor).toBeGreaterThan(0);

    const first = await changes("?limit=2");
    expect(first.transactions.map((t) => t.id)).toEqual(ids.slice(0, 2));
    expect(first).toMatchObject({ cursor, deletedIds: [], hasMore: true });
    const second = await changes(`?afterId=${ids[1]}&limit=2`);
    expect(second.transactions.map((t) => t.id)).toEqual(ids.slice(2, 4));
    expect(second.hasMore).toBe(true);
    const last = await changes(`?afterId=${ids[3]}&limit=2`);
    expect(last.transactions.map((t) => t.id)).toEqual(ids.slice(4));
    expect(last.hasMore).toBe(false);
    // A page that ends exactly at the last row has nothing more.
    expect((await changes(`?afterId=${ids[2]}&limit=2`)).hasMore).toBe(false);

    const all = await changes();
    expect(all.transactions.map((t) => t.id)).toEqual(ids);
    expect(all.hasMore).toBe(false);
    const listed = await (await client.request("/api/b/1/transactions?limit=0")).json();
    expect(all.transactions).toEqual([...listed].sort((x: TransactionBody, y: TransactionBody) => x.id - y.id));
  });

  it("gives an inserted transaction in the delta", async () => {
    const { cursor } = await changes();
    const created = await create("New");
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions).toEqual([created]);
    expect(delta).toMatchObject({ deletedIds: [], hasMore: false });
    expect(delta.cursor).toBeGreaterThan(cursor);
    expect(delta.cursor).toBe(await maxSeq());
    // Nothing changed after the new cursor.
    expect(await changes(`?since=${delta.cursor}`)).toEqual({
      cursor: delta.cursor, transactions: [], deletedIds: [], hasMore: false,
    });
  });

  it("gives an updated transaction in the delta", async () => {
    const { cursor } = await changes();
    const response = await client.request(`/api/b/1/transactions/${ids[2]}`, json("PUT", { description: "Renamed" }));
    expect(response.status).toBe(200);
    const updated = await response.json();
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions).toEqual([updated]);
    expect(delta.transactions[0].description).toBe("Renamed");
    expect(delta.deletedIds).toEqual([]);
  });

  it("gives a transaction whose splits alone changed", async () => {
    const { cursor } = await changes();
    await exec("UPDATE transaction_splits SET amount = -amount WHERE transaction_id = $1", [ids[1]]);
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions.map((t) => t.id)).toEqual([ids[1]]);
    expect(delta.transactions[0].splits).toMatchObject([{ amount: 200 }, { amount: -200 }]);

    const split = await createInvestmentSplit({
      transactionId: ids[3], accountId: a.brokerage, securityId: a.vti, action: "buy",
      sharesMicros: 1_000_000, priceMicros: 10_000_000,
    });
    const afterInsert = await changes(`?since=${delta.cursor}`);
    expect(afterInsert.transactions.map((t) => t.id)).toEqual([ids[3]]);
    await exec("UPDATE investment_splits SET shares_micros = 2000000 WHERE id = $1", [split.id]);
    const afterUpdate = await changes(`?since=${afterInsert.cursor}`);
    expect(afterUpdate.transactions.map((t) => t.id)).toEqual([ids[3]]);
    await exec("DELETE FROM investment_splits WHERE id = $1", [split.id]);
    const afterDelete = await changes(`?since=${afterUpdate.cursor}`);
    expect(afterDelete.transactions.map((t) => t.id)).toEqual([ids[3]]);
    expect(afterDelete.transactions[0].investmentSplits).toEqual([]);
  });

  it("gives a deleted transaction in deletedIds", async () => {
    const { cursor } = await changes();
    const response = await client.request(`/api/b/1/transactions/${ids[0]}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const delta = await changes(`?since=${cursor}`);
    expect(delta).toMatchObject({ transactions: [], deletedIds: [ids[0]], hasMore: false });
  });

  it("gives both transactions when a split moves from one to another", async () => {
    const { cursor } = await changes();
    await exec(
      "UPDATE transaction_splits SET transaction_id = $1 WHERE id = (SELECT min(id) FROM transaction_splits WHERE transaction_id = $2)",
      [ids[4], ids[0]]
    );
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions.map((t) => t.id)).toEqual([ids[0], ids[4]]);
    expect(delta.transactions[0].splits).toHaveLength(1);
    expect(delta.transactions[1].splits).toHaveLength(3);
  });

  it("keeps the changes of another book out of the delta", async () => {
    const { cursor } = await changes();
    await createTransactionWithSplits({
      date: "2025-03-01", bookId: a.other,
      splits: [{ accountId: a.otherAccount, amount: 2 }, { accountId: a.otherAccount, amount: -2 }],
    });
    const delta = await changes(`?since=${cursor}`);
    expect(delta).toMatchObject({ transactions: [], deletedIds: [] });
    // The cursor is the newest change of the whole log.
    expect(delta.cursor).toBeGreaterThan(cursor);
    expect(delta.cursor).toBe(await maxSeq());
  });

  it("gives the changes made during a paged download in the delta since the first cursor", async () => {
    const first = await changes("?limit=2");
    // A row the client has, a row it has not read yet, and a new row.
    const edited = await client.request(`/api/b/1/transactions/${ids[0]}`, json("PUT", { description: "Edited" }));
    expect(edited.status).toBe(200);
    expect((await client.request(`/api/b/1/transactions/${ids[3]}`, { method: "DELETE" })).status).toBe(200);
    const created = await create("During download");

    const second = await changes(`?afterId=${ids[1]}&limit=2`);
    expect(second.transactions.map((t) => t.id)).toEqual([ids[2], ids[4]]);
    const last = await changes(`?afterId=${ids[4]}&limit=2`);
    expect(last.transactions.map((t) => t.id)).toEqual([created.id]);
    expect(last.hasMore).toBe(false);

    const delta = await changes(`?since=${first.cursor}`);
    expect(delta.transactions.map((t) => t.id)).toEqual([ids[0], created.id]);
    expect(delta.transactions[0].description).toBe("Edited");
    expect(delta.deletedIds).toEqual([ids[3]]);
  });

  it("writes no log row for a write that rolls back", async () => {
    const before = await maxSeq();
    const brokerageCash = await createAccount({
      name: "Brokerage Cash", type: "asset", subtype: "cash", parentId: a.brokerage, isInvestmentCash: true,
    });
    // Valid until the investment split insert, which the database refuses.
    const response = await client.request("/api/b/1/transactions", json("POST", {
      date: "2025-01-01",
      splits: [{ accountId: a.brokerage, amount: 1_000 }, { accountId: brokerageCash.id, amount: -1_000 }],
      investmentSplits: [{
        securityId: a.vti, action: "split", sharesMicros: 1_000_000, priceMicros: 10_000_000,
        splitNumerator: 3_000_000_000, splitDenominator: 1,
      }],
    }));
    expect(response.status).toBe(500);
    expect(await maxSeq()).toBe(before);
  });

  it("answers 410 for a cursor newer than the log", async () => {
    const { cursor } = await changes();
    await expectError(`?since=${cursor + 1}`, 410);
  });

  it("answers 410 for a cursor from before a restore, also after the log grows past it", async () => {
    const { cursor } = await changes();
    // A restored snapshot carries a floor marker (book 0) above its newest
    // seq. Here the snapshot is the state at `cursor`, and the client also
    // saw one change that the restore removes.
    await create("Lost in the restore");
    const { cursor: clientCursor } = await changes(`?since=${cursor}`);
    await exec("DELETE FROM transaction_changes WHERE seq > $1", [cursor]);
    await exec(
      "INSERT INTO transaction_changes (seq, book_id, transaction_id) VALUES ($1 + 4294967296, 0, 0)",
      [cursor]
    );
    // New changes after the restore move the log past the client's cursor.
    await create("After the restore");
    await expectError(`?since=${clientCursor}`, 410, "The database was restored after the sync cursor. Download all transactions again.");

    // A full download after the restore gives a cursor that works.
    const full = await changes();
    expect(full.cursor).toBeGreaterThan(cursor + 4294967296);
    const created = await create("Next");
    expect((await changes(`?since=${full.cursor}`)).transactions).toEqual([created]);
  });

  it("answers 410 when more than 5000 transactions changed", async () => {
    const { cursor } = await changes();
    await exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001)
      INSERT INTO transactions (book_id, date, created_at, updated_at)
      SELECT 1, '2025-04-01', '2025-04-01 00:00:00', '2025-04-01 00:00:00' FROM n
    `);
    await expectError(`?since=${cursor}`, 410);
    // Exactly 5000 is still a delta.
    const newest = Number(await scalar("SELECT max(id) AS id FROM transactions"));
    await exec("DELETE FROM transaction_changes WHERE transaction_id = $1", [newest]);
    const delta = await changes(`?since=${cursor}`);
    expect(delta.transactions).toHaveLength(5000);
  });

  it("refuses invalid query values", async () => {
    for (const query of ["?limit=0", "?limit=5001", "?limit=abc", "?afterId=-1", "?since=-1", "?since=abc", "?since=1&afterId=1", "?since=1&limit=10"]) {
      await expectError(query, 400);
    }
    expect((await changes("?limit=5000")).transactions).toHaveLength(5);
  });

  it("answers 404 to a user who is not a member and 401 without a session", async () => {
    const stranger = await createUser({ username: "stranger" });
    const book = await createBook({ name: "Theirs", userId: stranger.id });
    await expectError("", 404, undefined, book.id);
    const anonymous = await client.anonymous("/api/b/1/transactions/changes");
    expect(anonymous.status).toBe(401);
  });
});

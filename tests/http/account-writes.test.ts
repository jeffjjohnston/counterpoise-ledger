import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accounts } from "../../db/schema";
import {
  addBookMember, createAccount, createBook, createTransactionWithSplits, createUser, db,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { workerDatabaseUrl } from "../helpers/database-safety";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract, type Contract } from "../helpers/contract";

const accountNodeSchema = contract("AccountNode");
const accountWithChildrenSchema = contract("AccountWithChildren");

type Client = Awaited<ReturnType<typeof sessionHttpClient>>;

function expectShape(schema: Contract<unknown>, body: unknown): void {
  schema.parse(body);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("account write HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Client;
  let listener: ReturnType<typeof postgres>;
  let changes: unknown[] = [];
  let reached: (() => void) | undefined;

  // A notification on the listening connection is a delivery barrier: every
  // change the server committed before it arrives first.
  async function barrier() {
    const delivered = new Promise<void>((resolve) => { reached = resolve; });
    await listener.notify("test_account_write_barrier", "barrier");
    await delivered;
  }

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
    listener = postgres(workerDatabaseUrl(), { max: 1 });
    await listener.listen("counterpoise_changes", (payload) => changes.push(JSON.parse(payload)));
    await listener.listen("test_account_write_barrier", () => reached?.());
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    await barrier();
    changes = [];
  });

  afterAll(async () => { await Promise.all([stop?.(), listener?.end()]); });

  async function expectError(path: string, init: RequestInit, status: number, error: string) {
    const response = await client.request(path, init);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }

  it("creates a book-scoped account with an empty node shape and notifies the book", async () => {
    const response = await client.request("/api/b/1/accounts", json("POST", {
      name: "Groceries", type: "expense", icon: " 🛒 ", bookId: 999, id: 888, isFavorite: true,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountNodeSchema, body);
    expect(body).toMatchObject({
      bookId: 1, name: "Groceries", type: "expense", subtype: null, parentId: null, icon: "🛒",
      isActive: true, isFavorite: false, isInvestmentCash: false,
      balance: 0, hasTransactions: false, children: [],
    });
    expect(body.id).not.toBe(888);
    expect(body.createdAt).toBe(body.updatedAt);
    expect(Math.abs(Date.parse(body.createdAt) - Date.now())).toBeLessThan(60_000);
    await barrier();
    expect(changes).toEqual([{ bookId: 1, table: "accounts" }]);
  });

  it("creates the paired cash sub-account for an investment account in one write", async () => {
    const parent = await createAccount({ name: "Assets", type: "asset" });
    const response = await client.request("/api/b/1/accounts", json("POST", {
      name: "Brokerage", type: "asset", subtype: "investment", parentId: parent.id,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountNodeSchema, body);
    expect(body).toMatchObject({ parentId: parent.id, subtype: "investment", children: [] });
    const cash = await db.select().from(accounts).where(eq(accounts.parentId, body.id));
    expect(cash).toMatchObject([{
      name: "Brokerage Cash", type: "asset", subtype: "cash", isActive: true,
      isInvestmentCash: true, bookId: 1,
    }]);
  });

  it("rejects account-create input with the Node status and message", async () => {
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createAccount({ name: "Foreign", type: "asset", bookId: otherBook.id });
    await createAccount({ name: "Taken", type: "asset" });
    for (const [body, status, error] of [
      [[], 400, "Name and type are required"],
      [{ name: "", type: "asset" }, 400, "Name and type are required"],
      [{ name: "A", type: "banana" }, 400, "Invalid account type"],
      [{ name: "A", type: "asset", subtype: "bad" }, 400, "Invalid account subtype"],
      [{ name: "A", type: "asset", parentId: "1" }, 400, "Invalid input: expected number, received string"],
      [{ name: "A", type: "asset", parentId: 1.5 }, 400, "Invalid input: expected int, received number"],
      [{ name: "A", type: "asset", parentId: 0 }, 400, "Too small: expected number to be >0"],
      [{ name: "A", type: "asset", icon: 5 }, 400, "Invalid input"],
      [{ name: "A", type: "asset", icon: "🚗🚙" }, 400, "Icon must be a single character"],
      [{ name: "A", type: "asset", parentId: foreign.id }, 400, "Invalid parentId"],
      [{ name: "A", type: "asset", parentId: 3_000_000_000 }, 500, "Failed to create account"],
      [{ name: "Taken", type: "asset" }, 500, "Failed to create account"],
    ] as const) {
      await expectError("/api/b/1/accounts", json("POST", body), status, error);
    }
    await expectError("/api/b/1/accounts", { method: "POST", body: "{" }, 500, "Failed to create account");
    expect(await db.select().from(accounts).where(eq(accounts.bookId, 1))).toHaveLength(1);
  });

  it("updates only the sent fields and returns the row with raw children", async () => {
    const account = await createAccount({ name: "Checking", type: "asset", subtype: "bank", isFavorite: true });
    const child = await createAccount({ name: "Envelope", type: "asset", parentId: account.id });
    await barrier();
    changes = [];
    const response = await client.request(`/api/b/${1}/accounts/${account.id}`, json("PUT", {
      name: "Main Checking", subtype: null, icon: "", type: "expense", bookId: 999,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountWithChildrenSchema, body);
    expect(body).toMatchObject({
      id: account.id, bookId: 1, name: "Main Checking", type: "asset", subtype: null, icon: null,
      isFavorite: true, isActive: true,
    });
    expect(body.children.map((row: { id: number }) => row.id)).toEqual([child.id]);
    expect(Date.parse(body.updatedAt)).toBeGreaterThan(account.updatedAt.getTime());
    expect(body.createdAt).toBe(account.createdAt.toISOString());
    await barrier();
    expect(changes).toEqual([{ bookId: 1, table: "accounts" }]);
  });

  it("keeps the investment cash sub-account in step on rename and deactivation", async () => {
    const created = await client.request("/api/b/1/accounts", json("POST", {
      name: "Brokerage", type: "asset", subtype: "investment",
    }));
    const { id } = await created.json();
    const response = await client.request(`/api/b/1/accounts/${id}`, json("PUT", {
      name: "Retirement", isActive: false,
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expectShape(accountWithChildrenSchema, body);
    expect(body.children).toMatchObject([{ name: "Retirement Cash", isActive: false, isInvestmentCash: true }]);

    // Node applies the pair rule with `??`, so a null subtype still counts as
    // the stored "investment" for this request and the cash row follows.
    const cleared = await client.request(`/api/b/1/accounts/${id}`, json("PUT", {
      name: "Taxable", subtype: null, isActive: true,
    }));
    const clearedBody = await cleared.json();
    expect(clearedBody).toMatchObject({ subtype: null, isActive: true });
    expect(clearedBody.children).toMatchObject([{ name: "Taxable Cash", isActive: true }]);
  });

  it("creates a missing cash sub-account when an account becomes an investment", async () => {
    const account = await createAccount({ name: "Brokerage", type: "asset", subtype: "bank" });
    const response = await client.request(`/api/b/1/accounts/${account.id}`, json("PUT", { subtype: "investment" }));
    expect(response.status).toBe(200);
    expect((await response.json()).children).toMatchObject([
      { name: "Brokerage Cash", subtype: "cash", isInvestmentCash: true, isActive: true },
    ]);
  });

  it("rejects account-update input with the Node status and message", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createAccount({ name: "Foreign", type: "asset", bookId: otherBook.id });
    await createAccount({ name: "Taken", type: "asset" });
    const path = `/api/b/1/accounts/${account.id}`;
    for (const [body, status, error] of [
      [null, 400, "Invalid input: expected object, received null"],
      [[], 400, "Invalid input: expected object, received array"],
      [{ isActive: null, name: 5 }, 400, "Invalid input: expected string, received number"],
      [{ subtype: 5 }, 400, "Invalid account subtype"],
      [{ parentId: true }, 400, "Invalid input: expected number, received boolean"],
      [{ isActive: "yes" }, 400, "Invalid input: expected boolean, received string"],
      [{ isFavorite: 1 }, 400, "Invalid input: expected boolean, received number"],
      [{ icon: [] }, 400, "Invalid input"],
      [{ parentId: foreign.id }, 400, "Invalid parentId"],
      [{ parentId: 3_000_000_000 }, 500, "Failed to update account"],
      [{ name: "Taken" }, 500, "Failed to update account"],
    ] as const) {
      await expectError(path, json("PUT", body), status, error);
    }
    await expectError(path, { method: "PUT", body: "not json" }, 500, "Failed to update account");
    await expectError("/api/b/1/accounts/999999", json("PUT", { name: "X" }), 404, "Account not found");
    await expectError(`/api/b/1/accounts/${foreign.id}`, json("PUT", { name: "X" }), 404, "Account not found");
    await expectError("/api/b/1/accounts/abc", json("PUT", { name: "X" }), 500, "Failed to update account");
    await expectError("/api/b/1/accounts/abc", json("PUT", { name: 5 }), 400, "Invalid input: expected string, received number");
    const [unchanged] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(unchanged).toMatchObject({ name: "Checking", parentId: null });
  });

  it("deletes an unused account and refuses one with transactions or sub-accounts", async () => {
    const used = await createAccount({ name: "Checking", type: "asset" });
    const expense = await createAccount({ name: "Food", type: "expense" });
    await createAccount({ name: "Child", type: "expense", parentId: expense.id });
    const unused = await createAccount({ name: "Unused", type: "asset" });
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createAccount({ name: "Foreign", type: "asset", bookId: otherBook.id });
    await createTransactionWithSplits({
      date: "2025-01-01",
      splits: [{ accountId: used.id, amount: -100 }, { accountId: expense.id, amount: 100 }],
    });
    await expectError(`/api/b/1/accounts/${used.id}`, { method: "DELETE" }, 400, "Cannot delete account with transactions");
    const parentOnly = await createAccount({ name: "Parent", type: "asset" });
    await createAccount({ name: "Sub", type: "asset", parentId: parentOnly.id });
    await expectError(`/api/b/1/accounts/${parentOnly.id}`, { method: "DELETE" }, 400, "Cannot delete account with sub-accounts");
    await expectError(`/api/b/1/accounts/${foreign.id}`, { method: "DELETE" }, 404, "Account not found");
    await expectError("/api/b/1/accounts/abc", { method: "DELETE" }, 500, "Failed to delete account");
    await expectError("/api/b/1/accounts/3000000000", { method: "DELETE" }, 500, "Failed to delete account");
    await barrier();
    changes = [];

    const response = await client.request(`/api/b/1/accounts/${unused.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await db.select().from(accounts).where(and(eq(accounts.id, unused.id)))).toEqual([]);
    expect(await db.select().from(accounts).where(eq(accounts.id, foreign.id))).toHaveLength(1);
    await barrier();
    expect(changes).toEqual([{ bookId: 1, table: "accounts" }]);
  });

  it("reads path IDs with JavaScript parseInt, including hex and its whitespace set", async () => {
    const account = await createAccount({ name: "Checking", type: "asset" });
    const hex = `0x${account.id.toString(16)}`;
    // U+FEFF is JavaScript whitespace and U+0085 is not; Rust's own trim
    // treats them the other way round.
    const bom = `%EF%BB%BF${account.id}`;
    const nel = `%C2%85${account.id}`;

    const read = await client.request(`/api/b/1/accounts/${hex}`);
    expect(read.status).toBe(200);
    expect((await read.json()).id).toBe(account.id);
    expect((await client.request(`/api/b/1/accounts/${bom}`)).status).toBe(200);
    await expectError(`/api/b/1/accounts/${nel}`, {}, 500, "Failed to fetch account");

    const renamed = await client.request(`/api/b/1/accounts/${hex}`, json("PUT", { name: "Hex" }));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Hex");
    expect((await client.request(`/api/b/1/accounts/${bom}`, json("PUT", { name: "Bom" }))).status).toBe(200);
    await expectError(`/api/b/1/accounts/${nel}`, json("PUT", { name: "Nel" }), 500, "Failed to update account");
    await expectError("/api/b/1/accounts/0x", json("PUT", { name: "Nel" }), 500, "Failed to update account");
    await expectError(`/api/b/1/accounts/${nel}`, { method: "DELETE" }, 500, "Failed to delete account");
    const [stored] = await db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(stored.name).toBe("Bom");

    // Book IDs use parseInt(id, 10): hex reads as 0, and U+0085 is NaN.
    expect((await client.request("/api/b/%EF%BB%BF1/accounts")).status).toBe(200);
    await expectError("/api/b/0x1/accounts", {}, 404, "Book not found");
    await expectError("/api/b/%C2%851/accounts", {}, 400, "Invalid book ID");
    await expectError("/api/b/%C2%851/accounts", json("POST", { name: "A", type: "asset" }), 400, "Invalid book ID");

    const deleted = await client.request(`/api/b/1/accounts/${hex}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await db.select().from(accounts).where(eq(accounts.id, account.id))).toEqual([]);
  });

  it("denies viewers and non-members before reading the body", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const account = await createAccount({ name: "Checking", type: "asset", bookId: shared.id });
    const readOnly = "You have read-only access to this book";
    await expectError(`/api/b/${shared.id}/accounts`, { method: "POST", body: "{" }, 403, readOnly);
    await expectError(`/api/b/${shared.id}/accounts/${account.id}`, json("PUT", { name: "X" }), 403, readOnly);
    await expectError(`/api/b/${shared.id}/accounts/${account.id}`, { method: "DELETE" }, 403, readOnly);
    await expectError("/api/b/999999/accounts", json("POST", { name: "A", type: "asset" }), 404, "Book not found");
    const anonymous = await client.anonymous("/api/b/1/accounts", json("POST", { name: "A", type: "asset" }));
    expect(anonymous.status).toBe(401);
  });
});

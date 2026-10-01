import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addBookMember, createAccount, createBook, createPayee, createTransactionWithSplits, createUser,
  resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { rows } from "../helpers/sql";
import type { Payee } from "../../types/db";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { contract } from "../helpers/contract";

const payeeRowSchema = contract("PayeeRow");

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("payee write HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
  });
  afterAll(async () => { await stop?.(); });

  async function expectError(path: string, init: RequestInit, status: number, error: string) {
    const response = await client.request(path, init);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  }

  async function post(name: unknown) {
    const response = await client.request("/api/b/1/payees", json("POST", { name, bookId: 999 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(payeeRowSchema.safeParse(body).success).toBe(true);
    return body as { id: number; bookId: number; name: string; createdAt: string };
  }

  it("normalizes a new name with JavaScript whitespace rules and keeps its case", async () => {
    const created = await post("﻿  Bob’s   IKEA\t");
    expect(created).toMatchObject({ bookId: 1, name: "Bob's IKEA" });
    expect(Math.abs(Date.parse(created.createdAt) - Date.now())).toBeLessThan(60_000);
    // U+0085 is whitespace to Rust but not to JavaScript.
    expect((await post("\u0085Cafe")).name).toBe("\u0085Cafe");
    const stored = await rows<Payee>("SELECT * FROM payees WHERE book_id = $1", [1]);
    expect(stored.map((row) => row.name).sort()).toEqual(["Bob's IKEA", "\u0085Cafe"]);
  });

  it("returns the stored payee for a case variant instead of creating one", async () => {
    const existing = await createPayee({ name: "Blue Bottle" });
    const matched = await post("  blue   BOTTLE ");
    expect(matched).toEqual({
      id: existing.id, bookId: 1, name: "Blue Bottle", createdAt: existing.createdAt.toISOString(),
    });
    const otherBook = await createBook({ name: "Other" });
    await createPayee({ name: "Elsewhere", bookId: otherBook.id });
    expect((await post("elsewhere")).bookId).toBe(1);
    expect(await rows("SELECT * FROM payees WHERE book_id = $1", [1])).toHaveLength(2);
  });

  it("rejects payee-create input with the Node status and message", async () => {
    for (const body of [null, [], {}, { name: 5 }, { name: "  ﻿ " }]) {
      await expectError("/api/b/1/payees", json("POST", body), 400, "Name is required");
    }
    await expectError("/api/b/1/payees", { method: "POST", body: "{" }, 500, "Failed to create payee");
  });

  it("deletes an unused payee and refuses a used, missing, or malformed one", async () => {
    const checking = await createAccount({ name: "Checking", type: "asset" });
    const food = await createAccount({ name: "Food", type: "expense" });
    const used = await createPayee({ name: "Used" });
    const unused = await createPayee({ name: "Unused" });
    const otherBook = await createBook({ name: "Other" });
    const foreign = await createPayee({ name: "Foreign", bookId: otherBook.id });
    await createTransactionWithSplits({
      date: "2025-01-01", payeeId: used.id,
      splits: [{ accountId: checking.id, amount: -100 }, { accountId: food.id, amount: 100 }],
    });
    for (const [id, status, error] of [
      [used.id, 409, "Cannot delete a payee that has associated transactions"],
      [foreign.id, 404, "Payee not found"],
      ["12a", 400, "Invalid payee id"],
      ["-1", 400, "Invalid payee id"],
      ["3000000000", 500, "Failed to delete payee"],
    ] as const) {
      await expectError(`/api/b/1/payees/${id}`, { method: "DELETE" }, status, error);
    }
    const response = await client.request(`/api/b/1/payees/${unused.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect((await rows<Payee>("SELECT * FROM payees")).map((row) => row.id).sort()).toEqual(
      [used.id, foreign.id].sort()
    );
  });

  it("denies viewers write access", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const payee = await createPayee({ name: "Cafe", bookId: shared.id });
    const readOnly = "You have read-only access to this book";
    await expectError(`/api/b/${shared.id}/payees`, json("POST", { name: "X" }), 403, readOnly);
    await expectError(`/api/b/${shared.id}/payees/${payee.id}`, { method: "DELETE" }, 403, readOnly);
  });
});

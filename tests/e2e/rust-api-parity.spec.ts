import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { emptyBookTest as test, expect } from "./fixtures";
import { hashApiKey } from "../helpers/api-keys";
import { exec, insert, insertRows, scalar } from "../helpers/sql";
import { API_CONTRACT } from "../../lib/api-contract";

const packageVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// Through the security layers of the Rust server. Its values come from
// independently created rows, not from the route under test.
test("version and account list preserve the HTTP contract", async ({ request, bookId }) => {
  const version = await request.get("/api/version");
  expect(version.status()).toBe(200);
  expect(await version.json()).toEqual({ version: packageVersion, apiContract: API_CONTRACT });

  const root = await request.post(`/api/b/${bookId}/accounts`, {
    data: { name: "Checking", type: "asset", subtype: "bank" },
  });
  const expense = await request.post(`/api/b/${bookId}/accounts`, {
    data: { name: "Groceries", type: "expense" },
  });
  const child = await request.post(`/api/b/${bookId}/accounts`, {
    data: { name: "Savings", type: "asset", parentId: (await root.json()).id },
  });
  expect(root.status()).toBe(200);
  expect(expense.status()).toBe(200);
  expect(child.status()).toBe(200);
  const rootId = (await root.json()).id as number;
  const expenseId = (await expense.json()).id as number;

  const transaction = await insert<{ id: number }>("transactions", { bookId, date: "2025-01-10" });
  await insertRows("transaction_splits", [
    { bookId, transactionId: transaction.id, accountId: rootId, amount: -1250 },
    { bookId, transactionId: transaction.id, accountId: expenseId, amount: 1250 },
  ]);

  const list = await request.get(`/api/b/${bookId}/accounts?type=asset&asOfDate=2025-12-31`);
  expect(list.status()).toBe(200);
  const accounts = await list.json();
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({
    id: rootId, bookId, name: "Checking", type: "asset", subtype: "bank",
    parentId: null, isActive: true, balance: -1250, hasTransactions: true,
    children: [{ name: "Savings", parentId: rootId, balance: 0, hasTransactions: false, children: [] }],
  });
  expect(accounts[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  const before = await request.get(`/api/b/${bookId}/accounts?type=asset&asOfDate=2024-12-31`);
  expect((await before.json())[0]).toMatchObject({ balance: 0, hasTransactions: false });
  const invalid = await request.get(`/api/b/${bookId}/accounts?asOfDate=2025-02-30`);
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toEqual({ error: "Invalid ISO date" });
  const noncanonical = await request.get(`/api/b/${bookId}/accounts?asOfDate=2025-01-%201`);
  expect(noncanonical.status()).toBe(400);
  expect(await noncanonical.json()).toEqual({ error: "Invalid ISO date" });
  const invalidType = await request.get(`/api/b/${bookId}/accounts?type=banana`);
  expect(invalidType.status()).toBe(400);
  expect(await invalidType.json()).toEqual({ error: 'Invalid option: expected one of "asset"|"liability"|"equity"|"income"|"expense"' });
  const firstValue = await request.get(`/api/b/${bookId}/accounts?type=asset&type=banana&ignored=anything`);
  expect(firstValue.status()).toBe(200);
  expect((await firstValue.json()).map((account: { type: string }) => account.type)).toEqual(["asset"]);
  const invalidBody = await request.post(`/api/b/${bookId}/accounts`, {
    data: { name: "Wrong", type: "banana" },
  });
  expect(invalidBody.status()).toBe(400);
  expect(await invalidBody.json()).toEqual({ error: "Invalid account type" });
  const missingName = await request.post(`/api/b/${bookId}/accounts`, { data: { type: "asset" } });
  expect(missingName.status()).toBe(400);
  expect(await missingName.json()).toEqual({ error: "Name and type are required" });
  const sessionToken = (await request.storageState()).cookies.find((cookie) => cookie.name === "counterpoise_session")?.value;
  expect(sessionToken).toBeTruthy();
  const malformed = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `counterpoise_session=${sessionToken}` },
    body: "{",
  });
  expect(malformed.status).toBe(500);
  expect(await malformed.json()).toEqual({ error: "Failed to create account" });
  const otherBook = await request.post("/api/books", { data: { name: `Other ${randomUUID()}` } });
  expect(otherBook.status()).toBe(200);
  const otherBookId = (await otherBook.json()).id as number;
  try {
    const otherParent = await request.post(`/api/b/${otherBookId}/accounts`, {
      data: { name: "Other Parent", type: "asset" },
    });
    expect(otherParent.status()).toBe(200);
    const foreignParent = await request.post(`/api/b/${bookId}/accounts`, {
      data: { name: "Child", type: "asset", parentId: (await otherParent.json()).id },
    });
    expect(foreignParent.status()).toBe(400);
    expect(await foreignParent.json()).toEqual({ error: "Invalid parentId" });
  } finally {
    const cleanup = await request.delete(`/api/books/${otherBookId}`);
    expect(cleanup.status()).toBe(200);
  }
  const protectedFields = await request.post(`/api/b/${bookId}/accounts`, {
    data: { name: "Protected", type: "asset", bookId: 999999999, id: 999999999 },
  });
  expect(protectedFields.status()).toBe(200);
  const protectedRow = await protectedFields.json() as { id: number; bookId: number; name: string };
  expect(protectedRow).toMatchObject({ bookId, name: "Protected" });
  expect(protectedRow.id).not.toBe(999999999);
  expect(await scalar("SELECT book_id FROM accounts WHERE id = $1", [protectedRow.id])).toBe(bookId);
  const missing = await request.get("/api/b/999999/accounts");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: "Book not found" });
  const invalidBook = await request.get("/api/b/not-a-book/accounts");
  expect(invalidBook.status()).toBe(400);
  expect(await invalidBook.json()).toEqual({ error: "Invalid book ID" });
  const unauthenticated = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`);
  expect(unauthenticated.status).toBe(401);
  // The shared Next proxy rejects a missing cookie before either server runs.
  expect(await unauthenticated.json()).toEqual({ error: "Unauthorized" });
});

test("cookie sessions and API keys honor book membership", async ({ request, bookId }) => {
  const username = `viewer-${randomUUID()}`;
  const key = `cpk_${randomBytes(24).toString("hex")}`;
  let otherKey = `cpk_${randomBytes(24).toString("hex")}`;
  while (otherKey.slice(0, 8) === key.slice(0, 8)) {
    otherKey = `cpk_${randomBytes(24).toString("hex")}`;
  }
  let viewerId: number | undefined;
  try {
    const viewer = await insert<{ id: number }>("users", { username, passwordHash: "unused" });
    viewerId = viewer.id;
    await insert("book_members", { bookId, userId: viewerId, role: "viewer" });
    await insert("api_keys", {
      userId: viewerId, name: "rust-spike", keyHash: await hashApiKey(key), keyPrefix: key.slice(0, 8),
    });
    await insert("api_keys", {
      userId: viewerId, name: "rust-spike-other", keyHash: await hashApiKey(otherKey), keyPrefix: otherKey.slice(0, 8),
    });

    const own = await request.get(`/api/b/${bookId}/accounts`);
    expect(own.status()).toBe(200);

    const viewerRead = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(viewerRead.status).toBe(200);
    expect(await viewerRead.json()).toEqual([]);

    const viewerWrite = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Denied", type: "asset" }),
    });
    expect(viewerWrite.status).toBe(403);
    expect(await viewerWrite.json()).toEqual({ error: "You have read-only access to this book" });

    const viewerOwner = await fetch(`http://127.0.0.1:3001/api/books/${bookId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Denied" }),
    });
    expect(viewerOwner.status).toBe(403);
    expect(await viewerOwner.json()).toEqual({ error: "Only an owner can do this" });

    const otherBook = await fetch("http://127.0.0.1:3001/api/b/1/accounts", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(otherBook.status).toBe(404);
    expect(await otherBook.json()).toEqual({ error: "Book not found" });

    const wrongKey = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
      headers: { authorization: `Bearer cpk_${"0".repeat(48)}` },
    });
    expect(wrongKey.status).toBe(401);
    expect(await wrongKey.json()).toEqual({ error: "Not authenticated" });

    const wrongSamePrefix = `${key.slice(0, 8)}${key[8] === "0" ? "1" : "0"}${key.slice(9)}`;
    const malformedSamePrefix = `${key.slice(0, 8)}g${key.slice(9)}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      // Exercise real hash mismatches, then reach the same IP/prefix limit
      // without making this test depend on 20 serial scrypt runtimes.
      const candidate = attempt < 2 ? wrongSamePrefix : malformedSamePrefix;
      const denied = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
        headers: { authorization: `Bearer ${candidate}`, "x-forwarded-for": "198.51.100.9" },
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ error: "Not authenticated" });
    }
    const lockedValidKey = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
      headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "198.51.100.9" },
    });
    expect(lockedValidKey.status).toBe(401);
    expect(await lockedValidKey.json()).toEqual({ error: "Not authenticated" });
    const otherPrefix = await fetch(`http://127.0.0.1:3001/api/b/${bookId}/accounts`, {
      headers: { authorization: `Bearer ${otherKey}`, "x-forwarded-for": "198.51.100.9" },
    });
    expect(otherPrefix.status).toBe(200);
    expect(await otherPrefix.json()).toEqual([]);
  } finally {
    if (viewerId !== undefined) await exec("DELETE FROM users WHERE id = $1", [viewerId]);
  }
});

test("cron bearer and login lockout denial bodies match the Rust adapters", async ({ request }) => {
  const missingCron = await request.get("/api/cron/typesafe-cleanup");
  expect(missingCron.status()).toBe(401);
  expect(await missingCron.json()).toEqual({ error: "Unauthorized" });
  const wrongCron = await request.get("/api/cron/typesafe-cleanup", {
    headers: { authorization: "Bearer wrong" },
  });
  expect(wrongCron.status()).toBe(401);
  expect(await wrongCron.json()).toEqual({ error: "Unauthorized" });

  const username = `absent-${randomUUID()}`;
  const options = {
    data: { username, password: "wrong-but-valid" },
    headers: { "x-forwarded-for": "203.0.113.77" },
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const denied = await request.post("/api/auth/login", options);
    expect(denied.status()).toBe(401);
    expect(await denied.json()).toEqual({ error: "Invalid username or password" });
  }
  const limited = await request.post("/api/auth/login", options);
  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBe("60");
  expect(await limited.json()).toEqual({ error: "Too many attempts. Try again in 60s." });
});

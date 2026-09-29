import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { securities } from "../../db/schema";
import {
  addBookMember, createBook, createUser, db, resetTestDatabase, setupTestDatabase,
} from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { createInvestmentScenario, stable } from "../helpers/investment-scenario";

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Full bodies are snapshots; see investments.test.ts.
describe("security HTTP parity", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let client: Awaited<ReturnType<typeof sessionHttpClient>>;
  let scenario: Awaited<ReturnType<typeof createInvestmentScenario>>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer());
  }, 120_000);
  beforeEach(async () => {
    await resetTestDatabase();
    client = await sessionHttpClient(baseUrl);
    scenario = await createInvestmentScenario();
  });
  afterAll(async () => { await stop?.(); });

  async function ok(path: string, init?: RequestInit) {
    const response = await client.request(path, init);
    expect(response.status, path).toBe(200);
    return response.json();
  }

  async function expectError(path: string, init: RequestInit, status: number, error: string) {
    const response = await client.request(path, init);
    expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(status);
    expect(await response.json()).toEqual({ error });
  }

  it("lists securities by name with book-wide positions and asset-leg income", async () => {
    const list = await ok("/api/b/1/securities");
    expect(list.map((row: { symbol: string }) => row.symbol)).toEqual(["BND", "IDLE", "VTI"]);
    expect(list.find((row: { symbol: string }) => row.symbol === "VTI").incomeCents).toBe(950);
    expect(list.find((row: { symbol: string }) => row.symbol === "IDLE")).toMatchObject({
      sharesMicros: 0, costBasisCents: 0, priceMicros: null, marketValueCents: null, incomeCents: 0,
    });
    expect(stable(list)).toMatchSnapshot();
  });

  it("creates a trimmed security and refuses a case-insensitive duplicate symbol", async () => {
    const created = await ok("/api/b/1/securities", json("POST", {
      name: "﻿ Money Market ", symbol: " mmf", securityType: "mutual_fund",
      fetchPrices: true, fixedPriceMicros: 1_000_000, bookId: 999,
    }));
    expect(created).toMatchObject({
      bookId: 1, name: "Money Market", symbol: "mmf", securityType: "mutual_fund",
      fetchPrices: false, fixedPriceMicros: 1_000_000,
    });
    expect(Math.abs(Date.parse(created.createdAt) - Date.now())).toBeLessThan(60_000);
    const plain = await ok("/api/b/1/securities", json("POST", { name: "Plain", symbol: "PLN", securityType: "stock" }));
    expect(plain).toMatchObject({ fetchPrices: true, fixedPriceMicros: null });
    await expectError("/api/b/1/securities", json("POST", { name: "Again", symbol: " VTi ", securityType: "etf" }),
      409, `A security with symbol "VTi" already exists (id ${scenario.vti.id})`);
    for (const [body, error] of [
      [[], "Name is required"],
      [{ name: " ", symbol: "X", securityType: "etf" }, "Name is required"],
      [{ name: "A" }, "Symbol is required"],
      [{ name: "A", symbol: "B" }, "securityType must be one of: etf, mutual_fund, stock"],
      [{ name: "A", symbol: "B", securityType: "etf", fetchPrices: null }, "fetchPrices must be a boolean"],
      [{ name: "A", symbol: "B", securityType: "etf", fixedPriceMicros: 1.5 }, "fixedPriceMicros must be a positive whole number of micros"],
    ] as const) {
      await expectError("/api/b/1/securities", json("POST", body), 400, error);
    }
    await expectError("/api/b/1/securities", { method: "POST", body: "{" }, 500, "Failed to create security");
    // The symbol check trims first, so a trailing space still clashes.
    await expectError("/api/b/1/securities", json("POST", { name: "Plain", symbol: "PLN ", securityType: "stock" }),
      409, `A security with symbol "PLN" already exists (id ${plain.id})`);
  });

  it("reads, updates, and deletes one security with the Node errors", async () => {
    const path = `/api/b/1/securities/${scenario.idle.id}`;
    expect(stable(await ok(path))).toMatchSnapshot("read");
    expect((await ok(`/api/b/1/securities/${scenario.idle.id}abc`)).id).toBe(scenario.idle.id);
    await expectError("/api/b/1/securities/abc", {}, 400, "Invalid security id");
    await expectError("/api/b/1/securities/999999", {}, 404, "Security not found");
    await expectError("/api/b/1/securities/3000000000", {}, 500, "Failed to fetch security");

    const updated = await ok(path, json("PUT", { name: " Renamed ", fixedPriceMicros: 2_000_000, fetchPrices: true }));
    expect(updated).toMatchObject({ name: "Renamed", symbol: "IDLE", fetchPrices: false, fixedPriceMicros: 2_000_000 });
    const cleared = await ok(path, json("PUT", { fixedPriceMicros: null }));
    expect(cleared).toMatchObject({ fetchPrices: false, fixedPriceMicros: null });
    for (const [id, body, status, error] of [
      [scenario.idle.id, null, 400, "Invalid input: expected object, received null"],
      [scenario.idle.id, {}, 400, "No fields to update"],
      [scenario.idle.id, { symbol: " " }, 400, "Symbol is required"],
      [scenario.idle.id, { fetchPrices: "x" }, 400, "Fetch prices must be a boolean"],
      [scenario.idle.id, { securityType: null }, 400, "securityType must be one of: etf, mutual_fund, stock"],
      [scenario.idle.id, { symbol: "vti" }, 500, "Failed to update security"],
      ["abc", { name: "X" }, 400, "Invalid security id"],
      ["abc", null, 400, "Invalid security id"],
      ["999999", { name: "X" }, 404, "Security not found"],
      ["3000000000", {}, 400, "No fields to update"],
      ["3000000000", { name: "X" }, 500, "Failed to update security"],
    ] as const) {
      await expectError(`/api/b/1/securities/${id}`, json("PUT", body), status, error);
    }
    await expectError(path, { method: "PUT", body: "{" }, 500, "Failed to update security");

    await expectError(`/api/b/1/securities/${scenario.vti.id}`, { method: "DELETE" }, 400,
      "Cannot delete security with investment transactions");
    await expectError("/api/b/1/securities/999999", { method: "DELETE" }, 404, "Security not found");
    await expectError("/api/b/1/securities/abc", { method: "DELETE" }, 400, "Invalid security id");
    expect(await ok(path, { method: "DELETE" })).toEqual({ success: true });
    expect(await db.select().from(securities).where(eq(securities.id, scenario.idle.id))).toEqual([]);
  });

  it("returns detail with per-account positions, lot basis, and newest-first splits", async () => {
    const detail = await ok(`/api/b/1/securities/${scenario.vti.id}/detail`);
    expect(detail.security).toMatchObject({ symbol: "VTI", latestPriceMicros: 120_333_333, latestPriceDate: "2025-06-02" });
    expect(detail.positionsByAccount.map((row: { accountName: string }) => row.accountName))
      .toEqual(["Brokerage", "Closed Brokerage"]);
    expect(stable(detail)).toMatchSnapshot("vti");
    const fixed = await ok(`/api/b/1/securities/${scenario.bnd.id}/detail`);
    expect(stable(fixed.security)).toMatchObject({ latestPriceMicros: 1_000_000, latestPriceDate: "<today>" });
    expect(stable(fixed)).toMatchSnapshot("bnd");
    await expectError("/api/b/1/securities/abc/detail", {}, 400, "Invalid security id");
    await expectError("/api/b/1/securities/999999/detail", {}, 404, "Security not found");
  });

  it("lists open lots oldest first", async () => {
    const lots = await ok(`/api/b/1/securities/${scenario.vti.id}/lots`);
    expect(lots.length).toBeGreaterThan(0);
    expect(lots.every((lot: { sharesMicros: number }) => lot.sharesMicros > 0)).toBe(true);
    expect(lots).toMatchSnapshot();
    await expectError("/api/b/1/securities/999999/lots", {}, 404, "Security not found");
  });

  it("pages investment splits and adds the cash amount of income rows", async () => {
    const path = `/api/b/1/securities/${scenario.vti.id}/splits`;
    const first = await ok(`${path}?limit=3`);
    expect(first).toMatchObject({ totalCount: 14, hasMore: true });
    expect(first.splits).toHaveLength(3);
    const income = first.splits.find((row: { action: string }) => row.action === "dividend");
    expect(income.cashAmountCents).toBe(950);
    expect(first.splits.find((row: { action: string }) => row.action !== "dividend")).not.toHaveProperty("cashAmountCents");
    expect(stable(first)).toMatchSnapshot("first page");
    expect(stable(await ok(`${path}?limit=4&offset=12`))).toMatchSnapshot("last page");
    expect(await ok(`${path}?limit=1e300&offset=-1`)).toEqual(await ok(path));
    expect((await ok(`${path}?limit=1000`)).splits).toHaveLength(14);
    // Number() trims U+FEFF, and U+0085 makes the value NaN, so the default applies.
    expect((await ok(`${path}?limit=%EF%BB%BF3`)).splits).toHaveLength(3);
    expect((await ok(`${path}?limit=%C2%853`)).splits).toHaveLength(14);
    await expectError("/api/b/1/securities/999999/splits", {}, 404, "Security not found");
  });

  it("denies viewers every security write", async () => {
    const owner = await createUser({ username: "owner" });
    const shared = await createBook({ name: "Shared", userId: owner.id });
    await addBookMember({ bookId: shared.id, userId: 1, role: "viewer" });
    const readOnly = "You have read-only access to this book";
    expect(await ok(`/api/b/${shared.id}/securities`)).toEqual([]);
    await expectError(`/api/b/${shared.id}/securities`, { method: "POST", body: "{" }, 403, readOnly);
    await expectError(`/api/b/${shared.id}/securities/1`, json("PUT", { name: "X" }), 403, readOnly);
    await expectError(`/api/b/${shared.id}/securities/1`, { method: "DELETE" }, 403, readOnly);
  });
});

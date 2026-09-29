import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";
import { createInvestmentScenario, stable } from "../helpers/investment-scenario";
import { contract } from "../helpers/contract";

const accountMarketValueListSchema = contract("AccountMarketValueList");

// Each full body is a snapshot. The snapshots were recorded while Node and
// Rust gave the same bodies, so a change to a body fails here. The explicit
// assertions name the rules that matter most.
describe("investment and realized-gain HTTP parity", () => {
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

  async function ok(path: string) {
    const response = await client.request(path);
    expect(response.status, path).toBe(200);
    return response.json();
  }

  async function expectError(path: string, status: number, error: string) {
    const response = await client.request(path);
    expect(response.status, path).toBe(status);
    expect(await response.json()).toEqual({ error });
  }

  it("reports positions from the split replay with lot cost basis", async () => {
    const book = await ok("/api/b/1/investments/positions");
    expect(book.map((row: { securitySymbol: string }) => row.securitySymbol)).toEqual(["BND", "VTI"]);
    const bnd = book.find((row: { securitySymbol: string }) => row.securitySymbol === "BND");
    expect(bnd).toMatchObject({ priceMicros: 1_000_000, sharesMicros: 2_500_000, marketValueCents: 250 });
    expect(stable(book)).toMatchSnapshot("book");
    const brokerage = await ok(`/api/b/1/investments/positions?accountId=${scenario.brokerage.id}`);
    expect(stable(brokerage)).toMatchSnapshot("brokerage");
    expect(await ok("/api/b/1/investments/positions?accountId=0")).toEqual(book);
    expect(await ok("/api/b/1/investments/positions?accountId=-3")).toEqual([]);
    expect(await ok(`/api/b/1/investments/positions?accountId=0x${scenario.ira.id.toString(16)}`))
      .toEqual(await ok(`/api/b/1/investments/positions?accountId=${scenario.ira.id}`));
    // Number() trims JavaScript whitespace: U+FEFF but not U+0085.
    expect(await ok(`/api/b/1/investments/positions?accountId=%EF%BB%BF${scenario.brokerage.id}`)).toEqual(brokerage);
    for (const value of ["", "abc", "5.5", "1e20", "Infinity", "inf", "%C2%85", `%C2%85${scenario.brokerage.id}`]) {
      await expectError(`/api/b/1/investments/positions?accountId=${value}`, 400, "Invalid accountId");
    }
    await expectError("/api/b/1/investments/positions?accountId=3000000000", 500, "Failed to fetch positions");
  });

  it("values each account at the latest price, with an optional as-of date", async () => {
    const values = await ok("/api/b/1/investments/account-values");
    expect(accountMarketValueListSchema.safeParse(values).success).toBe(true);
    expect(values).toMatchSnapshot("today");
    const early = await ok("/api/b/1/investments/account-values?asOfDate=2024-02-29");
    expect(early).toMatchSnapshot("before split");
    expect(await ok("/api/b/1/investments/account-values?asOfDate=")).toEqual(values);
    await expectError("/api/b/1/investments/account-values?asOfDate=2025-02-30", 400, "Invalid ISO date");
  });

  it("reports realized gains per allocation, unallocated shares, and totals", async () => {
    const report = await ok("/api/b/1/reports/realized-gains");
    expect(report.rows.map((row: { term: string }) => row.term)).toEqual(
      expect.arrayContaining(["short", "long", "unknown"])
    );
    expect(report.totals.unknownBasisRows).toBe(1);
    const boundary = report.rows
      .filter((row: { accountName: string }) => row.accountName === "Closed Brokerage")
      .map((row: { sellDate: string; term: string }) => `${row.sellDate} ${row.term}`);
    expect(boundary).toEqual([
      "2025-02-20 short", "2025-02-21 long", "2025-03-01 short", "2025-03-02 long",
    ]);
    expect(stable(report)).toMatchSnapshot("all");
    expect(stable(await ok("/api/b/1/reports/realized-gains?startDate=2025-01-01&endDate=2025-12-31"))).toMatchSnapshot("2025");
    expect(stable(await ok(`/api/b/1/reports/realized-gains?accountId=${scenario.ira.id}`))).toMatchSnapshot("ira");
    expect(await ok(`/api/b/1/reports/realized-gains?accountId=%EF%BB%BF${scenario.ira.id}%C2%A0`))
      .toEqual(await ok(`/api/b/1/reports/realized-gains?accountId=${scenario.ira.id}`));
    expect(await ok(`/api/b/1/reports/realized-gains?accountId=%20${scenario.ira.id}%20`))
      .toEqual(await ok(`/api/b/1/reports/realized-gains?accountId=${scenario.ira.id}`));
    for (const [query, status, error] of [
      ["startDate=bad&accountId=x", 400, "Invalid ISO date"],
      ["startDate=2025-01-01&accountId=x", 400, "Both startDate and endDate are required"],
      ["accountId=1.5", 400, "Invalid accountId"],
      ["accountId=0", 400, "Invalid accountId"],
      ["accountId=1e20", 500, "Failed to generate realized gains report"],
      [`accountId=%C2%85${scenario.ira.id}`, 400, "Invalid accountId"],
    ] as const) {
      await expectError(`/api/b/1/reports/realized-gains?${query}`, status, error);
    }
  });

  it("hides other books and requires a session", async () => {
    for (const path of [
      "/api/b/999999/investments/positions", "/api/b/999999/investments/account-values",
      "/api/b/999999/reports/realized-gains",
    ]) {
      await expectError(path, 404, "Book not found");
    }
    expect((await client.anonymous("/api/b/1/investments/positions")).status).toBe(401);
  });
});

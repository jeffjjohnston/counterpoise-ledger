import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDatabase, resetTestDatabase, createAccount, createSecurity } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";
import { transactions, transactionSplits, investmentSplits, investmentLots, investmentLotAllocations, payees } from "@/db/schema";

vi.mock("@/lib/api-auth", async () => {
  const { mockApiAuth } = await import("@/tests/helpers/db");
  return mockApiAuth();
});
const { POST } = await import("@/app/api/b/[bookId]/transactions/route");
const { PUT } = await import("@/app/api/b/[bookId]/transactions/[id]/route");

const request = (body: object, method = "POST") => new Request("http://localhost/api/transactions", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const params = (id?: number) => ({ params: Promise.resolve({ bookId: "1", id: String(id) }) });

async function ledger() {
  return {
    transactions: await db.select().from(transactions).orderBy(transactions.id),
    splits: await db.select().from(transactionSplits).orderBy(transactionSplits.id),
    investments: await db.select().from(investmentSplits).orderBy(investmentSplits.id),
    lots: await db.select().from(investmentLots).orderBy(investmentLots.id),
    allocations: await db.select().from(investmentLotAllocations).orderBy(investmentLotAllocations.id),
    payees: await db.select().from(payees).orderBy(payees.id),
  };
}

// A sequence is deliberately nontransactional: is_called proves the trigger
// ran even when every ledger write it followed was rolled back.
async function failDuringLotInsert() {
  await db.execute(sql`CREATE SEQUENCE atomicity_probe`);
  await db.execute(sql`
    CREATE FUNCTION fail_lot_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('atomicity_probe');
      RAISE EXCEPTION 'injected lot insert failure';
    END $$`);
  await db.execute(sql`
    CREATE TRIGGER fail_lot_insert BEFORE INSERT ON investment_lots
    FOR EACH ROW EXECUTE FUNCTION fail_lot_insert()`);
}

describe("transaction writes roll back after persistence has begun", () => {
  beforeAll(setupTestDatabase);
  beforeEach(async () => {
    await resetTestDatabase();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS fail_lot_insert ON investment_lots`);
    await db.execute(sql`DROP FUNCTION IF EXISTS fail_lot_insert()`);
    await db.execute(sql`DROP SEQUENCE IF EXISTS atomicity_probe`);
  });

  async function buy() {
    const brokerage = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment" });
    const cash = await createAccount({ name: "Cash", type: "asset", subtype: "bank" });
    const security = await createSecurity({ name: "Fund", symbol: "FUND", securityType: "etf" });
    return {
      date: "2025-01-15", description: "Original buy", payeeName: "Original broker",
      splits: [{ accountId: brokerage.id, amount: 5000 }, { accountId: cash.id, amount: -5000 }],
      investmentSplits: [{ securityId: security.id, action: "buy", sharesMicros: 1_000_000, priceMicros: 50_000_000, feesCents: 0 }],
    };
  }

  it.each(["create", "update"] as const)("rolls back the entire ledger when %s fails during lot rebuilding", async (operation) => {
    const body = await buy();
    let id: number | undefined;
    if (operation === "update") {
      const created = await POST(request(body), params());
      expect(created.status).toBe(200);
      id = (await created.json()).id;
      expect((await ledger()).lots).toHaveLength(1);
    }
    const before = await ledger();
    await failDuringLotInsert();

    const changed = { ...body, description: "Must not persist", payeeName: "Must not persist either" };
    const response = operation === "create"
      ? await POST(request(changed), params())
      : await PUT(request(changed, "PUT"), params(id));

    expect(response.status).toBe(500);
    const probe = await db.execute<{ is_called: boolean }>(sql`SELECT is_called FROM atomicity_probe`);
    expect(probe[0].is_called, "the injected failure must be reached after validation").toBe(true);
    expect(await ledger()).toEqual(before);
  });

  it("rejects a foreign account before writing anything", async () => {
    const body = await buy();
    const before = await ledger();
    body.splits[1].accountId = 999999;
    const response = await POST(request(body), params());
    expect(response.status).toBe(400);
    expect(await ledger()).toEqual(before);
  });

  it("rejects a foreign security before writing anything", async () => {
    const body = await buy();
    const before = await ledger();
    body.investmentSplits[0].securityId = 999999;
    const response = await POST(request(body), params());
    expect(response.status).toBe(400);
    expect(await ledger()).toEqual(before);
  });
});

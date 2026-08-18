import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/tests/helpers/db-utils";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createSecurity,
  createInvestmentLot,
} from "@/tests/helpers/db";
import { investmentLots } from "@/db/schema";

describe("investment lot schema", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("stores a lot with account, acquisition date, and quantities", async () => {
    const book = await createBook({ name: "B" });
    const account = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
      bookId: book.id,
    });
    const security = await createSecurity({
      name: "Vanguard Total",
      symbol: "VTI",
      securityType: "etf",
      bookId: book.id,
    });

    const lot = await createInvestmentLot({
      bookId: book.id,
      accountId: account.id,
      securityId: security.id,
      acquiredDate: "2024-03-01",
      originalSharesMicros: 100_000_000,
      originalBasisCents: 100_000,
    });

    const [stored] = await db.select().from(investmentLots).where(eq(investmentLots.id, lot.id));

    expect(stored.accountId).toBe(account.id);
    expect(stored.acquiredDate).toBe("2024-03-01");
    expect(stored.originalSharesMicros).toBe(100_000_000);
    expect(stored.remainingSharesMicros).toBe(100_000_000);
    expect(stored.remainingBasisCents).toBe(100_000);
  });
});

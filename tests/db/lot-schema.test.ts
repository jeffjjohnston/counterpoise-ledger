import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  setupTestDatabase,
  resetTestDatabase,
  createBook,
  createAccount,
  createSecurity,
  createInvestmentLot,
} from "@/tests/helpers/db-utils";
import { exec, row } from "@/tests/helpers/sql";
import type { InvestmentLot } from "@/types/db";

describe("investment lot schema", () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function fixtures() {
    const book = await createBook({ name: "B" });
    const account = await createAccount({ name: "Brokerage", type: "asset", subtype: "investment", bookId: book.id });
    const security = await createSecurity({ name: "Vanguard Total", symbol: "VTI", securityType: "etf", bookId: book.id });
    return { book, account, security };
  }

  it("stores a lot with account, acquisition date, and quantities", async () => {
    const { book, account, security } = await fixtures();
    const lot = await createInvestmentLot({
      bookId: book.id,
      accountId: account.id,
      securityId: security.id,
      acquiredDate: "2024-03-01",
      originalSharesMicros: 100_000_000,
      originalBasisCents: 100_000,
    });

    const stored = await row<InvestmentLot>("SELECT * FROM investment_lots WHERE id = $1", [lot.id]);

    expect(stored.accountId).toBe(account.id);
    expect(stored.acquiredDate).toBe("2024-03-01");
    expect(stored.originalSharesMicros).toBe(100_000_000);
    expect(stored.remainingSharesMicros).toBe(100_000_000);
    expect(stored.remainingBasisCents).toBe(100_000);
  });

  it("deletes the lots with their account", async () => {
    const { book, account, security } = await fixtures();
    await createInvestmentLot({
      bookId: book.id,
      accountId: account.id,
      securityId: security.id,
      acquiredDate: "2024-03-01",
      originalSharesMicros: 1_000_000,
      originalBasisCents: 100,
    });
    await exec("DELETE FROM accounts WHERE id = $1", [account.id]);
    expect(await row("SELECT COUNT(*) AS n FROM investment_lots")).toEqual({ n: 0 });
  });
});

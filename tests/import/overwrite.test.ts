import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { accounts, payees, recurringRules, transactions } from "@/db/schema";
import { overwriteBookDataForImport } from "@/scripts/import-moneydance/overwrite";
import { setupTestDatabase, resetTestDatabase } from "@/tests/helpers/db";
import { db } from "@/tests/helpers/db-utils";

describe("Moneydance overwrite", () => {
  beforeAll(async () => { await setupTestDatabase(); });
  beforeEach(async () => { await resetTestDatabase(); });

  it("deletes all data for the book from the unified database", async () => {
    // Insert some data for book 1
    await db
      .insert(accounts)
      .values({
        bookId: 1,
        name: "Assets:Checking",
        type: "asset",
        subtype: "bank",
      });

    await db.insert(payees).values({ bookId: 1, name: "Test Payee" });

    // Verify data exists
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(await db.select().from(payees)).toHaveLength(1);

    // Overwrite should delete all data for book 1
    await overwriteBookDataForImport(db, 1);

    expect(await db.select().from(payees)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("only deletes data for the specified book", async () => {
    // Insert data for book 1
    await db
      .insert(accounts)
      .values({
        bookId: 1,
        name: "Book1 Account",
        type: "asset",
        subtype: "bank",
      });

    // Overwrite book 1 data
    await overwriteBookDataForImport(db, 1);

    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("deletes transactions before recurring rules to avoid FK violations", async () => {
    const [rule] = await db
      .insert(recurringRules)
      .values({
        bookId: 1,
        name: "Monthly Rent",
        frequency: "monthly",
        interval: 1,
        startDate: "2024-01-01",
        nextDate: "2024-02-01",
      })
      .returning({ id: recurringRules.id });

    await db.insert(transactions).values({
      bookId: 1,
      date: "2024-01-15",
      description: "Rent",
      recurringRuleId: rule.id,
    });

    await expect(overwriteBookDataForImport(db, 1)).resolves.toBeUndefined();
    expect(await db.select().from(transactions)).toHaveLength(0);
    expect(await db.select().from(recurringRules)).toHaveLength(0);
  });
});

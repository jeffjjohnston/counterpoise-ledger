import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql, eq } from "drizzle-orm";
import {
  setupTestDatabase,
  resetTestDatabase,
  createAccount,
  createSecurity,
  createTransactionWithSplits,
  createInvestmentSplit,
  db,
} from "@/tests/helpers/db-utils";
import { investmentSplits } from "@/db/schema";

const MIGRATIONS_DIR = join(process.cwd(), "db", "migrations");

function loadBackfillMigrationSql(): string {
  // readdirSync order isn't guaranteed across filesystems, and more than one
  // matching migration could exist in future. Sort by the numeric prefix and
  // take the latest so selection is deterministic and explicit.
  const file = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /backfill.*dividend.*account.*\.sql$/i.test(name))
    .sort()
    .at(-1);
  if (!file) {
    throw new Error("Backfill dividend-account migration file not found");
  }
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

async function runBackfillMigration() {
  const content = loadBackfillMigrationSql();
  const statements = content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function getAccountId(splitId: number): Promise<number | null> {
  const [row] = await db
    .select({ accountId: investmentSplits.accountId })
    .from(investmentSplits)
    .where(eq(investmentSplits.id, splitId));
  return row.accountId;
}

describe("backfill dividend/capGain/fee investment-split accountId", () => {
  const bookId = 1;
  let investmentAcct: Awaited<ReturnType<typeof createAccount>>;
  let cashAcct: Awaited<ReturnType<typeof createAccount>>;
  let incomeAcct: Awaited<ReturnType<typeof createAccount>>;
  let expenseAcct: Awaited<ReturnType<typeof createAccount>>;
  let security: Awaited<ReturnType<typeof createSecurity>>;

  beforeAll(async () => {
    await setupTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    investmentAcct = await createAccount({
      name: "Brokerage",
      type: "asset",
      subtype: "investment",
      bookId,
    });
    cashAcct = await createAccount({
      name: "Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: investmentAcct.id,
      isInvestmentCash: true,
      bookId,
    });
    incomeAcct = await createAccount({
      name: "Dividend Income",
      type: "income",
      subtype: "other",
      bookId,
    });
    expenseAcct = await createAccount({
      name: "Investment Fees",
      type: "expense",
      subtype: "other",
      bookId,
    });
    security = await createSecurity({
      name: "Vanguard Total Stock",
      symbol: "VTI",
      securityType: "etf",
      bookId,
    });
  });

  it("resolves a legacy null dividend split to the cash leg's parent brokerage account", async () => {
    const txn = await createTransactionWithSplits({
      date: "2025-03-15",
      description: "VTI Dividend",
      bookId,
      splits: [
        { accountId: cashAcct.id, amount: 1500 },
        { accountId: incomeAcct.id, amount: -1500 },
      ],
    });
    const split = await createInvestmentSplit({
      transactionId: txn.id,
      accountId: null,
      securityId: security.id,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
      bookId,
    });

    await runBackfillMigration();

    expect(await getAccountId(split.id)).toBe(investmentAcct.id);
  });

  it("resolves legacy null capGain and fee splits the same way", async () => {
    const capGainTxn = await createTransactionWithSplits({
      date: "2025-03-15",
      bookId,
      splits: [
        { accountId: cashAcct.id, amount: 2500 },
        { accountId: incomeAcct.id, amount: -2500 },
      ],
    });
    const capGainSplit = await createInvestmentSplit({
      transactionId: capGainTxn.id,
      accountId: null,
      securityId: security.id,
      action: "capGain",
      sharesMicros: 0,
      priceMicros: 0,
      bookId,
    });

    const feeTxn = await createTransactionWithSplits({
      date: "2025-03-16",
      bookId,
      splits: [
        { accountId: expenseAcct.id, amount: 500 },
        { accountId: cashAcct.id, amount: -500 },
      ],
    });
    const feeSplit = await createInvestmentSplit({
      transactionId: feeTxn.id,
      accountId: null,
      securityId: security.id,
      action: "fee",
      sharesMicros: 0,
      priceMicros: 0,
      feesCents: 500,
      bookId,
    });

    await runBackfillMigration();

    expect(await getAccountId(capGainSplit.id)).toBe(investmentAcct.id);
    expect(await getAccountId(feeSplit.id)).toBe(investmentAcct.id);
  });

  it("leaves accountId null when the cash leg is not an investment-cash account", async () => {
    const checking = await createAccount({
      name: "Plain Checking",
      type: "asset",
      subtype: "bank",
      bookId,
    });
    const txn = await createTransactionWithSplits({
      date: "2025-03-15",
      bookId,
      splits: [
        { accountId: checking.id, amount: 1500 },
        { accountId: incomeAcct.id, amount: -1500 },
      ],
    });
    const split = await createInvestmentSplit({
      transactionId: txn.id,
      accountId: null,
      securityId: security.id,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
      bookId,
    });

    await runBackfillMigration();

    expect(await getAccountId(split.id)).toBeNull();
  });

  it("does not touch buy/sell splits that already have an accountId", async () => {
    const txn = await createTransactionWithSplits({
      date: "2025-03-01",
      bookId,
      splits: [
        { accountId: investmentAcct.id, amount: 50000 },
        { accountId: cashAcct.id, amount: -50000 },
      ],
    });
    const split = await createInvestmentSplit({
      transactionId: txn.id,
      accountId: investmentAcct.id,
      securityId: security.id,
      action: "buy",
      sharesMicros: 10_000_000,
      priceMicros: 50_000_000,
      bookId,
    });

    await runBackfillMigration();

    expect(await getAccountId(split.id)).toBe(investmentAcct.id);
  });

  it("is idempotent when run twice", async () => {
    const txn = await createTransactionWithSplits({
      date: "2025-03-15",
      bookId,
      splits: [
        { accountId: cashAcct.id, amount: 1500 },
        { accountId: incomeAcct.id, amount: -1500 },
      ],
    });
    const split = await createInvestmentSplit({
      transactionId: txn.id,
      accountId: null,
      securityId: security.id,
      action: "dividend",
      sharesMicros: 0,
      priceMicros: 0,
      bookId,
    });

    await runBackfillMigration();
    await runBackfillMigration();

    expect(await getAccountId(split.id)).toBe(investmentAcct.id);
  });
});

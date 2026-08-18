import { describe, expect, it, beforeAll } from "vitest";
import { getDb } from "@/db";
import { seed } from "@/db/seed";
import {
  accounts,
  transactions,
  transactionSplits,
  investmentSplits,
  investmentLots,
  investmentLotAllocations,
  payees,
  securities,
  plaidTokens,
  plaidAccounts,
  plaidTransactionReconciliation,
  recurringRules,
  recurringTemplateSplits,
} from "@/db/schema";
import { sql, eq } from "drizzle-orm";
import { resolveAccountIcon } from "@/lib/accounting";

describe("seed", () => {
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    await seed();
    db = getDb();
  }, 120_000);

  it("creates expected account count", async () => {
    const [result] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(accounts);
    expect(result.count).toBe(62);
  });

  it("creates expected payee count", async () => {
    const [result] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(payees);
    expect(result.count).toBe(46);
  });

  it("creates expected transaction count", async () => {
    const [result] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(transactions);
    // 2232 before the year-end rebalance sells were added; one per year of the
    // 2023-2025 span, so 2235.
    expect(result.count).toBe(2235);
  });

  it("creates securities", async () => {
    const [result] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(securities);
    expect(result.count).toBe(4);
  });

  describe("category icons", () => {
    let categories: Array<{
      id: number;
      name: string;
      type: string;
      icon: string | null;
      parentId: number | null;
    }>;

    beforeAll(async () => {
      categories = await db
        .select({
          id: accounts.id,
          name: accounts.name,
          type: accounts.type,
          icon: accounts.icon,
          parentId: accounts.parentId,
        })
        .from(accounts);
    });

    const byName = (name: string) => {
      const account = categories.find((candidate) => candidate.name === name);
      if (!account) throw new Error(`No seeded account named "${name}"`);
      return account;
    };

    it("gives top-level categories their own icon", () => {
      expect(byName("Food").icon).toBe("🍔");
      expect(byName("Salary").icon).toBe("💰");
    });

    it("leaves an inheriting child null so it resolves to its parent", () => {
      const groceries = byName("Food:Groceries");
      expect(groceries.icon).toBeNull();
      expect(resolveAccountIcon(groceries, categories)).toBe("🍔");
    });

    it("overrides a child whose icon differs from its parent", () => {
      const coffee = byName("Food:Coffee");
      expect(coffee.icon).toBe("☕");
      expect(resolveAccountIcon(coffee, categories)).toBe("☕");
    });

    it("leaves one branch bare so the full-path fallback stays exercised", () => {
      const misc = byName("Miscellaneous");
      expect(misc.icon).toBeNull();
      expect(resolveAccountIcon(misc, categories)).toBeNull();
    });

    it("gives no two top-level categories the same icon", () => {
      // Decision 6 of the design dropped the (icon, leaf) disambiguation rule,
      // on the grounds that two roots sharing an emoji is self-inflicted. Seed
      // data must not be the thing that inflicts it.
      const rootIcons = categories
        .filter(
          (account) =>
            (account.type === "income" || account.type === "expense") &&
            account.parentId === null &&
            account.icon
        )
        .map((account) => account.icon);
      expect(new Set(rootIcons).size).toBe(rootIcons.length);
    });

    it("stores every icon as a single grapheme", () => {
      // The seed writes through Drizzle and so never meets accountIconSchema.
      // A seeded value the icon picker would itself reject is a trap for later,
      // so hold the seed to the same grapheme rule the schema enforces.
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const withIcons = categories.filter((account) => account.icon);
      expect(withIcons.length).toBeGreaterThan(0);
      for (const account of withIcons) {
        expect([...segmenter.segment(account.icon as string)]).toHaveLength(1);
      }
    });
  });

  it("all transaction splits sum to zero", async () => {
    const unbalanced = await db
      .select({
        id: transactions.id,
        total: sql<number>`cast(sum(${transactionSplits.amount}) as integer)`,
      })
      .from(transactions)
      .innerJoin(transactionSplits, eq(transactionSplits.transactionId, transactions.id))
      .groupBy(transactions.id)
      .having(sql`abs(sum(${transactionSplits.amount})) > 1`);

    expect(unbalanced).toHaveLength(0);
  });

  it("creates investment splits and lots", async () => {
    const [splits] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentSplits);
    const [lots] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentLots);

    expect(splits.count).toBeGreaterThan(0);
    expect(lots.count).toBeGreaterThan(0);
  });

  it("seeds sells that draw from more than one lot", async () => {
    // The rebalance sells exist so a seeded book exercises FIFO *allocation*,
    // not merely lot creation. If every sell drew from a single lot, the
    // spanning path — the case the old single-lot-per-sell model could not
    // represent at all — would go unexercised on every seed run.
    const [sells] = await db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(investmentSplits)
      .where(eq(investmentSplits.action, "sell"));
    expect(sells.count).toBeGreaterThan(0);

    const spanning = await db
      .select({ sellSplitId: investmentLotAllocations.sellSplitId })
      .from(investmentLotAllocations)
      .groupBy(investmentLotAllocations.sellSplitId)
      .having(sql`count(*) > 1`);
    expect(spanning.length).toBeGreaterThan(0);
  });

  it("allocates every seeded sell to lots", async () => {
    // An unallocated residual would mean the rebalance oversold its position.
    // The report surfaces that as a "basis unknown" row, so it would be
    // visible rather than silent — but in seeded data it is a bug, not a
    // deliberate data gap.
    const unallocated = await db
      .select({ id: investmentSplits.id })
      .from(investmentSplits)
      .where(
        sql`${investmentSplits.action} = 'sell' and not exists (
          select 1 from investment_lot_allocations a
          where a.sell_split_id = ${investmentSplits.id}
        )`
      );

    expect(unallocated).toHaveLength(0);
  });

  describe("plaid sync demo data", () => {
    it("creates plaid token and account link", async () => {
      const tokens = await db.select().from(plaidTokens);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].financialInstitution).toBe("Chase Bank");
      // The access token is synthetic, so Plaid can only reject it. isDemo is
      // what keeps the scheduled sync from calling Plaid with it every six
      // hours — see the cron's WHERE clause and syncToken's guard.
      expect(tokens[0].isDemo).toBe(true);

      const accts = await db.select().from(plaidAccounts);
      expect(accts).toHaveLength(1);
      expect(accts[0].name).toBe("Chase Sapphire");
      expect(accts[0].counterpoiseAccountId).not.toBeNull();
    });

    it("creates reconciliation items with correct statuses", async () => {
      const items = await db.select().from(plaidTransactionReconciliation);
      expect(items.length).toBeGreaterThanOrEqual(5);

      // All should be pending
      for (const item of items) {
        expect(item.resolutionStatus).toBe("pending");
      }

      // At least one review item
      const reviewItems = items.filter((i) => i.reviewReason !== null);
      expect(reviewItems.length).toBeGreaterThanOrEqual(1);
    });

    it("reconciliation items use correct sign convention (positive = charge)", async () => {
      const items = await db.select().from(plaidTransactionReconciliation);

      // Items that represent charges (not payments) should have positive amountCents
      const charges = items.filter((i) => !i.name.includes("PAYMENT"));
      for (const charge of charges) {
        expect(charge.amountCents).toBeGreaterThan(0);
      }
    });

    it("has at least 2 strong match candidates (exact amount against real transactions)", async () => {
      // Get the plaid account's linked counterpoise account
      const [plaidAcct] = await db.select().from(plaidAccounts);
      const counterpoiseAccountId = plaidAcct.counterpoiseAccountId!;

      // Get reconciliation items and check if their negated amounts match real splits
      const items = await db.select().from(plaidTransactionReconciliation);

      let strongMatches = 0;
      for (const item of items) {
        const expectedAmount = -item.amountCents;
        const matchingSplits = await db
          .select()
          .from(transactionSplits)
          .innerJoin(transactions, eq(transactions.id, transactionSplits.transactionId))
          .where(
            sql`${transactionSplits.accountId} = ${counterpoiseAccountId}
              AND ${transactionSplits.amount} = ${expectedAmount}
              AND abs(${transactions.date}::date - ${item.date}::date) <= 1`
          );

        if (matchingSplits.length > 0) {
          strongMatches++;
        }
      }

      expect(strongMatches).toBeGreaterThanOrEqual(2);
    });
  });

  describe("recurring rules", () => {
    it("creates active rules across more than one frequency", async () => {
      const rules = await db.select().from(recurringRules);

      expect(rules.length).toBeGreaterThanOrEqual(5);
      expect(rules.every((rule) => rule.isActive)).toBe(true);
      expect(new Set(rules.map((rule) => rule.frequency)).size).toBeGreaterThan(1);
    });

    it("gives every rule template splits that sum to zero", async () => {
      const rules = await db.select().from(recurringRules);

      for (const rule of rules) {
        const splits = await db
          .select()
          .from(recurringTemplateSplits)
          .where(eq(recurringTemplateSplits.recurringRuleId, rule.id));

        expect(splits.length, `${rule.name} has no template splits`).toBeGreaterThanOrEqual(2);
        expect(
          splits.reduce((sum, split) => sum + split.amount, 0),
          `${rule.name} template splits do not balance`
        ).toBe(0);
      }
    });

    it("schedules every rule ahead of today", async () => {
      // The seed's transactions are frozen in 2023-2025, so a fixed nextDate
      // would read as months overdue in any book created later — and the
      // hourly recurring cron would immediately post all of them into every
      // demo book. Scheduling forward keeps a fresh book quiet and truthful.
      const rules = await db.select().from(recurringRules);
      const today = new Date().toISOString().slice(0, 10);

      for (const rule of rules) {
        expect(rule.nextDate > today, `${rule.name} is due ${rule.nextDate}`).toBe(true);
      }
    });
  });
});

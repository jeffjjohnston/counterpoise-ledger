import * as schema from "./schema";
import path from "path";
import { fileURLToPath } from "url";
import { getDb, runMigrations, getSqlClient_raw } from "./index";
import { hashPassword } from "../lib/auth";
import { sql, eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { findAllLotPairs, rebuildLots } from "@/lib/lots-db";

const seedVerbose = process.env.NODE_ENV !== "test" || process.env.SEED_VERBOSE === "1";

function logSeed(message: string) {
  if (seedVerbose) {
    console.log(message);
  }
}

export async function seedDefaultMeta(db: AppDb) {
  const passwordHash = await hashPassword("password");
  const [user] = await db
    .insert(schema.users)
    .values({ username: "admin", passwordHash })
    .returning();

  const [book] = await db
    .insert(schema.books)
    .values({ userId: user.id, name: "Family Finances" })
    .returning();

  return { user, book };
}

// ============================================================
// Deterministic PRNG (Mulberry32)
// ============================================================
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(42);

/** Returns a random integer in [min, max] inclusive */
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/** Pick a random element from an array */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ============================================================
// Utility functions
// ============================================================
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

function getInvestmentGrossAmountCents(
  sharesMicros: number,
  priceMicros: number
): number {
  return Math.round((sharesMicros * priceMicros) / 10_000_000_000);
}

// ============================================================
// Main seed function
// ============================================================

/**
 * Seed data into a specific book. The book must already exist.
 * Deletes any existing data in the book before seeding.
 */
export async function seedBook(db: AppDb, bookId: number) {
  logSeed(`Seeding book ${bookId} with realistic 3-year dataset...`);
  const startTime = Date.now();
  rand = mulberry32(42);

  // Delete existing book data (order matters for FK constraints)
  await db.delete(schema.plaidTransactionReconciliation).where(eq(schema.plaidTransactionReconciliation.bookId, bookId));
  await db.delete(schema.plaidAccounts).where(eq(schema.plaidAccounts.bookId, bookId));
  await db.delete(schema.plaidTokens).where(eq(schema.plaidTokens.bookId, bookId));
  await db.delete(schema.investmentSplits).where(eq(schema.investmentSplits.bookId, bookId));
  await db.delete(schema.investmentLots).where(eq(schema.investmentLots.bookId, bookId));
  await db.delete(schema.transactionSplits).where(eq(schema.transactionSplits.bookId, bookId));
  await db.delete(schema.recurringTemplateSplits).where(eq(schema.recurringTemplateSplits.bookId, bookId));
  await db.delete(schema.transactions).where(eq(schema.transactions.bookId, bookId));
  await db.delete(schema.recurringRules).where(eq(schema.recurringRules.bookId, bookId));
  await db.delete(schema.securityPrices).where(eq(schema.securityPrices.bookId, bookId));
  await db.delete(schema.securities).where(eq(schema.securities.bookId, bookId));
  await db.delete(schema.accounts).where(eq(schema.accounts.bookId, bookId));
  await db.delete(schema.payees).where(eq(schema.payees.bookId, bookId));

  logSeed("  Cleared existing book data");

  // ============================================================
  // ACCOUNTS
  // ============================================================

  // --- Assets ---
  const [checking] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Joint Checking", type: "asset", subtype: "bank", isFavorite: true })
    .returning();

  // Brokerage
  const [brokerage] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Joint Brokerage", type: "asset", subtype: "investment", isFavorite: true })
    .returning();
  const [brokerageCash] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Joint Brokerage Cash",
      type: "asset",
      subtype: "cash",
      parentId: brokerage.id,
      isInvestmentCash: true,
    })
    .returning();

  // Sarah 401(k)
  const [sarah401k] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Sarah 401(k)", type: "asset", subtype: "investment" })
    .returning();
  const [sarah401kCash] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Sarah 401(k) Cash",
      type: "asset",
      subtype: "cash",
      parentId: sarah401k.id,
      isInvestmentCash: true,
    })
    .returning();

  // Michael 401(k)
  const [michael401k] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Michael 401(k)", type: "asset", subtype: "investment" })
    .returning();
  const [michael401kCash] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Michael 401(k) Cash",
      type: "asset",
      subtype: "cash",
      parentId: michael401k.id,
      isInvestmentCash: true,
    })
    .returning();

  // Sarah IRA
  const [sarahIra] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Sarah IRA", type: "asset", subtype: "investment" })
    .returning();
  const [sarahIraCash] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Sarah IRA Cash",
      type: "asset",
      subtype: "cash",
      parentId: sarahIra.id,
      isInvestmentCash: true,
    })
    .returning();

  // Michael IRA
  const [michaelIra] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Michael IRA", type: "asset", subtype: "investment" })
    .returning();
  const [michaelIraCash] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Michael IRA Cash",
      type: "asset",
      subtype: "cash",
      parentId: michaelIra.id,
      isInvestmentCash: true,
    })
    .returning();

  logSeed("  Created asset accounts");

  // --- Liabilities ---
  const [chaseSapphire] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Chase Sapphire", type: "liability", subtype: "credit_card", isFavorite: true })
    .returning();
  const [amexBlue] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Amex Blue Cash", type: "liability", subtype: "credit_card" })
    .returning();
  const [citiDouble] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Citi Double Cash", type: "liability", subtype: "credit_card" })
    .returning();
  const [autoLoan] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Honda Auto Loan", type: "liability", subtype: "loan" })
    .returning();

  logSeed("  Created liability accounts");

  // Icons go on the top-level categories. A child keeps `icon: null`, which
  // means "inherit from the parent" — not "no icon". A child sets its own icon
  // only when it differs from the parent, as `Food:Coffee` does. `Investment
  // Fees` and `Miscellaneous` stay without an icon on purpose: they keep the
  // full-path display visible, which is what an unconfigured category shows.
  //
  // Give no two top-level categories the same icon. Two categories with the
  // same icon and the same leaf name show the same row text.

  // --- Income ---
  const [salaryIncome] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Salary", type: "income", icon: "💰" })
    .returning();
  const [investmentIncome] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Investment Income", type: "income", icon: "📈" })
    .returning();
  const [sarahSalary] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Salary:Sarah", type: "income", parentId: salaryIncome.id })
    .returning();
  const [michaelSalary] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Salary:Michael", type: "income", parentId: salaryIncome.id })
    .returning();
  const [dividendIncome] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Investment Income:Dividends",
      type: "income",
      parentId: investmentIncome.id,
    })
    .returning();
  await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Investment Income:Capital Gains",
      type: "income",
      parentId: investmentIncome.id,
    });
  await db
    .insert(schema.accounts)
    .values({ bookId, name: "Interest Income", type: "income", icon: "🏦" });

  logSeed("  Created income accounts");

  // --- Expenses ---
  const [taxes] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Taxes", type: "expense", icon: "🏛️" })
    .returning();
  const [insurance] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Insurance", type: "expense", icon: "🛡️" })
    .returning();
  const [housing] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing", type: "expense", icon: "🏠" })
    .returning();
  const [auto] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Auto", type: "expense", icon: "🚗" })
    .returning();
  const [food] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Food", type: "expense", icon: "🍔" })
    .returning();
  const [shopping] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Shopping", type: "expense", icon: "🛍️" })
    .returning();
  const [personal] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Personal", type: "expense", icon: "🧴" })
    .returning();
  const [interest] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Interest", type: "expense", icon: "💳" })
    .returning();
  const [taxFederal] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Taxes:Federal", type: "expense", parentId: taxes.id })
    .returning();
  const [taxNJ] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Taxes:NJ State", type: "expense", parentId: taxes.id })
    .returning();
  const [taxSS] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Taxes:Social Security", type: "expense", parentId: taxes.id })
    .returning();
  const [taxMedicare] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Taxes:Medicare", type: "expense", parentId: taxes.id })
    .returning();
  const [insHealth] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Insurance:Health", type: "expense", parentId: insurance.id })
    .returning();
  const [insDental] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Insurance:Dental", type: "expense", parentId: insurance.id })
    .returning();
  const [insCar] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Insurance:Car", type: "expense", parentId: insurance.id })
    .returning();
  const [housingRent] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing:Rent", type: "expense", parentId: housing.id })
    .returning();
  const [housingElectric] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing:Electric", type: "expense", parentId: housing.id })
    .returning();
  const [housingGas] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing:Gas", type: "expense", parentId: housing.id })
    .returning();
  const [housingWater] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing:Water", type: "expense", parentId: housing.id })
    .returning();
  const [housingInternet] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Housing:Internet",
      type: "expense",
      parentId: housing.id,
      icon: "🌐",
    })
    .returning();
  const [housingPhone] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Housing:Phone", type: "expense", parentId: housing.id })
    .returning();
  const [autoFuel] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Auto:Fuel", type: "expense", parentId: auto.id })
    .returning();
  const [autoMaintenance] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Auto:Maintenance", type: "expense", parentId: auto.id })
    .returning();
  const [foodGroceries] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Food:Groceries", type: "expense", parentId: food.id })
    .returning();
  const [foodDining] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Food:Dining", type: "expense", parentId: food.id })
    .returning();
  const [foodCoffee] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Food:Coffee", type: "expense", parentId: food.id, icon: "☕" })
    .returning();
  const [entertainment] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Entertainment", type: "expense", icon: "🎬" })
    .returning();
  const [shopClothing] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Shopping:Clothing", type: "expense", parentId: shopping.id })
    .returning();
  const [shopHousehold] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Shopping:Household", type: "expense", parentId: shopping.id })
    .returning();
  const [shopElectronics] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Shopping:Electronics", type: "expense", parentId: shopping.id })
    .returning();
  const [medical] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Medical", type: "expense", icon: "🏥" })
    .returning();
  const [personalGym] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Personal:Gym", type: "expense", parentId: personal.id, icon: "🏋️" })
    .returning();
  const [personalHaircuts] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Personal:Haircuts", type: "expense", parentId: personal.id })
    .returning();
  const [travel] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Travel", type: "expense", icon: "✈️" })
    .returning();
  const [gifts] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Gifts", type: "expense", icon: "🎁" })
    .returning();
  await db
    .insert(schema.accounts)
    .values({ bookId, name: "Investment Fees", type: "expense" });
  const [miscExpense] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Miscellaneous", type: "expense" })
    .returning();
  const [interestCarLoan] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Interest:Car Loan", type: "expense", parentId: interest.id })
    .returning();
  const [streaming] = await db
    .insert(schema.accounts)
    .values({
      bookId,
      name: "Entertainment:Streaming",
      type: "expense",
      parentId: entertainment.id,
      icon: "📺",
    })
    .returning();

  logSeed("  Created expense accounts");

  // --- Equity ---
  const [openingBalances] = await db
    .insert(schema.accounts)
    .values({ bookId, name: "Opening Balances", type: "equity" })
    .returning();

  logSeed("  Created equity account");

  // ============================================================
  // SECURITIES
  // ============================================================
  const [vti] = await db
    .insert(schema.securities)
    .values({ bookId, name: "Vanguard Total Stock Market ETF", symbol: "VTI", securityType: "etf" })
    .returning();
  const [vxus] = await db
    .insert(schema.securities)
    .values({ bookId, name: "Vanguard Total International Stock ETF", symbol: "VXUS", securityType: "etf" })
    .returning();
  const [bnd] = await db
    .insert(schema.securities)
    .values({ bookId, name: "Vanguard Total Bond Market ETF", symbol: "BND", securityType: "etf" })
    .returning();
  const [agg] = await db
    .insert(schema.securities)
    .values({ bookId, name: "iShares Core US Aggregate Bond ETF", symbol: "AGG", securityType: "etf" })
    .returning();

  logSeed("  Created securities");

  // ============================================================
  // SECURITY PRICE HISTORY (monthly Jan 2023 - Dec 2025)
  // ============================================================
  // Approximate month-end prices (realistic trajectories)
  const vtiPrices = [
    // 2023: recovery from 2022 bear market
    194_00, 196_50, 193_80, 200_20, 202_10, 208_50, 213_40, 210_60, 205_30, 211_70, 218_90, 222_50,
    // 2024: continued bull
    225_10, 228_40, 233_70, 236_90, 240_20, 245_60, 249_30, 252_80, 248_50, 255_40, 260_10, 264_80,
    // 2025: moderate growth
    262_30, 267_50, 270_80, 275_10, 272_40, 278_90, 283_50, 280_20, 276_80, 282_40, 288_10, 292_50,
  ];
  const vxusPrices = [
    // 2023
    52_80, 53_40, 51_90, 53_70, 52_80, 54_20, 55_60, 54_30, 52_90, 53_80, 55_10, 55_80,
    // 2024
    56_40, 57_20, 58_10, 58_90, 59_70, 60_50, 61_40, 60_80, 59_50, 60_90, 62_10, 63_00,
    // 2025
    62_50, 63_80, 64_50, 65_30, 64_10, 65_70, 66_80, 66_20, 65_00, 66_40, 67_80, 68_50,
  ];
  const bndPrices = [
    // 2023
    73_20, 72_80, 73_50, 73_90, 73_10, 72_60, 71_90, 71_50, 70_80, 71_40, 72_80, 73_50,
    // 2024
    73_80, 74_20, 74_60, 74_30, 73_90, 74_50, 75_10, 75_60, 75_20, 75_80, 76_30, 76_80,
    // 2025
    77_10, 77_50, 77_90, 78_30, 78_00, 78_60, 79_10, 79_50, 79_20, 79_80, 80_30, 80_80,
  ];
  const aggPrices = [
    // 2023
    98_40, 97_80, 98_60, 99_10, 98_30, 97_70, 96_90, 96_40, 95_70, 96_50, 97_90, 98_60,
    // 2024
    99_00, 99_50, 100_00, 99_70, 99_20, 99_80, 100_50, 101_10, 100_70, 101_30, 101_90, 102_50,
    // 2025
    102_80, 103_30, 103_80, 104_20, 103_90, 104_50, 105_10, 105_60, 105_20, 105_80, 106_40, 107_00,
  ];

  // Convert dollar-cents to priceMicros and insert
  const priceData: Array<{ securityId: number; prices: number[] }> = [
    { securityId: vti.id, prices: vtiPrices },
    { securityId: vxus.id, prices: vxusPrices },
    { securityId: bnd.id, prices: bndPrices },
    { securityId: agg.id, prices: aggPrices },
  ];

  const priceRows: Array<{
    bookId: number;
    securityId: number;
    priceDate: string;
    priceMicros: number;
    source: string;
  }> = [];

  for (const { securityId, prices } of priceData) {
    for (let i = 0; i < 36; i++) {
      const year = 2023 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      // Last day of month
      const lastDay = new Date(year, month, 0).getDate();
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      // Add small PRNG noise to prices (±0.5%)
      const noise = 1 + (rand() - 0.5) * 0.01;
      const priceCents = Math.round(prices[i] * noise);
      priceRows.push({
        bookId,
        securityId,
        priceDate: dateStr,
        priceMicros: priceCents * 10_000, // cents → micros
        source: "seed",
      });
    }
  }

  // Insert in batches
  for (let i = 0; i < priceRows.length; i += 50) {
    await db.insert(schema.securityPrices).values(priceRows.slice(i, i + 50));
  }

  logSeed("  Created security price history");

  // ============================================================
  // PAYEES
  // ============================================================
  const payeeNames = [
    // Employers
    "Meridian Health Systems",
    "NovaTech Solutions",
    // Utilities & Housing
    "Greenwood Apartments",
    "PSE&G",
    "New Jersey American Water",
    "Optimum Internet",
    "T-Mobile",
    // Auto
    "Honda Financial Services",
    "Geico",
    "Shell",
    "Exxon",
    "Mavis Discount Tire",
    "Jiffy Lube",
    // Groceries
    "ShopRite",
    "Trader Joe's",
    "Whole Foods",
    "Costco",
    "Aldi",
    // Dining
    "Panera Bread",
    "Chipotle",
    "Cheesecake Factory",
    "Olive Garden",
    "Sakura Sushi",
    "Tony's Pizza",
    // Coffee
    "Starbucks",
    "Dunkin'",
    // Entertainment
    "AMC Theatres",
    "Netflix",
    "Spotify",
    "Hulu",
    // Shopping
    "Amazon",
    "Target",
    "TJ Maxx",
    "Home Depot",
    "Best Buy",
    // Medical
    "Summit Medical Group",
    "CVS Pharmacy",
    "Dr. Patel DDS",
    // Personal
    "Equinox Gym",
    "Supercuts",
    // Travel
    "Delta Airlines",
    "Marriott Hotels",
    "Airbnb",
    // Gifts
    "Hallmark",
    // Misc
    "Venmo",
    "Zelle",
  ];

  const payeeMap: Record<string, number> = {};
  for (const name of payeeNames) {
    const [p] = await db.insert(schema.payees).values({ bookId, name }).returning();
    payeeMap[name] = p.id;
  }

  logSeed("  Created payees");

  // ============================================================
  // TRANSACTION HELPERS
  // ============================================================
  /** Create a simple transaction with splits. Returns transaction ID. */
  async function createTransaction(
    date: string,
    description: string,
    payeeId: number | null,
    splits: Array<{ accountId: number; amount: number }>
  ): Promise<number> {
    // Validate splits sum to zero
    const total = splits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(total) > 1) {
      throw new Error(
        `Splits don't balance! Total=${total}, desc="${description}", date=${date}`
      );
    }

    const [txn] = await db.insert(schema.transactions).values({
      bookId, date, description, payeeId, isReconciled: false,
    }).returning();

    await db.insert(schema.transactionSplits).values(
      splits.map(s => ({
        bookId, transactionId: txn.id, accountId: s.accountId,
        amount: s.amount,
      }))
    );

    return txn.id;
  }

  /** Create an investment buy transaction. Returns transaction ID. */
  async function createBuy(
    date: string,
    investmentAccountId: number,
    cashAccountId: number,
    securityId: number,
    sharesMicros: number,
    priceMicros: number,
    description: string
  ): Promise<number> {
    const grossCents = getInvestmentGrossAmountCents(sharesMicros, priceMicros);

    const txnId = await createTransaction(date, description, null, [
      { accountId: investmentAccountId, amount: grossCents },
      { accountId: cashAccountId, amount: -grossCents },
    ]);

    // Investment split
    await db.insert(schema.investmentSplits).values({
      bookId, transactionId: txnId, accountId: investmentAccountId, securityId,
      lotId: null, action: "buy", sharesMicros, priceMicros, feesCents: 0,
      splitNumerator: null, splitDenominator: null,
    });

    return txnId;
  }

  /**
   * Create an investment sell transaction. Returns transaction ID.
   *
   * The ledger records the sale at proceeds rather than at cost — what
   * buildSellSplits does when no explicit cost basis is supplied — so no
   * gain/loss account is involved. Realized gain is not read from the ledger
   * in any case: the realized gains report derives it from lot basis against
   * proceeds, which rebuildLots computes from these splits once seeding ends.
   */
  async function createSell(
    date: string,
    investmentAccountId: number,
    cashAccountId: number,
    securityId: number,
    sharesMicros: number,
    priceMicros: number,
    description: string
  ): Promise<number> {
    const grossCents = getInvestmentGrossAmountCents(sharesMicros, priceMicros);

    const txnId = await createTransaction(date, description, null, [
      { accountId: cashAccountId, amount: grossCents },
      { accountId: investmentAccountId, amount: -grossCents },
    ]);

    await db.insert(schema.investmentSplits).values({
      bookId, transactionId: txnId, accountId: investmentAccountId, securityId,
      lotId: null, action: "sell", sharesMicros, priceMicros, feesCents: 0,
      splitNumerator: null, splitDenominator: null,
    });

    return txnId;
  }

  /** Create a dividend transaction. */
  async function createDividend(
    date: string,
    investmentAccountId: number,
    cashAccountId: number,
    incomeAccountId: number,
    securityId: number,
    amountCents: number,
    description: string
  ): Promise<number> {
    const txnId = await createTransaction(date, description, null, [
      { accountId: cashAccountId, amount: amountCents },
      { accountId: incomeAccountId, amount: -amountCents },
    ]);

    // Investment split for dividend (0 shares, 0 price like the import does)
    await db.insert(schema.investmentSplits).values({
      bookId, transactionId: txnId, accountId: investmentAccountId, securityId,
      lotId: null, action: "dividend", sharesMicros: 0, priceMicros: 0, feesCents: 0,
      splitNumerator: null, splitDenominator: null,
    });

    return txnId;
  }

  // ============================================================
  // PRICE LOOKUP HELPER
  // ============================================================
  // Build a lookup: securityId → month index → priceMicros
  const priceLookup: Record<number, number[]> = {};
  for (const { securityId, prices } of priceData) {
    priceLookup[securityId] = prices.map((p) => p * 10_000); // cents → micros
  }

  /** Get the price for a security on a given date (uses month-end prices). */
  function getPriceMicros(securityId: number, date: Date): number {
    const monthIndex = (date.getFullYear() - 2023) * 12 + date.getMonth();
    const prices = priceLookup[securityId];
    if (!prices || monthIndex < 0 || monthIndex >= prices.length) {
      throw new Error(`No price for security ${securityId} at month index ${monthIndex}`);
    }
    return prices[monthIndex];
  }

  // ============================================================
  // OPENING BALANCES (Dec 31, 2022)
  // ============================================================
  logSeed("  Creating opening balances...");

  // $15,000 in checking
  await createTransaction("2022-12-31", "Opening Balance - Checking", null, [
    { accountId: checking.id, amount: 1_500_000 },
    { accountId: openingBalances.id, amount: -1_500_000 },
  ]);

  // $25,000 car loan
  await createTransaction("2022-12-31", "Opening Balance - Auto Loan", null, [
    { accountId: autoLoan.id, amount: -2_500_000 },
    { accountId: openingBalances.id, amount: 2_500_000 },
  ]);

  // ============================================================
  // STATE TRACKING
  // ============================================================
  // Credit card running balances (for monthly payoff)
  const ccBalances: Record<number, number> = {
    [chaseSapphire.id]: 0,
    [amexBlue.id]: 0,
    [citiDouble.id]: 0,
  };

  // Investment share positions per account per security (in sharesMicros)
  const positions: Record<string, number> = {};
  function posKey(accountId: number, securityId: number): string {
    return `${accountId}:${securityId}`;
  }
  function addPosition(accountId: number, securityId: number, sharesMicros: number) {
    const key = posKey(accountId, securityId);
    positions[key] = (positions[key] || 0) + sharesMicros;
  }
  function getPosition(accountId: number, securityId: number): number {
    return positions[posKey(accountId, securityId)] || 0;
  }

  // Car loan tracking
  let carLoanRemaining = 2_500_000; // in cents
  const carLoanRate = 0.049; // 4.9% APR
  const carLoanMonthlyPayment = 45_000; // $450/month

  // 401k contribution tracking per year
  const yearlyContrib: Record<string, Record<number, number>> = {};
  const maxContrib: Record<number, number> = {
    2023: 2_250_000, // $22,500
    2024: 2_300_000, // $23,000
    2025: 2_350_000, // $23,500
  };

  // Biweekly paycheck tracking
  let nextPayDate = new Date(2023, 0, 6); // First paycheck: Jan 6, 2023

  // ============================================================
  // GENERATE TRANSACTIONS MONTH BY MONTH
  // ============================================================
  logSeed("  Generating transactions...");

  {
    // --- Generate biweekly paychecks for the full range ---
    const endDate = new Date(2025, 11, 31);

    while (nextPayDate <= endDate) {
      const year = nextPayDate.getFullYear();
      const dateStr = formatDate(nextPayDate);
      const yearKey = String(year);

      if (!yearlyContrib[yearKey]) {
        yearlyContrib[yearKey] = {
          [sarah401k.id]: 0,
          [michael401k.id]: 0,
        };
      }

      // --- Sarah's paycheck (~$100k/year, $3846/biweekly gross) ---
      {
        const gross = 384_600; // $3,846.00
        const federal = 67_000; // ~17.4%
        const njState = 21_500; // ~5.6%
        const ss = 23_800; // 6.2%
        const medicare = 5_600; // 1.45%
        const healthIns = 18_500; // $185/paycheck
        const dentalIns = 3_500; // $35/paycheck

        // 401k: $865/paycheck (~$22,490/year) but cap at annual limit
        let contrib401k = 86_500;
        const currentContrib = yearlyContrib[yearKey][sarah401k.id] || 0;
        const remaining = (maxContrib[year] || 2_350_000) - currentContrib;
        if (remaining <= 0) {
          contrib401k = 0;
        } else if (contrib401k > remaining) {
          contrib401k = remaining;
        }
        yearlyContrib[yearKey][sarah401k.id] = currentContrib + contrib401k;

        const net = gross - federal - njState - ss - medicare - healthIns - dentalIns - contrib401k;

        const splits: Array<{ accountId: number; amount: number }> = [
          { accountId: checking.id, amount: net },
          { accountId: taxFederal.id, amount: federal },
          { accountId: taxNJ.id, amount: njState },
          { accountId: taxSS.id, amount: ss },
          { accountId: taxMedicare.id, amount: medicare },
          { accountId: insHealth.id, amount: healthIns },
          { accountId: insDental.id, amount: dentalIns },
          { accountId: sarahSalary.id, amount: -gross },
        ];

        if (contrib401k > 0) {
          splits.push({ accountId: sarah401kCash.id, amount: contrib401k });
          // Adjust salary credit to include 401k (it's pre-tax)
          // The gross already includes 401k contribution
        }

        await createTransaction(dateStr, "Paycheck - Meridian Health", payeeMap["Meridian Health Systems"], splits);

        // 401k purchases day after paycheck
        if (contrib401k > 0) {
          const buyDate = formatDate(addDays(nextPayDate, 1));
          const price_vti = getPriceMicros(vti.id, nextPayDate);
          const price_vxus = getPriceMicros(vxus.id, nextPayDate);
          const price_bnd = getPriceMicros(bnd.id, nextPayDate);

          // 40% VTI, 20% VXUS, 40% BND
          const vtiAmount = Math.round(contrib401k * 0.4);
          const vxusAmount = Math.round(contrib401k * 0.2);
          const bndAmount = contrib401k - vtiAmount - vxusAmount;

          const vtiShares = Math.round((vtiAmount * 10_000_000_000) / price_vti / 100) * 100;
          const vxusShares = Math.round((vxusAmount * 10_000_000_000) / price_vxus / 100) * 100;
          const bndShares = Math.round((bndAmount * 10_000_000_000) / price_bnd / 100) * 100;

          if (vtiShares > 0) {
            await createBuy(buyDate, sarah401k.id, sarah401kCash.id, vti.id, vtiShares, price_vti, "Buy VTI - Sarah 401(k)");
            addPosition(sarah401k.id, vti.id, vtiShares);
          }
          if (vxusShares > 0) {
            await createBuy(buyDate, sarah401k.id, sarah401kCash.id, vxus.id, vxusShares, price_vxus, "Buy VXUS - Sarah 401(k)");
            addPosition(sarah401k.id, vxus.id, vxusShares);
          }
          if (bndShares > 0) {
            await createBuy(buyDate, sarah401k.id, sarah401kCash.id, bnd.id, bndShares, price_bnd, "Buy BND - Sarah 401(k)");
            addPosition(sarah401k.id, bnd.id, bndShares);
          }
        }
      }

      // --- Michael's paycheck (~$130k/year, $5000/biweekly gross) ---
      {
        const gross = 500_000; // $5,000.00
        const federal = 92_000; // ~18.4%
        const njState = 30_000; // ~6%
        const ss = 31_000; // 6.2%
        const medicare = 7_300; // 1.45%
        const healthIns = 18_500; // $185/paycheck
        const dentalIns = 3_500; // $35/paycheck

        let contrib401k = 88_500; // ~$23,000/year
        const currentContrib = yearlyContrib[yearKey][michael401k.id] || 0;
        const remaining = (maxContrib[year] || 2_350_000) - currentContrib;
        if (remaining <= 0) {
          contrib401k = 0;
        } else if (contrib401k > remaining) {
          contrib401k = remaining;
        }
        yearlyContrib[yearKey][michael401k.id] = currentContrib + contrib401k;

        const net = gross - federal - njState - ss - medicare - healthIns - dentalIns - contrib401k;

        const splits: Array<{ accountId: number; amount: number }> = [
          { accountId: checking.id, amount: net },
          { accountId: taxFederal.id, amount: federal },
          { accountId: taxNJ.id, amount: njState },
          { accountId: taxSS.id, amount: ss },
          { accountId: taxMedicare.id, amount: medicare },
          { accountId: insHealth.id, amount: healthIns },
          { accountId: insDental.id, amount: dentalIns },
          { accountId: michaelSalary.id, amount: -gross },
        ];

        if (contrib401k > 0) {
          splits.push({ accountId: michael401kCash.id, amount: contrib401k });
        }

        await createTransaction(dateStr, "Paycheck - NovaTech Solutions", payeeMap["NovaTech Solutions"], splits);

        // 401k purchases day after paycheck
        if (contrib401k > 0) {
          const buyDate = formatDate(addDays(nextPayDate, 1));
          const price_vti = getPriceMicros(vti.id, nextPayDate);
          const price_vxus = getPriceMicros(vxus.id, nextPayDate);
          const price_bnd = getPriceMicros(bnd.id, nextPayDate);

          const vtiAmount = Math.round(contrib401k * 0.4);
          const vxusAmount = Math.round(contrib401k * 0.2);
          const bndAmount = contrib401k - vtiAmount - vxusAmount;

          const vtiShares = Math.round((vtiAmount * 10_000_000_000) / price_vti / 100) * 100;
          const vxusShares = Math.round((vxusAmount * 10_000_000_000) / price_vxus / 100) * 100;
          const bndShares = Math.round((bndAmount * 10_000_000_000) / price_bnd / 100) * 100;

          if (vtiShares > 0) {
            await createBuy(buyDate, michael401k.id, michael401kCash.id, vti.id, vtiShares, price_vti, "Buy VTI - Michael 401(k)");
            addPosition(michael401k.id, vti.id, vtiShares);
          }
          if (vxusShares > 0) {
            await createBuy(buyDate, michael401k.id, michael401kCash.id, vxus.id, vxusShares, price_vxus, "Buy VXUS - Michael 401(k)");
            addPosition(michael401k.id, vxus.id, vxusShares);
          }
          if (bndShares > 0) {
            await createBuy(buyDate, michael401k.id, michael401kCash.id, bnd.id, bndShares, price_bnd, "Buy BND - Michael 401(k)");
            addPosition(michael401k.id, bnd.id, bndShares);
          }
        }
      }

      nextPayDate = addDays(nextPayDate, 14);
    }
    logSeed("    Paychecks & 401(k) purchases done");

    // --- Monthly transactions: iterate month by month ---
    for (let year = 2023; year <= 2025; year++) {
      for (let month = 0; month < 12; month++) {
        const monthDate = new Date(year, month, 1);
        const mm = String(month + 1).padStart(2, "0");
        const monthStr = `${year}-${mm}`;

        // === RENT (1st of month) ===
        await createTransaction(
          `${monthStr}-01`,
          "Rent Payment",
          payeeMap["Greenwood Apartments"],
          [
            { accountId: housingRent.id, amount: 250_000 },
            { accountId: checking.id, amount: -250_000 },
          ]
        );

        // === ELECTRIC (variable by season, ~5th) ===
        {
          // Summer/winter higher, spring/fall lower
          const seasonFactor =
            month >= 5 && month <= 8
              ? 1.6 // summer
              : month >= 11 || month <= 1
                ? 1.4 // winter
                : 1.0;
          const baseElectric = 12_000; // $120
          const electric = Math.round(baseElectric * seasonFactor + randInt(-1500, 1500));
          await createTransaction(`${monthStr}-05`, "Electric Bill", payeeMap["PSE&G"], [
            { accountId: housingElectric.id, amount: electric },
            { accountId: checking.id, amount: -electric },
          ]);
        }

        // === GAS (variable by season, ~7th) ===
        {
          const seasonFactor =
            month >= 11 || month <= 2
              ? 2.0 // winter heating
              : month >= 5 && month <= 8
                ? 0.6 // summer (just water heater)
                : 1.0;
          const baseGas = 7_500; // $75
          const gas = Math.round(baseGas * seasonFactor + randInt(-1000, 1000));
          await createTransaction(`${monthStr}-07`, "Gas Bill", payeeMap["PSE&G"], [
            { accountId: housingGas.id, amount: gas },
            { accountId: checking.id, amount: -gas },
          ]);
        }

        // === WATER (~10th) ===
        {
          const water = 6_500 + randInt(-500, 500);
          await createTransaction(`${monthStr}-10`, "Water Bill", payeeMap["New Jersey American Water"], [
            { accountId: housingWater.id, amount: water },
            { accountId: checking.id, amount: -water },
          ]);
        }

        // === INTERNET (~12th) ===
        await createTransaction(`${monthStr}-12`, "Internet", payeeMap["Optimum Internet"], [
          { accountId: housingInternet.id, amount: 9_000 },
          { accountId: checking.id, amount: -9_000 },
        ]);

        // === PHONE (~12th) ===
        await createTransaction(`${monthStr}-12`, "Phone Bill", payeeMap["T-Mobile"], [
          { accountId: housingPhone.id, amount: 14_000 },
          { accountId: checking.id, amount: -14_000 },
        ]);

        // === CAR INSURANCE (~15th) ===
        await createTransaction(`${monthStr}-15`, "Car Insurance", payeeMap["Geico"], [
          { accountId: insCar.id, amount: 18_500 },
          { accountId: checking.id, amount: -18_500 },
        ]);

        // === CAR LOAN PAYMENT (~18th) ===
        if (carLoanRemaining > 0) {
          const monthlyInterest = Math.round(
            carLoanRemaining * (carLoanRate / 12)
          );
          let principal = carLoanMonthlyPayment - monthlyInterest;
          if (principal > carLoanRemaining) {
            principal = carLoanRemaining;
          }
          const totalPayment = principal + monthlyInterest;
          carLoanRemaining -= principal;

          await createTransaction(
            `${monthStr}-18`,
            "Auto Loan Payment",
            payeeMap["Honda Financial Services"],
            [
              { accountId: autoLoan.id, amount: principal }, // reduce liability (debit)
              { accountId: interestCarLoan.id, amount: monthlyInterest }, // interest expense
              { accountId: checking.id, amount: -totalPayment }, // payment from checking
            ]
          );
        }

        // === STREAMING (20th) - on Amex ===
        {
          await createTransaction(`${monthStr}-20`, "Netflix", payeeMap["Netflix"], [
            { accountId: streaming.id, amount: 1_599 },
            { accountId: amexBlue.id, amount: -1_599 },
          ]);
          ccBalances[amexBlue.id] += 1_599;
          await createTransaction(`${monthStr}-20`, "Spotify", payeeMap["Spotify"], [
            { accountId: streaming.id, amount: 999 },
            { accountId: amexBlue.id, amount: -999 },
          ]);
          ccBalances[amexBlue.id] += 999;
          await createTransaction(`${monthStr}-20`, "Hulu", payeeMap["Hulu"], [
            { accountId: streaming.id, amount: 799 },
            { accountId: amexBlue.id, amount: -799 },
          ]);
          ccBalances[amexBlue.id] += 799;
        }

        // === GYM (1st) ===
        await createTransaction(`${monthStr}-01`, "Equinox Membership", payeeMap["Equinox Gym"], [
          { accountId: personalGym.id, amount: 18_000 },
          { accountId: checking.id, amount: -18_000 },
        ]);

        // === CREDIT CARD CHARGES ===
        // Generate 15-25 charges per month spread across categories
        const numCharges = randInt(15, 25);

        // Charge definitions: [payees, expense account, card, min cents, max cents]
        type ChargeTemplate = {
          payees: string[];
          account: { id: number };
          card: { id: number };
          min: number;
          max: number;
          desc?: string;
        };

        const chargeTemplates: ChargeTemplate[] = [
          // Amex: groceries, fuel
          { payees: ["ShopRite", "Trader Joe's", "Whole Foods", "Costco", "Aldi"], account: foodGroceries, card: amexBlue, min: 3_500, max: 18_000 },
          { payees: ["ShopRite", "Trader Joe's", "Whole Foods"], account: foodGroceries, card: amexBlue, min: 4_000, max: 15_000 },
          { payees: ["Shell", "Exxon"], account: autoFuel, card: amexBlue, min: 3_500, max: 6_500 },
          // Chase: dining, coffee, entertainment, travel
          { payees: ["Panera Bread", "Chipotle", "Cheesecake Factory", "Olive Garden", "Sakura Sushi", "Tony's Pizza"], account: foodDining, card: chaseSapphire, min: 1_500, max: 8_500 },
          { payees: ["Panera Bread", "Chipotle", "Sakura Sushi", "Tony's Pizza"], account: foodDining, card: chaseSapphire, min: 2_000, max: 6_500 },
          { payees: ["Starbucks", "Dunkin'"], account: foodCoffee, card: chaseSapphire, min: 450, max: 750 },
          { payees: ["Starbucks", "Dunkin'"], account: foodCoffee, card: chaseSapphire, min: 400, max: 800 },
          { payees: ["AMC Theatres"], account: entertainment, card: chaseSapphire, min: 1_500, max: 4_000 },
          // Citi: clothing, household, medical, personal
          { payees: ["Amazon", "Target"], account: shopHousehold, card: citiDouble, min: 1_500, max: 8_000 },
          { payees: ["TJ Maxx"], account: shopClothing, card: citiDouble, min: 2_000, max: 12_000 },
          { payees: ["Home Depot"], account: shopHousehold, card: citiDouble, min: 2_000, max: 10_000 },
          { payees: ["Amazon"], account: shopElectronics, card: citiDouble, min: 2_000, max: 15_000 },
          { payees: ["CVS Pharmacy"], account: medical, card: citiDouble, min: 800, max: 5_000 },
          { payees: ["Supercuts"], account: personalHaircuts, card: citiDouble, min: 2_500, max: 4_500 },
        ];

        for (let c = 0; c < numCharges; c++) {
          const template = pick(chargeTemplates);
          const payeeName = pick(template.payees);
          const amount = randInt(template.min, template.max);
          // Spread charges across the month (days 2-28)
          const day = String(randInt(2, 28)).padStart(2, "0");

          await createTransaction(`${monthStr}-${day}`, payeeName, payeeMap[payeeName], [
            { accountId: template.account.id, amount },
            { accountId: template.card.id, amount: -amount },
          ]);
          ccBalances[template.card.id] += amount;
        }

        // Occasional bigger purchases (1-2 per month)
        if (rand() < 0.4) {
          // Medical visit
          const medAmount = randInt(5_000, 25_000);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 25)).padStart(2, "0")}`,
            "Doctor Visit",
            payeeMap["Summit Medical Group"],
            [
              { accountId: medical.id, amount: medAmount },
              { accountId: citiDouble.id, amount: -medAmount },
            ]
          );
          ccBalances[citiDouble.id] += medAmount;
        }

        if (rand() < 0.15) {
          // Auto maintenance
          const autoAmount = randInt(5_000, 45_000);
          const autoPayee = pick(["Mavis Discount Tire", "Jiffy Lube"]);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 25)).padStart(2, "0")}`,
            autoPayee,
            payeeMap[autoPayee],
            [
              { accountId: autoMaintenance.id, amount: autoAmount },
              { accountId: checking.id, amount: -autoAmount },
            ]
          );
        }

        if (rand() < 0.1) {
          // Electronics purchase
          const elecAmount = randInt(10_000, 80_000);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 25)).padStart(2, "0")}`,
            "Best Buy",
            payeeMap["Best Buy"],
            [
              { accountId: shopElectronics.id, amount: elecAmount },
              { accountId: chaseSapphire.id, amount: -elecAmount },
            ]
          );
          ccBalances[chaseSapphire.id] += elecAmount;
        }

        // Travel: ~2 trips per year
        if ((month === 3 || month === 8) && rand() < 0.7) {
          const airfare = randInt(30_000, 60_000);
          const hotel = randInt(40_000, 120_000);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 15)).padStart(2, "0")}`,
            "Flights",
            payeeMap["Delta Airlines"],
            [
              { accountId: travel.id, amount: airfare },
              { accountId: chaseSapphire.id, amount: -airfare },
            ]
          );
          ccBalances[chaseSapphire.id] += airfare;

          const hotelPayee = pick(["Marriott Hotels", "Airbnb"]);
          await createTransaction(
            `${monthStr}-${String(randInt(16, 25)).padStart(2, "0")}`,
            hotelPayee,
            payeeMap[hotelPayee],
            [
              { accountId: travel.id, amount: hotel },
              { accountId: chaseSapphire.id, amount: -hotel },
            ]
          );
          ccBalances[chaseSapphire.id] += hotel;
        }

        // Gifts: November/December
        if (month === 10 || month === 11) {
          const giftAmount = randInt(5_000, 30_000);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 25)).padStart(2, "0")}`,
            "Gift Purchase",
            payeeMap["Amazon"],
            [
              { accountId: gifts.id, amount: giftAmount },
              { accountId: chaseSapphire.id, amount: -giftAmount },
            ]
          );
          ccBalances[chaseSapphire.id] += giftAmount;
        }

        // === CREDIT CARD PAYMENTS (25th of each month) ===
        for (const [cardIdStr, balance] of Object.entries(ccBalances)) {
          const cardId = Number(cardIdStr);
          if (balance > 0) {
            await createTransaction(`${monthStr}-25`, "Credit Card Payment", null, [
              { accountId: cardId, amount: balance }, // debit liability (decreases)
              { accountId: checking.id, amount: -balance }, // credit checking
            ]);
            ccBalances[cardId] = 0;
          }
        }

        // === QUARTERLY DIVIDENDS (end of Mar, Jun, Sep, Dec) ===
        if ((month + 1) % 3 === 0) {
          const quarterEnd = new Date(year, month, 28);
          const dateStr = formatDate(quarterEnd);

          // Annual yields: VTI 1.5%, VXUS 3%, BND 3.5%, AGG 3.8%
          const yields: Record<number, number> = {
            [vti.id]: 0.015 / 4,
            [vxus.id]: 0.03 / 4,
            [bnd.id]: 0.035 / 4,
            [agg.id]: 0.038 / 4,
          };

          // Dividends for each account that holds securities
          const investmentAccounts = [
            { acct: sarah401k, cash: sarah401kCash, label: "Sarah 401(k)" },
            { acct: michael401k, cash: michael401kCash, label: "Michael 401(k)" },
            { acct: sarahIra, cash: sarahIraCash, label: "Sarah IRA" },
            { acct: michaelIra, cash: michaelIraCash, label: "Michael IRA" },
            { acct: brokerage, cash: brokerageCash, label: "Joint Brokerage" },
          ];

          for (const { acct, cash, label } of investmentAccounts) {
            for (const sec of [vti, vxus, bnd, agg]) {
              const sharesHeld = getPosition(acct.id, sec.id);
              if (sharesHeld <= 0) continue;

              const priceMicros = getPriceMicros(sec.id, quarterEnd);
              const marketValueCents = getInvestmentGrossAmountCents(sharesHeld, priceMicros);
              const dividendCents = Math.round(marketValueCents * yields[sec.id]);

              if (dividendCents > 0) {
                await createDividend(
                  dateStr,
                  acct.id,
                  cash.id,
                  dividendIncome.id,
                  sec.id,
                  dividendCents,
                  `${sec.symbol} Dividend - ${label}`
                );
              }
            }
          }
        }

        // === IRA CONTRIBUTIONS (January each year) ===
        if (month === 0) {
          const iraLimit =
            year === 2023 ? 650_000 : 700_000; // $6,500 (2023), $7,000 (2024-2025)

          // Sarah IRA
          await createTransaction(`${monthStr}-15`, "IRA Contribution - Sarah", null, [
            { accountId: sarahIraCash.id, amount: iraLimit },
            { accountId: checking.id, amount: -iraLimit },
          ]);

          // Buy funds in Sarah IRA (40% VTI, 20% VXUS, 40% BND)
          {
            const buyDate = `${monthStr}-16`;
            const p_vti = getPriceMicros(vti.id, monthDate);
            const p_vxus = getPriceMicros(vxus.id, monthDate);
            const p_bnd = getPriceMicros(bnd.id, monthDate);

            const vtiAmt = Math.round(iraLimit * 0.4);
            const vxusAmt = Math.round(iraLimit * 0.2);
            const bndAmt = iraLimit - vtiAmt - vxusAmt;

            const vtiSh = Math.round((vtiAmt * 10_000_000_000) / p_vti / 100) * 100;
            const vxusSh = Math.round((vxusAmt * 10_000_000_000) / p_vxus / 100) * 100;
            const bndSh = Math.round((bndAmt * 10_000_000_000) / p_bnd / 100) * 100;

            if (vtiSh > 0) {
              await createBuy(buyDate, sarahIra.id, sarahIraCash.id, vti.id, vtiSh, p_vti, "Buy VTI - Sarah IRA");
              addPosition(sarahIra.id, vti.id, vtiSh);
            }
            if (vxusSh > 0) {
              await createBuy(buyDate, sarahIra.id, sarahIraCash.id, vxus.id, vxusSh, p_vxus, "Buy VXUS - Sarah IRA");
              addPosition(sarahIra.id, vxus.id, vxusSh);
            }
            if (bndSh > 0) {
              await createBuy(buyDate, sarahIra.id, sarahIraCash.id, bnd.id, bndSh, p_bnd, "Buy BND - Sarah IRA");
              addPosition(sarahIra.id, bnd.id, bndSh);
            }
          }

          // Michael IRA
          await createTransaction(`${monthStr}-15`, "IRA Contribution - Michael", null, [
            { accountId: michaelIraCash.id, amount: iraLimit },
            { accountId: checking.id, amount: -iraLimit },
          ]);

          // Buy funds in Michael IRA
          {
            const buyDate = `${monthStr}-16`;
            const p_vti = getPriceMicros(vti.id, monthDate);
            const p_vxus = getPriceMicros(vxus.id, monthDate);
            const p_bnd = getPriceMicros(bnd.id, monthDate);

            const vtiAmt = Math.round(iraLimit * 0.4);
            const vxusAmt = Math.round(iraLimit * 0.2);
            const bndAmt = iraLimit - vtiAmt - vxusAmt;

            const vtiSh = Math.round((vtiAmt * 10_000_000_000) / p_vti / 100) * 100;
            const vxusSh = Math.round((vxusAmt * 10_000_000_000) / p_vxus / 100) * 100;
            const bndSh = Math.round((bndAmt * 10_000_000_000) / p_bnd / 100) * 100;

            if (vtiSh > 0) {
              await createBuy(buyDate, michaelIra.id, michaelIraCash.id, vti.id, vtiSh, p_vti, "Buy VTI - Michael IRA");
              addPosition(michaelIra.id, vti.id, vtiSh);
            }
            if (vxusSh > 0) {
              await createBuy(buyDate, michaelIra.id, michaelIraCash.id, vxus.id, vxusSh, p_vxus, "Buy VXUS - Michael IRA");
              addPosition(michaelIra.id, vxus.id, vxusSh);
            }
            if (bndSh > 0) {
              await createBuy(buyDate, michaelIra.id, michaelIraCash.id, bnd.id, bndSh, p_bnd, "Buy BND - Michael IRA");
              addPosition(michaelIra.id, bnd.id, bndSh);
            }
          }
        }

        // === QUARTERLY BROKERAGE INVESTMENTS (Mar, Jun, Sep, Dec) ===
        if ((month + 1) % 3 === 0) {
          const contribAmount = randInt(200_000, 500_000); // $2,000-$5,000

          // Transfer to brokerage cash
          await createTransaction(
            `${monthStr}-10`,
            "Transfer to Brokerage",
            null,
            [
              { accountId: brokerageCash.id, amount: contribAmount },
              { accountId: checking.id, amount: -contribAmount },
            ]
          );

          // Buy: 40% VTI, 15% VXUS, 25% BND, 20% AGG
          const buyDate = `${monthStr}-11`;
          const p_vti = getPriceMicros(vti.id, monthDate);
          const p_vxus = getPriceMicros(vxus.id, monthDate);
          const p_bnd = getPriceMicros(bnd.id, monthDate);
          const p_agg = getPriceMicros(agg.id, monthDate);

          const vtiAmt = Math.round(contribAmount * 0.4);
          const vxusAmt = Math.round(contribAmount * 0.15);
          const bndAmt = Math.round(contribAmount * 0.25);
          const aggAmt = contribAmount - vtiAmt - vxusAmt - bndAmt;

          const vtiSh = Math.round((vtiAmt * 10_000_000_000) / p_vti / 100) * 100;
          const vxusSh = Math.round((vxusAmt * 10_000_000_000) / p_vxus / 100) * 100;
          const bndSh = Math.round((bndAmt * 10_000_000_000) / p_bnd / 100) * 100;
          const aggSh = Math.round((aggAmt * 10_000_000_000) / p_agg / 100) * 100;

          if (vtiSh > 0) {
            await createBuy(buyDate, brokerage.id, brokerageCash.id, vti.id, vtiSh, p_vti, "Buy VTI - Brokerage");
            addPosition(brokerage.id, vti.id, vtiSh);
          }
          if (vxusSh > 0) {
            await createBuy(buyDate, brokerage.id, brokerageCash.id, vxus.id, vxusSh, p_vxus, "Buy VXUS - Brokerage");
            addPosition(brokerage.id, vxus.id, vxusSh);
          }
          if (bndSh > 0) {
            await createBuy(buyDate, brokerage.id, brokerageCash.id, bnd.id, bndSh, p_bnd, "Buy BND - Brokerage");
            addPosition(brokerage.id, bnd.id, bndSh);
          }
          if (aggSh > 0) {
            await createBuy(buyDate, brokerage.id, brokerageCash.id, agg.id, aggSh, p_agg, "Buy AGG - Brokerage");
            addPosition(brokerage.id, agg.id, aggSh);
          }

          // Year-end rebalance: trim the equity position back toward target.
          // Only the taxable brokerage sells — a trim inside an IRA or 401(k)
          // realizes nothing worth reporting. Because the brokerage buys
          // quarterly, a trim this size draws from several lots at once, so a
          // seeded book exercises FIFO *allocation* and not merely lot
          // creation, and the realized gains report has something to show.
          if (month === 11) {
            const heldVti = getPosition(brokerage.id, vti.id);
            // Positions are in micros (1 share = 1_000_000), so this rounds to
            // the nearest 100 micros — 0.0001 of a share — which is the same
            // quantum every buy above is sized to. Never trim more than is held.
            const trimSh = Math.round((heldVti * 0.2) / 100) * 100;
            if (trimSh > 0 && trimSh <= heldVti) {
              await createSell(
                `${monthStr}-18`, brokerage.id, brokerageCash.id, vti.id,
                trimSh, p_vti, "Sell VTI - Rebalance"
              );
              addPosition(brokerage.id, vti.id, -trimSh);
            }
          }
        }

        // === MISC VENMO/ZELLE (occasional) ===
        if (rand() < 0.3) {
          const miscPayee = pick(["Venmo", "Zelle"]);
          const miscAmount = randInt(1_500, 10_000);
          await createTransaction(
            `${monthStr}-${String(randInt(5, 25)).padStart(2, "0")}`,
            miscPayee,
            payeeMap[miscPayee],
            [
              { accountId: miscExpense.id, amount: miscAmount },
              { accountId: checking.id, amount: -miscAmount },
            ]
          );
        }

        // === DENTAL VISIT (every 6 months) ===
        if (month === 2 || month === 8) {
          const dentalAmount = randInt(15_000, 25_000);
          await createTransaction(
            `${monthStr}-${String(randInt(10, 20)).padStart(2, "0")}`,
            "Dental Cleaning",
            payeeMap["Dr. Patel DDS"],
            [
              { accountId: medical.id, amount: dentalAmount },
              { accountId: checking.id, amount: -dentalAmount },
            ]
          );
        }

        // === HAIRCUT (every 2 months) ===
        if (month % 2 === 1) {
          await createTransaction(
            `${monthStr}-${String(randInt(10, 25)).padStart(2, "0")}`,
            "Haircut",
            payeeMap["Supercuts"],
            [
              { accountId: personalHaircuts.id, amount: 3_500 },
              { accountId: checking.id, amount: -3_500 },
            ]
          );
        }
      }
    }

  }

  // ============================================================
  // PLAID SYNC DEMO DATA
  // ============================================================
  logSeed("  Seeding Plaid sync demo data...");

  // Find the 5 most recent Chase Sapphire transactions for candidate matching
  const recentChaseTxns = await db
    .select({
      id: schema.transactions.id,
      date: schema.transactions.date,
      description: schema.transactions.description,
      amount: schema.transactionSplits.amount,
    })
    .from(schema.transactions)
    .innerJoin(
      schema.transactionSplits,
      eq(schema.transactionSplits.transactionId, schema.transactions.id)
    )
    .where(
      sql`${schema.transactionSplits.accountId} = ${chaseSapphire.id}
        AND ${schema.transactions.bookId} = ${bookId}
        AND ${schema.transactionSplits.amount} < 0`
    )
    .orderBy(sql`${schema.transactions.date} DESC`)
    .limit(5);

  // These two identifiers carry the only unique constraints in the seed that
  // are NOT scoped by book: plaid_tokens.item_id and
  // plaid_accounts.plaid_account_id are unique across the whole table, because
  // real Plaid ids are globally unique. A fixed string therefore lets a
  // database hold exactly one seeded book, and seeding a second one fails on
  // the insert. The book id is what makes them distinct. Everything else the
  // seed writes is either book-scoped (accounts, payees, securities) or keyed
  // by a per-book id (reconciliation rows hang off plaidAccountLinkId), so it
  // needs no suffix.
  const [plaidToken] = await db
    .insert(schema.plaidTokens)
    .values({
      bookId,
      financialInstitution: "Chase Bank",
      itemId: `demo_item_chase_${bookId}`,
      accessToken: `demo_access_token_chase_${bookId}`,
      // Keeps the scheduled sync away from this connection. The reconciliation
      // rows below are what the Sync page demonstrates; none of them need a
      // live call to Plaid, and that call could only ever fail.
      isDemo: true,
    })
    .returning();

  const [plaidAccount] = await db
    .insert(schema.plaidAccounts)
    .values({
      bookId,
      tokenId: plaidToken.id,
      plaidAccountId: `demo_acct_chase_sapphire_${bookId}`,
      name: "Chase Sapphire",
      officialName: "Chase Sapphire Preferred",
      mask: "4567",
      type: "credit",
      subtype: "credit card",
      counterpoiseAccountId: chaseSapphire.id,
    })
    .returning();

  // Build reconciliation items from real transactions:
  // - First 2: exact amount matches (strong match candidates)
  // - Third: amount off by a small delta (weak match)
  // - Plus 2 items with no matching transaction
  const plaidReconItems: schema.NewPlaidTransactionReconciliation[] = [];
  const now = new Date();

  if (recentChaseTxns.length >= 3) {
    const [txn1, txn2, txn3] = recentChaseTxns;

    // Strong match: exact amount, same day
    plaidReconItems.push({
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_001",
      date: txn1.date,
      authorizedDate: txn1.date,
      amountCents: -txn1.amount, // Plaid convention: positive = charge
      name: `${txn1.description?.toUpperCase() ?? "PURCHASE"} #1234`,
      merchantName: txn1.description,
      originalDescription: `${txn1.description?.toUpperCase() ?? "PURCHASE"} STORE 1234`,
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
    });

    // Strong match: exact amount, 1 day before
    const dayBefore = new Date(txn2.date);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const dayBeforeStr = dayBefore.toISOString().slice(0, 10);
    plaidReconItems.push({
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_002",
      date: dayBeforeStr,
      authorizedDate: dayBeforeStr,
      amountCents: -txn2.amount,
      name: `${txn2.description?.toUpperCase() ?? "PURCHASE"} #567`,
      merchantName: txn2.description,
      originalDescription: `${txn2.description?.toUpperCase() ?? "PURCHASE"} 567`,
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
    });

    // Weak match: amount off by 29 cents
    plaidReconItems.push({
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_003",
      date: txn3.date,
      authorizedDate: txn3.date,
      amountCents: -txn3.amount + 29,
      name: `${txn3.description?.toUpperCase() ?? "PURCHASE"} MODIFIED`,
      merchantName: txn3.description,
      originalDescription: `${txn3.description?.toUpperCase() ?? "PURCHASE"} MODIFIED`,
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  // No-match items
  plaidReconItems.push(
    {
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_004",
      date: "2025-12-28",
      amountCents: 4250,
      name: "TRADER JOES #789",
      merchantName: "Trader Joe's",
      originalDescription: "TRADER JOES 789 JERSEY CITY NJ",
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
    },
    {
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_005",
      date: "2025-12-29",
      amountCents: 28999,
      name: "BEST BUY #0042",
      merchantName: "Best Buy",
      originalDescription: "BEST BUY 00042 SECAUCUS NJ",
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
    }
  );

  // One review item (plaid_modified) — uses first txn's amount for a match
  if (recentChaseTxns.length >= 4) {
    const txn4 = recentChaseTxns[3];
    plaidReconItems.push({
      bookId,
      plaidAccountLinkId: plaidAccount.id,
      plaidTransactionId: "demo_txn_006",
      date: txn4.date,
      authorizedDate: txn4.date,
      amountCents: -txn4.amount,
      name: `${txn4.description?.toUpperCase() ?? "PURCHASE"} REVISED`,
      merchantName: txn4.description,
      originalDescription: `${txn4.description?.toUpperCase() ?? "PURCHASE"} REVISED`,
      pending: false,
      rawJson: "{}",
      resolutionStatus: "pending",
      reviewReason: "plaid_modified",
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  await db.insert(schema.plaidTransactionReconciliation).values(plaidReconItems);
  logSeed(`  Plaid reconciliation items: ${plaidReconItems.length}`);

  // ============================================================
  // RECURRING RULES
  // ============================================================
  // Templates for the bills the loop above already posts every month, so the
  // Recurring page shows the same household the rest of the book describes.
  //
  // Dates are relative to today, unlike every other date in this seed. The
  // transactions are frozen in 2023-2025, so a fixed nextDate would read as
  // months overdue in any book created afterwards — and the hourly recurring
  // cron would post all of them into every demo book on its next run.
  const seedToday = new Date();

  /** The next <dayOfMonth> strictly after today. Keep the day <= 28. */
  const nextMonthlyDate = (dayOfMonth: number): string => {
    const candidate = new Date(seedToday.getFullYear(), seedToday.getMonth(), dayOfMonth);
    if (candidate <= seedToday) {
      candidate.setMonth(candidate.getMonth() + 1);
    }
    return formatDate(candidate);
  };

  /** The next given weekday strictly after today (0 = Sunday). */
  const nextWeekdayDate = (weekday: number): string => {
    const candidate = new Date(seedToday);
    // "|| 7" keeps it strictly future when today already is that weekday.
    candidate.setDate(seedToday.getDate() + (((weekday - seedToday.getDay() + 7) % 7) || 7));
    return formatDate(candidate);
  };

  const recurringSeeds: Array<{
    name: string;
    frequency: "weekly" | "monthly";
    interval: number;
    dayOfMonth?: number;
    weekday?: number;
    payee: string;
    templateDescription: string;
    autoCreateDaysBefore: number;
    splits: Array<{ accountId: number; amount: number }>;
  }> = [
    {
      name: "Rent",
      frequency: "monthly",
      interval: 1,
      dayOfMonth: 1,
      payee: "Greenwood Apartments",
      templateDescription: "Rent Payment",
      autoCreateDaysBefore: 3,
      splits: [
        { accountId: housingRent.id, amount: 250_000 },
        { accountId: checking.id, amount: -250_000 },
      ],
    },
    {
      name: "Electric Bill",
      frequency: "monthly",
      interval: 1,
      dayOfMonth: 5,
      payee: "PSE&G",
      templateDescription: "Electric Bill",
      autoCreateDaysBefore: 0,
      splits: [
        { accountId: housingElectric.id, amount: 12_000 },
        { accountId: checking.id, amount: -12_000 },
      ],
    },
    {
      name: "Internet",
      frequency: "monthly",
      interval: 1,
      dayOfMonth: 12,
      payee: "Optimum Internet",
      templateDescription: "Internet",
      autoCreateDaysBefore: 0,
      splits: [
        { accountId: housingInternet.id, amount: 9_000 },
        { accountId: checking.id, amount: -9_000 },
      ],
    },
    {
      name: "Phone Bill",
      frequency: "monthly",
      interval: 1,
      dayOfMonth: 12,
      payee: "T-Mobile",
      templateDescription: "Phone Bill",
      autoCreateDaysBefore: 0,
      splits: [
        { accountId: housingPhone.id, amount: 14_000 },
        { accountId: checking.id, amount: -14_000 },
      ],
    },
    {
      // On the credit card rather than checking, so the page shows both.
      name: "Netflix",
      frequency: "monthly",
      interval: 1,
      dayOfMonth: 20,
      payee: "Netflix",
      templateDescription: "Netflix",
      autoCreateDaysBefore: 0,
      splits: [
        { accountId: streaming.id, amount: 1_599 },
        { accountId: amexBlue.id, amount: -1_599 },
      ],
    },
    {
      // Biweekly, and the only multi-split template — it is what shows that a
      // rule is a full double-entry transaction and not just a reminder.
      name: "Paycheck - Meridian Health",
      frequency: "weekly",
      interval: 2,
      weekday: 5,
      payee: "Meridian Health Systems",
      templateDescription: "Paycheck - Meridian Health",
      autoCreateDaysBefore: 0,
      splits: [
        { accountId: checking.id, amount: 268_500 },
        { accountId: taxFederal.id, amount: 62_000 },
        { accountId: taxNJ.id, amount: 15_500 },
        { accountId: taxSS.id, amount: 26_800 },
        { accountId: taxMedicare.id, amount: 6_300 },
        { accountId: insHealth.id, amount: 18_000 },
        { accountId: insDental.id, amount: 2_900 },
        { accountId: sarahSalary.id, amount: -400_000 },
      ],
    },
  ];

  for (const ruleSeed of recurringSeeds) {
    const nextDate =
      ruleSeed.frequency === "monthly"
        ? nextMonthlyDate(ruleSeed.dayOfMonth as number)
        : nextWeekdayDate(ruleSeed.weekday as number);

    const [rule] = await db
      .insert(schema.recurringRules)
      .values({
        bookId,
        name: ruleSeed.name,
        frequency: ruleSeed.frequency,
        interval: ruleSeed.interval,
        // Both columns are text holding JSON, matching what the API writes.
        daysOfMonth:
          ruleSeed.dayOfMonth === undefined ? null : JSON.stringify([ruleSeed.dayOfMonth]),
        daysOfWeek: ruleSeed.weekday === undefined ? null : JSON.stringify([ruleSeed.weekday]),
        startDate: nextDate,
        nextDate,
        autoCreateDaysBefore: ruleSeed.autoCreateDaysBefore,
        templateDescription: ruleSeed.templateDescription,
        payeeId: payeeMap[ruleSeed.payee],
        isActive: true,
      })
      .returning();

    await db.insert(schema.recurringTemplateSplits).values(
      ruleSeed.splits.map((split) => ({
        bookId,
        recurringRuleId: rule.id,
        accountId: split.accountId,
        amount: split.amount,
      }))
    );
  }

  logSeed(`  Recurring rules: ${recurringSeeds.length}`);

  // Lots are derived state — let the real engine build them, which also
  // exercises it against a few thousand seeded splits on every seed run.
  // Per-pair transactions (rather than one transaction for the whole loop,
  // as the deploy-time backfill in scripts/rebuild-lots.ts uses) are fine
  // here: `--book-id N` reseeds into an existing book without a full schema
  // drop, so there's no self-healing reset, but rebuildLots must run inside
  // a real transaction (not the bare `db`) for its advisory lock to actually
  // serialize — see lib/lots-db.ts.
  const seededPairs = await findAllLotPairs(db, bookId);
  for (const pair of seededPairs) {
    await db.transaction(async (tx) => {
      await rebuildLots(tx, bookId, pair.accountId, pair.securityId);
    });
  }

  // ============================================================
  // VERIFICATION
  // ============================================================
  const [txnCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.transactions);
  const [splitCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.transactionSplits);
  const [investSplitCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.investmentSplits);
  const [lotCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.investmentLots);
  const [acctCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.accounts);
  const [payeeCountResult] = await db.select({ count: sql<number>`cast(count(*) as integer)` }).from(schema.payees);

  // Verify all transactions balance
  const unbalanced = await db.select({
    id: schema.transactions.id,
    date: schema.transactions.date,
    description: schema.transactions.description,
    total: sql<number>`cast(sum(${schema.transactionSplits.amount}) as integer)`,
  }).from(schema.transactions)
    .innerJoin(schema.transactionSplits, eq(schema.transactionSplits.transactionId, schema.transactions.id))
    .where(eq(schema.transactions.bookId, bookId))
    .groupBy(schema.transactions.id, schema.transactions.date, schema.transactions.description)
    .having(sql`abs(sum(${schema.transactionSplits.amount})) > 1`);

  if (unbalanced.length > 0) {
    console.error("UNBALANCED TRANSACTIONS FOUND:");
    for (const u of unbalanced) {
      console.error(`  ID=${u.id} date=${u.date} "${u.description}" total=${u.total}`);
    }
    throw new Error(`${unbalanced.length} unbalanced transactions found!`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  logSeed("\n  Seed complete!");
  logSeed(`  Time: ${elapsed}s`);
  logSeed(`  Accounts: ${acctCountResult.count}`);
  logSeed(`  Payees: ${payeeCountResult.count}`);
  logSeed(`  Transactions: ${txnCountResult.count}`);
  logSeed(`  Transaction Splits: ${splitCountResult.count}`);
  logSeed(`  Investment Splits: ${investSplitCountResult.count}`);
  logSeed(`  Investment Lots: ${lotCountResult.count}`);
  logSeed(`  All transactions balance: ✓`);
}

/**
 * Full destructive seed: drops all data, recreates schema, creates admin user + book,
 * then seeds data. Used by `npm run db:seed` (no args).
 */
export async function seed() {
  // Reset the database — drop both public (tables) and drizzle (migration metadata)
  // so migrations re-run from scratch
  const sqlClient = getSqlClient_raw();
  await sqlClient`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sqlClient`DROP SCHEMA IF EXISTS public CASCADE`;
  await sqlClient`CREATE SCHEMA public`;

  // Clear cached instances so migrations re-run
  delete globalThis.__counterpoiseDrizzle;
  delete globalThis.__counterpoiseMigrated;

  await runMigrations();
  const db = getDb();

  const { book } = await seedDefaultMeta(db);
  logSeed(`  Created user 'admin' (password: 'password') and book '${book.name}' (id: ${book.id})`);

  await seedBook(db, book.id);
}

export function runSeedCli(): Promise<number> {
  return seed()
    .then(() => 0)
    .catch((error) => {
      console.error("Seed failed:", error);
      return 1;
    });
}

async function main() {
  const args = process.argv.slice(2);
  const bookIdIndex = args.indexOf("--book-id");

  if (bookIdIndex !== -1) {
    const bookIdStr = args[bookIdIndex + 1];
    if (!bookIdStr) {
      console.error("Error: --book-id requires a numeric argument");
      process.exit(1);
    }
    const bookId = parseInt(bookIdStr, 10);
    if (isNaN(bookId)) {
      console.error(`Error: invalid book ID "${bookIdStr}"`);
      process.exit(1);
    }

    const db = getDb();

    // Verify book exists
    const [book] = await db
      .select({ id: schema.books.id, name: schema.books.name })
      .from(schema.books)
      .where(eq(schema.books.id, bookId));

    if (!book) {
      console.error(`Error: book ${bookId} not found. Use 'npm run db:list-books' to see available books.`);
      process.exit(1);
    }

    logSeed(`  Found book '${book.name}' (id: ${book.id})`);
    await seedBook(db, bookId);
  } else {
    const exitCode = await runSeedCli();
    process.exit(exitCode);
  }

  process.exit(0);
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}

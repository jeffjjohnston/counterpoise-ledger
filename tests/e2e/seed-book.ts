import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { buildSeedData } from "./seed-data";
import { e2eDatabaseUrl } from "./database";
import { rebuildLots } from "../../lib/lots-db";
import * as schema from "../../db/schema";

/** Only the accounts and one register row needed by basic CRUD and access tests. */
export async function seedSmallBookData(sql: postgres.Sql, bookId: number) {
  const now = new Date();
  const accounts = await insertAccounts(sql, bookId, [
    { name: "Checking", type: "asset" },
    { name: "Savings", type: "asset" },
    { name: "Groceries", type: "expense" },
    { name: "Salary", type: "income" },
  ]);
  const checking = accounts.find((account) => account.name === "Checking")!;
  const salary = accounts.find((account) => account.name === "Salary")!;
  await insertTransactionWithSplits(sql, bookId, {
    date: formatDate(now),
    description: "Opening salary",
    splits: [
      { accountId: checking.id, amount: 10000 },
      { accountId: salary.id, amount: -10000 },
    ],
  });
}

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatTransferDate = (index: number) => {
  const now = new Date();
  const date = new Date(
    now.getFullYear(),
    now.getMonth(),
    Math.max(1, now.getDate() - index)
  );
  return formatDate(date);
};


type SeedAccount = { name: string; type: string; subtype?: string; isInvestmentCash?: boolean; parentId?: number };

async function insertAccounts(sql: postgres.Sql, bookId: number, data: SeedAccount[]) {
  const now = new Date();
  const rows = data.map((account) => ({
    book_id: bookId,
    name: account.name,
    type: account.type,
    subtype: account.subtype ?? null,
    is_investment_cash: account.isInvestmentCash ?? false,
    parent_id: account.parentId ?? null,
    created_at: now,
    updated_at: now,
  }));
  const inserted = await sql`
    INSERT INTO accounts ${sql(rows, "book_id", "name", "type", "subtype", "is_investment_cash", "parent_id", "created_at", "updated_at")}
    RETURNING id, name, type
  `;
  return inserted.map((row) => ({ id: row.id as number, name: row.name as string, type: row.type as string }));
}

async function insertAccount(sql: postgres.Sql, bookId: number, data: SeedAccount) {
  const [account] = await insertAccounts(sql, bookId, [data]);
  return account;
}

async function insertPayee(sql: postgres.Sql, bookId: number, name: string) {
  const now = new Date();
  const [row] = await sql`INSERT INTO payees (book_id, name, created_at) VALUES (${bookId}, ${name}, ${now}) RETURNING id`;
  return { id: row.id as number, name };
}

async function insertSecurity(
  sql: postgres.Sql,
  bookId: number,
  data: { name: string; symbol: string; securityType: string }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO securities (book_id, name, symbol, security_type, created_at)
    VALUES (${bookId}, ${data.name}, ${data.symbol}, ${data.securityType}, ${now})
    RETURNING id
  `;
  return { id: row.id as number, ...data };
}

async function insertSecurityPrice(
  sql: postgres.Sql,
  bookId: number,
  data: { securityId: number; priceDate: string; priceMicros: number }
) {
  await sql`
    INSERT INTO security_prices (book_id, security_id, price_date, price_micros)
    VALUES (${bookId}, ${data.securityId}, ${data.priceDate}, ${data.priceMicros})
  `;
}

async function insertRecurringRule(
  sql: postgres.Sql,
  bookId: number,
  data: {
    name: string;
    frequency: string;
    startDate: string;
    nextDate: string;
    payeeId?: number;
    templateDescription?: string;
    splits: Array<{ accountId: number; amount: number }>;
  }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO recurring_rules (book_id, name, frequency, interval, start_date, next_date, payee_id, template_description, created_at)
    VALUES (${bookId}, ${data.name}, ${data.frequency}, 1, ${data.startDate}, ${data.nextDate}, ${data.payeeId ?? null}, ${data.templateDescription ?? null}, ${now})
    RETURNING id
  `;
  const ruleId = row.id as number;

  for (const split of data.splits) {
    await sql`
      INSERT INTO recurring_template_splits (book_id, recurring_rule_id, account_id, amount)
      VALUES (${bookId}, ${ruleId}, ${split.accountId}, ${split.amount})
    `;
  }
  return { id: ruleId };
}

async function insertTransactionWithSplits(
  sql: postgres.Sql,
  bookId: number,
  data: {
    date: string;
    description: string;
    splits: Array<{ accountId: number; amount: number }>;
  }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO transactions (book_id, date, description, created_at, updated_at)
    VALUES (${bookId}, ${data.date}, ${data.description}, ${now}, ${now})
    RETURNING id
  `;
  const txnId = row.id as number;

  await sql`
    INSERT INTO transaction_splits ${sql(data.splits.map((split) => ({
      book_id: bookId,
      transaction_id: txnId,
      account_id: split.accountId,
      amount: split.amount,
    })), "book_id", "transaction_id", "account_id", "amount")}
  `;
  return { id: txnId };
}

export async function seedBookData(sql: postgres.Sql, bookId: number) {
  const seed = buildSeedData();

  const checking = await insertAccount(sql, bookId, { name: "Checking", type: "asset" });
  const savings = await insertAccount(sql, bookId, { name: "Savings", type: "asset" });
  const salary = await insertAccount(sql, bookId, { name: "Salary", type: "income" });
  const groceries = await insertAccount(sql, bookId, {
    name: "Groceries",
    type: "expense",
  });
  const rent = await insertAccount(sql, bookId, { name: "Rent", type: "expense" });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.currentMonth,
    description: "Salary (current month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.currentMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.currentMonthIncome },
    ],
  });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.currentMonth,
    description: "Groceries (current month)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.currentMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.currentMonthExpense },
    ],
  });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.lastMonth,
    description: "Salary (last month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.lastMonthIncome },
    ],
  });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.lastMonth,
    description: "Rent (last month)",
    splits: [
      { accountId: rent.id, amount: seed.amounts.lastMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.lastMonthExpense },
    ],
  });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.lastYear,
    description: "Salary (last year)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastYearIncome },
      { accountId: salary.id, amount: -seed.amounts.lastYearIncome },
    ],
  });

  await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.lastYear,
    description: "Groceries (last year)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.lastYearExpense },
      { accountId: checking.id, amount: -seed.amounts.lastYearExpense },
    ],
  });

  for (let index = 0; index < seed.transferCount; index += 1) {
    await insertTransactionWithSplits(sql, bookId, {
      date: formatTransferDate(index + 1),
      description: `Transfer ${index + 1}`,
      splits: [
        { accountId: savings.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
  }

  // Payees
  const wholeFoods = await insertPayee(sql, bookId, "Whole Foods");
  const acmeCorp = await insertPayee(sql, bookId, "Acme Corp");

  // Link salary transactions to Acme Corp payee
  await sql`UPDATE transactions SET payee_id = ${acmeCorp.id} WHERE book_id = ${bookId} AND description LIKE '%Salary%'`;
  // Link groceries transactions to Whole Foods payee
  await sql`UPDATE transactions SET payee_id = ${wholeFoods.id} WHERE book_id = ${bookId} AND description LIKE '%Groceries%'`;

  // Investment accounts
  const brokerage = await insertAccount(sql, bookId, { name: "Brokerage", type: "asset", subtype: "investment" });
  const brokerageCash = await insertAccount(sql, bookId, { name: "Brokerage (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: brokerage.id });
  const retirement = await insertAccount(sql, bookId, { name: "Retirement", type: "asset", subtype: "investment" });
  await insertAccount(sql, bookId, { name: "Retirement (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: retirement.id });

  // Security
  const vti = await insertSecurity(sql, bookId, { name: "Vanguard Total Stock Market", symbol: "VTI", securityType: "etf" });

  // Security price
  await insertSecurityPrice(sql, bookId, {
    securityId: vti.id,
    priceDate: seed.dates.currentMonth,
    priceMicros: 250_000_000,
  });

  // Buy transaction in Brokerage so it has real positions
  // 4 shares of VTI at $250 = $1,000
  const shareMicros = 4_000_000;
  const priceMicros = 250_000_000;
  const grossCents = 100_000; // $1,000
  const buyTxn = await insertTransactionWithSplits(sql, bookId, {
    date: seed.dates.lastYear,
    description: "Buy VTI",
    splits: [
      { accountId: brokerage.id, amount: grossCents },
      { accountId: brokerageCash.id, amount: -grossCents },
    ],
  });
  await sql`
    INSERT INTO investment_splits (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros, fees_cents)
    VALUES (${bookId}, ${buyTxn.id}, ${brokerage.id}, ${vti.id}, 'buy', ${shareMicros}, ${priceMicros}, 0)
  `;
  // investment_lots is derived state (see lib/lots-db.ts) — rebuildLots() is its
  // only writer. Hand-inserting a stub row here used to work, but the lot
  // columns it skipped (account_id, acquired_date, original/remaining
  // shares/basis) are all NOT NULL, so a raw stub insert now fails outright.
  // Replaying the buy split through the real write path keeps this fixture in
  // sync with the schema by construction instead of hand-duplicating it.
  //
  // Wrapping `sql` itself in drizzle() and reusing it here would work for this
  // one call, but corrupts *later* raw `sql\`...\`` queries on the same
  // connection: any subsequent tagged-template query with a Date parameter
  // (e.g. insertRecurringRule's `created_at`) throws "Received an instance of
  // Date" from deep inside postgres.js's bind serializer. Root cause not fully
  // chased down, but reproduces reliably — mixing drizzle-orm/postgres-js and
  // raw postgres.js tagged templates on one connection is the trigger, and a
  // dedicated connection for the drizzle-wrapped call avoids it entirely.
  // A second security carrying two buys and one sell, so the realized gains
  // report has real disposals to render. Deliberately separate from VTI rather
  // than adding a sell to it: five other specs assert against VTI's single-buy,
  // no-sells shape, and this keeps them untouched.
  //
  // The sell spans both lots, which is the case the old single-lot-per-sell
  // model could not represent at all:
  //   lot 1  4 sh @ $250 = $1,000 basis, bought two years ago  -> long-term
  //   lot 2  2 sh @ $300 =   $600 basis, bought last month     -> short-term
  //   sell   5 sh @ $400 = $2,000 proceeds, dated this month
  // FIFO closes lot 1 (basis $1,000, proceeds $1,600, gain $600 long) and takes
  // 1 of lot 2's 2 shares (basis $300, proceeds $400, gain $100 short), leaving
  // one open lot of 1 share. Dating the sell in the current month puts it inside
  // the report's default range, which runs Jan 1 to today.
  const bnd = await insertSecurity(sql, bookId, {
    name: "Vanguard Total Bond Market",
    symbol: "BND",
    securityType: "etf",
  });
  await insertSecurityPrice(sql, bookId, {
    securityId: bnd.id,
    priceDate: seed.dates.currentMonth,
    priceMicros: 400_000_000,
  });

  const bndTrades = [
    { date: seed.dates.twoYearsAgo, action: "buy", shares: 4_000_000, price: 250_000_000, gross: 100_000, desc: "Buy BND" },
    { date: seed.dates.lastMonth, action: "buy", shares: 2_000_000, price: 300_000_000, gross: 60_000, desc: "Buy BND" },
    { date: seed.dates.currentMonth, action: "sell", shares: 5_000_000, price: 400_000_000, gross: 200_000, desc: "Sell BND" },
  ] as const;

  for (const trade of bndTrades) {
    const isBuy = trade.action === "buy";
    const txn = await insertTransactionWithSplits(sql, bookId, {
      date: trade.date,
      description: trade.desc,
      splits: [
        { accountId: brokerage.id, amount: isBuy ? trade.gross : -trade.gross },
        { accountId: brokerageCash.id, amount: isBuy ? -trade.gross : trade.gross },
      ],
    });
    await sql`
      INSERT INTO investment_splits (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros, fees_cents)
      VALUES (${bookId}, ${txn.id}, ${brokerage.id}, ${bnd.id}, ${trade.action}, ${trade.shares}, ${trade.price}, 0)
    `;
  }

  const lotsSql = postgres(e2eDatabaseUrl(), { onnotice: () => {} });
  const lotsDb = drizzle(lotsSql, { schema });
  await lotsDb.transaction(async (tx) => {
    await rebuildLots(tx, bookId, brokerage.id, vti.id);
    await rebuildLots(tx, bookId, brokerage.id, bnd.id);
  });
  await lotsSql.end();

  // Recurring rule — Monthly Rent, due tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  await insertRecurringRule(sql, bookId, {
    name: "Monthly Rent",
    frequency: "monthly",
    startDate: seed.dates.lastYear,
    nextDate: tomorrowStr,
    splits: [
      { accountId: rent.id, amount: 150000 },
      { accountId: checking.id, amount: -150000 },
    ],
  });
}

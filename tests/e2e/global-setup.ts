import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createHash } from "node:crypto";
import { resolve } from "path";
import { buildSeedData } from "./seed-data";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { hashPassword } from "../../lib/auth";
import { MIGRATIONS_FOLDER } from "../../db/create-book";
import { rebuildLots } from "../../lib/lots-db";
import * as schema from "../../db/schema";

const E2E_DB_URL =
  process.env.E2E_DATABASE_URL ||
  "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_e2e";
const E2E_STORAGE_STATE_PATH = resolve(
  "./test-results/e2e-storage-state.json"
);

const SESSION_TOKEN = "e2e-test-session-token-fixed";

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

function createQuietSql() {
  return postgres(E2E_DB_URL, {
    onnotice: () => {},
  });
}

async function setupDatabase() {
  // Drop and recreate schema for clean slate (including drizzle migration metadata)
  const setupSql = createQuietSql();
  await setupSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await setupSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await setupSql`CREATE SCHEMA public`;
  await setupSql.end();

  // Run migrations
  const migrationSql = createQuietSql();
  await migrate(drizzle(migrationSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await migrationSql.end();

  // Use a fresh connection for seeding
  const sql = createQuietSql();

  // Create user, book, and session
  const passwordHash = await hashPassword("testpassword");
  const now = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const sessionTokenHash = createHash("sha256").update(SESSION_TOKEN).digest("hex");

  await sql`INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'testuser', ${passwordHash}, ${now})`;
  await sql`INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'Test Book', ${now}, ${now})`;
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (${sessionTokenHash}, 1, ${expiresAt}, ${now})`;
  await sql`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, true)`;
  await sql`SELECT setval(pg_get_serial_sequence('books', 'id'), 1, true)`;

  return sql;
}

async function insertAccount(
  sql: postgres.Sql,
  data: { name: string; type: string; subtype?: string; isInvestmentCash?: boolean; parentId?: number }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO accounts (book_id, name, type, subtype, is_investment_cash, parent_id, created_at, updated_at)
    VALUES (1, ${data.name}, ${data.type}, ${data.subtype ?? null}, ${data.isInvestmentCash ?? false}, ${data.parentId ?? null}, ${now}, ${now})
    RETURNING id, name, type
  `;
  return { id: row.id as number, name: data.name, type: data.type };
}

async function insertPayee(sql: postgres.Sql, name: string) {
  const now = new Date();
  const [row] = await sql`INSERT INTO payees (book_id, name, created_at) VALUES (1, ${name}, ${now}) RETURNING id`;
  return { id: row.id as number, name };
}

async function insertSecurity(
  sql: postgres.Sql,
  data: { name: string; symbol: string; securityType: string }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO securities (book_id, name, symbol, security_type, created_at)
    VALUES (1, ${data.name}, ${data.symbol}, ${data.securityType}, ${now})
    RETURNING id
  `;
  return { id: row.id as number, ...data };
}

async function insertSecurityPrice(
  sql: postgres.Sql,
  data: { securityId: number; priceDate: string; priceMicros: number }
) {
  await sql`
    INSERT INTO security_prices (book_id, security_id, price_date, price_micros)
    VALUES (1, ${data.securityId}, ${data.priceDate}, ${data.priceMicros})
  `;
}

async function insertRecurringRule(
  sql: postgres.Sql,
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
    VALUES (1, ${data.name}, ${data.frequency}, 1, ${data.startDate}, ${data.nextDate}, ${data.payeeId ?? null}, ${data.templateDescription ?? null}, ${now})
    RETURNING id
  `;
  const ruleId = row.id as number;

  for (const split of data.splits) {
    await sql`
      INSERT INTO recurring_template_splits (book_id, recurring_rule_id, account_id, amount)
      VALUES (1, ${ruleId}, ${split.accountId}, ${split.amount})
    `;
  }
  return { id: ruleId };
}

async function insertTransactionWithSplits(
  sql: postgres.Sql,
  data: {
    date: string;
    description: string;
    splits: Array<{ accountId: number; amount: number }>;
  }
) {
  const now = new Date();
  const [row] = await sql`
    INSERT INTO transactions (book_id, date, description, created_at, updated_at)
    VALUES (1, ${data.date}, ${data.description}, ${now}, ${now})
    RETURNING id
  `;
  const txnId = row.id as number;

  for (const split of data.splits) {
    await sql`
      INSERT INTO transaction_splits (book_id, transaction_id, account_id, amount)
      VALUES (1, ${txnId}, ${split.accountId}, ${split.amount})
    `;
  }
  return { id: txnId };
}

async function seedBookData(sql: postgres.Sql) {
  const seed = buildSeedData();

  const checking = await insertAccount(sql, { name: "Checking", type: "asset" });
  const savings = await insertAccount(sql, { name: "Savings", type: "asset" });
  const salary = await insertAccount(sql, { name: "Salary", type: "income" });
  const groceries = await insertAccount(sql, {
    name: "Groceries",
    type: "expense",
  });
  const rent = await insertAccount(sql, { name: "Rent", type: "expense" });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.currentMonth,
    description: "Salary (current month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.currentMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.currentMonthIncome },
    ],
  });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.currentMonth,
    description: "Groceries (current month)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.currentMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.currentMonthExpense },
    ],
  });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.lastMonth,
    description: "Salary (last month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.lastMonthIncome },
    ],
  });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.lastMonth,
    description: "Rent (last month)",
    splits: [
      { accountId: rent.id, amount: seed.amounts.lastMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.lastMonthExpense },
    ],
  });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.lastYear,
    description: "Salary (last year)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastYearIncome },
      { accountId: salary.id, amount: -seed.amounts.lastYearIncome },
    ],
  });

  await insertTransactionWithSplits(sql, {
    date: seed.dates.lastYear,
    description: "Groceries (last year)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.lastYearExpense },
      { accountId: checking.id, amount: -seed.amounts.lastYearExpense },
    ],
  });

  for (let index = 0; index < seed.transferCount; index += 1) {
    await insertTransactionWithSplits(sql, {
      date: formatTransferDate(index + 1),
      description: `Transfer ${index + 1}`,
      splits: [
        { accountId: savings.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
  }

  // Payees
  const wholeFoods = await insertPayee(sql, "Whole Foods");
  const acmeCorp = await insertPayee(sql, "Acme Corp");

  // Link salary transactions to Acme Corp payee
  await sql`UPDATE transactions SET payee_id = ${acmeCorp.id} WHERE description LIKE '%Salary%'`;
  // Link groceries transactions to Whole Foods payee
  await sql`UPDATE transactions SET payee_id = ${wholeFoods.id} WHERE description LIKE '%Groceries%'`;

  // Investment accounts
  const brokerage = await insertAccount(sql, { name: "Brokerage", type: "asset", subtype: "investment" });
  const brokerageCash = await insertAccount(sql, { name: "Brokerage (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: brokerage.id });
  const retirement = await insertAccount(sql, { name: "Retirement", type: "asset", subtype: "investment" });
  await insertAccount(sql, { name: "Retirement (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: retirement.id });

  // Security
  const vti = await insertSecurity(sql, { name: "Vanguard Total Stock Market", symbol: "VTI", securityType: "etf" });

  // Security price
  await insertSecurityPrice(sql, {
    securityId: vti.id,
    priceDate: seed.dates.currentMonth,
    priceMicros: 250_000_000,
  });

  // Buy transaction in Brokerage so it has real positions
  // 4 shares of VTI at $250 = $1,000
  const shareMicros = 4_000_000;
  const priceMicros = 250_000_000;
  const grossCents = 100_000; // $1,000
  const buyTxn = await insertTransactionWithSplits(sql, {
    date: seed.dates.lastYear,
    description: "Buy VTI",
    splits: [
      { accountId: brokerage.id, amount: grossCents },
      { accountId: brokerageCash.id, amount: -grossCents },
    ],
  });
  await sql`
    INSERT INTO investment_splits (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros, fees_cents)
    VALUES (1, ${buyTxn.id}, ${brokerage.id}, ${vti.id}, 'buy', ${shareMicros}, ${priceMicros}, 0)
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
  const bnd = await insertSecurity(sql, {
    name: "Vanguard Total Bond Market",
    symbol: "BND",
    securityType: "etf",
  });
  await insertSecurityPrice(sql, {
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
    const txn = await insertTransactionWithSplits(sql, {
      date: trade.date,
      description: trade.desc,
      splits: [
        { accountId: brokerage.id, amount: isBuy ? trade.gross : -trade.gross },
        { accountId: brokerageCash.id, amount: isBuy ? -trade.gross : trade.gross },
      ],
    });
    await sql`
      INSERT INTO investment_splits (book_id, transaction_id, account_id, security_id, action, shares_micros, price_micros, fees_cents)
      VALUES (1, ${txn.id}, ${brokerage.id}, ${bnd.id}, ${trade.action}, ${trade.shares}, ${trade.price}, 0)
    `;
  }

  const lotsSql = createQuietSql();
  const lotsDb = drizzle(lotsSql, { schema });
  await rebuildLots(lotsDb, 1, brokerage.id, vti.id);
  await rebuildLots(lotsDb, 1, brokerage.id, bnd.id);
  await lotsSql.end();

  // Recurring rule — Monthly Rent, due tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  await insertRecurringRule(sql, {
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

function writeStorageState() {
  const dir = resolve("./test-results");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storageState = {
    cookies: [
      {
        name: "counterpoise_session",
        value: SESSION_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
        expires: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      },
    ],
    origins: [],
  };

  writeFileSync(E2E_STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}

const globalSetup = async () => {
  const sql = await setupDatabase();
  await seedBookData(sql);
  await sql.end();

  writeStorageState();
};

export default globalSetup;

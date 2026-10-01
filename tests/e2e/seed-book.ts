import { buildSeedData } from "./seed-data";
import { exec, insert, insertRows } from "../helpers/sql";

/**
 * Sends a POST with a JSON body to the E2E server as the E2E user, and returns
 * the parsed answer. It throws when the status is not 2xx.
 */
export type ApiPost = (path: string, body: unknown) => Promise<unknown>;

/**
 * Seeds a book. The caller sets the E2E database with `setDatabasePath()`
 * before it calls a seed function.
 */
export type SeedBook = (bookId: number, post: ApiPost) => Promise<void>;

/** Only the accounts and one register row needed by basic CRUD and access tests. */
export async function seedSmallBookData(bookId: number) {
  const now = new Date();
  const accounts = await insertAccounts(bookId, [
    { name: "Checking", type: "asset" },
    { name: "Savings", type: "asset" },
    { name: "Groceries", type: "expense" },
    { name: "Salary", type: "income" },
  ]);
  const checking = accounts.find((account) => account.name === "Checking")!;
  const salary = accounts.find((account) => account.name === "Salary")!;
  await insertTransactionWithSplits(bookId, {
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

async function insertAccounts(bookId: number, data: SeedAccount[]) {
  const inserted = await insertRows<{ id: number; name: string; type: string }>("accounts", data.map((account) => ({
    bookId,
    name: account.name,
    type: account.type,
    subtype: account.subtype ?? null,
    isInvestmentCash: account.isInvestmentCash ?? false,
    parentId: account.parentId ?? null,
  })));
  return inserted.map((row) => ({ id: row.id, name: row.name, type: row.type }));
}

async function insertAccount(bookId: number, data: SeedAccount) {
  const [account] = await insertAccounts(bookId, [data]);
  return account;
}

async function insertPayee(bookId: number, name: string) {
  const row = await insert<{ id: number }>("payees", { bookId, name });
  return { id: row.id, name };
}

async function insertSecurity(
  bookId: number,
  data: { name: string; symbol: string; securityType: string }
) {
  const row = await insert<{ id: number }>("securities", {
    bookId, name: data.name, symbol: data.symbol, securityType: data.securityType,
  });
  return { id: row.id, ...data };
}

async function insertSecurityPrice(
  bookId: number,
  data: { securityId: number; priceDate: string; priceMicros: number }
) {
  await insert("security_prices", { bookId, ...data });
}

async function insertRecurringRule(
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
  const row = await insert<{ id: number }>("recurring_rules", {
    bookId,
    name: data.name,
    frequency: data.frequency,
    interval: 1,
    startDate: data.startDate,
    nextDate: data.nextDate,
    payeeId: data.payeeId ?? null,
    templateDescription: data.templateDescription ?? null,
  });

  for (const split of data.splits) {
    await insert("recurring_template_splits", {
      bookId, recurringRuleId: row.id, accountId: split.accountId, amount: split.amount,
    });
  }
  return { id: row.id };
}

async function insertTransactionWithSplits(
  bookId: number,
  data: {
    date: string;
    description: string;
    splits: Array<{ accountId: number; amount: number }>;
  }
) {
  const row = await insert<{ id: number }>("transactions", {
    bookId, date: data.date, description: data.description,
  });
  await insertRows("transaction_splits", data.splits.map((split) => ({
    bookId, transactionId: row.id, accountId: split.accountId, amount: split.amount,
  })));
  return { id: row.id };
}

/**
 * Writes one investment transaction through the server. The server writes
 * the splits and rebuilds the lots of each pair in the same transaction.
 */
async function postInvestmentTransaction(
  post: ApiPost,
  bookId: number,
  data: {
    date: string;
    description: string;
    splits: Array<{ accountId: number; amount: number }>;
    investmentSplit: { securityId: number; action: "buy" | "sell"; sharesMicros: number; priceMicros: number };
  }
) {
  await post(`/api/b/${bookId}/transactions`, {
    date: data.date,
    description: data.description,
    splits: data.splits,
    investmentSplits: [{ ...data.investmentSplit, feesCents: 0 }],
  });
}

export async function seedBookData(bookId: number, post: ApiPost) {
  const seed = buildSeedData();

  const checking = await insertAccount(bookId, { name: "Checking", type: "asset" });
  const savings = await insertAccount(bookId, { name: "Savings", type: "asset" });
  const salary = await insertAccount(bookId, { name: "Salary", type: "income" });
  const groceries = await insertAccount(bookId, {
    name: "Groceries",
    type: "expense",
  });
  const rent = await insertAccount(bookId, { name: "Rent", type: "expense" });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.currentMonth,
    description: "Salary (current month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.currentMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.currentMonthIncome },
    ],
  });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.currentMonth,
    description: "Groceries (current month)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.currentMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.currentMonthExpense },
    ],
  });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.lastMonth,
    description: "Salary (last month)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastMonthIncome },
      { accountId: salary.id, amount: -seed.amounts.lastMonthIncome },
    ],
  });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.lastMonth,
    description: "Rent (last month)",
    splits: [
      { accountId: rent.id, amount: seed.amounts.lastMonthExpense },
      { accountId: checking.id, amount: -seed.amounts.lastMonthExpense },
    ],
  });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.lastYear,
    description: "Salary (last year)",
    splits: [
      { accountId: checking.id, amount: seed.amounts.lastYearIncome },
      { accountId: salary.id, amount: -seed.amounts.lastYearIncome },
    ],
  });

  await insertTransactionWithSplits(bookId, {
    date: seed.dates.lastYear,
    description: "Groceries (last year)",
    splits: [
      { accountId: groceries.id, amount: seed.amounts.lastYearExpense },
      { accountId: checking.id, amount: -seed.amounts.lastYearExpense },
    ],
  });

  for (let index = 0; index < seed.transferCount; index += 1) {
    await insertTransactionWithSplits(bookId, {
      date: formatTransferDate(index + 1),
      description: `Transfer ${index + 1}`,
      splits: [
        { accountId: savings.id, amount: 100 },
        { accountId: checking.id, amount: -100 },
      ],
    });
  }

  // Payees
  const wholeFoods = await insertPayee(bookId, "Whole Foods");
  const acmeCorp = await insertPayee(bookId, "Acme Corp");

  // Link salary transactions to Acme Corp payee
  await exec("UPDATE transactions SET payee_id = $1 WHERE book_id = $2 AND description LIKE '%Salary%'", [acmeCorp.id, bookId]);
  // Link groceries transactions to Whole Foods payee
  await exec("UPDATE transactions SET payee_id = $1 WHERE book_id = $2 AND description LIKE '%Groceries%'", [wholeFoods.id, bookId]);

  // Investment accounts
  const brokerage = await insertAccount(bookId, { name: "Brokerage", type: "asset", subtype: "investment" });
  const brokerageCash = await insertAccount(bookId, { name: "Brokerage (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: brokerage.id });
  const retirement = await insertAccount(bookId, { name: "Retirement", type: "asset", subtype: "investment" });
  await insertAccount(bookId, { name: "Retirement (Cash)", type: "asset", subtype: "cash", isInvestmentCash: true, parentId: retirement.id });

  // Security
  const vti = await insertSecurity(bookId, { name: "Vanguard Total Stock Market", symbol: "VTI", securityType: "etf" });

  // Security price
  await insertSecurityPrice(bookId, {
    securityId: vti.id,
    priceDate: seed.dates.currentMonth,
    priceMicros: 250_000_000,
  });

  // Buy transaction in Brokerage so it has real positions
  // 4 shares of VTI at $250 = $1,000
  const shareMicros = 4_000_000;
  const priceMicros = 250_000_000;
  const grossCents = 100_000; // $1,000
  // investment_lots is derived state: the server's lot rebuild is its only
  // writer. A raw insert of a lot must duplicate the lot columns by hand, and
  // they are all NOT NULL. Thus each investment transaction goes through the
  // real write path, which rebuilds the lots of its pair.
  await postInvestmentTransaction(post, bookId, {
    date: seed.dates.lastYear,
    description: "Buy VTI",
    splits: [
      { accountId: brokerage.id, amount: grossCents },
      { accountId: brokerageCash.id, amount: -grossCents },
    ],
    investmentSplit: { securityId: vti.id, action: "buy", sharesMicros: shareMicros, priceMicros },
  });

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
  const bnd = await insertSecurity(bookId, {
    name: "Vanguard Total Bond Market",
    symbol: "BND",
    securityType: "etf",
  });
  await insertSecurityPrice(bookId, {
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
    await postInvestmentTransaction(post, bookId, {
      date: trade.date,
      description: trade.desc,
      splits: [
        { accountId: brokerage.id, amount: isBuy ? trade.gross : -trade.gross },
        { accountId: brokerageCash.id, amount: isBuy ? -trade.gross : trade.gross },
      ],
      investmentSplit: { securityId: bnd.id, action: trade.action, sharesMicros: trade.shares, priceMicros: trade.price },
    });
  }

  // Recurring rule — Monthly Rent, due tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = formatDate(tomorrow);

  await insertRecurringRule(bookId, {
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

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  serial,
  timestamp,
  foreignKey,
  primaryKey,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ── Meta tables ────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("users_username_unique").on(table.username)]
);

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(), // First 8 chars for identification
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const books = pgTable("books", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  upcomingDays: integer("upcoming_days").notNull().default(30),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  check("upcoming_days_range", sql`${table.upcomingDays} >= 1 AND ${table.upcomingDays} <= 365`),
]);

export const issueReports = pgTable("issue_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  type: text("type", {
    enum: ["bug", "improvement", "other"],
  })
    .notNull()
    .default("bug"),
  page: text("page").notNull(),
  status: text("status", {
    enum: ["new", "resolved", "wontfix"],
  })
    .notNull()
    .default("new"),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

// ── Book-scoped tables ─────────────────────────────────────────────────────────

export const accounts = pgTable(
  "accounts",
  {
    id: serial("id").primaryKey(),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["asset", "liability", "equity", "income", "expense"],
    }).notNull(),
    subtype: text("subtype", {
      enum: ["bank", "credit_card", "loan", "investment", "cash", "other"],
    }),
    parentId: integer("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    isFavorite: boolean("is_favorite")
      .notNull()
      .default(false),
    isInvestmentCash: boolean("is_investment_cash")
      .notNull()
      .default(false),
    // A single emoji grapheme. `null` means "inherit from the parent
    // account", not "no icon". resolveAccountIcon() in lib/accounting.ts does
    // the walk at render time.
    icon: text("icon"),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
    }),
    uniqueIndex("accounts_name_book_unique").on(table.name, table.bookId),
  ]
);

export const payees = pgTable(
  "payees",
  {
    id: serial("id").primaryKey(),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("payees_name_book_unique").on(table.name, table.bookId)]
);

export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  description: text("description"),
  checkNumber: text("check_number"),
  notes: text("notes"),
  payeeId: integer("payee_id").references(() => payees.id, { onDelete: "set null" }),
  isReconciled: boolean("is_reconciled").notNull().default(false),
  isFloating: boolean("is_floating").notNull().default(false),
  recurringRuleId: integer("recurring_rule_id").references(() => recurringRules.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  // Leads with bookId because every list query filters on it. Do not expect a
  // speedup: the flagship list sorts by effectiveDateSql, which no index can
  // serve while the effective date is computed on read (CURRENT_DATE is STABLE,
  // not IMMUTABLE, so an expression index over it is rejected). This is for
  // correctness and multi-book growth.
  index("idx_transactions_book_date_id").on(table.bookId, table.date, table.id),
  // Deliberately NOT bookId-prefixed. payeeId is itself book-scoped, so an
  // equality predicate on it already confines the scan to one book; adding
  // bookId ahead of it would only widen the index for no gain.
  index("idx_transactions_payee_date_id").on(table.payeeId, table.date, table.id),
]);

export const securities = pgTable("securities", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  securityType: text("security_type", {
    enum: ["etf", "mutual_fund", "stock"],
  }).notNull(),
  fetchPrices: boolean("fetch_prices")
    .notNull()
    .default(true),
  // A security whose price never moves — a money market fund at a $1.00 NAV.
  // Non-null means fixed-price: this value supersedes every security_prices
  // row for valuation, and the security is excluded from the Tiingo cron and
  // the price entry pill. Null means the price comes from security_prices as
  // usual. Micros, like every other price in the schema.
  fixedPriceMicros: bigint("fixed_price_micros", { mode: "number" }),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("securities_name_symbol_book_unique").on(table.name, table.symbol, table.bookId),
]);

export const securityPrices = pgTable(
  "security_prices",
  {
    securityId: integer("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    priceDate: text("price_date").notNull(),
    priceMicros: bigint("price_micros", { mode: "number" }).notNull(),
    source: text("source"),
  },
  (table) => [primaryKey({ columns: [table.securityId, table.priceDate] })]
);

export const investmentLots = pgTable("investment_lots", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  securityId: integer("security_id")
    .notNull()
    .references(() => securities.id, { onDelete: "cascade" }),
  // Effective date of the opening buy. Drives short vs long term.
  acquiredDate: text("acquired_date").notNull(),
  // The buy split that opened this lot. Unique per lot, so rebuildLots can map
  // replayed lots to inserted rows without relying on RETURNING row order.
  openedSplitId: integer("opened_split_id").references(
    (): AnyPgColumn => investmentSplits.id,
    { onDelete: "set null" }
  ),
  openedTransactionId: integer("opened_transaction_id").references(() => transactions.id, {
    onDelete: "set null",
  }),
  closedTransactionId: integer("closed_transaction_id").references(() => transactions.id, {
    onDelete: "set null",
  }),
  originalSharesMicros: bigint("original_shares_micros", { mode: "number" }).notNull(),
  originalBasisCents: integer("original_basis_cents").notNull(),
  remainingSharesMicros: bigint("remaining_shares_micros", { mode: "number" }).notNull(),
  remainingBasisCents: integer("remaining_basis_cents").notNull(),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("idx_investment_lots_pair").on(table.bookId, table.accountId, table.securityId),
  index("idx_investment_lots_open").on(table.securityId, table.remainingSharesMicros),
  // rebuildLots maps replayed lots back to inserted rows by keying a Map on
  // openedSplitId, so a duplicate must fail loudly at the DB rather than
  // silently dropping a lot from that map. PostgreSQL unique indexes allow
  // multiple NULLs, so lots whose opening split was deleted (onDelete: "set
  // null") are unaffected.
  uniqueIndex("idx_investment_lots_opened_split_unique").on(table.openedSplitId),
]);

export const investmentSplits = pgTable("investment_splits", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  transactionId: integer("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  accountId: integer("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  securityId: integer("security_id")
    .notNull()
    .references(() => securities.id, { onDelete: "cascade" }),
  lotId: integer("lot_id").references(() => investmentLots.id, { onDelete: "set null" }),
  action: text("action", {
    enum: ["buy", "sell", "dividend", "capGain", "fee", "split"],
  }).notNull(),
  sharesMicros: bigint("shares_micros", { mode: "number" }).notNull(),
  priceMicros: bigint("price_micros", { mode: "number" }).notNull(),
  feesCents: integer("fees_cents").notNull().default(0),
  splitNumerator: integer("split_numerator"),
  splitDenominator: integer("split_denominator"),
}, (table) => [
  index("idx_investment_splits_txn").on(table.transactionId),
  index("idx_investment_splits_account_txn").on(table.accountId, table.transactionId),
  index("idx_investment_splits_security_txn").on(table.securityId, table.transactionId),
]);

export const investmentLotAllocations = pgTable("investment_lot_allocations", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  lotId: integer("lot_id")
    .notNull()
    .references(() => investmentLots.id, { onDelete: "cascade" }),
  sellSplitId: integer("sell_split_id")
    .notNull()
    .references(() => investmentSplits.id, { onDelete: "cascade" }),
  transactionId: integer("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  sharesMicros: bigint("shares_micros", { mode: "number" }).notNull(),
  basisCents: integer("basis_cents").notNull(),
  proceedsCents: integer("proceeds_cents").notNull(),
}, (table) => [
  index("idx_lot_allocations_lot").on(table.lotId),
  index("idx_lot_allocations_sell").on(table.sellSplitId),
  index("idx_lot_allocations_book_txn").on(table.bookId, table.transactionId),
]);

export const transactionSplits = pgTable("transaction_splits", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  transactionId: integer("transaction_id")
    .notNull()
    .references(() => transactions.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  amount: integer("amount").notNull(), // positive = debit, negative = credit
}, (table) => [
  index("idx_transaction_splits_account_txn").on(table.accountId, table.transactionId),
  index("idx_transaction_splits_txn_amount").on(table.transactionId, table.amount),
]);

export const recurringRules = pgTable("recurring_rules", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  frequency: text("frequency", {
    enum: ["daily", "weekly", "monthly", "yearly"],
  }).notNull(),
  interval: integer("interval").notNull().default(1),
  daysOfWeek: text("days_of_week"),
  weekOfMonth: text("week_of_month"),
  daysOfMonth: text("days_of_month"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  nextDate: text("next_date").notNull(),
  // When true, an occurrence that lands on a weekend is observed on the
  // following Monday instead. Only the *occurrence* moves: next_date keeps the
  // unshifted schedule, so a Saturday occurrence never drags the following
  // month's due date forward with it. Weekends are the whole definition of
  // "non-business day" here — bank holidays are not modeled, same limitation
  // getNextBusinessDay() in lib/accounting.ts documents. Two scheduled
  // occurrences can collapse onto one observed date (a daily rule's Saturday
  // and Sunday both land on Monday); that is two occurrences observed the same
  // day, and both transactions are created.
  businessDaysOnly: boolean("business_days_only").notNull().default(false),
  autoCreateDaysBefore: integer("auto_create_days_before").notNull().default(0),
  templateDescription: text("template_description"),
  payeeId: integer("payee_id").references(() => payees.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index("idx_recurring_rules_active_next").on(table.isActive, table.nextDate),
]);

export const recurringTemplateSplits = pgTable("recurring_template_splits", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  recurringRuleId: integer("recurring_rule_id")
    .notNull()
    .references(() => recurringRules.id, { onDelete: "cascade" }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  amount: integer("amount").notNull(),
}, (table) => [
  index("idx_recurring_template_splits_rule").on(table.recurringRuleId),
]);

export const plaidTokens = pgTable(
  "plaid_tokens",
  {
    id: serial("id").primaryKey(),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    financialInstitution: text("financial_institution").notNull(),
    itemId: text("item_id").notNull(),
    accessToken: text("access_token").notNull(),
    syncCursor: text("sync_cursor"),
    lastSyncedAt: timestamp("last_synced_at"),
    lastError: text("last_error"),
    // True for the connection the seed creates in a demo book. Its access
    // token is synthetic, so any call to Plaid with it is guaranteed to fail.
    // The scheduled sync skips these rows and syncToken refuses them, which
    // keeps a demo book from making a doomed external request every six hours
    // and reporting "Last sync failed" on its own Sync page.
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("plaid_tokens_item_id_unique").on(table.itemId)]
);

export const plaidAccounts = pgTable(
  "plaid_accounts",
  {
    id: serial("id").primaryKey(),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    tokenId: integer("token_id")
      .notNull()
      .references(() => plaidTokens.id, { onDelete: "cascade" }),
    plaidAccountId: text("plaid_account_id").notNull(),
    name: text("name").notNull(),
    officialName: text("official_name"),
    mask: text("mask"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    counterpoiseAccountId: integer("counterpoise_account_id").references(
      () => accounts.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("plaid_accounts_plaid_account_id_unique").on(
      table.plaidAccountId
    ),
    uniqueIndex("plaid_accounts_counterpoise_account_id_unique").on(
      table.counterpoiseAccountId
    ),
    index("idx_plaid_accounts_token").on(table.tokenId),
  ]
);

export const plaidTransactionReconciliation = pgTable(
  "plaid_transaction_reconciliation",
  {
    id: serial("id").primaryKey(),
    bookId: integer("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    plaidAccountLinkId: integer("plaid_account_link_id")
      .notNull()
      .references(() => plaidAccounts.id, { onDelete: "cascade" }),
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    date: text("date").notNull(),
    authorizedDate: text("authorized_date"),
    amountCents: integer("amount_cents").notNull(),
    name: text("name").notNull(),
    merchantName: text("merchant_name"),
    originalDescription: text("original_description"),
    pending: boolean("pending").notNull().default(false),
    pendingTransactionId: text("pending_transaction_id"),
    isoCurrencyCode: text("iso_currency_code"),
    unofficialCurrencyCode: text("unofficial_currency_code"),
    categoryPrimary: text("category_primary"),
    categoryDetailed: text("category_detailed"),
    rawJson: text("raw_json").notNull(),
    resolutionStatus: text("resolution_status", {
      enum: ["pending", "matched", "created", "ignored"],
    })
      .notNull()
      .default("pending"),
    reviewReason: text("review_reason", {
      enum: ["plaid_modified", "plaid_removed"],
    }),
    reviewMetadataJson: text("review_metadata_json"),
    matchedTransactionId: integer("matched_transaction_id").references(
      () => transactions.id,
      { onDelete: "set null" }
    ),
    resolvedAt: timestamp("resolved_at"),
    firstSeenAt: timestamp("first_seen_at")
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: timestamp("last_seen_at")
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("plaid_recon_link_txn_unique").on(
      table.plaidAccountLinkId,
      table.plaidTransactionId
    ),
    uniqueIndex("plaid_recon_link_matched_txn_unique").on(
      table.plaidAccountLinkId,
      table.matchedTransactionId
    ),
    index("plaid_recon_link_status_idx").on(
      table.plaidAccountLinkId,
      table.resolutionStatus,
      table.reviewReason
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  books: many(books),
  apiKeys: many(apiKeys),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const booksRelations = relations(books, ({ one, many }) => ({
  user: one(users, { fields: [books.userId], references: [users.id] }),
  accounts: many(accounts),
  transactions: many(transactions),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  book: one(books, { fields: [accounts.bookId], references: [books.id] }),
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: "parentChild",
  }),
  children: many(accounts, { relationName: "parentChild" }),
  splits: many(transactionSplits),
  plaidLinks: many(plaidAccounts),
}));

export const transactionsRelations = relations(transactions, ({ one, many }) => ({
  book: one(books, { fields: [transactions.bookId], references: [books.id] }),
  splits: many(transactionSplits),
  investmentSplits: many(investmentSplits),
  plaidReconciliations: many(plaidTransactionReconciliation),
  openedInvestmentLots: many(investmentLots, { relationName: "openedInvestmentLots" }),
  closedInvestmentLots: many(investmentLots, { relationName: "closedInvestmentLots" }),
  payee: one(payees, {
    fields: [transactions.payeeId],
    references: [payees.id],
  }),
  recurringRule: one(recurringRules, {
    fields: [transactions.recurringRuleId],
    references: [recurringRules.id],
  }),
}));

export const transactionSplitsRelations = relations(transactionSplits, ({ one }) => ({
  transaction: one(transactions, {
    fields: [transactionSplits.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, {
    fields: [transactionSplits.accountId],
    references: [accounts.id],
  }),
}));

export const recurringRulesRelations = relations(recurringRules, ({ one, many }) => ({
  book: one(books, { fields: [recurringRules.bookId], references: [books.id] }),
  transactions: many(transactions),
  templateSplits: many(recurringTemplateSplits),
  payee: one(payees, {
    fields: [recurringRules.payeeId],
    references: [payees.id],
  }),
}));

export const recurringTemplateSplitsRelations = relations(recurringTemplateSplits, ({ one }) => ({
  recurringRule: one(recurringRules, {
    fields: [recurringTemplateSplits.recurringRuleId],
    references: [recurringRules.id],
  }),
  account: one(accounts, {
    fields: [recurringTemplateSplits.accountId],
    references: [accounts.id],
  }),
}));

export const securityPricesRelations = relations(securityPrices, ({ one }) => ({
  security: one(securities, {
    fields: [securityPrices.securityId],
    references: [securities.id],
  }),
}));

export const investmentLotsRelations = relations(investmentLots, ({ one, many }) => ({
  security: one(securities, {
    fields: [investmentLots.securityId],
    references: [securities.id],
  }),
  account: one(accounts, {
    fields: [investmentLots.accountId],
    references: [accounts.id],
  }),
  openedTransaction: one(transactions, {
    fields: [investmentLots.openedTransactionId],
    references: [transactions.id],
    relationName: "openedInvestmentLots",
  }),
  closedTransaction: one(transactions, {
    fields: [investmentLots.closedTransactionId],
    references: [transactions.id],
    relationName: "closedInvestmentLots",
  }),
  allocations: many(investmentLotAllocations),
}));

export const investmentLotAllocationsRelations = relations(investmentLotAllocations, ({ one }) => ({
  lot: one(investmentLots, {
    fields: [investmentLotAllocations.lotId],
    references: [investmentLots.id],
  }),
  sellSplit: one(investmentSplits, {
    fields: [investmentLotAllocations.sellSplitId],
    references: [investmentSplits.id],
  }),
  transaction: one(transactions, {
    fields: [investmentLotAllocations.transactionId],
    references: [transactions.id],
  }),
}));

export const investmentSplitsRelations = relations(investmentSplits, ({ one }) => ({
  transaction: one(transactions, {
    fields: [investmentSplits.transactionId],
    references: [transactions.id],
  }),
  account: one(accounts, {
    fields: [investmentSplits.accountId],
    references: [accounts.id],
  }),
  security: one(securities, {
    fields: [investmentSplits.securityId],
    references: [securities.id],
  }),
  lot: one(investmentLots, {
    fields: [investmentSplits.lotId],
    references: [investmentLots.id],
  }),
}));

export const securitiesRelations = relations(securities, ({ one, many }) => ({
  book: one(books, { fields: [securities.bookId], references: [books.id] }),
  prices: many(securityPrices),
  investmentLots: many(investmentLots),
  investmentSplits: many(investmentSplits),
}));

export const payeesRelations = relations(payees, ({ one, many }) => ({
  book: one(books, { fields: [payees.bookId], references: [books.id] }),
  transactions: many(transactions),
}));

export const plaidTokensRelations = relations(plaidTokens, ({ one, many }) => ({
  book: one(books, { fields: [plaidTokens.bookId], references: [books.id] }),
  accounts: many(plaidAccounts),
}));

export const plaidAccountsRelations = relations(plaidAccounts, ({ one }) => ({
  token: one(plaidTokens, {
    fields: [plaidAccounts.tokenId],
    references: [plaidTokens.id],
  }),
  account: one(accounts, {
    fields: [plaidAccounts.counterpoiseAccountId],
    references: [accounts.id],
  }),
}));

export const plaidTransactionReconciliationRelations = relations(
  plaidTransactionReconciliation,
  ({ one }) => ({
    plaidAccount: one(plaidAccounts, {
      fields: [plaidTransactionReconciliation.plaidAccountLinkId],
      references: [plaidAccounts.id],
    }),
    matchedTransaction: one(transactions, {
      fields: [plaidTransactionReconciliation.matchedTransactionId],
      references: [transactions.id],
    }),
  })
);

// ── Type exports ───────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Payee = typeof payees.$inferSelect;
export type NewPayee = typeof payees.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionSplit = typeof transactionSplits.$inferSelect;
export type NewTransactionSplit = typeof transactionSplits.$inferInsert;
export type InvestmentLot = typeof investmentLots.$inferSelect;
export type NewInvestmentLot = typeof investmentLots.$inferInsert;
export type InvestmentSplit = typeof investmentSplits.$inferSelect;
export type NewInvestmentSplit = typeof investmentSplits.$inferInsert;
export type RecurringRule = typeof recurringRules.$inferSelect;
export type NewRecurringRule = typeof recurringRules.$inferInsert;
export type RecurringTemplateSplit = typeof recurringTemplateSplits.$inferSelect;
export type NewRecurringTemplateSplit = typeof recurringTemplateSplits.$inferInsert;
export type Security = typeof securities.$inferSelect;
export type NewSecurity = typeof securities.$inferInsert;
export type SecurityPrice = typeof securityPrices.$inferSelect;
export type NewSecurityPrice = typeof securityPrices.$inferInsert;
export type PlaidToken = typeof plaidTokens.$inferSelect;
export type NewPlaidToken = typeof plaidTokens.$inferInsert;
export type PlaidAccount = typeof plaidAccounts.$inferSelect;
export type NewPlaidAccount = typeof plaidAccounts.$inferInsert;
export type PlaidTransactionReconciliation =
  typeof plaidTransactionReconciliation.$inferSelect;
export type NewPlaidTransactionReconciliation =
  typeof plaidTransactionReconciliation.$inferInsert;

// Account type helpers
export const BALANCE_SHEET_TYPES = ["asset", "liability", "equity"] as const;
export const INCOME_STATEMENT_TYPES = ["income", "expense"] as const;

export function isBalanceSheetAccount(type: string): boolean {
  return BALANCE_SHEET_TYPES.includes(
    type as (typeof BALANCE_SHEET_TYPES)[number]
  );
}

export function isIncomeStatementAccount(type: string): boolean {
  return INCOME_STATEMENT_TYPES.includes(
    type as (typeof INCOME_STATEMENT_TYPES)[number]
  );
}

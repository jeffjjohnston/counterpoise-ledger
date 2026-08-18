import { type AppDb } from "@/db";
import {
  accounts,
  investmentSplits,
  payees,
  securities,
  transactions,
  transactionSplits,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  isValidDateString,
  type InvestmentAction,
  validateInvestmentActions,
  validateInvestmentSplitPayload,
  validateSplits,
} from "@/lib/accounting";
import { normalizePayeeName } from "@/lib/payees";
import { collectAffectedPairs, rebuildLotsForPairs } from "@/lib/lots-db";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class TransactionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionValidationError";
  }
}

export class TransactionNotFoundError extends Error {
  constructor(message: string = "Transaction not found") {
    super(message);
    this.name = "TransactionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface SplitInput {
  accountId: number;
  amount: number;
}

export interface InvestmentSplitInput {
  securityId: number;
  action: InvestmentAction;
  sharesMicros: number;
  priceMicros: number;
  feesCents?: number;
  splitNumerator?: number;
  splitDenominator?: number;
}

export interface CreateTransactionInput {
  date: string;
  description?: string;
  notes?: string;
  checkNumber?: string;
  isFloating?: boolean;
  isReconciled?: boolean;
  splits: SplitInput[];
  investmentSplits?: InvestmentSplitInput[];
  payeeName?: string;
}

export interface UpdateTransactionInput {
  date?: string;
  description?: string;
  notes?: string | null;
  checkNumber?: string;
  isFloating?: boolean;
  splits?: SplitInput[];
  isReconciled?: boolean;
  investmentSplits?: InvestmentSplitInput[];
  payeeName?: string | null;
}

// ---------------------------------------------------------------------------
// Shared: query config for loading a full transaction with relations
// ---------------------------------------------------------------------------

const FULL_TRANSACTION_QUERY_CONFIG = {
  with: {
    payee: true,
    splits: {
      with: {
        account: true,
      },
    },
    investmentSplits: {
      with: {
        security: true,
        account: true,
      },
    },
  },
} as const;

const INVALID_DATE_MESSAGE = "Date must be in YYYY-MM-DD format";

async function loadSplitAccountRows(
  db: AppDb,
  bookId: number,
  accountIds: number[]
) {
  if (accountIds.length === 0) {
    return [];
  }

  // Self-join to each account's parent so an investment-cash leg can be
  // resolved back to its brokerage account — but only when that parent is an
  // investment account in the SAME book. accounts.parentId is not book-scoped
  // by its FK, so this guard prevents a dividend/fee split from ever resolving
  // to (and storing) an account that belongs to another book.
  const parent = alias(accounts, "parent_account");

  return db
    .select({
      id: accounts.id,
      subtype: accounts.subtype,
      isInvestmentCash: accounts.isInvestmentCash,
      investmentParentId: sql<number | null>`CASE WHEN ${parent.subtype} = 'investment' THEN ${parent.id} ELSE NULL END`,
    })
    .from(accounts)
    .leftJoin(
      parent,
      and(eq(parent.id, accounts.parentId), eq(parent.bookId, bookId))
    )
    .where(and(eq(accounts.bookId, bookId), inArray(accounts.id, accountIds)));
}

type SplitAccountRow = Awaited<ReturnType<typeof loadSplitAccountRows>>[number];

/**
 * Determine which investment account an investment split belongs to, given the
 * accounts referenced by the transaction's double-entry splits.
 *
 * Buy/sell transactions touch the brokerage (investment-subtype) account
 * directly. Dividend, capital-gain, and fee transactions don't — they only
 * touch the brokerage's cash sub-account plus an income/expense account — so we
 * recover the brokerage from the investment-cash leg's parent. That parent has
 * already been validated as a same-book investment account by
 * loadSplitAccountRows (exposed as investmentParentId), so this stays a pure
 * lookup with no extra query. Returns null when neither is present (e.g. a
 * dividend paid into a plain bank account), which surfaces as "All Accounts" on
 * the security detail page.
 */
function deriveInvestmentAccountId(rows: SplitAccountRow[]): number | null {
  const direct = rows.find((account) => account.subtype === "investment");
  if (direct) return direct.id;

  const investmentCash = rows.find((account) => account.isInvestmentCash);
  return investmentCash?.investmentParentId ?? null;
}

function requiresInvestmentAccount(splits: InvestmentSplitInput[]): boolean {
  return splits.some(
    (split) => split.action === "buy" || split.action === "sell"
  );
}

async function validateInvestmentSplitReferences(
  db: AppDb,
  bookId: number,
  splits: InvestmentSplitInput[]
) {
  const securityIds = [...new Set(splits.map((split) => split.securityId))];

  if (securityIds.length > 0) {
    const securityRows = await db
      .select({ id: securities.id })
      .from(securities)
      .where(
        and(eq(securities.bookId, bookId), inArray(securities.id, securityIds))
      );

    if (securityRows.length !== securityIds.length) {
      throw new TransactionValidationError(
        "One or more investment split securities do not belong to this book"
      );
    }
  }
}

/**
 * Resolve a free-text payee name to an id, creating the payee if this book has
 * no match. Returns null when the name normalises to nothing.
 *
 * The lookup is case-insensitive so typing "ikea" reuses an existing "IKEA",
 * but payees_name_book_unique is case-SENSITIVE and normalizePayeeName
 * deliberately preserves case (see the payee section of CLAUDE.md), so the two
 * are not interchangeable and the lookup cannot simply be dropped.
 *
 * The insert is an upsert because the lookup and the insert are separate
 * statements: another session committing the same name in between makes a
 * plain insert fail the unique index, which aborts the surrounding transaction
 * and surfaces as a 500 on an otherwise valid save. ON CONFLICT DO UPDATE
 * rather than DO NOTHING because only DO UPDATE returns the conflicting row,
 * and the id is the whole point of the call.
 */
async function resolvePayeeId(
  tx: AppDb,
  bookId: number,
  payeeName: string
): Promise<number | null> {
  const normalizedPayeeName = normalizePayeeName(payeeName);
  if (!normalizedPayeeName) return null;

  const [existingPayee] = await tx
    .select({ id: payees.id })
    .from(payees)
    .where(
      and(
        eq(payees.bookId, bookId),
        sql`lower(${payees.name}) = ${normalizedPayeeName.toLowerCase()}`
      )
    )
    .limit(1);
  if (existingPayee) return existingPayee.id;

  const [newPayee] = await tx
    .insert(payees)
    .values({ name: normalizedPayeeName, bookId })
    .onConflictDoUpdate({
      target: [payees.name, payees.bookId],
      set: { name: normalizedPayeeName },
    })
    .returning();
  return newPayee?.id ?? null;
}

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------

export async function createTransaction(
  db: AppDb,
  bookId: number,
  input: CreateTransactionInput
) {
  const {
    date,
    description,
    notes,
    checkNumber: checkNumberInput,
    isFloating,
    isReconciled,
    splits,
    investmentSplits: investmentSplitsInput,
    payeeName,
  } = input;

  if (!date || !splits || splits.length < 2) {
    throw new TransactionValidationError(
      "Date and at least 2 splits are required, even for stock splits"
    );
  }

  if (!isValidDateString(date)) {
    throw new TransactionValidationError(INVALID_DATE_MESSAGE);
  }

  if (investmentSplitsInput !== undefined && !Array.isArray(investmentSplitsInput)) {
    throw new TransactionValidationError(
      "investmentSplits must be an array when provided"
    );
  }

  if (checkNumberInput !== undefined && typeof checkNumberInput !== "string") {
    throw new TransactionValidationError(
      "checkNumber must be a string when provided"
    );
  }
  const checkNumber =
    typeof checkNumberInput === "string" && checkNumberInput.trim()
      ? checkNumberInput.trim()
      : null;

  if (!validateSplits(splits)) {
    throw new TransactionValidationError(
      "Transaction splits must sum to zero (debits = credits)"
    );
  }

  const splitAccountIds = [
    ...new Set<number>(
      splits.map((split: { accountId: number }) => split.accountId)
    ),
  ];
  const splitAccountRows =
    splitAccountIds.length > 0
      ? await loadSplitAccountRows(db, bookId, splitAccountIds)
      : [];
  // Verify all split accounts belong to this book
  if (splitAccountRows.length !== splitAccountIds.length) {
    throw new TransactionValidationError(
      "One or more split accounts do not belong to this book"
    );
  }

  const requiresInvestmentSplits = splitAccountRows.some(
    (account) => account.subtype === "investment"
  );
  const hasBankAccount = splitAccountRows.some(
    (account) => account.subtype === "bank"
  );

  if (checkNumber && !hasBankAccount) {
    throw new TransactionValidationError(
      "Check number can only be set for transactions involving bank accounts"
    );
  }

  if (
    requiresInvestmentSplits &&
    (!investmentSplitsInput || investmentSplitsInput.length === 0)
  ) {
    throw new TransactionValidationError(
      "Investment transactions require investmentSplits"
    );
  }

  if (investmentSplitsInput && investmentSplitsInput.length > 0) {
    const invalidSplit = investmentSplitsInput.find(
      (split) =>
        !validateInvestmentSplitPayload(
          split as Parameters<typeof validateInvestmentSplitPayload>[0]
        )
    );

    if (invalidSplit) {
      throw new TransactionValidationError("Invalid investment split values");
    }

    const actionInputs = investmentSplitsInput.map((split) => ({
      action: split.action,
      sharesMicros: split.sharesMicros,
      priceMicros: split.priceMicros,
      feesCents: split.feesCents,
      splitNumerator: split.splitNumerator,
      splitDenominator: split.splitDenominator,
    }));

    if (!validateInvestmentActions(actionInputs)) {
      throw new TransactionValidationError("Invalid investment actions");
    }

    await validateInvestmentSplitReferences(
      db,
      bookId,
      investmentSplitsInput
    );

    if (
      requiresInvestmentAccount(investmentSplitsInput) &&
      !splitAccountRows.some((account) => account.subtype === "investment")
    ) {
      throw new TransactionValidationError(
        "Investment splits require a transaction split on an investment account"
      );
    }
  }

  const newTransaction = await db.transaction(async (tx) => {
    const payeeId =
      typeof payeeName === "string"
        ? await resolvePayeeId(tx, bookId, payeeName)
        : null;

    const [txnRow] = await tx
      .insert(transactions)
      .values({
        date,
        description: description || null,
        notes: notes ?? null,
        checkNumber,
        isFloating: isFloating ?? false,
        isReconciled: isReconciled ?? false,
        payeeId,
        bookId,
      })
      .returning();

    const splitValues = splits.map(
      (split: { accountId: number; amount: number }) => ({
        transactionId: txnRow.id,
        accountId: split.accountId,
        amount: split.amount,
        bookId,
      })
    );

    await tx.insert(transactionSplits).values(splitValues);

    if (investmentSplitsInput && investmentSplitsInput.length > 0) {
      // Derive the investment account from the transaction splits (the
      // brokerage account for buy/sell, or the investment-cash leg's parent
      // for dividend/capGain/fee).
      const investmentAccountId = deriveInvestmentAccountId(splitAccountRows);

      const investmentSplitValues = investmentSplitsInput.map((split) => ({
        transactionId: txnRow.id,
        accountId: split.action === "split" ? null : investmentAccountId,
        securityId: split.securityId,
        action: split.action,
        sharesMicros: split.sharesMicros,
        priceMicros: split.priceMicros,
        feesCents: split.feesCents ?? 0,
        splitNumerator: split.splitNumerator ?? null,
        splitDenominator: split.splitDenominator ?? null,
        bookId,
      }));

      await tx.insert(investmentSplits).values(investmentSplitValues);

      // Lots are derived state: regenerate every pair this write could affect.
      await rebuildLotsForPairs(tx, bookId, await collectAffectedPairs(tx, bookId, txnRow.id));
    }

    return txnRow;
  });

  const result = await db.query.transactions.findFirst({
    where: (txns, { eq }) => eq(txns.id, newTransaction.id),
    ...FULL_TRANSACTION_QUERY_CONFIG,
  });

  return result!;
}

// ---------------------------------------------------------------------------
// updateTransaction
// ---------------------------------------------------------------------------

export async function updateTransaction(
  db: AppDb,
  bookId: number,
  transactionId: number,
  input: UpdateTransactionInput
) {
  const {
    date,
    description,
    notes,
    checkNumber: checkNumberInput,
    isFloating,
    splits,
    isReconciled,
    investmentSplits: investmentSplitsInput,
    payeeName,
  } = input;

  if (date !== undefined && !isValidDateString(date)) {
    throw new TransactionValidationError(INVALID_DATE_MESSAGE);
  }

  if (investmentSplitsInput !== undefined && !Array.isArray(investmentSplitsInput)) {
    throw new TransactionValidationError(
      "investmentSplits must be an array when provided"
    );
  }

  if (checkNumberInput !== undefined && typeof checkNumberInput !== "string") {
    throw new TransactionValidationError(
      "checkNumber must be a string when provided"
    );
  }
  const checkNumber =
    typeof checkNumberInput === "string"
      ? checkNumberInput.trim() || null
      : undefined;

  if (splits && splits.length < 2) {
    throw new TransactionValidationError(
      "At least 2 splits are required, even for stock splits"
    );
  }

  if (splits && !validateSplits(splits)) {
    throw new TransactionValidationError(
      "Transaction splits must sum to zero (debits = credits)"
    );
  }

  let splitAccountIds: number[] | null = null;
  let existingSplitCount: number | null = null;
  if (splits && splits.length > 0) {
    splitAccountIds = [
      ...new Set<number>(
        splits.map((split: { accountId: number }) => split.accountId)
      ),
    ];
  } else if (investmentSplitsInput !== undefined) {
    const existingSplits = await db
      .select({ accountId: transactionSplits.accountId })
      .from(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, transactionId),
          eq(transactionSplits.bookId, bookId)
        )
      );
    splitAccountIds = [
      ...new Set<number>(existingSplits.map((split) => split.accountId)),
    ];
    existingSplitCount = existingSplits.length;
  }

  if (checkNumber && splitAccountIds === null) {
    const existingSplits = await db
      .select({ accountId: transactionSplits.accountId })
      .from(transactionSplits)
      .where(
        and(
          eq(transactionSplits.transactionId, transactionId),
          eq(transactionSplits.bookId, bookId)
        )
      );
    splitAccountIds = [
      ...new Set<number>(existingSplits.map((split) => split.accountId)),
    ];
  }

  if (
    investmentSplitsInput &&
    investmentSplitsInput.length > 0 &&
    splits === undefined &&
    existingSplitCount !== null &&
    existingSplitCount < 2
  ) {
    throw new TransactionValidationError(
      "At least 2 splits are required, even for stock splits"
    );
  }

  let splitAccountRows: Awaited<ReturnType<typeof loadSplitAccountRows>> = [];
  if (splitAccountIds && splitAccountIds.length > 0) {
    splitAccountRows = await loadSplitAccountRows(
      db,
      bookId,
      splitAccountIds
    );

    if (splitAccountRows.length !== splitAccountIds.length) {
      throw new TransactionValidationError(
        "One or more split accounts do not belong to this book"
      );
    }

    const requiresInvestmentSplits = splitAccountRows.some(
      (account) => account.subtype === "investment"
    );
    const hasBankAccount = splitAccountRows.some(
      (account) => account.subtype === "bank"
    );

    if (checkNumber && !hasBankAccount) {
      throw new TransactionValidationError(
        "Check number can only be set for transactions involving bank accounts"
      );
    }

    if (
      requiresInvestmentSplits &&
      (!investmentSplitsInput || investmentSplitsInput.length === 0)
    ) {
      const existingInvestmentSplits = await db
        .select({ id: investmentSplits.id })
        .from(investmentSplits)
        .where(
          and(
            eq(investmentSplits.transactionId, transactionId),
            eq(investmentSplits.bookId, bookId)
          )
        );

      if (existingInvestmentSplits.length === 0) {
        throw new TransactionValidationError(
          "Investment transactions require investmentSplits"
        );
      }
    }
  } else if (checkNumber) {
    throw new TransactionValidationError(
      "Check number can only be set for transactions involving bank accounts"
    );
  }

  if (investmentSplitsInput && investmentSplitsInput.length > 0) {
    const invalidSplit = investmentSplitsInput.find(
      (split) =>
        !validateInvestmentSplitPayload(
          split as Parameters<typeof validateInvestmentSplitPayload>[0]
        )
    );

    if (invalidSplit) {
      throw new TransactionValidationError("Invalid investment split values");
    }

    const actionInputs = investmentSplitsInput.map((split) => ({
      action: split.action,
      sharesMicros: split.sharesMicros,
      priceMicros: split.priceMicros,
      feesCents: split.feesCents,
      splitNumerator: split.splitNumerator,
      splitDenominator: split.splitDenominator,
    }));

    if (!validateInvestmentActions(actionInputs)) {
      throw new TransactionValidationError("Invalid investment actions");
    }

    await validateInvestmentSplitReferences(
      db,
      bookId,
      investmentSplitsInput
    );

    if (
      requiresInvestmentAccount(investmentSplitsInput) &&
      !splitAccountRows.some((account) => account.subtype === "investment")
    ) {
      throw new TransactionValidationError(
        "Investment splits require a transaction split on an investment account"
      );
    }
  }

  await db.transaction(async (tx) => {
    // Captured before any splits are deleted or replaced, since a split
    // account/security can be replaced entirely — the old pair still needs a
    // rebuild once its investment splits are gone.
    const priorPairs = await collectAffectedPairs(tx, bookId, transactionId);

    // undefined means "leave the payee alone"; null clears it.
    let payeeIdUpdate: number | null | undefined = undefined;
    if (payeeName !== undefined) {
      payeeIdUpdate =
        typeof payeeName === "string"
          ? await resolvePayeeId(tx, bookId, payeeName)
          : null;
    }

    await tx
      .update(transactions)
      .set({
        ...(date !== undefined && { date }),
        ...(description !== undefined && { description }),
        ...(notes !== undefined && { notes: notes ?? null }),
        ...(checkNumber !== undefined && { checkNumber }),
        ...(payeeIdUpdate !== undefined && { payeeId: payeeIdUpdate }),
        ...(isReconciled !== undefined && { isReconciled }),
        ...(isFloating !== undefined && { isFloating }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.id, transactionId),
          eq(transactions.bookId, bookId)
        )
      );

    if (splits && splits.length >= 2) {
      await tx
        .delete(transactionSplits)
        .where(
          and(
            eq(transactionSplits.transactionId, transactionId),
            eq(transactionSplits.bookId, bookId)
          )
        );

      const splitValues = splits.map(
        (split: { accountId: number; amount: number }) => ({
          transactionId,
          accountId: split.accountId,
          amount: split.amount,
          bookId,
        })
      );

      await tx.insert(transactionSplits).values(splitValues);
    }

    if (investmentSplitsInput) {
      await tx
        .delete(investmentSplits)
        .where(
          and(
            eq(investmentSplits.transactionId, transactionId),
            eq(investmentSplits.bookId, bookId)
          )
        );

      if (investmentSplitsInput.length > 0) {
        // Derive the investment account from the transaction splits (the
        // brokerage account for buy/sell, or the investment-cash leg's parent
        // for dividend/capGain/fee). splitAccountRows was loaded above from the
        // new or existing transaction splits.
        const investmentAccountId = deriveInvestmentAccountId(splitAccountRows);

        const investmentSplitValues = investmentSplitsInput.map((split) => ({
          transactionId,
          accountId: split.action === "split" ? null : investmentAccountId,
          securityId: split.securityId,
          action: split.action,
          sharesMicros: split.sharesMicros,
          priceMicros: split.priceMicros,
          feesCents: split.feesCents ?? 0,
          splitNumerator: split.splitNumerator ?? null,
          splitDenominator: split.splitDenominator ?? null,
          bookId,
        }));

        await tx.insert(investmentSplits).values(investmentSplitValues);
      }
    }

    // Lots are derived state: regenerate every pair this write could have
    // touched. A date change alone reorders FIFO even when splits are
    // untouched, so this runs unconditionally rather than only when
    // investmentSplitsInput was provided.
    const currentPairs = await collectAffectedPairs(tx, bookId, transactionId);
    await rebuildLotsForPairs(tx, bookId, [...priorPairs, ...currentPairs]);
  });

  const result = await db.query.transactions.findFirst({
    where: and(
      eq(transactions.id, transactionId),
      eq(transactions.bookId, bookId)
    ),
    ...FULL_TRANSACTION_QUERY_CONFIG,
  });

  if (!result) {
    throw new TransactionNotFoundError();
  }

  return result;
}

// lib/securities.ts
import { type AppDb } from "@/db";
import { investmentSplits, securities, transactionSplits } from "@/db/schema";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { getPositions } from "@/lib/investments";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class SecurityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityValidationError";
  }
}

export class SecurityDuplicateError extends Error {
  existingId: number;
  symbol: string;

  constructor(existingId: number, symbol: string) {
    super(`A security with symbol "${symbol}" already exists (id ${existingId})`);
    this.name = "SecurityDuplicateError";
    this.existingId = existingId;
    this.symbol = symbol;
  }
}

export class SecurityNotFoundError extends Error {
  constructor(securityId: number) {
    super(`Security ${securityId} not found`);
    this.name = "SecurityNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

const SECURITY_TYPES = ["etf", "mutual_fund", "stock"] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

export interface CreateSecurityInput {
  name: string;
  symbol: string;
  securityType: SecurityType;
  fetchPrices?: boolean;
  /** Micros. Non-null marks the security fixed-price and forces fetching off. */
  fixedPriceMicros?: number | null;
}

// ---------------------------------------------------------------------------
// createSecurity
// ---------------------------------------------------------------------------

export async function createSecurity(
  db: AppDb,
  bookId: number,
  input: CreateSecurityInput,
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
  const securityType = input.securityType;

  if (!name) {
    throw new SecurityValidationError("Name is required");
  }
  if (!symbol) {
    throw new SecurityValidationError("Symbol is required");
  }
  if (!securityType || !SECURITY_TYPES.includes(securityType)) {
    throw new SecurityValidationError(
      `securityType must be one of: ${SECURITY_TYPES.join(", ")}`,
    );
  }
  if (input.fetchPrices !== undefined && typeof input.fetchPrices !== "boolean") {
    throw new SecurityValidationError("fetchPrices must be a boolean");
  }

  const fixedPriceMicros = input.fixedPriceMicros ?? null;
  if (
    fixedPriceMicros !== null &&
    (!Number.isInteger(fixedPriceMicros) || fixedPriceMicros <= 0)
  ) {
    throw new SecurityValidationError(
      "fixedPriceMicros must be a positive whole number of micros",
    );
  }

  // Case-insensitive duplicate check within the book
  const [existing] = await db
    .select({ id: securities.id })
    .from(securities)
    .where(
      and(
        eq(securities.bookId, bookId),
        sql`lower(${securities.symbol}) = lower(${symbol})`,
      ),
    )
    .limit(1);

  if (existing) {
    throw new SecurityDuplicateError(existing.id, symbol);
  }

  const [created] = await db
    .insert(securities)
    .values({
      bookId,
      name,
      symbol,
      securityType,
      fixedPriceMicros,
      // A fixed price has no feed behind it, so fetching is switched off with
      // it rather than left to the caller to keep consistent.
      ...(fixedPriceMicros !== null
        ? { fetchPrices: false }
        : input.fetchPrices !== undefined
          ? { fetchPrices: input.fetchPrices }
          : {}),
    })
    .returning();

  if (!created) {
    throw new Error("Failed to create security");
  }

  return created;
}

// ---------------------------------------------------------------------------
// listSecurities
// ---------------------------------------------------------------------------

export interface SecurityWithPosition {
  id: number;
  name: string;
  symbol: string;
  securityType: string;
  fetchPrices: boolean;
  fixedPriceMicros: number | null;
  sharesMicros: number;
  costBasisCents: number;
  priceMicros: number | null;
  priceDate: string | null;
  marketValueCents: number | null;
  incomeCents: number;
}

export async function listSecurities(
  db: AppDb,
  bookId: number,
): Promise<SecurityWithPosition[]> {
  const allSecurities = await db
    .select({
      id: securities.id,
      name: securities.name,
      symbol: securities.symbol,
      securityType: securities.securityType,
      fetchPrices: securities.fetchPrices,
      fixedPriceMicros: securities.fixedPriceMicros,
    })
    .from(securities)
    .where(eq(securities.bookId, bookId))
    .orderBy(asc(securities.name));

  // Calculate positions — shares/price/market value from the split replay,
  // cost basis from FIFO lots (the single source of truth also used by
  // getPositions's other callers: the transactions page and MCP tools).
  // Book-wide, so this intentionally includes inactive accounts' holdings —
  // matching getPositions's own behavior everywhere else it's called
  // unscoped, rather than special-casing this route to exclude them.
  const positions = await getPositions(db, bookId);
  const positionMap = new Map(positions.map((p) => [p.securityId, p]));

  // Income (dividends + capital gains) per security. Book-wide, matching
  // getPositions above — a security held only in an archived account should
  // show real income beside its real shares/basis, not $0 income next to a
  // nonzero position.
  const allInvestmentSplitsWithTxId = await db
    .select({
      transactionId: investmentSplits.transactionId,
      securityId: investmentSplits.securityId,
      action: investmentSplits.action,
    })
    .from(investmentSplits)
    .where(
      and(
        eq(investmentSplits.bookId, bookId),
        inArray(investmentSplits.action, ["dividend", "capGain"] as const),
      ),
    );

  const incomeTxIds = allInvestmentSplitsWithTxId.map((s) => s.transactionId);

  const incomeTxSplits =
    incomeTxIds.length > 0
      ? await db
          .select({
            transactionId: transactionSplits.transactionId,
            amount: transactionSplits.amount,
          })
          .from(transactionSplits)
          .where(inArray(transactionSplits.transactionId, incomeTxIds))
      : [];

  const incomeMap = new Map<number, number>();
  for (const invSplit of allInvestmentSplitsWithTxId) {
    const txSplitsForThisTx = incomeTxSplits.filter(
      (ts) => ts.transactionId === invSplit.transactionId,
    );
    // Positive amounts are debits to cash accounts — income received.
    const incomeAmount = txSplitsForThisTx
      .filter((ts) => ts.amount > 0)
      .reduce((sum, ts) => sum + ts.amount, 0);

    const currentIncome = incomeMap.get(invSplit.securityId) ?? 0;
    incomeMap.set(invSplit.securityId, currentIncome + incomeAmount);
  }

  return allSecurities.map((security) => {
    const position = positionMap.get(security.id);
    return {
      ...security,
      sharesMicros: position?.sharesMicros ?? 0,
      costBasisCents: position?.costBasisCents ?? 0,
      priceMicros: position?.priceMicros ?? null,
      priceDate: position?.priceDate ?? null,
      marketValueCents: position?.marketValueCents ?? null,
      incomeCents: incomeMap.get(security.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// updateSecurity
// ---------------------------------------------------------------------------

export interface UpdateSecurityInput {
  name?: string;
  symbol?: string;
  securityType?: SecurityType;
  fetchPrices?: boolean;
  fixedPriceMicros?: number | null;
}

export async function updateSecurity(
  db: AppDb,
  bookId: number,
  securityId: number,
  input: UpdateSecurityInput,
) {
  const { securityType, fetchPrices, fixedPriceMicros } = input;

  // Trim name and symbol the same way createSecurity does, and for the same
  // reason: an untrimmed " vti " slips past the case-insensitive duplicate
  // check below (the whitespace defeats the lower() comparison) and lands in
  // the column with it, and a whitespace-only value would be written where
  // createSecurity refuses it outright. The trimmed value feeds both the
  // duplicate check and the write below — never the raw one.
  const name =
    input.name !== undefined
      ? typeof input.name === "string"
        ? input.name.trim()
        : ""
      : undefined;
  const symbol =
    input.symbol !== undefined
      ? typeof input.symbol === "string"
        ? input.symbol.trim()
        : ""
      : undefined;

  if (name !== undefined && !name) {
    throw new SecurityValidationError("Name is required");
  }
  if (symbol !== undefined && !symbol) {
    throw new SecurityValidationError("Symbol is required");
  }

  // Setting a fixed price switches fetching off with it: there is no feed for
  // a fixed NAV, and the cron and the price entry pill both read the pair.
  // Clearing the fixed price leaves fetching where it was — turning it back
  // on is the user's call.
  const nextFetchPrices =
    fixedPriceMicros !== undefined && fixedPriceMicros !== null
      ? false
      : fetchPrices;

  const updates = {
    ...(name !== undefined && { name }),
    ...(symbol !== undefined && { symbol }),
    ...(securityType !== undefined && { securityType }),
    ...(nextFetchPrices !== undefined && { fetchPrices: nextFetchPrices }),
    ...(fixedPriceMicros !== undefined && { fixedPriceMicros }),
  };

  // Every field of UpdateSecurityInput is optional, and securities has no
  // updatedAt column, so an empty input builds an empty SET clause — invalid
  // SQL, not a clean validation message. Same failure mode
  // lib/issue-reports.ts's updateIssueReport() guards against, and the same
  // fix: check the built object, not the raw input, before touching the DB.
  if (Object.keys(updates).length === 0) {
    throw new SecurityValidationError("No fields to update");
  }

  const existing = await db.query.securities.findFirst({
    where: and(eq(securities.id, securityId), eq(securities.bookId, bookId)),
  });

  if (!existing) {
    throw new SecurityNotFoundError(securityId);
  }

  // createSecurity refuses a case-insensitive duplicate symbol within the
  // book; without the same rule here, update_security could reach the state
  // create_security exists to prevent. `ne(securities.id, securityId)` is what
  // lets a caller resend the symbol it already has — a full-replace update
  // does that on every call that changes only the name.
  if (symbol !== undefined) {
    const [clash] = await db
      .select({ id: securities.id })
      .from(securities)
      .where(
        and(
          eq(securities.bookId, bookId),
          ne(securities.id, securityId),
          sql`lower(${securities.symbol}) = lower(${symbol})`
        )
      )
      .limit(1);

    if (clash) {
      throw new SecurityDuplicateError(clash.id, symbol);
    }
  }

  const [updated] = await db
    .update(securities)
    .set(updates)
    .where(and(eq(securities.id, securityId), eq(securities.bookId, bookId)))
    .returning();

  if (!updated) {
    throw new SecurityNotFoundError(securityId);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// deleteSecurity
// ---------------------------------------------------------------------------

export async function deleteSecurity(
  db: AppDb,
  bookId: number,
  securityId: number,
): Promise<void> {
  // Investment splits, lots, and prices all cascade from securities, so a
  // delete here would silently erase the security's entire investment history
  // while leaving the double-entry transactions in place.
  const [splitsCount] = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(investmentSplits)
    .where(
      and(
        eq(investmentSplits.securityId, securityId),
        eq(investmentSplits.bookId, bookId),
      ),
    );

  if (splitsCount.count > 0) {
    throw new SecurityValidationError(
      "Cannot delete security with investment transactions",
    );
  }

  const deleted = await db
    .delete(securities)
    .where(and(eq(securities.id, securityId), eq(securities.bookId, bookId)))
    .returning();

  if (deleted.length === 0) {
    throw new SecurityNotFoundError(securityId);
  }
}

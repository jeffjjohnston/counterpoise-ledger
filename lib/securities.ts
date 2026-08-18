// lib/securities.ts
import { type AppDb } from "@/db";
import { securities } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

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

// lib/security-prices.ts
import { type AppDb } from "@/db";
import { securities, securityPrices } from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { SecurityValidationError, SecurityNotFoundError } from "@/lib/securities";
import { priceUpdateItemSchema, type PriceUpdateItem } from "@/lib/schemas/security-prices";
import { getPositions } from "@/lib/investments";
import { toDateString } from "@/lib/formatters";

export interface DiscardedPriceUpdate {
  /** Position in the array the caller passed, so it can identify the item. */
  index: number;
  reason: string;
}

export interface SetSecurityPricesResult {
  count: number;
  written: PriceUpdateItem[];
  discarded: DiscardedPriceUpdate[];
}

/**
 * Upsert manual prices for this book's securities.
 *
 * Takes the RAW array rather than parsed items on purpose. `bulkPricesSchema`
 * filters malformed entries away inside a `.transform()`, so a caller that
 * parses first cannot say what it lost. The HTTP route still parses (its
 * 400-when-nothing-survives behavior lives in that schema) and passes the
 * survivors, which partition again to an empty `discarded` — its response is
 * unchanged. The MCP tool passes the raw array and reports the difference.
 */
export async function setSecurityPrices(
  db: AppDb,
  bookId: number,
  items: unknown[],
): Promise<SetSecurityPricesResult> {
  const written: PriceUpdateItem[] = [];
  const discarded: DiscardedPriceUpdate[] = [];

  items.forEach((item, index) => {
    const parsed = priceUpdateItemSchema.safeParse(item);
    if (parsed.success) {
      written.push(parsed.data);
    } else {
      discarded.push({ index, reason: parsed.error.issues[0].message });
    }
  });

  if (written.length === 0) {
    throw new SecurityValidationError("No valid price updates provided");
  }

  const securityIds = [...new Set(written.map((u) => u.securityId))];
  const owned = await db
    .select({ id: securities.id })
    .from(securities)
    .where(and(eq(securities.bookId, bookId), inArray(securities.id, securityIds)));

  if (owned.length !== securityIds.length) {
    throw new SecurityValidationError(
      "One or more securities do not belong to this book",
    );
  }

  // One transaction for the whole batch. The route this replaced looped
  // bare upserts, so a failure partway through left the earlier items
  // written with no error path that mentioned them.
  await db.transaction(async (tx) => {
    for (const { securityId, priceMicros, priceDate } of written) {
      const [existing] = await tx
        .select()
        .from(securityPrices)
        .where(
          and(
            eq(securityPrices.bookId, bookId),
            eq(securityPrices.securityId, securityId),
            eq(securityPrices.priceDate, priceDate),
          ),
        );

      if (existing) {
        await tx
          .update(securityPrices)
          .set({ priceMicros })
          .where(
            and(
              eq(securityPrices.bookId, bookId),
              eq(securityPrices.securityId, securityId),
              eq(securityPrices.priceDate, priceDate),
            ),
          );
      } else {
        await tx.insert(securityPrices).values({
          securityId,
          priceDate,
          priceMicros,
          source: "manual",
          bookId,
        });
      }
    }
  });

  return { count: written.length, written, discarded };
}

export class PriceEntryNotFoundError extends Error {
  constructor(priceDate: string) {
    super(`Price entry for ${priceDate} not found`);
    this.name = "PriceEntryNotFoundError";
  }
}

/** The target date of a move already holds a price for this security. */
export class PriceEntryConflictError extends Error {
  constructor(priceDate: string) {
    super(`A price already exists for ${priceDate}`);
    this.name = "PriceEntryConflictError";
  }
}

/**
 * Confirm a security belongs to this book. Every price write is keyed on
 * (securityId, priceDate) alone — securityId is globally unique, so this
 * check is what makes those writes book-safe.
 */
async function requireSecurityInBook(db: AppDb, bookId: number, securityId: number) {
  const security = await db.query.securities.findFirst({
    where: and(eq(securities.id, securityId), eq(securities.bookId, bookId)),
  });
  if (!security) throw new SecurityNotFoundError(securityId);
  return security;
}

export interface UpdateSecurityPriceFields {
  priceDate: string;
  priceMicros: number;
  source?: string | null;
}

export async function updateSecurityPrice(
  db: AppDb,
  bookId: number,
  securityId: number,
  currentDate: string,
  input: UpdateSecurityPriceFields,
): Promise<void> {
  await requireSecurityInBook(db, bookId, securityId);

  const { priceDate, priceMicros, source } = input;

  const oldPrice = await db.query.securityPrices.findFirst({
    where: and(
      eq(securityPrices.securityId, securityId),
      eq(securityPrices.priceDate, currentDate),
    ),
  });

  if (!oldPrice) {
    throw new PriceEntryNotFoundError(currentDate);
  }

  // priceDate is part of the key, so a date change is a move, not an update.
  if (priceDate !== currentDate) {
    // (securityId, priceDate) is the key, so a move onto an occupied date
    // inserts over an existing row — a raw driver error rather than a
    // message a caller can act on. Checked before the transaction opens so
    // the delete never runs.
    const occupied = await db.query.securityPrices.findFirst({
      where: and(
        eq(securityPrices.securityId, securityId),
        eq(securityPrices.priceDate, priceDate),
      ),
    });

    if (occupied) {
      throw new PriceEntryConflictError(priceDate);
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(securityPrices)
        .where(
          and(
            eq(securityPrices.securityId, securityId),
            eq(securityPrices.priceDate, currentDate),
          ),
        );

      await tx.insert(securityPrices).values({
        securityId,
        priceDate,
        priceMicros,
        source: source ?? null,
        bookId,
      });
    });
  } else {
    await db
      .update(securityPrices)
      .set({ priceMicros, source: source ?? null })
      .where(
        and(
          eq(securityPrices.securityId, securityId),
          eq(securityPrices.priceDate, currentDate),
        ),
      );
  }
}

export async function deleteSecurityPrice(
  db: AppDb,
  bookId: number,
  securityId: number,
  priceDate: string,
): Promise<void> {
  await requireSecurityInBook(db, bookId, securityId);

  const deleted = await db
    .delete(securityPrices)
    .where(
      and(
        eq(securityPrices.securityId, securityId),
        eq(securityPrices.priceDate, priceDate),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    throw new PriceEntryNotFoundError(priceDate);
  }
}

function lastWeekdayOnOrBefore(date: Date): string {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return toDateString(d);
}

export interface PriceDueSecurity {
  securityId: number;
  name: string;
  symbol: string;
  lastPriceMicros: number | null;
  lastPriceDate: string | null;
}

export interface PricesDueResult {
  dueDate: string | null;
  securities: PriceDueSecurity[];
}

/**
 * Manually-priced securities (fetchPrices = false, no fixed price) with an
 * open position and no price for the last market day. Drives the navbar price
 * entry pill.
 */
export async function listPricesDue(
  db: AppDb,
  bookId: number,
): Promise<PricesDueResult> {
  // Fixed-price securities carry their price on their own row and are never
  // prompted for, so they are not part of the manually-priced population at
  // all — this is what excludes them, not the staleness check further down.
  const manual = await db
    .select({ id: securities.id })
    .from(securities)
    .where(
      and(
        eq(securities.bookId, bookId),
        eq(securities.fetchPrices, false),
        isNull(securities.fixedPriceMicros),
      ),
    );

  if (manual.length === 0) {
    return { dueDate: null, securities: [] };
  }

  // The newest price across auto-fetched securities is the last market day
  // (the price-sync cron keeps them current, including around holidays).
  // Books without fetchable prices fall back to the last calendar weekday.
  const [latest] = await db
    .select({ maxDate: sql<string | null>`max(${securityPrices.priceDate})` })
    .from(securityPrices)
    .innerJoin(securities, eq(securityPrices.securityId, securities.id))
    .where(and(eq(securities.bookId, bookId), eq(securities.fetchPrices, true)));
  const dueDate = latest?.maxDate ?? lastWeekdayOnOrBefore(new Date());

  const manualIds = new Set(manual.map((s) => s.id));
  const positions = await getPositions(db, bookId);
  const due = positions
    .filter(
      (p) =>
        manualIds.has(p.securityId) &&
        p.sharesMicros > 0 &&
        (p.priceDate === null || p.priceDate < dueDate),
    )
    .map((p) => ({
      securityId: p.securityId,
      name: p.securityName,
      symbol: p.securitySymbol,
      lastPriceMicros: p.priceMicros,
      lastPriceDate: p.priceDate,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { dueDate, securities: due };
}

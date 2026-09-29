import type { AppDb } from "@/db";
import {
  books,
  typesafeAggregates,
  typesafeDecisions,
  typesafeEvaluations,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { isTypeSafeConfigured } from "./client";
import type { TypeSafeSettings } from "./types";

export class TypeSafeRequestError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export async function lockTypeSafeBook(db: AppDb, bookId: number) {
  const [book] = await db
    .select()
    .from(books)
    .where(eq(books.id, bookId))
    .for("update");
  if (!book) throw new TypeSafeRequestError("Book not found", 404);
  return book;
}

export async function getTypeSafeSettings(
  db: AppDb,
  bookId: number,
): Promise<TypeSafeSettings> {
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) throw new TypeSafeRequestError("Book not found", 404);
  return {
    enabled: book.typesafeReconciliationEnabled,
    revision: book.typesafeRevision,
    configured: isTypeSafeConfigured(),
  };
}

export async function setTypeSafeSettings(
  db: AppDb,
  bookId: number,
  enabled: boolean,
  clear = false,
) {
  return db.transaction(async (tx) => {
    const book = await lockTypeSafeBook(tx, bookId);
    if (enabled && !isTypeSafeConfigured())
      throw new TypeSafeRequestError(
        "TypeSafe is unavailable on this installation",
      );
    if (clear || book.typesafeReconciliationEnabled !== enabled) {
      await tx
        .update(books)
        .set({
          typesafeReconciliationEnabled: enabled,
          typesafeRevision: sql`${books.typesafeRevision} + 1`,
        })
        .where(eq(books.id, bookId));
      // Do not allow a previous lease to block re-enabling. Its attempt/revision
      // cannot publish a result after this transaction commits.
      await tx
        .update(typesafeEvaluations)
        .set({ status: "stale" })
        .where(
          and(
            eq(typesafeEvaluations.bookId, bookId),
            eq(typesafeEvaluations.status, "pending"),
          ),
        );
    }
    if (clear) {
      await tx
        .delete(typesafeDecisions)
        .where(eq(typesafeDecisions.bookId, bookId));
      await tx
        .delete(typesafeEvaluations)
        .where(eq(typesafeEvaluations.bookId, bookId));
      await tx
        .delete(typesafeAggregates)
        .where(eq(typesafeAggregates.bookId, bookId));
    }
    return getTypeSafeSettings(tx, bookId);
  });
}

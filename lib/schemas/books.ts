import { z } from "zod/v4";

// Shape validation for the meta-level books resource (app/api/books/**).
// Business rules that require a database read stay in the route handlers:
//   - "Book not found" (404, PUT and DELETE) — a book owned by a different
//     user, or a nonexistent id.
// "Invalid book ID" (both PUT and DELETE, from parseInt on the :bookId path
// segment) is left untouched — the same precedent lib/schemas/accounts.ts
// and lib/schemas/sync.ts establish for path-segment ids not being this
// schema layer's job.

const BOOK_NAME_REQUIRED_MESSAGE = "Book name is required"; // books/route.ts:46, books/[bookId]/route.ts:33
const UPCOMING_DAYS_MESSAGE = "upcomingDays must be an integer between 1 and 365"; // books/[bookId]/route.ts:45 — matches the DB's own upcoming_days_range CHECK constraint (db/schema.ts)

// Shared by create and update: both routes run the identical
// `!name || typeof name !== "string" || !name.trim()` guard with the
// identical message. `.trim()` reproduces the route's own `name.trim()`
// normalization for the stored value, and `.min(1, ...)` after `.trim()`
// reproduces `!name.trim()` — a whitespace-only name is rejected the same
// as an empty or missing one.
const bookNameSchema = z
  .string({ error: BOOK_NAME_REQUIRED_MESSAGE })
  .trim()
  .min(1, BOOK_NAME_REQUIRED_MESSAGE);

// Both routes' top-level `z.object(...)` also take `{ error:
// BOOK_NAME_REQUIRED_MESSAGE }`. The original routes destructure `name`
// (and `upcomingDays`) straight off the parsed body — `const { name } =
// await request.json()` — which auto-boxes a non-object body (`[]`,
// `"abc"`, `5`, `true`) without throwing, landing on this exact "required"
// guard at 400 (only a literal `null` body threw, pre-schema). Without this
// override, zod's own object-shape check would reject those same inputs
// with its generic "Invalid input: expected object, ..." text instead of
// the ported message. Same reasoning as lib/schemas/auth.ts's loginSchema.
export const createBookSchema = z.object(
  {
    name: bookNameSchema,
  },
  { error: BOOK_NAME_REQUIRED_MESSAGE }
);

export type CreateBookInput = z.infer<typeof createBookSchema>;

// PUT's guard for upcomingDays only runs `if (upcomingDays !== undefined)` —
// an absent field is left alone entirely (the route never touches the
// column), so it stays optional here too. `name` is NOT optional on PUT:
// the route's original guard runs unconditionally on every update request,
// same as create — an update always resends the full name, it doesn't
// support a partial rename-less update.
//
// Every failure mode of the original combined upcomingDays check (wrong
// type, non-integer, below 1, above 365) shares one message, the same
// "one field, one message across its whole validation chain" idiom
// lib/schemas/recurring.ts's `autoCreateDaysBeforeSchema` and
// lib/schemas/accounts.ts's `accountSubtypeSchema` both use.
// Same non-object-root reasoning as createBookSchema above: PUT's original
// guard order checks `name` before `upcomingDays`, so `name`'s message is
// also the right one to report for a non-object body here.
export const updateBookSchema = z.object(
  {
    name: bookNameSchema,
    upcomingDays: z
      .number({ error: UPCOMING_DAYS_MESSAGE })
      .int(UPCOMING_DAYS_MESSAGE)
      .min(1, UPCOMING_DAYS_MESSAGE)
      .max(365, UPCOMING_DAYS_MESSAGE)
      .optional(),
  },
  { error: BOOK_NAME_REQUIRED_MESSAGE }
);

export type UpdateBookInput = z.infer<typeof updateBookSchema>;

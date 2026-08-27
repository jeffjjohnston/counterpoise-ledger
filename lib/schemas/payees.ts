import { z } from "zod/v4";

// Shape validation for the payees resource (app/api/b/[bookId]/payees/**).
// Business rules that require a database read stay in the route handlers —
// a schema cannot express them:
//   - The case-insensitive duplicate-name lookup (POST, returns the
//     existing payee instead of creating a new one) — a SELECT against
//     `payees` scoped to this book.
//
// `payees/[id]/last-account/route.ts` has no query params or body to
// validate — its sole guard, `Invalid payee id`, checks the `:id` route-path
// segment (`parseInt(id, 10)`), which every prior task in this plan has left
// untouched: a Next.js route-segment string isn't a request body or query
// param (see lib/schemas/securities.ts's and lib/schemas/sync.ts's identical
// carve-out for their own `:id` routes). That file is intentionally not
// modified by this task.

const NAME_REQUIRED_MESSAGE = "Name is required"; // payees/route.ts:71,76

// ---------------------------------------------------------------------------
// createPayeeSchema — POST /api/b/[bookId]/payees
// ---------------------------------------------------------------------------
//
// The route's original guard is two checks with the same message: `typeof
// name !== "string"` (payees/route.ts:70-72), then, after running
// `normalizePayeeName(name)` (trim; collapse internal whitespace runs;
// normalize curly quotes), `if (!normalizedName)` (payees/route.ts:74-77).
//
// `.trim()` alone — not the real `normalizePayeeName()` — reproduces the
// SECOND check exactly: normalizePayeeName's own first step is `.trim()`,
// and none of its later steps (whitespace-run collapse, quote
// normalization) can turn a string that survives trimming into an empty
// one — they only substitute or collapse characters, never delete a
// string down to nothing. So "does this string become empty after
// normalizePayeeName()" and "does this string become empty after .trim()"
// are the same question, verified against lib/payees.ts directly rather
// than assumed. The route still calls the real `normalizePayeeName()` on
// `parsed.data.name` afterward to get the fully normalized value (whitespace
// runs collapsed, quotes normalized) used for the duplicate lookup and
// insert — the schema only owns the presence/emptiness shape check, not the
// full normalization, matching this plan's default of leaving pure-function
// business logic in its existing home unless removing it is unambiguous
// (contrast with sync.ts's createTokenSchema, whose `.trim()` reproduces the
// route's *entire* normalizeString(), not an approximation of it).
// The top-level `z.object(...)` also takes `{ error: NAME_REQUIRED_MESSAGE
// }`. The original route's `const { name } = body` auto-boxes a non-object
// body (`[]`, `"abc"`, `5`, `true`) without throwing, landing on `name`
// `undefined` and reporting this exact message at 400 (only a literal
// `null` body threw, pre-schema). Without this override, zod's own
// object-shape check would reject those same inputs with its generic
// "Invalid input: expected object, ..." text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const createPayeeSchema = z.object(
  {
    name: z
      .string({ error: NAME_REQUIRED_MESSAGE })
      .trim()
      .min(1, NAME_REQUIRED_MESSAGE)
      .describe(
        "The payee's name. Normalized on save: whitespace runs collapse to one space and " +
          "curly quotes straighten to '. Case is NOT changed — \"IKEA\" and \"Ikea\" stay two " +
          "different payees."
      ),
  },
  { error: NAME_REQUIRED_MESSAGE }
);

export type CreatePayeeInput = z.infer<typeof createPayeeSchema>;

// ---------------------------------------------------------------------------
// listPayeesQuery — GET /api/b/[bookId]/payees
// ---------------------------------------------------------------------------
//
// `search` is read behind a truthy check (`search ? normalizePayeeName(search)
// : ""`, payees/route.ts:25) — an empty string means "no filter", same as a
// missing key, so the caller maps it with `|| undefined`. No format
// validation existed or is added here; the route does its own
// normalization and filtering after parsing, unchanged.
//
// `limit` never 400s today: `limitParam ? parseInt(limitParam, 10) :
// undefined`, then `Number.isFinite(parsedLimit) ? parsedLimit : undefined`
// (payees/route.ts:20-23) — a missing, non-numeric, or non-finite limit all
// silently fall back to "no limit" (the route's own `limit ? ...limit(limit)
// : ...` treats `undefined` and the falsy `0` identically, so which of the
// two a malformed input resolves to doesn't change behavior either way).
// `.catch(undefined)` reproduces that fallback instead of turning malformed
// input into a new 400 — same idiom lib/schemas/securities.ts's limitParam
// and lib/schemas/sync.ts's reconcileListQuery use for their own
// never-fails limit/offset. `.int()` is added as the standing rule for any
// coerced id/count: without it, a
// fractional string like "5.5" would coerce to 5.5 and reach Drizzle's
// `.limit(5.5)` unchanged — worse than the original's `parseInt` truncation
// to 5 — so `.int()` turns that into the same "no limit" fallback instead of
// a new 500. `.positive()` matches every other limit param here
// (securities.ts, sync.ts); it changes one edge case, a negative limit
// string (e.g. "-5"), from a likely DB-level error (Postgres rejects a
// negative LIMIT) to the same graceful "no limit" fallback.
const listPayeesLimitParam = z.coerce.number<string>().int().positive().optional().catch(undefined);

export const listPayeesQuery = z.object({
  search: z.string().optional(),
  limit: listPayeesLimitParam,
});

export type ListPayeesQuery = z.infer<typeof listPayeesQuery>;

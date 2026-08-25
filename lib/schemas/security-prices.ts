import { z } from "zod/v4";

// Shape validation for security price writes: PUT/DELETE on a single
// (security, date) price entry
// (app/api/b/[bookId]/securities/[id]/prices/[date]), and the two
// /api/b/[bookId]/security-prices/** routes (manual bulk entry, Tiingo
// fetch). Business rules that require a database read stay in the route
// handlers:
//   - "Price entry not found" / "Security not found" (both routes under
//     securities/[id]/prices/[date]) — lookups, not shape.
//   - "One or more securities do not belong to this book" (bulk) — a SELECT
//     against `securities` scoped to this book.
// "Invalid security id" on the prices/[date] routes is left untouched for
// the same reason given in lib/schemas/securities.ts: a route-segment
// string, not a body or query field, out of this task's scope.
//
// Rule settled during the final-review fix wave, so it doesn't get
// re-litigated: WRITE paths get calendar validation (z.iso.date());
// READ-ONLY filters may stay presence-only. `priceDate` here and
// `bulkPricesSchema.priceDate` below are both consumed by an INSERT/UPDATE —
// `security_prices.price_date` is `text NOT NULL` with no CHECK constraint,
// and "latest price" is resolved by plain string comparison
// (lib/investments.ts), so a non-calendar string written through either path
// can outrank every real date and silently become the security's market
// price. `recurringTransactionsQuery` in lib/schemas/recurring.ts
// legitimately stays presence-only: it's a read filter with no write path,
// so a malformed value there can only ever match nothing, never corrupt
// stored data.

// ---------------------------------------------------------------------------
// updateSecurityPriceSchema — PUT /api/b/[bookId]/securities/[id]/prices/[date]
// ---------------------------------------------------------------------------
//
// priceDate uses z.iso.date(PRICE_DATE_REQUIRED_MESSAGE), not a bare
// non-empty string: the original guard (`!priceDate || typeof priceDate !==
// "string"`, prices/[date]/route.ts:33) never validated calendar format,
// only presence and type, but this route is a write path (see the rule
// above) — a calendar-invalid priceDate reaches an INSERT verbatim (the PUT
// handler deletes the old (security, date) row and inserts a new one keyed
// on the body's priceDate when it differs from the URL's date segment), and
// because "latest price" is a plain string comparison, a bogus value like
// "banana" sorts above every real "20xx-…" date and wins. z.iso.date()'s
// single-message shorthand applies PRICE_DATE_REQUIRED_MESSAGE uniformly to
// every failure mode of this field — missing, wrong type, blank, AND a
// calendar-invalid string like "2026-02-30" all read as "priceDate is
// required". That's a slightly imprecise message for the calendar-invalid
// case, but it preserves the exact ported text for the missing/blank case
// (verified in tests/lib/schemas/security-prices.test.ts) while still
// rejecting (400) the data-corrupting input instead of writing it — the
// same trade-off the task brief's own suggested fix makes.
const PRICE_DATE_REQUIRED_MESSAGE = "priceDate is required";
const INVALID_PRICE_MICROS_MESSAGE = "Invalid priceMicros";

// The top-level `z.object(...)` also takes `{ error:
// PRICE_DATE_REQUIRED_MESSAGE }`. The original route's `const { priceDate,
// priceMicros, source } = body` auto-boxes a non-object body (`[]`, `"abc"`,
// `5`, `true`) without throwing, landing on `priceDate` `undefined` and
// reporting this exact "required" message at 400 (only a literal `null`
// body threw, pre-schema). Without this override, zod's own object-shape
// check would reject those same inputs with its generic "Invalid input:
// expected object, ..." text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const updateSecurityPriceSchema = z.object(
  {
    priceDate: z.iso
      .date(PRICE_DATE_REQUIRED_MESSAGE)
      .describe("The date this price applies to (YYYY-MM-DD). Pass a different date to move the entry."),
    // `.int()` for the same reason as priceUpdateItemSchema below: micros are
    // the integer unit and the column is bigint, so a fractional value here
    // reached the UPDATE and failed as a 500 rather than a 400. It carries the
    // ported message so the user-facing text is unchanged for every input that
    // was already rejected.
    priceMicros: z
      .number({ error: INVALID_PRICE_MICROS_MESSAGE })
      .int(INVALID_PRICE_MICROS_MESSAGE)
      .positive(INVALID_PRICE_MICROS_MESSAGE)
      .describe("Price in micros (1,000,000 = $1.00)"),
    // Never type-checked by the original guard — `source ?? null` accepts
    // whatever is given. Left permissive (z.any()) rather than narrowed to
    // z.string() to avoid adding validation beyond what existed, the same
    // convention lib/schemas/recurring.ts uses for its own no-prior-guard
    // fields (e.g. templateDescription).
    source: z.any().optional().describe("Where the price came from, such as \"manual\""),
  },
  { error: PRICE_DATE_REQUIRED_MESSAGE }
);

export type UpdateSecurityPriceInput = z.infer<typeof updateSecurityPriceSchema>;

// ---------------------------------------------------------------------------
// bulkPricesSchema — POST /api/b/[bookId]/security-prices/bulk
// ---------------------------------------------------------------------------
//
// The original guard is unusual: it FILTERS priceUpdates down to the
// well-formed entries rather than rejecting the whole request over one bad
// one, and only 400s if nothing survives (bulk/route.ts:27-45). A plain
// z.array(itemSchema) would reject the entire array on the first bad
// element — stricter than today. This reproduces the filter with
// .transform() + .refine(), the same technique
// listTransactionsQuery.accountIds uses in lib/schemas/transactions.ts for
// its own lenient comma-split parse.
//
// priceDate uses z.iso.date() here, unlike updateSecurityPriceSchema above:
// the original guard already ran a literal /^\d{4}-\d{2}-\d{2}$/ regex
// (bulk/route.ts:35), so swapping it for z.iso.date() is the direct,
// task-mandated replacement (real calendar validation, not new scope) —
// not new validation being introduced where none existed. One behavior
// changes as a result: an item with a calendar-invalid but regex-matching
// date (e.g. "2026-02-30") was previously accepted and written to the
// database; it is now filtered out like any other malformed item (silently
// dropped, not a 400 — unless it's the last item standing, in which case
// the request now 400s with "No valid price updates provided" where it
// previously would have written the bad date). Flagged in
// task-5-report.md.
const PRICE_UPDATES_ARRAY_MESSAGE = "priceUpdates must be an array";
const NO_VALID_PRICE_UPDATES_MESSAGE = "No valid price updates provided";

// priceMicros is `.int()` because micros ARE the integer unit and the column
// is bigint. Without it a fractional value like 1.5 passes this schema, is
// classified writable, and then fails only when postgres serializes it for
// the INSERT — aborting the whole batch instead of being reported in
// `discarded`, which is the one thing this filtering schema exists to do.
//
// Note zod's `.int()` bounds to the SAFE integer range (< 2^53), which is
// well inside bigint's (< 2^63). So nothing that passes here can overflow
// the column: this closes the oversized case as well as the fractional one.
export const priceUpdateItemSchema = z.object({
  securityId: z.number().int().positive(),
  priceMicros: z.number().int().positive(),
  priceDate: z.iso.date(),
});

export type PriceUpdateItem = z.infer<typeof priceUpdateItemSchema>;

// The top-level `z.object(...)` also takes `{ error:
// PRICE_UPDATES_ARRAY_MESSAGE }`. The original route's `const { priceUpdates
// } = body` auto-boxes a non-object body (`[]`, `"abc"`, `5`, `true`) without
// throwing, landing on `priceUpdates` `undefined` and reporting this exact
// "required" message at 400 (only a literal `null` body threw, pre-schema).
// Without this override, zod's own object-shape check would reject those
// same inputs with its generic "Invalid input: expected object, ..." text
// instead. Same reasoning as lib/schemas/auth.ts's loginSchema.
export const bulkPricesSchema = z.object(
  {
    priceUpdates: z
      .array(z.unknown(), { error: PRICE_UPDATES_ARRAY_MESSAGE })
      .transform((items) =>
        items.filter(
          (item): item is z.infer<typeof priceUpdateItemSchema> =>
            priceUpdateItemSchema.safeParse(item).success
        )
      )
      .refine((items) => items.length > 0, NO_VALID_PRICE_UPDATES_MESSAGE),
  },
  { error: PRICE_UPDATES_ARRAY_MESSAGE }
);

export type BulkPricesInput = z.infer<typeof bulkPricesSchema>;

// ---------------------------------------------------------------------------
// tiingoFetchSchema — POST /api/b/[bookId]/security-prices/tiingo
// ---------------------------------------------------------------------------
//
// The original guard (tiingo/route.ts:24) only checks that `symbols` is a
// non-empty array — it never validates element types, so whatever is in the
// array flows straight into fetchLatestTiingoPrices (typed `string[]`)
// exactly as received today. z.any() per element (not z.string()) preserves
// that: adding a type check here would reject input the route has always
// passed through unexamined.
const SYMBOLS_MESSAGE = "symbols must be a non-empty array";

// The top-level `z.object(...)` also takes `{ error: SYMBOLS_MESSAGE }`. The
// original route's `const { symbols } = body` auto-boxes a non-object body
// (`[]`, `"abc"`, `5`, `true`) without throwing, landing on `symbols`
// `undefined` and reporting this exact message at 400 (only a literal `null`
// body threw, pre-schema). Without this override, zod's own object-shape
// check would reject those same inputs with its generic "Invalid input:
// expected object, ..." text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const tiingoFetchSchema = z.object(
  {
    symbols: z
      .array(z.any(), { error: SYMBOLS_MESSAGE })
      .min(1, SYMBOLS_MESSAGE)
      .describe("Ticker symbols to fetch the latest end-of-day price for (e.g. [\"VTI\", \"BND\"])"),
  },
  { error: SYMBOLS_MESSAGE }
);

export type TiingoFetchInput = z.infer<typeof tiingoFetchSchema>;

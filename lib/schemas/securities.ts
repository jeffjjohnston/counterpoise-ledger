import { z } from "zod/v4";

// Shape validation for the securities resource
// (app/api/b/[bookId]/securities/**). Business rules that require a database
// read stay in the route handlers — a schema cannot express them:
//   - "Security not found" (GET/PUT/DELETE, and the prices/splits routes) —
//     a lookup, not a shape check.
//   - "Cannot delete security with investment transactions" (DELETE) — a
//     COUNT against `investment_splits` scoped to this book.
//   - The case-insensitive duplicate-symbol check (POST, via
//     SecurityDuplicateError -> 409) — a SELECT against `securities`.
//
// "Invalid security id" (every route that takes an :id path segment) is
// left untouched by this task: it's a Next.js route-segment string, not a
// request body or query param, and Task 2 established the precedent of
// leaving that parsing to the route (accounts/[id]/route.ts's
// `parseInt(id)` is not schema-validated at all). See task-5-report.md for
// the full 16-guard classification.

// Value list mirrors the `enum` decoration on securities.securityType in
// db/schema.ts — a bare Postgres `text` column, no CHECK constraint (see
// CLAUDE.md's Lot Tracking section on `text(col, { enum: [...] })` not being
// real runtime enforcement). Confirmed directly against db/schema.ts and
// against lib/securities.ts's own SECURITY_TYPES constant: both agree on
// etf | mutual_fund | stock, so — unlike a brief on an earlier task whose
// illustrative example admitted values the engine had no case for — there is
// no discrepancy to resolve here.
const securityTypeValues = ["etf", "mutual_fund", "stock"] as const;

// ---------------------------------------------------------------------------
// createSecuritySchema — POST /api/b/[bookId]/securities
// ---------------------------------------------------------------------------
//
// lib/securities.ts's createSecurity() — the shared write path this route
// and the MCP create_security tool both call — already performs all four of
// these checks with these exact messages (lib/securities.ts:56-69). This
// schema reproduces them verbatim as a boundary pre-filter rather than
// replacing them: createSecurity() still runs on schema success and remains
// the authority (its own checks are, if anything, a little stricter — e.g.
// it trims a whitespace-only name to "" before the required check, which a
// bare z.string().min(1) does not do, so nothing invalid can reach the
// database even if it slipped past this schema). This mirrors
// createTransactionBodySchema's relationship with lib/transactions.ts's own
// guards (lib/schemas/transactions.ts) rather than removing validation from
// a shared lib that MCP also depends on independently. The resulting
// overlap — both layers checking the same four things — is reported in
// full in task-5-report.md rather than left undocumented.
const NAME_REQUIRED_MESSAGE = "Name is required"; // lib/securities.ts:57
const SYMBOL_REQUIRED_MESSAGE = "Symbol is required"; // lib/securities.ts:60
const SECURITY_TYPE_MESSAGE = // lib/securities.ts:63-65
  `securityType must be one of: ${securityTypeValues.join(", ")}`;
const CREATE_FETCH_PRICES_MESSAGE = "fetchPrices must be a boolean"; // lib/securities.ts:68

// Both routes share this message: unlike fetchPrices (whose create and update
// wordings differ and are preserved verbatim), fixedPriceMicros is new on both,
// so there is no existing user-facing string to keep. Positive rather than
// non-negative — a fixed price of zero would value the whole position at
// nothing with no error anywhere.
const FIXED_PRICE_MESSAGE =
  "fixedPriceMicros must be a positive whole number of micros";

const fixedPriceMicrosSchema = z
  .number({ error: FIXED_PRICE_MESSAGE })
  .int(FIXED_PRICE_MESSAGE)
  .positive(FIXED_PRICE_MESSAGE)
  .nullable()
  .optional();

// Shared between create and update so the two routes can't drift out of
// sync on what counts as a valid securityType — same technique
// accounts.ts's accountSubtypeSchema and recurring.ts's frequencySchema use
// for their own closed-set columns.
const securityTypeSchema = z.enum(securityTypeValues, {
  error: SECURITY_TYPE_MESSAGE,
});

// The top-level `z.object(...)` also takes `{ error: NAME_REQUIRED_MESSAGE
// }`. lib/securities.ts's createSecurity() reads `input.name` via property
// access, not destructuring — for a non-object body (`[]`, `"abc"`, `5`,
// `true`), that access auto-boxes to `undefined`, `name` normalizes to `""`,
// and `!name` throws this exact message (only a literal `null` body threw,
// pre-schema — `null.name` is a TypeError). Without this override, zod's own
// object-shape check would reject those same inputs with its generic
// "Invalid input: expected object, ..." text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const createSecuritySchema = z.object(
  {
    name: z.string({ error: NAME_REQUIRED_MESSAGE }).min(1, NAME_REQUIRED_MESSAGE),
    symbol: z.string({ error: SYMBOL_REQUIRED_MESSAGE }).min(1, SYMBOL_REQUIRED_MESSAGE),
    securityType: securityTypeSchema,
    fetchPrices: z.boolean({ error: CREATE_FETCH_PRICES_MESSAGE }).optional(),
    fixedPriceMicros: fixedPriceMicrosSchema,
  },
  { error: NAME_REQUIRED_MESSAGE }
);

export type CreateSecurityInput = z.infer<typeof createSecuritySchema>;

// ---------------------------------------------------------------------------
// updateSecuritySchema — PUT /api/b/[bookId]/securities/[id]
// ---------------------------------------------------------------------------
//
// Unlike POST, PUT has no shared-lib write path — the route updates the row
// directly and today validates only fetchPrices's type. That existing
// message is "Fetch prices must be a boolean" (capital F,
// securities/[id]/route.ts:60) — a different string from create's lowercase
// "fetchPrices must be a boolean" above. Both are ported verbatim to their
// own route rather than unified, since unifying them would silently change
// one route's user-facing toast text.
//
// `name`/`symbol` gain a type-only check (bare z.string().optional(), no
// .min(1)): there was no prior guard for either on this route, and
// updateAccountSchema.name makes the identical choice for the identical
// reason — this closes a real gap (a non-string value would previously
// reach the UPDATE statement uncomplaining) without newly requiring
// non-emptiness, which nothing ever enforced on update.
//
// `securityType` gets real validation for the first time on this route by
// reusing securityTypeSchema: it's a closed-set enum column with zero
// DB-level enforcement (same bug class as accounts.ts's `subtype` and
// recurring.ts's `frequency` on their own update routes) — today PUT
// accepts and silently persists any string here. This is a deliberate
// tightening, not a side effect; see task-5-report.md.
const UPDATE_FETCH_PRICES_MESSAGE = "Fetch prices must be a boolean"; // securities/[id]/route.ts:60

export const updateSecuritySchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  securityType: securityTypeSchema.optional(),
  fetchPrices: z.boolean({ error: UPDATE_FETCH_PRICES_MESSAGE }).optional(),
  fixedPriceMicros: fixedPriceMicrosSchema,
});

export type UpdateSecurityInput = z.infer<typeof updateSecuritySchema>;

// ---------------------------------------------------------------------------
// Query schemas: GET /securities/[id]/prices and GET /securities/[id]/splits
// ---------------------------------------------------------------------------
//
// Both routes share an identical hand-written parsePositiveInteger helper
// that NEVER 400s: an absent, non-numeric, non-positive, or non-finite
// limit/offset silently falls back to a default instead of rejecting.
// z.coerce.number() alone would turn any malformed value into a brand-new
// 400 path that never existed before — exactly the "query param that now
// fails closed where it previously fell back to a default" case this task's
// instructions call out to avoid. `.catch()` reproduces the fallback
// instead of a rejection: on any parse failure (missing, non-numeric, zero,
// negative, non-integer) it substitutes the same default the hand-written
// helper used, so this field truly never fails.
//
// limit's `.catch(DEFAULT_LIMIT)` mirrors parsePositiveInteger's own
// fallback; the `.transform` after it reproduces the route's separate
// `Math.min(limit, MAX_LIMIT)` clamp, which parsePositiveInteger does not
// do itself (the route applies it after calling the helper). So malformed
// input still falls back to 50, while a well-formed value above 200 is
// clamped to 200 rather than replaced with the default — exactly like
// today.
//
// One edge case does not match exactly: parsePositiveInteger parses with
// Number.parseInt (truncates decimals and trailing non-numeric characters —
// "50.5" -> 50, "12abc" -> 12), while z.coerce.number() parses the whole
// string with Number() ("50.5" -> 50.5, which then fails .int() and falls
// back to the default; "12abc" -> NaN, likewise falls back). A
// truncatable-but-not-fully-numeric limit/offset value is the only input
// this changes, and only from "the truncated value" to "the default" — it
// still never produces a 400. Flagged in task-5-report.md.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const limitParam = z.coerce
  .number<string>()
  .int()
  .positive()
  .catch(DEFAULT_LIMIT)
  .transform((value) => Math.min(value, MAX_LIMIT));

const offsetParam = z.coerce.number<string>().int().nonnegative().catch(0);

export const securityPriceListQuery = z.object({
  limit: limitParam,
  offset: offsetParam,
});

export type SecurityPriceListQuery = z.infer<typeof securityPriceListQuery>;

export const securitySplitListQuery = z.object({
  limit: limitParam,
  offset: offsetParam,
});

export type SecuritySplitListQuery = z.infer<typeof securitySplitListQuery>;

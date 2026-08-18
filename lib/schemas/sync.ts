import { z } from "zod/v4";

// Shape validation for the Plaid sync resource
// (app/api/b/[bookId]/sync/**). Business rules that require a database read
// stay in the route handlers — a schema cannot express them:
//   - "A token with this itemId already exists" (POST/PUT tokens, 409) — a
//     SELECT against plaidTokens scoped to this book.
//   - "Unknown plaidAccountId for token: ..." / "One or more
//     counterpoiseAccountId values are invalid" / "One or more Counterpoise
//     accounts are already mapped to another Plaid account" (PUT
//     tokens/[id]/accounts) — all three read plaidAccounts/accounts.
//   - "Only asset or liability Counterpoise accounts can be reconciled
//     against Plaid transactions" (GET/POST accounts/[id]/reconcile) — needs
//     the link's counterpoiseAccountType, itself a join result from a DB
//     read keyed off the :id path segment, not anything in the request body.
//   - Every other 400 inside the reconcile POST's per-action branches
//     ("Selected transaction does not include the linked account", "...
//     already linked to a different Plaid transaction...", "Amount update
//     is only supported for transactions with exactly 2 splits", "...not
//     supported for investment transactions", "Transaction has no
//     counterpart split...", "Counter account must be different from linked
//     account" (needs the already-DB-resolved link, not just the body),
//     "Counter account not found") — every one needs a DB read the schema
//     cannot perform, or a value resolved from the URL path rather than the
//     body.
//   - "Reconciliation row not found" / "Transaction not found" (404s) — not
//     shape guards at all.
//
// "Invalid token id" / "Invalid linked account id" (every route with an
// :id path segment) are left untouched by this task, the same precedent
// Task 2 and Task 5 established: a Next.js route-segment string is not a
// request body or query param, so it's not this schema layer's job.
//
// See task-6-report.md for the full guard classification.

// ---------------------------------------------------------------------------
// createTokenSchema — POST /api/b/[bookId]/sync/tokens
// ---------------------------------------------------------------------------
//
// The route's own guard runs normalizeString() (trim; non-string -> "") on
// all three fields before checking `!financialInstitution || !itemId ||
// !accessToken` as one combined message. `.trim()` reproduces the
// normalization itself (so parsed.data carries the same value the route
// used to insert, and the route no longer needs its own normalizeString
// call), and `.trim().min(1, ...)` after a `{ error }`-carrying z.string()
// reproduces the combined "missing or empty" guard — same technique
// accounts.ts's name/type and recurring.ts's name/frequency/... use for a
// single guard spanning multiple fields.
const CREATE_TOKEN_REQUIRED_MESSAGE =
  "financialInstitution, itemId, and accessToken are required"; // tokens/route.ts:73

// The top-level `z.object(...)` also takes `{ error:
// CREATE_TOKEN_REQUIRED_MESSAGE }`. The original route reads each field via
// `normalizeString(body.financialInstitution)` etc. — property access, not
// destructuring — so a non-object body (`[]`, `"abc"`, `5`, `true`)
// auto-boxes every access to `undefined`, `normalizeString` turns that into
// `""`, and the combined guard reports this exact message at 400 (only a
// literal `null` body threw, pre-schema — `null.financialInstitution` is a
// TypeError). Without this override, zod's own object-shape check would
// reject those same inputs with its generic "Invalid input: expected
// object, ..." text instead. Same reasoning as lib/schemas/auth.ts's
// loginSchema.
export const createTokenSchema = z.object(
  {
    financialInstitution: z
      .string({ error: CREATE_TOKEN_REQUIRED_MESSAGE })
      .trim()
      .min(1, CREATE_TOKEN_REQUIRED_MESSAGE),
    itemId: z
      .string({ error: CREATE_TOKEN_REQUIRED_MESSAGE })
      .trim()
      .min(1, CREATE_TOKEN_REQUIRED_MESSAGE),
    accessToken: z
      .string({ error: CREATE_TOKEN_REQUIRED_MESSAGE })
      .trim()
      .min(1, CREATE_TOKEN_REQUIRED_MESSAGE),
  },
  { error: CREATE_TOKEN_REQUIRED_MESSAGE }
);

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

// ---------------------------------------------------------------------------
// updateTokenSchema — PUT /api/b/[bookId]/sync/tokens/[id]
// ---------------------------------------------------------------------------
//
// accessToken is optional here — only financialInstitution/itemId are
// required on update. The route's own `...(accessToken ? { accessToken } :
// {})` leaves the stored access token untouched whenever normalizeString()
// would have produced "". A bare `.optional()` isn't enough to reproduce
// that: it only treats `undefined` as absent, so a non-string value
// (previously silently normalized to "" and therefore ignored) would newly
// 400, and a whitespace-only string (previously trimmed to "" and ignored)
// would newly be accepted as a real, blank access token. The preprocess
// collapses every input normalizeString() would have turned into "" — not a
// string at all, or a string that's empty after trimming — to `undefined`
// before the string check ever runs, so "omitted", "wrong type", and
// "blank" all still mean exactly what they meant before: leave the access
// token alone. Verified against tests/api/sync-tokens.test.ts's "rejects
// duplicate item ids on update" case, which sends `accessToken: ""` and
// must not error.
const UPDATE_TOKEN_REQUIRED_MESSAGE =
  "financialInstitution and itemId are required"; // tokens/[id]/route.ts:62

// The top-level `z.object(...)` also takes `{ error:
// UPDATE_TOKEN_REQUIRED_MESSAGE }`. Same reasoning as createTokenSchema
// above: the original route reads `normalizeString(body.financialInstitution)`
// (property access), so a non-object body (`[]`, `"abc"`, `5`, `true`)
// auto-boxes to `undefined` -> `""` and reports this exact message at 400
// (only a literal `null` body threw, pre-schema). Without this override,
// zod's own object-shape check would reject those same inputs with its
// generic "Invalid input: expected object, ..." text instead.
export const updateTokenSchema = z.object(
  {
    financialInstitution: z
      .string({ error: UPDATE_TOKEN_REQUIRED_MESSAGE })
      .trim()
      .min(1, UPDATE_TOKEN_REQUIRED_MESSAGE),
    itemId: z
      .string({ error: UPDATE_TOKEN_REQUIRED_MESSAGE })
      .trim()
      .min(1, UPDATE_TOKEN_REQUIRED_MESSAGE),
    accessToken: z.preprocess(
      (value) => {
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        return trimmed === "" ? undefined : trimmed;
      },
      z.string().optional()
    ),
  },
  { error: UPDATE_TOKEN_REQUIRED_MESSAGE }
);

export type UpdateTokenInput = z.infer<typeof updateTokenSchema>;

// ---------------------------------------------------------------------------
// assignAccountsSchema — PUT /api/b/[bookId]/sync/tokens/[id]/accounts
// ---------------------------------------------------------------------------
//
// Per-element and array-level shape only. Two of the route's checks stay
// behind because they need a database read: "Unknown plaidAccountId for
// token" (needs this token's cached plaidAccounts rows) and "One or more
// counterpoiseAccountId values are invalid" / "...already mapped to another
// Plaid account" (both need accounts/plaidAccounts reads). The two
// *duplicate* checks below need no DB read at all — each is a pure function
// of the request body — which is exactly what makes "Duplicate
// plaidAccountId in assignments" schema-expressible per the task brief; the
// same reasoning applies unchanged to the counterpoiseAccountId duplicate
// check, since it's the identical pattern (Set-size-vs-length over one
// field of the same array) applied to a different field of the same body.
//
// The two refinements are chained in the order the original route
// encountered them: plaidAccountId duplicates were detected in a loop
// immediately after the per-element shape checks and before any DB read;
// counterpoiseAccountId duplicates were detected later, after the
// DB-dependent "Unknown plaidAccountId" check. That DB check can't move
// into the schema, so this ordering is the closest schema-only equivalent —
// among the two checks that *did* move here, plaidAccountId-duplicate still
// runs first, same as before.
const ASSIGNMENTS_ARRAY_MESSAGE = "assignments must be an array"; // tokens/[id]/accounts/route.ts:188
const PLAID_ACCOUNT_ID_MESSAGE = "Each assignment must include plaidAccountId"; // tokens/[id]/accounts/route.ts:203
const COUNTERPOISE_ACCOUNT_ID_MESSAGE =
  "counterpoiseAccountId must be a positive integer or null"; // tokens/[id]/accounts/route.ts:214-216
const DUPLICATE_PLAID_ACCOUNT_ID_MESSAGE = "Duplicate plaidAccountId in assignments"; // tokens/[id]/accounts/route.ts:231
const DUPLICATE_COUNTERPOISE_ACCOUNT_ID_MESSAGE =
  "A Counterpoise account cannot be assigned to more than one Plaid account"; // tokens/[id]/accounts/route.ts:262-263

const accountAssignmentSchema = z.object(
  {
    // .trim() so parsed.data carries the same value the route used to look
    // up and compare against DB rows — the original guard trims before use
    // too (`assignment.plaidAccountId.trim()`).
    plaidAccountId: z
      .string({ error: PLAID_ACCOUNT_ID_MESSAGE })
      .trim()
      .min(1, PLAID_ACCOUNT_ID_MESSAGE),
    // No `.optional()`/`.nullish()`: the original guard treats a missing key
    // the same as any other non-null, non-positive-integer value (undefined
    // fails `Number.isInteger(undefined)`), so the key is required — it just
    // happens that `null` is one of the values that satisfies it.
    counterpoiseAccountId: z
      .number({ error: COUNTERPOISE_ACCOUNT_ID_MESSAGE })
      .int(COUNTERPOISE_ACCOUNT_ID_MESSAGE)
      .positive(COUNTERPOISE_ACCOUNT_ID_MESSAGE)
      .nullable(),
  },
  // Zod's per-field `{ error }` only covers a field failing its OWN type
  // check inside an already-object element; it does not cover the element
  // itself being something other than a plain object (`null`, a string, an
  // array). The original guard used `assignment?.plaidAccountId` — optional
  // chaining that returns `undefined` for exactly those non-object cases,
  // landing on the same "must include plaidAccountId" message a genuine
  // object missing the field gets. This second argument reproduces that:
  // it's the element-level type-check message, so `{ assignments: [null] }`
  // now reports PLAID_ACCOUNT_ID_MESSAGE instead of zod's default "Invalid
  // input: expected object, received null". Verified directly (see
  // task-6-report.md's fix-round section) rather than assumed.
  { error: PLAID_ACCOUNT_ID_MESSAGE }
);

// The top-level `z.object(...)` also takes `{ error:
// ASSIGNMENTS_ARRAY_MESSAGE }`. The original route reads `body.assignments`
// via property access — for a non-object body (`[]`, `"abc"`, `5`, `true`),
// that auto-boxes to `undefined`, and `!Array.isArray(undefined)` reports
// this exact message at 400 (only a literal `null` body threw, pre-schema).
// Without this override, zod's own object-shape check would reject those
// same inputs with its generic "Invalid input: expected object, ..." text
// instead. This corrects an earlier (wrong) ruling during this plan that no
// override was needed here because a null body 500'd — true for literal
// `null` only, not for `[]`/`"abc"`/`5`/`true`, which auto-box instead of
// throwing. Same reasoning as lib/schemas/auth.ts's loginSchema.
export const assignAccountsSchema = z.object(
  {
    assignments: z
      .array(accountAssignmentSchema, { error: ASSIGNMENTS_ARRAY_MESSAGE })
      .refine(
        (assignments) =>
          new Set(assignments.map((a) => a.plaidAccountId)).size === assignments.length,
        { error: DUPLICATE_PLAID_ACCOUNT_ID_MESSAGE }
      )
      .refine(
        (assignments) => {
          const nonNullIds = assignments
            .map((a) => a.counterpoiseAccountId)
            .filter((id): id is number => id !== null);
          return new Set(nonNullIds).size === nonNullIds.length;
        },
        { error: DUPLICATE_COUNTERPOISE_ACCOUNT_ID_MESSAGE }
      ),
  },
  { error: ASSIGNMENTS_ARRAY_MESSAGE }
);

export type AssignAccountsInput = z.infer<typeof assignAccountsSchema>;

// ---------------------------------------------------------------------------
// reconcileSchema — POST /api/b/[bookId]/sync/accounts/[id]/reconcile
// ---------------------------------------------------------------------------
//
// `action` drives which of `transactionId`/`counterAccountId` is required —
// a decision the original route makes with a hand-written if/else chain
// entirely over the body, no DB read involved, so it's shape validation
// just like the array-duplicate checks above, expressed here with
// `.superRefine()` instead of `.refine()` since it needs to attach the
// custom message to a specific field path.
const RECONCILIATION_ID_MESSAGE = "reconciliationId is required"; // reconcile/route.ts:564
const INVALID_ACTION_MESSAGE = "Invalid action"; // reconcile/route.ts:912
const TRANSACTION_ID_MATCH_MESSAGE = "transactionId is required for match"; // reconcile/route.ts:581
const TRANSACTION_ID_MATCH_UPDATE_MESSAGE =
  "transactionId is required for match_update_amount"; // reconcile/route.ts:655
const COUNTER_ACCOUNT_ID_MESSAGE = "counterAccountId is required for create"; // reconcile/route.ts:786

const reconcileActionValues = [
  "match",
  "match_update_amount",
  "create",
  "ignore",
  "keep_local",
  "unlink",
] as const;

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

export const reconcileSchema = z
  .object(
    {
      // No `.positive()`: the original guard only checks
      // `typeof !== "number" || !Number.isInteger(...)`, so a non-positive
      // integer (0, a negative id) passes this guard exactly as before — an
      // invalid id just fails the DB lookup a few lines later
      // ("Reconciliation row not found").
      reconciliationId: z
        .number({ error: RECONCILIATION_ID_MESSAGE })
        .int(RECONCILIATION_ID_MESSAGE),
      action: z.enum(reconcileActionValues, { error: INVALID_ACTION_MESSAGE }),
      // Declared as `unknown`, not `z.number().optional()`: their
      // required-ness is conditional on `action` (checked below), and a bare
      // type-checked optional field would report zod's own "Invalid input:
      // expected number..." message instead of the action-specific ported
      // message when the type is wrong. The superRefine below does its own
      // typeof/Number.isInteger check, so every failure mode — missing,
      // wrong type, non-integer, (for counterAccountId) non-positive —
      // reports the one message the original single guard gave for all of
      // them.
      transactionId: z.unknown().optional(),
      counterAccountId: z.unknown().optional(),
      // Never validated by the original guard —
      // `typeof body.payeeName === "string" ? body.payeeName : (fallback)`
      // silently accepts any other type. Left as `unknown` so that leniency
      // isn't newly tightened; the real UI consumer (ReconciliationModal)
      // always sends a string here regardless.
      payeeName: z.unknown().optional(),
    },
    // Zod's per-field `{ error }` above only covers a field failing its own
    // type check inside an already-object body; it does not cover the body
    // itself being something other than a plain object (`null`, a string,
    // an array). The original guard's `!body || typeof body !== "object"`
    // check treated all of those the same as a body simply missing
    // `reconciliationId`, landing on this same message — this second
    // argument reproduces that for a non-object POST body. Verified
    // directly (see task-6-report.md's fix-round section).
    { error: RECONCILIATION_ID_MESSAGE }
  )
  .superRefine((data, ctx) => {
    // This chain, reconcileActionValues above, SyncResolveActionPayload
    // (types.ts), and the route's own action switch are four lists kept in
    // sync by hand. Adding a 7th action to the first two without adding its
    // branch here is silently accepted (no issue added — falls through with
    // no error). See reconcile/route.ts's action switch for the matching
    // safety net: its trailing `else` throw is what actually catches an
    // action this superRefine has no case for.
    if (data.action === "match" && !isInt(data.transactionId)) {
      ctx.addIssue({
        code: "custom",
        message: TRANSACTION_ID_MATCH_MESSAGE,
        path: ["transactionId"],
      });
    } else if (data.action === "match_update_amount" && !isInt(data.transactionId)) {
      ctx.addIssue({
        code: "custom",
        message: TRANSACTION_ID_MATCH_UPDATE_MESSAGE,
        path: ["transactionId"],
      });
    } else if (data.action === "create" && !isPositiveInt(data.counterAccountId)) {
      ctx.addIssue({
        code: "custom",
        message: COUNTER_ACCOUNT_ID_MESSAGE,
        path: ["counterAccountId"],
      });
    }
  });

export type ReconcileInput = z.infer<typeof reconcileSchema>;

// ---------------------------------------------------------------------------
// pendingTransactionsQuery — GET /api/b/[bookId]/sync/pending-transactions
// ---------------------------------------------------------------------------
//
// The route reads accountId behind a truthy check
// (`accountIdParam ? parseInt(...) : null`), so `""` must keep meaning "no
// filter" — map with `|| undefined` before calling `.safeParse()` (never
// `??`; see lib/schemas/accounts.ts's listAccountsQuery comment on why the
// operator choice matters).
//
// Deliberately not the shared `idParam` idiom transactions.ts/recurring.ts
// use for their numeric id params: those enforce `.positive()` because
// their original guards did too, and this route's original guard never
// rejected a negative or zero accountId (it simply matched no account and
// returned an empty list, same as any other id nothing owns) — so there's
// no `.positive()` here either.
//
// `.int()` *is* added, unlike the first cut of this schema: the original
// parsed with `parseInt(accountIdParam, 10)`, which always yields an
// integer or NaN — it can never produce a fractional value. `z.coerce
// .number()` alone does not share that guarantee (`Number("5.5")` is
// `5.5`, not `5`), and a fractional accountId reaching
// `eq(accounts.id, 5.5)` against an `integer` column is worse than the old
// truncation — an empty result at best, a driver-level error at worst.
// `.int()` restores the "always a whole number or rejected" guarantee at
// no behavioral cost for any real caller (no UI path sends a fractional
// accountId here).
export const pendingTransactionsQuery = z.object({
  accountId: z.coerce.number({ error: "Invalid accountId" }).int("Invalid accountId").optional(), // pending-transactions/route.ts:48
});

export type PendingTransactionsQuery = z.infer<typeof pendingTransactionsQuery>;

// ---------------------------------------------------------------------------
// reconcileListQuery — GET /api/b/[bookId]/sync/accounts/[id]/reconcile
// ---------------------------------------------------------------------------
//
// The route's own parsedLimit/parsedOffset never 400: an absent,
// non-numeric, zero, negative, or non-integer value silently falls back to
// a default (25 for limit, 0 for offset) — reconcile/route.ts:471-475. Same
// idiom as lib/schemas/securities.ts's limitParam/offsetParam: `.catch()`
// reproduces the fallback instead of turning it into a new 400 path this
// route never had (this route is polled by ReconciliationModal on every
// page load, so failing closed here would be a much larger behavior change
// than the query-param work in this task is meant to make). Unlike
// securities.ts's limitParam, there's no upper-bound clamp here — the
// original route uses `limit` as-is once positive, with no `Math.min`
// anywhere in this file.
//
// Same "truncate vs. reset to default" caveat securities.ts documents for
// its own limit/offset: the original parses with `Number.parseInt(..., 10)`
// (truncates — "1.5" -> 1, no fallback used), while `z.coerce.number()`
// parses the whole string ("1.5" -> 1.5), which then fails `.int()` and
// falls back to the default instead of truncating. Still never produces a
// 400 — only changes which value one edge-case input resolves to, and only
// for a value nothing today can actually send.
const reconcileLimitParam = z.coerce.number<string>().int().positive().catch(25);
const reconcileOffsetParam = z.coerce.number<string>().int().nonnegative().catch(0);

export const reconcileListQuery = z.object({
  limit: reconcileLimitParam,
  offset: reconcileOffsetParam,
});

export type ReconcileListQuery = z.infer<typeof reconcileListQuery>;

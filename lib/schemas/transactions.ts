import { z } from "zod/v4";

// Shape validation for the transactions resource, shared by the HTTP routes
// (app/api/b/[bookId]/transactions/**) and the MCP write tools
// (mcp/tools/write-transactions.ts). One definition, two surfaces: the MCP
// tools spread `.shape` into their `inputSchema`, which is why every field
// carries the `.describe()` text MCP surfaces to the model.
//
// Business rules that require a database read stay in the callers:
// lib/transactions.ts still owns "splits must sum to zero", "split accounts
// must belong to this book", "check numbers need a bank account",
// "investment accounts require investmentSplits", and the security
// book-ownership check; the GET route still owns the in-book checks on
// balanceAccountId and payeeId. A schema checks the shape of an id, never
// whose book it belongs to.

// Messages mirror the guards they replace in lib/transactions.ts verbatim —
// they surface in user-facing toasts, so they must not drift. Hoisted so the
// create/update pair and the array/element checks share one copy each.
const INVALID_DATE_MESSAGE = "Date must be in YYYY-MM-DD format";
const CREATE_SPLITS_MESSAGE =
  "Date and at least 2 splits are required, even for stock splits";
const UPDATE_SPLITS_MESSAGE =
  "At least 2 splits are required, even for stock splits";
const CHECK_NUMBER_MESSAGE = "checkNumber must be a string when provided";
const INVESTMENT_SPLITS_ARRAY_MESSAGE =
  "investmentSplits must be an array when provided";

// Moved verbatim from mcp/tools/write-transactions.ts, `.describe()` calls
// included. Until now these constrained only the MCP surface; the HTTP routes
// reached lib/transactions.ts with whatever JSON.parse produced.
export const splitSchema = z.object({
  accountId: z
    .number()
    .int()
    .positive()
    .describe("The account ID for this split"),
  amount: z
    .number()
    .int()
    .describe(
      "Amount in cents. Positive = debit, negative = credit. All splits must sum to zero."
    ),
});

export const investmentSplitSchema = z.object({
  securityId: z
    .number()
    .int()
    .positive()
    .describe("The security ID"),
  action: z
    .enum(["buy", "sell", "dividend", "capGain", "fee", "split"])
    .describe("Investment action type"),
  sharesMicros: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Number of shares in micros (1,000,000 = 1 share). Always positive."
    ),
  priceMicros: z
    .number()
    .int()
    .nonnegative()
    .describe("Price per share in micros (1,000,000 = $1.00)"),
  feesCents: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Fees in cents"),
  splitNumerator: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For stock split: new share ratio numerator"),
  splitDenominator: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For stock split: old share ratio denominator"),
});

// POST /api/b/[bookId]/transactions, and `create_transaction` over MCP.
// No `bookId`: the route takes it from the URL, MCP re-adds it to the shape.
//
// `date` uses z.iso.date(), not /^\d{4}-\d{2}-\d{2}$/ — the regex accepts
// "2026-13-45", and lot ordering, holding-term classification, and accounting
// periods are all derived from this string.
//
// The top-level `z.object(...)` also takes `{ error: CREATE_SPLITS_MESSAGE
// }`. lib/transactions.ts's createTransaction() runs `if (!date || !splits
// || splits.length < 2)` as its very first guard — the original route's
// `const body = await request.json()` passed straight through, so a
// non-object body (`[]`, `"abc"`, `5`, `true`) auto-boxes `date`/`splits` to
// `undefined` and lands on this exact combined message (only a literal
// `null` body threw, pre-schema). Without this override, zod's own
// object-shape check would reject those same inputs with its generic
// "Invalid input: expected object, ..." text instead — even though `date` is
// declared first below, CREATE_SPLITS_MESSAGE (not INVALID_DATE_MESSAGE) is
// the message the original guard actually gave first for a body missing
// both fields. Same reasoning as lib/schemas/auth.ts's loginSchema.
export const createTransactionBodySchema = z.object(
  {
    date: z
      .iso
      .date(INVALID_DATE_MESSAGE)
      .describe("Transaction date in YYYY-MM-DD format"),
    description: z.string().optional().describe("Transaction description"),
    notes: z.string().optional().describe("Additional notes"),
    payeeName: z
      .string()
      .optional()
      .describe("Payee name (will be created if new, or matched to existing)"),
    // `error` (not just a refinement) so a non-string reproduces the original
    // `typeof checkNumberInput !== "string"` guard's message.
    checkNumber: z
      .string({ error: CHECK_NUMBER_MESSAGE })
      .optional()
      .describe("Check number (only for bank account transactions)"),
    isFloating: z
      .boolean()
      .optional()
      .describe(
        "If true, the transaction's effective date auto-advances to today until reconciled. " +
        "Useful for checks or expected deposits where the clearing date is unknown."
      ),
    isReconciled: z
      .boolean()
      .optional()
      .describe(
        "If true, the transaction is recorded as already reconciled. " +
        "If the transaction is floating (isFloating is true), also set " +
        "isFloating to false and give the cleared date in the same call. " +
        "If you set only isReconciled, the transaction stays floating, and " +
        "its effective date keeps moving to today even though it is marked " +
        "reconciled."
      ),
    // The schema-level `error` covers "missing" and "not an array"; `.min(2)`
    // covers "too few" — all three were the same guard, so all three keep the
    // same message.
    splits: z
      .array(splitSchema, { error: CREATE_SPLITS_MESSAGE })
      .min(2, CREATE_SPLITS_MESSAGE)
      .describe("Transaction splits (must sum to zero)"),
    investmentSplits: z
      .array(investmentSplitSchema, { error: INVESTMENT_SPLITS_ARRAY_MESSAGE })
      .optional()
      .describe(
        "Investment splits (required if transaction involves investment accounts)"
      ),
  },
  { error: CREATE_SPLITS_MESSAGE }
);

export type CreateTransactionBody = z.infer<typeof createTransactionBodySchema>;

// PUT /api/b/[bookId]/transactions/[id], and `update_transaction` over MCP.
// Every field is optional — the route applies only what it is given, and the
// transactions page PUTs single-field bodies (e.g. `{ isReconciled }`).
// `notes` and `payeeName` are nullish because lib/transactions.ts treats null
// as "clear this field".
export const updateTransactionBodySchema = z.object({
  date: z
    .iso
    .date(INVALID_DATE_MESSAGE)
    .optional()
    .describe("New date in YYYY-MM-DD format"),
  description: z.string().optional().describe("New description"),
  notes: z.string().nullish().describe("New notes"),
  payeeName: z.string().nullish().describe("New payee name"),
  checkNumber: z
    .string({ error: CHECK_NUMBER_MESSAGE })
    .optional()
    .describe("New check number"),
  isFloating: z
    .boolean()
    .optional()
    .describe(
      "Set to true to make the transaction float (effective date = today). " +
      "Set to false to stop floating."
    ),
  isReconciled: z
    .boolean()
    .optional()
    .describe(
      "Set to true to mark the transaction reconciled. If the transaction " +
      "is floating (isFloating is true), also set isFloating to false and " +
      "set date to the cleared date in the same call. If you set only " +
      "isReconciled, the transaction stays floating, and its effective " +
      "date keeps moving to today even though it is marked reconciled."
    ),
  splits: z
    .array(splitSchema, { error: UPDATE_SPLITS_MESSAGE })
    .min(2, UPDATE_SPLITS_MESSAGE)
    .optional()
    .describe("New splits (replaces all existing, must sum to zero)"),
  investmentSplits: z
    .array(investmentSplitSchema, { error: INVESTMENT_SPLITS_ARRAY_MESSAGE })
    .optional()
    .describe("New investment splits (replaces all existing)"),
});

export type UpdateTransactionBody = z.infer<typeof updateTransactionBodySchema>;

// GET /api/b/[bookId]/transactions query params.
//
// Ids are parsed through a non-empty string first rather than with a bare
// z.coerce.number(): z.coerce.number() turns "" into 0, so `?accountId=`
// would silently become "filter by account 0" instead of the 400 the route
// returns today. The messages are the route's own, ported verbatim.
const idParam = (message: string) =>
  z
    .string()
    .min(1, message)
    .pipe(z.coerce.number<string>({ error: message }).int(message).positive(message));

// Non-negative rather than positive: offset 0 and the "0 means unlimited"
// limit sentinel are both legitimate.
const countParam = (message: string) =>
  z
    .string()
    .min(1, message)
    .pipe(z.coerce.number<string>({ error: message }).int(message).nonnegative(message));

// Key order is significant: zod reports issues in shape order and the routes
// return only `issues[0].message`, so this mirrors the order the route's
// hand-written guards ran in (accountId, accountIds, balanceAccountId,
// payeeId).
export const listTransactionsQuery = z.object({
  accountId: idParam("Invalid accountId").optional(),
  // Reproduces the route's own lenient parse: split on commas, drop entries
  // that aren't numbers, and fail only when nothing usable is left.
  accountIds: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => Number.isFinite(id))
    )
    .refine((ids) => ids.length > 0, "Invalid accountIds")
    .optional(),
  balanceAccountId: idParam("Invalid balanceAccountId").optional(),
  payeeId: idParam("Invalid payeeId").optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  // Left as a bare string: the route's semantics are "true only for the
  // literal string 'true'", which z.coerce.boolean() would not reproduce.
  includeMeta: z.string().optional(),
  limit: countParam("Invalid limit").optional(),
  offset: countParam("Invalid offset").optional(),
  ensureId: idParam("Invalid ensureId").optional(),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;

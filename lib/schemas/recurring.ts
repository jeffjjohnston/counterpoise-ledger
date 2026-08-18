import { z } from "zod/v4";

// Shape validation for the recurring-rules resource
// (app/api/b/[bookId]/recurring/**). Business rules that require a database
// read stay in the route handlers — a schema cannot express them:
//   - "endDate cannot be earlier than startDate" (both routes) — on PUT the
//     effective startDate can come from the *existing* row when the request
//     doesn't include one, so the comparison isn't always a pure body check;
//     the same rule is kept in POST too so both routes stay consistent.
//   - "Template splits must sum to zero (debits = credits)" — validateSplits()
//     in lib/accounting.ts, the shared accounting invariant (see the same
//     ruling for transactions in lib/schemas/transactions.ts).
//   - "One or more template split accounts do not belong to this book" — a
//     SELECT against `accounts` scoped to this book.

// Value list mirrors RecurrenceConfig["frequency"] in lib/accounting.ts and
// the `enum` decoration on recurringRules.frequency in db/schema.ts (that
// decoration is TypeScript-only — see CLAUDE.md's Lot Tracking-adjacent note
// on `text(col, { enum: [...] })` not being a real Postgres constraint. This
// schema is the first and only runtime enforcement this column gets).
const frequencyValues = ["daily", "weekly", "monthly", "yearly"] as const;

// No prior guard validated frequency's *value* (only its presence, folded
// into REQUIRED_MESSAGE below) — same gap as accounts.ts's `type` field.
// Reused as-is (not re-declared) in updateRuleSchema, same reasoning
// accounts.ts gives for sharing `accountSubtypeSchema` between create/update:
// one closed-set domain, one message, one place to keep them in sync.
const FREQUENCY_MESSAGE = "Invalid frequency";
const frequencySchema = z.enum(frequencyValues, { error: FREQUENCY_MESSAGE });

// POST's guard was a single combined check across 4 fields:
// `if (!name || !frequency || !startDate || !templateSplits)`. Zod validates
// each field independently, so this exact message can only still appear for
// *every* combination once frequency/startDate/templateSplits gain their own
// more specific messages below (name is the only field with no other
// validator, so it's the only one that can still surface this message on its
// own — same trade-off accounts.ts made for `name`/`type`, documented there
// and here).
const REQUIRED_MESSAGE = "Name, frequency, startDate, and templateSplits are required";

const START_DATE_FORMAT_MESSAGE = "startDate must be in YYYY-MM-DD format";
const END_DATE_FORMAT_MESSAGE = "endDate must be in YYYY-MM-DD format";
const NEXT_DATE_FORMAT_MESSAGE = "nextDate must be in YYYY-MM-DD format";
const TEMPLATE_SPLITS_MESSAGE = "templateSplits must be an array of at least 2 valid splits";
const AUTO_CREATE_DAYS_MESSAGE = "autoCreateDaysBefore must be an integer between 0 and 30";

// Mirrors isValidTemplateSplitInput's checks (Number.isInteger(accountId),
// Number.isFinite(amount)) exactly — no `.positive()` on accountId (the
// original guard didn't require one; an out-of-book/nonexistent id is caught
// by the business-rule DB check, not shape), and no `.int()` on amount: a
// balanced-but-column-overflowing amount (e.g. 3_000_000_000, wider than the
// `integer` column) must still pass shape and fail at the database, per
// tests/api/recurring.test.ts's "leaves no rule behind..." case. Every field
// carries TEMPLATE_SPLITS_MESSAGE so any failure mode inside an element —
// wrong type, non-integer accountId, non-finite amount — reports the same
// single message the original guard gave for any invalid split, not a
// field-specific one.
const templateSplitSchema = z.object({
  accountId: z.number({ error: TEMPLATE_SPLITS_MESSAGE }).int(TEMPLATE_SPLITS_MESSAGE),
  amount: z.number({ error: TEMPLATE_SPLITS_MESSAGE }),
});

export type TemplateSplitInput = z.infer<typeof templateSplitSchema>;

// `{error}` on the array covers "missing" and "not an array"; `.min(2, ...)`
// covers "too few"; the element schema's own per-field errors (above) cover
// "array of the wrong shape" — all four failure modes were one guard
// (isValidTemplateSplitPayload), so all four keep the same message.
const templateSplitsSchema = (message: string) =>
  z.array(templateSplitSchema, { error: message }).min(2, message);

// Shared by create and update: `parseAutoCreateDaysBefore(value, 0)` treats
// only `value === undefined` as "use the fallback" — an explicit `null`,
// wrong type, non-integer, or out-of-range value all hit the same "invalid"
// branch and 400 with this message, on both routes, identically. The route
// still applies the `?? 0` fallback itself; the schema only validates shape.
const autoCreateDaysBeforeSchema = z
  .number({ error: AUTO_CREATE_DAYS_MESSAGE })
  .int(AUTO_CREATE_DAYS_MESSAGE)
  .min(0, AUTO_CREATE_DAYS_MESSAGE)
  .max(30, AUTO_CREATE_DAYS_MESSAGE)
  .optional();

// POST's endDate guard was `if (endDate && !isValidDateString(endDate))` —
// note the bare truthy check, not `!== undefined && !== null` like the other
// three date guards below. `""` and `null` are both falsy, so both silently
// bypassed validation and were normalized to `null` by the route's own
// `endDate: endDate || null`. The recurring-rule create form
// (app/b/[bookId]/recurring/page.tsx) relies on exactly this: it sends
// `endDate: endDate || null` whenever the end-date input is empty. A plain
// `.nullish()` wrapping `z.iso.date()` would reject `""` (it isn't `null` or
// `undefined`, so it would hit date-format validation and fail) — that
// would 400 on the exact payload the real UI sends. Preprocessing `""` to
// `null` first reproduces the original "falsy bypasses validation" rule
// before the date-format check ever runs.
const createEndDateSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.iso.date(END_DATE_FORMAT_MESSAGE).nullish()
);

// PUT's endDate/nextDate guards both use
// `!== undefined && !== null && !isValidDateString(...)` — unlike POST,
// `""` is NOT treated as absent here: it is neither undefined nor null, so
// it reaches isValidDateString("") (false) and 400s. `.nullish()` alone
// reproduces this exactly: null/undefined bypass, everything else — `""`
// included — goes through date-format validation.
const nullishDateSchema = (message: string) => z.iso.date(message).nullish();

// createRuleSchema fields are declared in the order POST's guards ran
// (name/frequency/startDate/templateSplits as one combined check, then
// startDate's own format check, then endDate's, then templateSplits' shape,
// then autoCreateDaysBefore) so that when more than one field is invalid at
// once, `issues[0]` — the only thing the route returns — lands on the field
// that would have been reported first before this change. Fields with no
// prior guard (interval, daysOfWeek, weekOfMonth, daysOfMonth,
// templateDescription, payeeId, payeeName) are appended after and left
// exactly as permissive as the route already was: `resolvePayeeId` in both
// route files explicitly types payeeId/payeeName as `unknown` and treats any
// other type as "not provided" rather than an error, and the rest
// (interval, daysOfWeek, weekOfMonth, daysOfMonth, templateDescription) flow
// into `x || fallback`/`JSON.stringify(x)` with no shape guard today — adding
// one now would be new validation this task wasn't scoped to introduce.
//
// The top-level `z.object(...)` also takes `{ error: REQUIRED_MESSAGE }`.
// The original route's `const { name, frequency, ... } = body` auto-boxes a
// non-object body (`[]`, `"abc"`, `5`, `true`) without throwing, landing on
// `name`/`frequency`/`startDate`/`templateSplits` all `undefined` and
// reporting this exact combined "required" message at 400 (only a literal
// `null` body threw, pre-schema). Without this override, zod's own
// object-shape check would reject those same inputs with its generic
// "Invalid input: expected object, ..." text instead. Same reasoning as
// lib/schemas/auth.ts's loginSchema.
export const createRuleSchema = z.object(
  {
    name: z.string({ error: REQUIRED_MESSAGE }).min(1, REQUIRED_MESSAGE),
    frequency: frequencySchema,
    startDate: z.iso.date(START_DATE_FORMAT_MESSAGE),
    endDate: createEndDateSchema,
    templateSplits: templateSplitsSchema(TEMPLATE_SPLITS_MESSAGE),
    autoCreateDaysBefore: autoCreateDaysBeforeSchema,
    interval: z.any().optional(),
    daysOfWeek: z.any().optional(),
    weekOfMonth: z.any().optional(),
    daysOfMonth: z.any().optional(),
    templateDescription: z.any().optional(),
    payeeId: z.unknown().optional(),
    payeeName: z.unknown().optional(),
  },
  { error: REQUIRED_MESSAGE }
);

export type CreateRuleInput = z.infer<typeof createRuleSchema>;

// updateRuleSchema fields are declared in PUT's guard order (startDate,
// endDate, nextDate, templateSplits, autoCreateDaysBefore), then the
// remaining fields. Every field is optional — PUT applies only what it's
// given, same convention as updateTransactionBodySchema.
//
// `name` has no prior guard on PUT (unlike POST, where it's part of the
// combined required check) — kept as a bare optional string, matching
// updateAccountSchema.name's identical reasoning: no `.min(1)`, so an empty
// name stays exactly as accepted as it is today.
//
// `frequency` also has no prior guard on PUT, but — unlike `name` — it's a
// closed-set domain column with no DB-level enforcement (see the frequency
// value-list comment above), the same bug class as accounts.ts's `subtype`
// on update. Reusing `frequencySchema` here closes that gap on both routes
// at once, consistent with how accounts.ts reused `accountSubtypeSchema`.
//
// `isActive` also gains new validation despite no prior guard: unlike the
// frequency/subtype text columns, `is_active` is a real Postgres boolean
// (see CLAUDE.md's "Boolean columns" gotcha) — a non-boolean value here was
// always going to fail at the database, so this converts a would-be 500 into
// a clean 400 without changing what values are actually accepted.
export const updateRuleSchema = z.object({
  startDate: z.iso.date(START_DATE_FORMAT_MESSAGE).optional(),
  endDate: nullishDateSchema(END_DATE_FORMAT_MESSAGE),
  nextDate: nullishDateSchema(NEXT_DATE_FORMAT_MESSAGE),
  templateSplits: templateSplitsSchema(TEMPLATE_SPLITS_MESSAGE).optional(),
  autoCreateDaysBefore: autoCreateDaysBeforeSchema,
  name: z.string().optional(),
  frequency: frequencySchema.optional(),
  isActive: z.boolean().optional(),
  interval: z.any().optional(),
  daysOfWeek: z.any().optional(),
  weekOfMonth: z.any().optional(),
  daysOfMonth: z.any().optional(),
  templateDescription: z.any().optional(),
  payeeId: z.unknown().optional(),
  payeeName: z.unknown().optional(),
});

export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

// POST /api/b/[bookId]/recurring/process. Neither field had any prior shape
// guard — `if (ruleId) {...} else if (processAll) {...}` accepted anything
// truthy. `ruleId` deliberately has no `.positive()`: recurringRules.id is a
// serial PK starting at 1, so `0` is never a real id, and the route's own
// `if (ruleId)` truthy check already treats `0` as "not provided" and falls
// through to the processAll branch — rejecting `0` here would 400 on input
// the route itself currently shrugs off as absent. An actually wrong type
// (a string, an object) previously reached `processRecurringRuleById`
// unguarded; this closes that gap with a normal 400 instead of whatever the
// database driver did with it.
export const processRulesSchema = z.object({
  ruleId: z.number().int().optional(),
  processAll: z.boolean().optional(),
});

export type ProcessRulesInput = z.infer<typeof processRulesSchema>;

// GET /api/b/[bookId]/recurring/projected query params. No prior guard
// existed for any of the three — all three were read behind truthiness
// checks (`... || toDateString(...)`, `accountIdParam ? parseInt(...) :
// null`), so the route maps every absent/empty param with `|| undefined`
// before calling `.safeParse()` (never `??` — see lib/schemas/accounts.ts's
// listAccountsQuery comment on null vs undefined). `startDate`/`endDate` use
// zod's default "Invalid ISO date" message (no prior string to port, same
// as listAccountsQuery.asOfDate in lib/schemas/accounts.ts).
const idParam = (message: string) =>
  z
    .string()
    .min(1, message)
    .pipe(z.coerce.number<string>({ error: message }).int(message).positive(message));

export const projectedQuery = z.object({
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  accountId: idParam("Invalid accountId").optional(),
});

export type ProjectedQuery = z.infer<typeof projectedQuery>;

// GET /api/b/[bookId]/recurring/transactions query params. Both were read
// with a combined truthy check (`if (!startDate || !endDate)`), same pattern
// as createRuleSchema.name — `error` on z.string() covers "missing", `.min(1,
// ...)` covers "present but empty", both carrying the ported message. No
// date-format validation: the original guard never called isValidDateString
// on these, only checked presence, so this schema doesn't either — adding
// format validation here would be new behavior beyond the ported guard.
const REQUIRED_DATES_MESSAGE = "startDate and endDate are required";

export const recurringTransactionsQuery = z.object({
  startDate: z.string({ error: REQUIRED_DATES_MESSAGE }).min(1, REQUIRED_DATES_MESSAGE),
  endDate: z.string({ error: REQUIRED_DATES_MESSAGE }).min(1, REQUIRED_DATES_MESSAGE),
});

export type RecurringTransactionsQuery = z.infer<typeof recurringTransactionsQuery>;

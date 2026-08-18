import { z } from "zod/v4";

// Shape validation for the reports resource
// (app/api/b/[bookId]/reports/**). All three routes are GET-only aggregate
// queries with no request body, so every schema here is a `searchParams`
// query schema. None of the three routes have a database-dependent 400 — the
// only guards that existed were pure functions of the query string itself
// (date-pair presence, accountId shape), so nothing stays behind in the
// route handlers for this resource.
//
// A `URLSearchParams.get()` miss returns `null`, not `undefined`, and
// `z.coerce.number()` coerces `null` (and `""`) to `0` — the classic "no
// filter silently becomes filter-by-0" trap this plan exists to avoid. Every
// field below is designed against the ORIGINAL route's own truthiness gate,
// not just its literal `??`/no-op read: `reports/data` and
// `reports/realized-gains` both eventually run the raw param through an
// `if (value)` check (in the route itself, or one call deeper in
// lib/reports-queries.ts / lib/realized-gains.ts) before the value is ever
// used, so `""` was always equivalent to "absent" for every date param in
// this file, however the route's own local variable happened to be
// assigned. Callers therefore map every param — dates included — with
// `|| undefined`, never `??`: `??` would let a bare `?startDate=` reach the
// new `z.iso.date()` check below and turn a historically-silent no-op into a
// brand-new 400. See task-8-report.md for the full per-param inventory this
// reasoning produced.
//
// None of the three routes validated `startDate`/`endDate`'s *format*
// before this change — only presence (and, on income-statement/
// realized-gains, that both-or-neither were given). `z.iso.date()` is added
// here anyway, same tightening `listAccountsQuery.asOfDate` and
// `listTransactionsQuery.startDate/endDate` already made in Tasks 2 and 3: a
// malformed date filter has no sensible behavior to preserve (it either hit
// a SQL comparison against a non-date string or silently matched nothing),
// and turning it into a clean 400 is the established precedent for every
// date-range query param in this plan. Flagged here, not decided silently.

const accountTypeValues = ["asset", "liability", "equity", "income", "expense"] as const;
type ReportAccountType = (typeof accountTypeValues)[number];

// ---------------------------------------------------------------------------
// reportDataQuery — GET /api/b/[bookId]/reports/data
// ---------------------------------------------------------------------------
//
// The only query schema in this file with no cross-field or DB-independent
// business rule at all: startDate, endDate, accountIds, and accountTypes are
// each fully independent, and none of them ever 400s today — a malformed
// accountIds/accountTypes entry is silently dropped, and an entirely
// unusable list (all entries invalid, or empty after filtering) collapses to
// "no filter" rather than an error (data/route.ts:23-34,39-40). The two
// list-shaped transforms below reproduce that exact leniency: parse what can
// be parsed, drop what can't, and treat "nothing usable survived" the same
// as "the param was never given".
export const reportDataQuery = z.object({
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  accountIds: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const ids = value
        .split(",")
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n));
      return ids.length > 0 ? ids : undefined;
    }),
  accountTypes: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const types = value
        .split(",")
        .filter((t): t is ReportAccountType =>
          accountTypeValues.includes(t as ReportAccountType)
        );
      return types.length > 0 ? types : undefined;
    }),
});

export type ReportDataQuery = z.infer<typeof reportDataQuery>;

// ---------------------------------------------------------------------------
// incomeStatementQuery — GET /api/b/[bookId]/reports/income-statement
// ---------------------------------------------------------------------------
//
// Shared verbatim with realizedGainsQuery below — both routes guard
// startDate/endDate with the identical
// `if ((startDate && !endDate) || (!startDate && endDate))` check and the
// identical message (income-statement/route.ts:21-26,
// realized-gains/route.ts:21-26).
const REQUIRED_DATES_MESSAGE = "Both startDate and endDate are required";

// `includeInactive` stays a bare optional string, not `z.coerce.boolean()`:
// the route's own semantics are "truthy only on the literal string 'true'"
// (income-statement/route.ts:19), computed after parsing, same convention
// `listAccountsQuery.includeInactive` already established in Task 2.
export const incomeStatementQuery = z
  .object({
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    includeInactive: z.string().optional(),
  })
  .refine((data) => Boolean(data.startDate) === Boolean(data.endDate), {
    error: REQUIRED_DATES_MESSAGE,
  });

export type IncomeStatementQuery = z.infer<typeof incomeStatementQuery>;

// ---------------------------------------------------------------------------
// realizedGainsQuery — GET /api/b/[bookId]/reports/realized-gains
// ---------------------------------------------------------------------------
//
// `accountId` is declared as a plain (unvalidated) optional string, with its
// real shape check moved into the `superRefine` below rather than expressed
// as a field-level `z.coerce.number()...` — that's deliberate, not a
// stylistic choice: the original route checks the date pair FIRST and
// returns before ever looking at accountId
// (`if ((startDate && !endDate) || ...) return 400; ... if (accountIdParam
// && ...) return 400;`, realized-gains/route.ts:21-31), so a request with
// BOTH a bad date pair AND a bad accountId must report the date message,
// not the accountId one. Zod runs field-level checks before any
// `.refine()`/`.superRefine()` on the object, so a field-level accountId
// schema would report "Invalid accountId" first whenever both were wrong —
// backwards from the route's own priority. Encoding both checks inside one
// `superRefine`, in the route's own order, with an early `return` after the
// first one fires, reproduces that priority exactly. This is the same
// technique lib/schemas/sync.ts's reconcileSchema uses for its own
// action-conditional fields.
const INVALID_ACCOUNT_ID_MESSAGE = "Invalid accountId";

export const realizedGainsQuery = z
  .object({
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    accountId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (Boolean(data.startDate) !== Boolean(data.endDate)) {
      ctx.addIssue({ code: "custom", message: REQUIRED_DATES_MESSAGE });
      return;
    }
    if (data.accountId === undefined) return;
    // Mirrors `Number(accountIdParam)` + `!Number.isInteger(accountId) ||
    // accountId <= 0` verbatim (realized-gains/route.ts:28-31) — not
    // `z.coerce.number().int().positive()`, so that a fractional string
    // ("5.5") is rejected the same way the original did (`Number.isInteger`
    // false) rather than silently coerced.
    const parsedAccountId = Number(data.accountId);
    if (!Number.isInteger(parsedAccountId) || parsedAccountId <= 0) {
      ctx.addIssue({
        code: "custom",
        message: INVALID_ACCOUNT_ID_MESSAGE,
        path: ["accountId"],
      });
    }
  });

export type RealizedGainsQuery = z.infer<typeof realizedGainsQuery>;

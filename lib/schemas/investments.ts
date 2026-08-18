import { z } from "zod/v4";

// Shape validation for the investments resource
// (app/api/b/[bookId]/investments/**). Neither route has a business rule
// left behind: both are read-only aggregate queries whose only guard is a
// query-param shape check.
//
// Not in the brief's own file list — the brief's "Create" line names only
// lib/schemas/reports.ts and lib/schemas/payees.ts, but the interfaces it
// asks this task to produce (`accountValuesQuery`, `positionsQuery`) need a
// home, and neither reports.ts nor payees.ts is the right one. Every other
// resource in this plan gets its own schema file named after the resource
// (accounts.ts, securities.ts, sync.ts, recurring.ts, transactions.ts) — this
// file follows that same convention rather than being wedged into an
// unrelated one. Flagged in task-8-report.md rather than done silently.

// ---------------------------------------------------------------------------
// accountValuesQuery — GET /api/b/[bookId]/investments/account-values
// ---------------------------------------------------------------------------
//
// `asOfDate` is read with `?? undefined` in the route itself
// (account-values/route.ts:16), but the value it feeds,
// `getMarketValuesByAccount`, gates it behind `asOfDate ? ... : ...`
// (lib/investments.ts:416) — so `""` has always meant "no filter", same as
// an absent key. The caller here maps with `|| undefined`, not the route's
// own literal `??`: mapping with `??` would let `?asOfDate=` reach the new
// `z.iso.date()` check below and turn what is silently a no-op today into a
// brand-new 400. No prior format validation existed for this param; adding
// `z.iso.date()` is the same deliberate tightening documented at the top of
// lib/schemas/reports.ts, applied here for the identical reason.
export const accountValuesQuery = z.object({
  asOfDate: z.iso.date().optional(),
});

export type AccountValuesQuery = z.infer<typeof accountValuesQuery>;

// ---------------------------------------------------------------------------
// positionsQuery — GET /api/b/[bookId]/investments/positions
// ---------------------------------------------------------------------------
//
// The original guard is `if (accountIdParam !== null)` (positions/route.ts:19)
// — NOT a truthy check. An explicit `?accountId=` is a non-null string, so it
// reaches `parseInt("", 10)` -> `NaN` -> `!Number.isFinite(NaN)` -> 400
// "Invalid accountId" (positions/route.ts:20-23). Unlike every other
// accountId/date param in this task, `""` is a real, invalid value here, not
// a synonym for "absent" — so the caller maps with `?? undefined` (only a
// missing key becomes `undefined`; an explicit empty string is left alone to
// fail validation), and `z.coerce.number()` alone cannot reproduce that: it
// coerces `""` to `0` (Number("") === 0), which is finite and would be
// silently ACCEPTED as accountId 0 instead of rejected — the exact
// missing-key-becomes-0 trap this task exists to avoid, just triggered by an
// explicit empty string instead of a missing key. `z.string().min(1,
// message)` closes that gap by rejecting `""` before coercion ever runs.
//
// `.int()`, no `.positive()`: the original only checks `Number.isFinite`,
// so a negative accountId was never rejected (it simply matches no account,
// the same non-error "no results" every other id nothing owns produces) —
// same reasoning lib/schemas/sync.ts's pendingTransactionsQuery documents
// for its own accountId, and `accountId: 0` still falls through
// `getPositions`'s own `accountId ? ... : ...` truthy check as "no filter",
// unchanged by this schema either way. `.int()` IS added despite no prior
// guard requiring it: `parseInt("5.5", 10)` truncates to 5 and was silently
// accepted before, while a bare `z.coerce.number()` would carry 5.5 through
// unchanged into `getPositions(db, bookId, 5.5)` — worse than before (see
// CLAUDE.md's Task 6 note on this exact trap). No real caller sends a
// fractional accountId here.
const INVALID_ACCOUNT_ID_MESSAGE = "Invalid accountId"; // positions/route.ts:22

export const positionsQuery = z.object({
  accountId: z
    .string()
    .min(1, INVALID_ACCOUNT_ID_MESSAGE)
    .pipe(
      z.coerce.number<string>({ error: INVALID_ACCOUNT_ID_MESSAGE }).int(INVALID_ACCOUNT_ID_MESSAGE)
    )
    .optional(),
});

export type PositionsQuery = z.infer<typeof positionsQuery>;

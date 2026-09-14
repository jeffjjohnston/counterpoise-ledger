# Recurring Transactions

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## How Recurring Rules Work
- Stored in `recurring_rules` table with frequency and date settings
- Template splits stored in `recurring_template_splits`
- `nextDate` field tracks next due date
- `autoCreateDaysBefore` (default 0) lets a rule's transaction be auto-created up to N days before it's due
- `businessDaysOnly` (default false) shifts an occurrence that lands on a weekend to the following Monday — see Business-Day Occurrences below
- Process via POST to `/api/b/[bookId]/recurring/process`
- Cron endpoint at `/api/cron/recurring` runs hourly (via Docker `scheduler` sidecar; same sidecar runs Plaid sync — see [guides/plaid-sync.md](plaid-sync.md))
- `/lib/recurring-rules.ts` is the single home for rule CRUD and projections, shared by the API routes and the MCP recurring tools

## Processing Due Rules
1. Check if the *observed* date (`getOccurrenceDate(nextDate, businessDaysOnly)`) is `<= today` (plus `autoCreateDaysBefore`)
2. Create new transaction from template, dated the observed date
3. Calculate next date using `getNextDate()` function — from the **scheduled** `nextDate`, never the observed one
4. Update rule's `nextDate`
5. If past `endDate`, deactivate rule

## Business-Day Occurrences
`getOccurrenceDate(scheduledDate, businessDaysOnly)` in `/lib/recurring.ts` is
the single place the shift is applied, and it is applied at *read* time — when a
scheduled date becomes a transaction date — never written back into the rule.
Storing the shifted date in `nextDate` would make `getNextDate()` compute the
following occurrence from the Monday, so a rule due on the 15th would creep to
the 17th and stay there.

Everything that turns a rule into dates goes through it: `processRecurringRuleById`
and `processAllRecurringRules` (`/lib/recurring-processing.ts`), the projection
route (`/app/api/b/[bookId]/recurring/projected/route.ts`), the recurring page's
due badge, "Next:" line and calendar, and the global search page's "Next Date"
column (`lib/search.ts` carries `businessDaysOnly` through so the two pages
cannot disagree). `isRecurringRuleDue()` takes `businessDaysOnly` as an optional
4th argument and compares the observed date, so a rule whose occurrence falls on
a Saturday is not due — and is not created — until the Monday it will be dated.

`advanceNextDateToFuture()` (`/lib/accounting.ts`) needs the observed date too,
for the opposite reason: it decides which scheduled occurrence to *store* when a
rule is created or its schedule is edited. Comparing raw dates against today
threw away a Saturday occurrence for a rule created on that Sunday or Monday,
even though the rule would still have created the transaction on the Monday. It
takes an optional `observe` transform rather than a `businessDaysOnly` flag:
`lib/recurring.ts` already imports `lib/accounting.ts`, so a flag would need
either a circular import or a second copy of the shift inside `accounting.ts`.
Callers pass `(date) => getOccurrenceDate(date, businessDaysOnly)`; the default
leaves dates alone.

Two consequences worth knowing:
- **Weekends are the whole definition of "non-business day."** Bank holidays are
  not modeled, the same limitation `getNextBusinessDay()` in `/lib/accounting.ts`
  documents. `advanceToBusinessDay()` next to it is the "when is this observed?"
  variant — it leaves a weekday alone, where `getNextBusinessDay()` always moves.
- **Two occurrences can collapse onto one observed date.** A daily rule's Saturday
  and Sunday both land on Monday, and both transactions are created. That is two
  occurrences observed the same day, not a duplicate.

`endDate` still bounds the **scheduled** date, not the observed one: an occurrence
scheduled on or before `endDate` counts even when its shift lands past it.

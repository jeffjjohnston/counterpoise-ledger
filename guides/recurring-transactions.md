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
- The server runs the recurring job hourly (`rust-api/server/src/scheduler.rs`; it also runs Plaid sync — see [guides/plaid-sync.md](plaid-sync.md)). `/api/cron/recurring` runs the same job now. Rust serves it from `rust-api/server/src/routes/cron.rs`, which calls `process_all()` in `routes/recurring.rs` for each book. A failure in one book is logged, and the job continues with the next book. `tests/http/cron.test.ts` covers it
- `rust-api/server/src/routes/recurring.rs` is the single home for rule CRUD, processing and projections. It serves the `/api/b/[bookId]/recurring/**` routes, the MCP recurring tools send their requests through those routes, and the cron calls its `process_all()`. `tests/http/recurring.test.ts` covers the routes. See [the Rust book routes](api-route-patterns.md)
- The date rules are in `ledger_core::recurring` (`rust-api/core/src/recurring.rs`). The browser runs the same code as WASM through `lib/wasm-client.ts`, and `lib/recurring.ts` and `lib/accounting.ts` hold the TypeScript helpers that the pages call

## Processing Due Rules
1. Check if the *observed* date (`occurrence_date(next_date, business_days_only)`) is `<= today` (plus `autoCreateDaysBefore`)
2. Create new transaction from template, dated the observed date
3. Calculate next date using `next_date()` — from the **scheduled** `nextDate`, never the observed one
4. Update rule's `nextDate`
5. If past `endDate`, deactivate rule

## Business-Day Occurrences
`occurrence_date(scheduled, business_days_only)` in `ledger_core::recurring` is
the single place the shift is applied, and `getOccurrenceDate()` in
`/lib/recurring.ts` is its TypeScript copy for the pages. The shift is applied
at *read* time — when a scheduled date becomes a transaction date — never
written back into the rule. Storing the shifted date in `nextDate` would make
`next_date()` compute the following occurrence from the Monday, so a rule due
on the 15th would creep to the 17th and stay there.

Everything that turns a rule into dates goes through it: `process_rule()` and
`process_all()` and the `projected` route in `rust-api/server/src/routes/recurring.rs`,
the recurring page's due badge, "Next:" line and calendar, and the global
search page's "Next Date" column (the search route in
`rust-api/server/src/routes/search.rs` carries `businessDaysOnly` through so the
two pages cannot disagree). `is_recurring_rule_due()` (and `isRecurringRuleDue()`
in TypeScript) takes `businessDaysOnly` and compares the observed date, so a
rule whose occurrence falls on a Saturday is not due — and is not created —
until the Monday it will be dated.

`advance_next_date_to_future()` (and `advanceNextDateToFuture()` in `/lib/accounting.ts`) needs the observed date too,
for the opposite reason: it decides which scheduled occurrence to *store* when a
rule is created or its schedule is edited. Comparing raw dates against today
threw away a Saturday occurrence for a rule created on that Sunday or Monday,
even though the rule would still have created the transaction on the Monday.
The Rust function takes `business_days_only`. The TypeScript copy takes an
optional `observe` transform rather than a `businessDaysOnly` flag:
`lib/recurring.ts` already imports `lib/accounting.ts`, so a flag would need
either a circular import or a second copy of the shift inside `accounting.ts`.
Callers pass `(date) => getOccurrenceDate(date, businessDaysOnly)`; the default
leaves dates alone.

Two consequences worth knowing:
- **Weekends are the whole definition of "non-business day."** Bank holidays are
  not modeled, the same limitation `get_next_business_day()` in
  `ledger_core::recurring` (and `getNextBusinessDay()` in `/lib/accounting.ts`)
  documents. `advance_to_business_day()` next to it is the "when is this
  observed?" variant — it leaves a weekday alone, where
  `get_next_business_day()` always moves.
- **Two occurrences can collapse onto one observed date.** A daily rule's Saturday
  and Sunday both land on Monday, and both transactions are created. That is two
  occurrences observed the same day, not a duplicate.

`endDate` still bounds the **scheduled** date, not the observed one: an occurrence
scheduled on or before `endDate` counts even when its shift lands past it.

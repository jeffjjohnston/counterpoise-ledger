# TypeSafe reconciliation experiment

TypeSafe suggests an existing transaction for an unresolved Plaid row. When no
existing transaction matches, it proposes a new transaction: a payee and an
income or expense category. It never matches or creates automatically. The
original candidate list and its keyboard shortcuts stay in their original
order. Separate buttons confirm a match or create the proposed transaction
through the existing reconciliation resolver. **Edit…** copies a proposal into
the ordinary Create form.

## Enable or disable

1. Run a release whose schema has the TypeSafe tables. The SQLite baseline
   (`rust-api/db/migrations/0001_baseline.sql`) has them.
2. Set server-only `TYPESAFE_API_KEY` and `TYPESAFE_ENABLED=true` in the relevant
   deployment's environment, then restart that app. Neither variable is public.
3. In the current book's **Settings → TypeSafe AI — Experimental**, enable
   **Suggest Plaid transaction matches**. Every book starts off; configuring a
   key never opts a book in. Future features need separate permission.

Set `TYPESAFE_ENABLED=false` and restart to disable the integration across the
installation. A book owner can turn off their feature in Settings without a
restart, including when the provider is unavailable. Disabling hides cached
suggestions and invalidates results already in flight. Requests that already
sent data cannot be recalled. Clear experiment data also disables the feature
and deletes that book's local details/aggregates, retaining today's quota.

No live TypeSafe requests occur in tests. Review the applicable TypeSafe privacy
terms before enabling a real-data pilot. The public
[privacy policy](https://typesafe.ai/legal/privacy-policy) does not promise a
specific zero-retention period; the app's deletion action only deletes local data.

## Request and mutation boundaries

- Requests are triggered only for the selected reconciliation row in an opted-in
  browser and, for entry suggestions, from the transaction form (see "Entry
  suggestions" below). Plaid sync, cron sync, queue GETs, and MCP do not call
  TypeSafe.
  The weekly review ([weekly-review.md](weekly-review.md)) is a separate
  feature with its own opt-in, and it calls Claude from a scheduled job.
- It skips demo tokens, bank-pending rows, resolved rows, and modification/removal
  review rows. One request asks up to three Choice questions in parallel
  (prompt `plaid-match-v3`): `match` over the existing top five candidates,
  filtered to an exact signed amount on the mapped account and no existing link
  on that Plaid account link (multiple splits on the account must total that
  amount); and `payee` and `category`, which state the premise "suppose this is
  recorded as a new transaction". Code reads payee and category only when match
  is `none` or was not asked. A row with no eligible candidate is asked only
  payee and category. A row is skipped only when no question applies.
- Payee options come from code: the payee that earlier matches linked to this
  merchant, up to 15 existing payees that share words with the merchant, and
  the bank's own merchant text, with whitespace and quote marks normalized, as
  a new payee (left out when an existing payee has the same name, ignoring
  case). Jev picks; it never writes a name. A one-click create, or an Edit
  that keeps the proposed payee, writes that new payee to the ledger as the
  bank sent it, not the redacted text sent to TypeSafe. Category options are
  the book's active income and expense accounts (at most 254).
- It sends bounded merchant/name strings, amounts in cents, a code-computed
  money-in/money-out direction, dates, currency, candidate payee names,
  ephemeral labels, a payee shortlist, the income and expense account names,
  the candidate's first five income or expense counterpart account names and
  kinds in stable kind/name order, and the categories the merchant's payee used
  before. It also sends the name
  of the payee that earlier matches linked to this merchant, and up to three
  income or expense accounts that payee used, with a count for each. Long
  numeric references and email addresses are redacted from every string sent
  to TypeSafe, including the payee shortlist names; this redaction never
  reaches the ledger or the stored snapshot. Original bank descriptions, local
  transaction notes, asset and liability account names, account numbers, and
  Plaid IDs/tokens are omitted. Request
  bodies never enter logs or analytics.
- The direct [HTTP adapter](https://docs.typesafe.ai/api) pins `jev-1.13.0` and
  `plaid-match-v3`, validates the complete Choice distribution of every answer,
  allows `none`, and times out after five seconds without automatic retry. A
  returned score is not displayed as a percentage of proven accuracy.
- A book-row lock serializes claims and a persisted UTC-day quota limits attempts
  to 100/day/book. Successful input snapshots are cached. Only one evaluation can
  be active per book. The lease expires after 30 seconds; a new attempt UUID
  fences old completions. Failed requests have a 60-second retry cooldown.
- Network I/O holds no database transaction. Settings revisions fence off/on
  cycles. Fingerprints include effective day, book/account mapping, model/prompt,
  candidate snapshot, and baseline order. Display and confirmation revalidate
  current state. Confirmation locks the relevant rows and calls the ordinary
  resolver within the same transaction.
- New routes have explicit MCP parity waivers: the opt-in, display observation,
  and human confirmation belong to the browser experiment, not MCP automation.

## Entry suggestions

The second TypeSafe feature, with its own opt-in: **Suggest entries for new
transactions** (`books.typesafe_entry_enabled`, the field
`entrySuggestionsEnabled` of `settings/typesafe`). It starts off. Both features
share `typesafe_revision`, so a change of either setting fences the requests
of both, and **Clear experiment data** turns both off and deletes the records
of both.

**The fill, for every book.** When the user picks an existing payee in a new
transaction (simple or journal mode, in a register with an account), the form
reads `GET /api/b/{bookId}/payees/{id}/entry-patterns?accountId=` (Read). The
patterns come from `rust-api/server/src/entry_patterns.rs`:

- the latest 200 transactions of the payee with a split on the account, with an
  effective date in the 24 months up to today (`ledger_db::clock::today()`),
  without investment splits;
- a pattern is the sorted list of the other accounts and their direction; the
  splits on the account are summed into one net amount;
- a pattern is `stable` when it has 2 or more uses and its last 3 uses (or both
  of 2) have the same split amounts; `range` is the min and max of the account's
  amount over the last 12 uses;
- at most 8, newest last use first. The first is the baseline.

The form fills from the baseline at once: the accounts, and the amount only
when stable (else the hint "usually $31.20–$164.00"). It changes only the
fields that the user has not set since the form reset. A pattern with more than
one other account switches to journal mode: the amounts are the pattern's when
they repeat; else the first line of this account gets the typed amount (kept
through later fills), or the total when the total repeats (a loan payment whose
principal and interest change), and the hint shows the range. When the payee changes, the fields that the fill set and
the user did not touch go back to the empty entry. With no patterns, or when they
cannot load, the form keeps the earlier last-account fill.

**The TypeSafe pick, for an opted-in book.** With 2 or more patterns the form
calls `POST /api/b/{bookId}/entry-suggestion` (Write) with exactly
`{ accountId, payeeId, date, amount }`. The server computes the patterns again,
and asks one Choice question (`pattern`, prompt `entry-pattern-v1`, options
`P1`–`P8` and `none`). It sends the redacted payee name, the date, the weekday,
the day of month, the kind of the account, the typed amount with its direction
(`{ cents, direction }`; the request sends it signed, negative for money out),
each option's
income and expense account names (asset and liability accounts by kind only),
counts, dates, amounts and ranges, and the last 12 uses. Memos, descriptions,
check numbers, asset and liability names and Plaid data are not sent. The
quota (100 attempts per book per UTC day) is shared with the reconciliation
feature; the 60-second retry, the 5-second timeout and the answer checks are the
same. One entry evaluation of a book runs at a time: while another one is
pending (30-second lease), a request answers `busy`. A stored answer with the same fingerprint is reused
without a call. The form applies the pick only when the user has not edited
the form since the last fill, and the payee, the account, the date and the
settings revision are the same; else it drops it. The form waits 400 ms before the request, so a payee
typed past (an exact match on the way to a longer name) makes no call.

**The chip.** Under the payee: "Filled from: Groceries · $42.10 (history)",
"(TypeSafe)", "(TypeSafe was not sure)" for `none`, or "(your pick)". The chip
and the outcome name the fill that the form shows: a dropped TypeSafe answer
changes neither. A click lists the patterns; a pick fills the form again, over
edits, but keeps a typed amount when the picked pattern has none (in journal
mode, on this account's line). Choosing the pattern already shown is not a
pick. A mode change
and a new expense account count as edits.

**Records.** `typesafe_entry_evaluations` (one per book and fingerprint) and
`typesafe_entry_outcomes`. After a save that the page reports as successful
(`onSubmit` resolves `true`), the form posts
`POST /api/b/{bookId}/entry-suggestion/outcome` (Write; only for an opted-in
book): `kept`, `changed_amount`, `picked_other`, `changed_accounts`, or
`abandoned` when the form closes with a fill and no save (Cancel, the sheet's
close button or backdrop, leaving the page). The hourly cleanup archives the counts of entry
records older than 30 days and deletes them; an outcome is counted apart from
its evaluation, so a newer outcome stays. The report adds the keys `entry_*` (a failed request also counts
`entry_error_<code>`)
(`summarize_entries` in `typesafe.rs` and `summarizeEntries` in
`lib/typesafe/report.ts`, with the shared cases `entryCases` in
`tests/fixtures/typesafe-summary.json`).

The three routes have MCP waivers: the patterns are a form helper, and the
request and the outcome belong to the browser.

## Evidence and retention

Run against the intended database from a source checkout:

```sh
npm run typesafe:report -- --book-id 1
```

The command prints counts only, never transaction text. It includes request
outcomes, baseline agreement, candidate coverage on explicit manual matches,
exposed suggestions, button acceptances, subsequent observed UI unlinks, token
usage when returned, and total/sample counts for latency and active review time.
Merchant familiarity means a prior matched row with the same merchant string
after the payee-name rule (whitespace collapsed, quote marks made straight,
letter case ignored). The same rule finds the payee that earlier matches linked
to the merchant. It is not a claim of human labeling.

A click on **Match this transaction** or **Create transaction** also records
the display time when the UI's display report has not arrived yet. The click
proves that the suggestion was on screen.

For proposals, it counts proposals made and displayed, agreement between the
proposed category and the history-based `suggestedCounterAccountId`, one-click
creates, edits that kept both values, edits that changed the payee or the
category, and rows where a shown proposal was followed by another action. An
Edit is never counted as a button acceptance.

Only successful explicit web actions record decisions; automatic/MCP matches do
not become human labels. Merely receiving an answer is not UI exposure. Outcome
logging errors are reported without undoing a committed ledger action or telling
the user to repeat it. Missing observations remain unknown. Ignore/create actions
are not independently verified `none` labels.

The reconcile POST, the suggestion route, and the transaction-banner unlink
run in Rust. They record their observations through
`rust-api/server/src/typesafe.rs`, which ports `recordTypeSafeDecision` and
`recordTypeSafeUnlink`. A change to either function must also change that
file.

`GET /api/cron/typesafe-cleanup`, protected by `CRON_SECRET`, archives counts and
deletes details older than 30 days in batches of at most 1,000 evaluations.
The server runs the same job hourly at :15 (`rust-api/server/src/scheduler/mod.rs`),
even with TypeSafe disabled. The retention window is therefore 30 days plus
the next cleanup; a large backlog may need more than one batch. A server with
`COUNTERPOISE_SCHEDULER` off must have something else call the endpoint on an
equivalent schedule. Book deletion cascades through experiment
tables. Existing database backups retain their normal independent lifecycle.

For the first 100–200 decisions, compare cases where Jev differs from the
baseline, check a blinded sample, and inspect latency and corrections. Acceptance
is assisted-use evidence, not independent accuracy. Low candidate coverage
suggests improving retrieval; it cannot be fixed by confidence thresholds.

## Rust port

Rust serves every TypeSafe route. The Rust modules, and the TypeScript that
remains beside them:

| Rust | What it holds | TypeScript that remains |
| --- | --- | --- |
| `routes/typesafe_suggestion.rs` | the snapshot, the claim, the lease, the quota, display, and confirmation | none |
| `typesafe_questions.rs` | redaction, payee options, state, and questions | `lib/typesafe/questions.ts` |
| `typesafe_client.rs` | the request and the response checks | `lib/typesafe/client.ts` |
| `typesafe.rs` | decision records, the summary, and the cleanup | `lib/typesafe/report.ts` |
| `routes/typesafe.rs` | the settings and the cleanup route | none |
| `entry_patterns.rs` | the entry patterns, snapshot and question | none |
| `routes/entry_suggestion.rs` | the three entry routes | none |

The TypeScript modules remain only for `npm run typesafe:report`
(`scripts/typesafe-report.ts`), which reads the records. A change to a rule
that the report depends on must change both sides. Both summaries count each
evaluation in the same named steps: request, latency, cost, suggestion,
proposal, then the resolution by the user. `tests/fixtures/typesafe-summary.json`
holds hand-worked event histories with their expected counts; a Rust test and
a Vitest test both read it. Add a case there with a change to a count.
Two rules cover records that the server does not write (owner decision of
2026-10-11):

- A usage with a token count that is missing, null or not a number adds 0
  tokens. The usage is still a sample (`usage_samples`).
- A snapshot without a `baselineIds` list has no baseline. The summary does
  not fail on it: a chosen candidate counts as `differs_from_baseline`, and a
  manual match does not count as `baseline_agrees_with_user`.

The MCP tools do not call TypeSafe. The fingerprint is the SHA-256 of `JSON.stringify(snapshot)`, so the
Rust snapshot keeps the key order that the Node object literal had, and stored
fingerprints stay valid. The state and the questions are built from the
snapshot as the database returns it: the JSON columns are read as text, so
the key order is the stored order.
`TYPESAFE_API_URL` replaces the TypeSafe origin, so the HTTP tests use a local
mock. `tests/http/typesafe-suggestion.test.ts` checks the request body against
a snapshot. It also displays and confirms, through the Rust routes, an
evaluation that the server made, and checks that display recomputes the same
fingerprint.

Redaction cuts at 160 UTF-16 code units. When the cut falls inside a surrogate
pair, the Rust server answers 503. The retired Node handler kept the lone high
surrogate in text that it only sent, and failed with 503 only when it stored
the snapshot. `redactText` in `lib/typesafe/questions.ts` still keeps the lone
surrogate.

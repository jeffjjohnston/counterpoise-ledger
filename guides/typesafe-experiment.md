# TypeSafe reconciliation experiment

TypeSafe suggests an existing transaction for an unresolved Plaid row. When no
existing transaction matches, it proposes a new transaction: a payee and an
income or expense category. It never matches or creates automatically. The
original candidate list and its keyboard shortcuts stay in their original
order. Separate buttons confirm a match or create the proposed transaction
through the existing reconciliation resolver. **Edit…** copies a proposal into
the ordinary Create form.

## Enable or disable

1. Apply the normal Drizzle migrations, including `0022_broken_meggan.sql`.
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
  browser. Plaid sync, cron sync, queue GETs, and MCP do not call TypeSafe.
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
The existing Docker scheduler calls it hourly at :15, even with TypeSafe
disabled. The retention window is therefore 30 days plus the next cleanup; a large backlog
may need more than one batch. Deployments without that scheduler must call the
endpoint on an equivalent schedule. Book deletion cascades through experiment
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
| `routes/typesafe.rs` | the settings and the cleanup route | `lib/typesafe/settings.ts` |

The TypeScript modules remain only for `npm run typesafe:report`
(`scripts/typesafe-report.ts`), which reads the records. A change to a rule
that the report depends on must change both sides. The MCP tools do not call
TypeSafe. The fingerprint is the SHA-256 of `JSON.stringify(snapshot)`, so the
Rust snapshot keeps the key order that the Node object literal had, and stored
fingerprints stay valid. The state and the questions are built from the
snapshot as jsonb returns it, in the key order that PostgreSQL gives.
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

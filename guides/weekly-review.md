# Weekly review

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## What it does

Once a week, for each book that opts in, the server sends the activity of the
week and a summary of its history to Claude. It stores the answer: a summary
of the week in 1 to 3 sentences, and at most 12 items. The dashboard shows
them as a card.

- A **check** item is a probable error to fix: `duplicate`, `missed_payment`,
  `unusual_amount` or `other`.
- An **insight** item is information that needs no fix: `price_change`,
  `new_recurring`, `spending_change` or `other`.

Each item names the transactions or the recurring rule that it is about, and
the card links to them. The review only suggests. It never writes a
transaction, a rule or a payee: the user fixes a problem through the usual
pages and routes.

## Policy

- This is the first AI call that a scheduled job makes. The TypeSafe rule "no
  call from cron" ([typesafe-experiment.md](typesafe-experiment.md)) stays
  true for TypeSafe. The weekly review has its own opt-in, separate from
  TypeSafe.
- Every book starts off. An editor or an owner turns it on in the book
  settings. A server without `ANTHROPIC_API_KEY` cannot turn it on (409), and
  the card is hidden.
- A user can also start a review with "Review now". There is no daily limit in
  this version (a later option). Only one review of a book runs at a time.

## Data sent

One request per review. The user content is one JSON document
(`input::document()` in `rust-api/server/src/weekly_review/input.rs`):

- `period`: the first and the last day (local dates).
- `accounts`: the ID, name, type and parent name of each account.
- `transactions`: each transaction whose effective date is in the period,
  at most 1000 (`truncated` says when the week was cut): ID, effective date,
  payee, description, memo, `isFloating`, `isReconciled`, recurring rule ID,
  its splits (account ID and amount in cents), and for an investment split the
  action, the symbol and the shares.
- `history`: for each of the 13 whole calendar months before the month of the
  period, the total and the count of the income and expense splits per payee
  and per account. The days of the period's month before the period are not
  sent: a part of a month would look low next to whole months.
- `recurringRules`: each active rule with its payee, frequency, interval, next
  date and template amounts.

Memos and real account names are sent: the owner chose that for a better
review. Every name, description and memo passes `redact_text()`
(`typesafe_questions.rs`), the TypeSafe rule: an email address becomes
`[email]`, a run of 7 or more digits becomes `[reference]`, and the text is
cut to 160 UTF-16 units. Plaid IDs, bank descriptions and Plaid account
numbers are not sent.

## The call

`anthropic::ask()` in `rust-api/server/src/weekly_review/anthropic.rs` sends
raw HTTP: Anthropic has no Rust SDK.

- `POST {ANTHROPIC_API_URL}/v1/messages`, with `x-api-key`,
  `anthropic-version: 2023-06-01` and
  `anthropic-beta: server-side-fallback-2026-07-01`.
- Model `claude-opus-5-5`, `max_tokens` 16000, effort `medium`, structured
  output (`output_config.format`, the schema of `output::schema()`), and
  `fallbacks: "default"`: when the model declines, the API runs the same
  request on a fallback model in the same call. The review stores the model
  that answered.
- A 5-minute timeout, one try, no retry. The next week, or "Try again", is the
  retry.
- No request body and no response body go to a log. A log line has the error
  code, the book ID and the review ID. An error status also logs its number.
- `ANTHROPIC_API_KEY` is read on every use. `ANTHROPIC_API_URL` replaces
  `https://api.anthropic.com` for a test mock.

## Life of a review

`rust-api/server/src/weekly_review/mod.rs`:

1. `start()` locks the book row, refuses when the book has not opted in or a
   review runs, and inserts a `running` review for `date(today, '-7 days')`
   to `date(today, '-1 day')`, with today from `ledger_db::clock`. On Monday
   this is Monday to Sunday
   of the previous week.
2. `run()` reads the data in one read transaction, then calls Claude with no
   transaction open.
3. `save()` locks the book row and compares its `weekly_review_revision` with
   the revision at the start. A change (the user turned the feature off, or
   cleared it) makes the review `failed` with `discarded`. Otherwise it checks
   the answer (`output::checked()`) and writes the items:
   - it removes each transaction ID and rule ID that is not in the book;
   - it drops a check item that names no valid ID;
   - it drops an item whose fingerprint (kind, category, sorted IDs) matches
     an item that a user dismissed; an item with no ID cannot be matched;
   - it keeps the first 12.
4. `prune()` keeps the newest 12 reviews of the book. Their items go with them.
   A review that holds a dismissed item stays, so that its fingerprint keeps
   the item out of later reviews.

At startup, `mark_interrupted()` makes each `running` review `failed` with
`interrupted`, so that a restart does not block a book. `start()` does the
same for a `running` review older than 15 minutes: its save was lost (a busy
database, a panic), and it must not block the book until the next restart. The
GET route does not report such a run as `running`, so the card offers "Review
now", whose start marks it `interrupted`. A clear deletes the
reviews of the book; a run in flight then finds no row and writes nothing.

The GET route reads the settings, `latest`, `running` and `lastFailure` in one
read transaction. With separate reads, a save that committed between them took
the review out of `running` before `latest` showed it: the card showed no
review until its next load, and a test that waits for the end of a run saw
`latest: null`.

## Error codes

| Code | Card text (`lib/weekly-review.ts`) |
| --- | --- |
| `not_configured` | The server has no Anthropic API key |
| `network_error` | The server could not reach Anthropic |
| `timeout` | Anthropic did not answer in time |
| `rate_limited` | Anthropic asked the server to wait (429) |
| `invalid_api_key` | Anthropic refused the server's API key (401, 403) |
| `provider_unavailable` | Anthropic is busy or down (5xx, 529) |
| `provider_error` | Anthropic returned an error (another status) |
| `refusal` | The model declined to review this week |
| `invalid_response` | The answer could not be read (also a cut answer, `max_tokens`) |
| `discarded` | The setting changed during the review |
| `interrupted` | The server restarted during the review |
| `database_error` | The server could not read or save the review |

## Schedule

The scheduler job `weekly-review` runs on Monday at 05:00 in `TZ`
(`scheduler/mod.rs`). It reviews each book that opted in, one book per
step, so that one step fits in a Workers alarm; the failure of one book does
not stop the others. A book that already has a scheduled review of this week
(`source = 'schedule'` with this `period_start`) is left out, so a run that
starts again does not ask Claude twice. Without the key it records "not
configured". `GET /api/cron/weekly-review` runs the same job, every book in
one call, and requires `CRON_SECRET`; its answer counts `booksReviewed`
(complete) and `booksFailed` (a failed start or a failed review). The System page marks the
job stale after 8 days.

## Routes and MCP

`rust-api/server/src/routes/weekly_review.rs`:

| Route | Level |
| --- | --- |
| `GET /api/b/{bookId}/settings/weekly-review` | Read |
| `PATCH /api/b/{bookId}/settings/weekly-review` (exactly `{enabled}`) | Write |
| `DELETE /api/b/{bookId}/settings/weekly-review` (off, and delete the reviews) | Write |
| `GET /api/b/{bookId}/weekly-review` | Read |
| `POST /api/b/{bookId}/weekly-review/run` (202) | Write |
| `POST /api/b/{bookId}/weekly-review/items/{id}/dismiss` | Write |
| `POST /api/b/{bookId}/weekly-review/items/{id}/restore` | Write |
| `GET /api/cron/weekly-review` | `CRON_SECRET` |

The MCP tool `get_weekly_review` reads the GET route. The other routes have
waivers in `tests/mcp/route-coverage.ts`: a run is a paid AI call that an AI
client must not start, and a dismissal is the user's judgment in the card.

## Client

- `components/settings/WeeklyReviewSettings.tsx`: the opt-in in the book
  settings modal, for editors and owners.
- `components/dashboard/WeeklyReviewCard.tsx`: the card, above the net worth
  chart. It loads on mount and on window focus, and asks every 5 seconds while
  a review runs. Each item of the GET route has `transactions: [{id,
  accountId}]`, the register account of each transaction (its first asset or
  liability account). The link adds `accountId`, because the register without
  it opens the favorite account and loses `highlight`. A viewer can hide it (local storage). The invitation to turn
  it on opens the book settings with the window event
  `counterpoise:open-book-settings`.
- After a save, the settings section sends the window event
  `counterpoise:weekly-review-settings`, and the card loads again. The card
  ignores an answer for a book that it no longer shows, and Undo belongs to
  the review that held the item. A read that started before a dismissal or a
restore is dropped, so it cannot bring back the old list.

## Tests

No test calls the real API.

- Rust unit tests in `weekly_review/{output,input,anthropic}.rs` and the
  `due` test in `scheduler/mod.rs`.
- `tests/http/weekly-review.test.ts` starts an Anthropic mock and points
  `ANTHROPIC_API_URL` at it. It covers a run, the request body, failures,
  409s, the revision check, a clear during a run, a restart, dismissals,
  retention, access levels and the cron route.
- `tests/db/weekly-review-schema.test.ts`, the component tests, and
  `tests/mcp/mcp-weekly-review-tools.test.ts`.

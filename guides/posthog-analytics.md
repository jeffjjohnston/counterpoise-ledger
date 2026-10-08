# PostHog Analytics

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Counterpoise includes PostHog integration for usage analytics. Custom events
carry no financial values — they track actions (e.g. "transaction created")
with metadata like `bookId` and `splitCount`.

**`$pageview` carries a URL, so its query string is redacted.**
`app/posthog-pageview.tsx` builds `$current_url` through
`redactedCaptureUrl()` in `lib/posthog-url.ts`, which replaces every query
string value with `[redacted]` and keeps only the parameter names. A search for
a payee or an amount reaches PostHog as `/b/1/search?q=[redacted]`, so the fact
of the search and the filters in play stay measurable and the text does not
leave the instance.

Redaction is unconditional, not a list of known-sensitive parameters. A
parameter added to a page later is private by default, instead of leaking until
someone remembers to extend a list. Do not build a capture URL by hand —
go through the helper, and `tests/lib/posthog-url.test.ts` keeps it honest.

This was not always true: before v1.39.6 the full query string was sent, so an
instance that had analytics enabled before then may hold real search text in
its captured URLs.

**Autocapture is off.** posthog-js turns it on by default, and the
`defaults: "2025-11-30"` preset does not change that. Autocapture sends the
text of each clicked element as `$el_text`, so a click on a payee link, an
account row or a position row would send the name and the balance, and the
redaction above would have a second channel around it. `app/posthog-provider.tsx`
passes `autocapture: false`, and `tests/app/posthog-provider.test.tsx` keeps
it so. The one-time API key panel in `components/account/ApiKeyManager.tsx`
carries `ph-no-capture` as well: posthog-js leaves such an element out of
dead-click and copy capture, and masks it in session replay, so the key does
not reach PostHog even if an operator turns those on in the project. Until
this change, an instance with analytics enabled may hold payee and account
names in its `$autocapture` events.

## Environment Variables

| Variable | Context | Purpose |
| -------- | ------- | ------- |
| `NEXT_PUBLIC_POSTHOG_KEY` | Build-time (browser), runtime (Rust server) | Public project API key. Inlined into the JS bundle, and read by the Rust server for server-side capture |
| `NEXT_PUBLIC_POSTHOG_HOST` | Build-time (browser), runtime (Rust server) | PostHog instance URL |
| `POSTHOG_PERSONAL_API_KEY` | Runtime (Rust server) | Personal API key for querying PostHog REST API |

The names keep their `NEXT_PUBLIC_` prefix. `vite.config.ts` reads them from the same `.env` files and inlines them into the bundle at build time. In Docker, they are passed as **build args** of the `rust-api` service in `docker-compose.yml` → the root `Dockerfile`, whose `client` stage runs `npm run build`. A change needs a new image. The Rust server reads the same variables and the personal API key at runtime, from `env_file`.

## Client-Side Tracking

- **`/app/posthog-provider.tsx`** — Wraps app with `PostHogProvider`, initializes SDK, auto-identifies returning users via `/api/auth/me`
- **`/app/posthog-pageview.tsx`** — Captures `$pageview` on SPA route changes (pathname + redacted search params)
- **`/lib/posthog-url.ts`** — `redactedCaptureUrl()`: strips every query string value before capture
- **`/lib/posthog-client.ts`** — Helpers: `identifyUser(userId)` (called on login), `resetUser()` (called on logout)

## Server-Side Event Capture

- **`/rust-api/server/src/analytics.rs`** — `PostHogCapture::capture_event(user_id, event, properties)` sends one event to the PostHog batch endpoint, with the user ID as `distinct_id`. Capture is a no-op without the project key, and it does not delay or fail the accounting response. A route that runs for an MCP tool records nothing (`mcp::in_tool_call()`).

Instrumented server events:
| Event | Route | Properties |
|-------|-------|-----------|
| `transaction_created` | POST `/api/b/[bookId]/transactions` | `bookId`, `hasInvestmentSplits`, `splitCount` |
| `transaction_updated` | PUT `/api/b/[bookId]/transactions/[id]` | `bookId`, `fieldsChanged`, `splitsAccountsChanged` |
| `transaction_deleted` | DELETE `/api/b/[bookId]/transactions/[id]` | `bookId` |
| `account_created` | POST `/api/b/[bookId]/accounts` | `bookId`, `type`, `subtype` |
| `recurring_rule_created` | POST `/api/b/[bookId]/recurring` | `bookId` |
| `report_generated` | GET `/api/b/[bookId]/reports/*` | `bookId`, `reportType` |
| `sync_transaction_matched` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_created` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_ignored` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_kept_local` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_unlinked` | POST `/api/b/[bookId]/transactions/[id]/plaid/unlink` | `bookId` |
| `sync_transaction_amount_updated` | POST `/api/b/[bookId]/sync/accounts/[id]/reconcile` | `bookId` |
| `sync_transaction_auto_matched` | `auto_match()` in `/rust-api/server/src/routes/plaid_sync.rs` (one per match, attributed to the book owner) | `bookId` |

## PostHog Query API Client

- **`/lib/posthog-query.ts`** — used by `scripts/posthog-export.ts`. `runHogQLQuery(query)` runs HogQL via `POST /api/projects/@current/query/` (the `@current` alias is required for project-scoped personal API keys). Also `escapeHogQLString()` and `parsePropertiesColumn()` (HogQL returns `properties` as a JSON string). The legacy `/api/event/` endpoint is deprecated and silently returns only ~1 day of events — never use it for historical analysis.

## CLI Event Export

```bash
npx tsx scripts/posthog-export.ts [--days N] [--output FILE]
```
- Batch exports events via the PostHog Query API (HogQL, paginated) for analysis
- `--days N` — Lookback period (default: 7)
- `--output FILE` — Write JSON to file (omit for stdout)
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

## MCP Tool: `analyze_usage`

Defined in `rust-api/server/src/mcp/tools/usage.rs`, with the query code in `rust-api/server/src/posthog_query.rs`. Queries PostHog for event summaries.
- **Input**: `days` (1–90, default 7), optional `eventType` filter
- **Output**: `totalEvents`, `eventCounts` (sorted by frequency), `recentEvents` (last 20)
- **Scope**: the events of the calling user only (`distinct_id = String(userId)`). A book viewer, such as an advisor, must not see the events of other users. `recentEvents` returns raw properties, which include page paths. For instance-wide data, use the PostHog UI or `scripts/posthog-export.ts`
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

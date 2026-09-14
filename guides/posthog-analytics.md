# PostHog Analytics

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Counterpoise includes PostHog integration for usage analytics. Custom events
carry no financial values — they track actions (e.g. "transaction created")
with metadata like `bookId` and `splitCount`.

**`$pageview` is the exception, and it is not a small one.**
`app/posthog-pageview.tsx` sends the full URL including its query string, and
the search page puts the user's search text in `?q=`. A search for a payee or
an amount therefore reaches PostHog in `$current_url`. Anyone enabling
analytics on an instance holding real data should weigh that.

## Environment Variables

| Variable | Context | Purpose |
| -------- | ------- | ------- |
| `NEXT_PUBLIC_POSTHOG_KEY` | Build-time | Public project API key (inlined into JS bundle) |
| `NEXT_PUBLIC_POSTHOG_HOST` | Build-time | PostHog instance URL |
| `POSTHOG_PERSONAL_API_KEY` | Runtime (server) | Personal API key for querying PostHog REST API |

In Docker, the `NEXT_PUBLIC_*` vars are passed as **build args** in `docker-compose.yml` → `Dockerfile` so Next.js can inline them. The personal API key is a runtime env var via `env_file`.

## Client-Side Tracking

- **`/app/posthog-provider.tsx`** — Wraps app with `PostHogProvider`, initializes SDK, auto-identifies returning users via `/api/auth/me`
- **`/app/posthog-pageview.tsx`** — Captures `$pageview` on SPA route changes (pathname + search params)
- **`/lib/posthog-client.ts`** — Helpers: `identifyUser(userId)` (called on login), `resetUser()` (called on logout)

## Server-Side Event Capture

- **`/lib/posthog-server.ts`** — Singleton `posthog-node` client with `captureEvent(userId, event, properties?)`. Returns null/no-op if PostHog is not configured.

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
| `sync_transaction_auto_matched` | `autoMatchPendingTransactions()` in `/lib/plaid-auto-match.ts` (one per match, attributed to the book owner) | `bookId` |

## PostHog Query API Client

- **`/lib/posthog-query.ts`** — `runHogQLQuery(query)` runs HogQL via `POST /api/projects/@current/query/` (the `@current` alias is required for project-scoped personal API keys). Also `escapeHogQLString()` and `parsePropertiesColumn()` (HogQL returns `properties` as a JSON string). The legacy `/api/event/` endpoint is deprecated and silently returns only ~1 day of events — never use it for historical analysis.

## CLI Event Export

```bash
npx tsx scripts/posthog-export.ts [--days N] [--output FILE]
```
- Batch exports events via the PostHog Query API (HogQL, paginated) for analysis
- `--days N` — Lookback period (default: 7)
- `--output FILE` — Write JSON to file (omit for stdout)
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

## MCP Tool: `analyze_usage`

Defined in `/mcp/tools/usage.ts`. Queries PostHog for event summaries.
- **Input**: `days` (1–90, default 7), optional `eventType` filter
- **Output**: `totalEvents`, `eventCounts` (sorted by frequency), `recentEvents` (last 20)
- Requires `POSTHOG_PERSONAL_API_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`

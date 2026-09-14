# MCP Server

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Counterpoise includes a Model Context Protocol (MCP) server that gives AI assistants read and write access to accounting data. The server uses stdio transport and runs via `npm run mcp:dev`.

## Authentication

All MCP tools require a valid `COUNTERPOISE_API_KEY` environment variable. The key is verified at startup via `initMcpAuth()` in `/mcp/auth.ts`, cached in memory, and periodically revalidated so revoked keys stop working without a process restart.

**How it works:**
1. User creates an API key in the UI at `/account` (ApiKeyManager component)
2. Key is `cpk_` + 48 hex chars; only the scrypt hash is stored in the `apiKeys` table
3. User provides the key to their MCP client via environment variable
4. On startup, `initMcpAuth()` looks up candidates by `keyPrefix` (first 8 chars), then verifies with scrypt
5. Each tool call checks auth via `requireAuth()` or `requireBookAuth(bookId)`, and `requireAuth()` periodically re-checks that the key still exists

**Auth helpers** in `/mcp/auth.ts`:
- `requireAuth()` — returns `McpAuth` (userId, keyId) or an MCP error response
- `requireBookAuth(bookId)` — chains auth + book ownership check (book must belong to the user)
- Both return `{ isError: true, content: [...] }` on failure, checked via `"isError" in result`

## MCP Client Configuration

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "npm",
      "args": ["run", "mcp:dev"],
      "cwd": "/path/to/counterpoise",
      "env": {
        "COUNTERPOISE_API_KEY": "cpk_..."
      }
    }
  }
}
```

## Docker MCP Client Configuration

When running Counterpoise via Docker Compose, configure MCP clients to use `docker exec` with the API key passed via `-e`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "COUNTERPOISE_API_KEY=cpk_...", "counterpoise-app-1", "node", "/app/mcp-server.mjs"]
    }
  }
}
```

**Prerequisites:**
- Generate an API key at `/account` in the web UI
- The `app` container must be running
  (`docker compose --env-file .env.production.local up -d` — the service-level
  `env_file` does not feed the compose file's own `${VAR}` interpolation)
- `/app/mcp-server.mjs` is bundled at image build time by `scripts/bundle-node-entrypoints.mjs` (Dockerfile builder stage)
- Each user provides their own API key in the MCP client config — no container rebuild needed

## Environment Variables

| Variable | Purpose |
| -------- | ------- |
| `COUNTERPOISE_API_KEY` | User API key for MCP authentication (required) |
| `DATABASE_URL` | PostgreSQL connection string (defaults to local dev DB) |

## Available Tools

**Books:**
- `list_books` — List books the authenticated user owns
- `create_book` — Create a new accounting book
- `update_book` — Rename a book, and optionally change its recurring-transaction projection window. `name` is always required; resend the current name to leave it unchanged
- `create_demo_book` — Create a new book pre-filled with realistic sample data (about three years of transactions)
- `delete_book` — Permanently delete a book and all of its data; requires `confirmBookName` to match the book's exact name

**Accounts** (require `bookId`):
- `list_accounts` — List accounts with balances, filterable by type and as-of date
- `get_account_tree` — Hierarchical account tree grouped by type
- `create_account` — Create an account in the chart of accounts
- `update_account` — Update an account's fields
- `delete_account` — Delete an account; refuses if it still has transactions or sub-accounts

**Transactions** (require `bookId`):
- `list_transactions` — List transactions with splits, payees, and investment data; filter by one account (`accountId`) or several (`accountIds`), by payee, and by date, with pagination. An out-of-book `payeeId` is an error, not an empty list
- `search` — Search accounts, payees, and transactions by text or amount
- `create_transaction` — Create a double-entry transaction with splits (must sum to zero)
- `update_transaction` — Update an existing transaction's fields or replace splits
- `delete_transaction` — Delete a transaction and all of its splits

**Payees** (require `bookId`):
- `list_payees` — List payees with transaction count and most recent transaction date; optional `search` (case-insensitive substring) and `limit`
- `get_payee` — Get one payee, with its transaction count and last-used account
- `create_payee` — Create a payee; refuses an exact-name repeat in the same book
- `delete_payee` — Delete a payee; refuses if it still has transactions

**Recurring** (require `bookId`):
- `list_recurring_rules` — List recurring transaction rules with their payees and template splits
- `create_recurring_rule` — Create a recurring transaction rule; template splits must sum to zero
- `update_recurring_rule` — Update a rule; passing `templateSplits` replaces every existing split
- `delete_recurring_rule` — Delete a rule and its template splits; transactions it already created are kept
- `get_projected_transactions` — Project the transactions active rules will create over a date range, without creating anything
- `list_recurring_transactions` — List transactions a recurring rule actually created in a date range
- `process_recurring_rules` — Create the transactions rules are due for. With `processAll`, a rule that is not due is skipped, so a repeat call creates nothing more. With `ruleId`, that one rule is forced: its next occurrence is created whether or not it is due, so two identical calls create two transactions

**Reports** (require `bookId`):
- `get_income_statement` — Income/expense totals for a date range
- `get_report_data` — Raw split data for custom analysis
- `get_account_balance_history` — Running balance over time for an account
- `get_realized_gains` — Realized capital gains/losses per lot disposed of, with short/long-term totals

**Investments** (require `bookId`):
- `get_investment_positions` — Current positions with shares, cost basis, market value, gain/loss
- `list_securities` — List every security in a book with shares, cost basis, latest price, market value, and income received
- `get_security_detail` — Security info, price history, transactions, and position. `includeLots` adds the open FIFO lots; dividend and capital-gain rows carry the cash received
- `create_security` — Create a new security (ETF, mutual fund, or stock); fails if the symbol already exists in the book
- `update_security` — Update a security's name, symbol, type, fetch setting, or fixed price; setting a fixed price forces fetching off
- `delete_security` — Delete a security; refuses when it still has investment transactions

**Security prices** (require `bookId`):
- `set_security_prices` — Record manual prices; malformed entries are skipped and reported in `discarded`
- `update_security_price` — Change a recorded price, or move it to another date
- `delete_security_price` — Delete one recorded price
- `list_prices_due` — Securities needing a manual price for the most recent market day
- `fetch_tiingo_prices` — Fetch the latest end-of-day prices from Tiingo; records nothing

**Issue Reports:**
- `create_issue_report` — File a bug or improvement report about Counterpoise itself
- `list_issue_reports` — List the authenticated user's own issue reports
- `update_issue_report` — Change the description, type, or status of an issue report
- `delete_issue_report` — Delete an issue report

**System:**
- `get_system_status` — Report the health of Counterpoise's background jobs (backup, backup pruning, recurring processing, bank sync, security price sync, search reindex)

**Analytics:**
- `analyze_usage` — Query PostHog for event summaries (requires PostHog env vars)

**Plaid sync** (require `bookId`):
- `get_plaid_status` — Every bank connection (access token masked), the count of transactions waiting to be reconciled, which accounts hold unmatched manually-entered transactions, and every Plaid account mapped to a Counterpoise account. Folds four separate UI polls into one call
- `list_plaid_token_accounts` — List a connection's bank accounts and each one's Counterpoise mapping. Local only: the HTTP route takes a `refresh` option and this tool deliberately does not expose it, so the tool stays a plain read
- `update_plaid_token` — Full replace of a connection's institution name and item id. This tool cannot set the access token: a Plaid access token is re-obtainable only through the Link browser flow, so a hallucinated value would destroy the connection with no way to recover it
- `delete_plaid_token` — Delete a connection, its account mappings, and its entire reconciliation history — the staged unreconciled transactions **and** every already-resolved row (matched, created, ignored)
- `set_plaid_token_accounts` — Map a connection's bank accounts to Counterpoise accounts. Pass `counterpoiseAccountId: null` to unmap one
- `sync_plaid_token` — Fetch new, changed, and removed transactions from Plaid for one connection, stage them, and run auto-match. Reaches Plaid and changes data; a demo connection cannot sync and says so
- `clear_plaid_sync_data` — Discard a connection's staged transactions and reset its sync cursor, so the next sync starts over. Touches only this database; never calls Plaid
- `list_pending_plaid_transactions` — Staged bank transactions nothing has reconciled yet. Their ids are synthetic placeholders — never pass them to `create_transaction`, `update_transaction`, `delete_transaction`, or any other transaction tool
- `get_transaction_plaid_link` — The staged Plaid row a transaction is matched to, or `null` if the transaction was entered by hand
- `unlink_plaid_transaction` — Remove a transaction's Plaid link. The bank transaction returns to the pending queue; the local transaction stops being reconciled
- `get_reconcile_candidates` — The reconciliation queue for one linked bank account: staged transactions awaiting a decision, each with up to five ranked candidate matches and a suggested counter account
- `reconcile_plaid_transaction` — Resolve one staged bank transaction: match it to an existing transaction, match and rewrite that transaction's amount, create a new transaction from it, ignore it, keep what you already have, or unlink an already-resolved row (which also un-reconciles its transaction unless another bank row still matches it). Linking a row that is already linked is refused

## Sharing a Zod Schema With a Tool

A tool's `inputSchema` spreads a shared zod schema's `.shape`. Every spread goes through `toolShape()` in `/mcp/tools/_tool-shape.ts`; none reads `.shape` directly. Spreading keeps each field-level rule and silently drops what is attached to the object itself — `.refine()` and `.superRefine()`. The tool then accepts input the HTTP route rejects, and the difference shows up as a database error or a malformed write rather than a validation message. `toolShape()` throws at registration time when it is handed such a schema, so `registerAllTools()` fails and every suite that builds a server catches it. Pass `objectRefineHandledBy: "<file>:<function>"` to record where the same rule is enforced instead; `update_issue_report` and `reconcile_plaid_transaction` are the two tools that need it today.

Two further rules matter before you add a tool or edit that helper:

- **Never derive a schema inline before you hand it over.** `toolShape()` must inspect the original schema. Earlier Zod versions silently dropped object-level checks during derivation; Zod 4.5 now rejects `.omit()`, `.pick()` and `.partial()` on refined objects and preserves checks through `.extend()`. Spreading `.shape` still drops object-level rules, so the registration guard remains necessary. Use the `omit` option: it checks the base schema first, then filters the returned shape. `update_plaid_token` uses it to keep `accessToken` out of the published shape. `tests/mcp/tool-shape.test.ts` verifies the current Zod behavior and keeps inline derivations out of tool call sites.

- **The return type is an overload pair, not `Partial<T["shape"]>`.** Collapsing the overloads into one `Partial` signature is the obvious simplification, and it type-checks inside the helper. It then widens every spread field to optional at every call site of `toolShape(` under `mcp/tools/`. The MCP SDK infers each handler's argument type straight from `inputSchema`, so the loosened shape reaches the handler and breaks its calls into the shared library. `tsc` does report it, but at the call sites rather than at the helper — one edit to one file, and every error lands somewhere else.

## Tool Annotations

Every `registerTool` call passes one preset from `/mcp/tools/_annotations.ts`: `READ`, `READ_NETWORK`, `CREATE`, `UPDATE`, `DESTRUCTIVE`, `WRITE_NETWORK`. A client can tell a query from a write without reading the description.

`WRITE_NETWORK` is for a tool that both changes data and leaves the process to do it. `sync_plaid_token` is currently its only user — distinct from `READ_NETWORK`, which is for a tool that reaches out but changes nothing (`fetch_tiingo_prices`, `analyze_usage`). The presets are enumerated by hand in `tests/mcp/annotations.test.ts`, and that file asserts the two lists agree: a preset exported from `_annotations.ts` but missing from the test's `checked` set fails the coverage assertion rather than slipping through it.

## Shared Transaction Logic

`/lib/transactions.ts` contains `createTransaction()`, `updateTransaction()`, and `deleteTransaction()` shared by both API routes and MCP tools. Error classes:
- `TransactionValidationError` — invalid input (splits don't balance, missing fields)
- `TransactionNotFoundError` — transaction ID doesn't exist in the book

## API Key Management

- **Routes**: `/app/api/auth/api-keys/route.ts` (GET, POST), `/app/api/auth/api-keys/[id]/route.ts` (DELETE)
- **UI**: `/components/account/ApiKeyManager.tsx` on the `/account` page
- **Library**: `/lib/api-keys.ts` — `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, `getKeyPrefix()`

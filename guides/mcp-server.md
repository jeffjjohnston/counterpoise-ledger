# MCP Server

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Counterpoise includes a Model Context Protocol (MCP) server that gives AI
assistants read and write access to accounting data. The Rust server serves
all 63 tools, over two transports: stdio (`counterpoise-rust-api mcp`) and
Streamable HTTP at `/api/mcp`. The browser gets a subset through WebMCP; see
[WebMCP (Rust)](#webmcp-rust). The code is in `rust-api/server/src/mcp/`.

## Authentication

Every tool requires a valid API key. Over stdio the key is
`COUNTERPOISE_API_KEY`; over HTTP it is the `Authorization: Bearer` header.

1. A user creates an API key in the UI at `/account` (ApiKeyManager component).
2. The key is `cpk_` + 48 hex chars; only the scrypt hash is stored in the
   `apiKeys` table.
3. The user gives the key to their MCP client.
4. Each tool call checks the key again (`Caller::user()` in `mcp/call.rs`,
   through `principal()` in `auth.rs`), so a revoked key stops working at the
   next call, without a restart. A tool then sends its route requests with the
   same key, so each route checks it too.

## Access Levels

Every book-scoped tool declares an access level: `read`, `write`, or `owner`.
`read` accepts every role (owner, editor, viewer). `write` accepts owner and
editor. `owner` accepts owner only. A handler gives the level in its own body:
`caller.book(book_id, Level::Read)`.

**The annotation-to-level rule:** a tool whose annotations set `readOnlyHint`
uses `Level::Read`. An owner-only tool uses `Level::Owner`. Every other tool
uses `Level::Write`. A tool that must break this pairing is named in
`LEVEL_EXCEPTIONS` in `tests/lib/book-access-levels.test.ts`, with the level
it actually needs — today the only entry is `remove_book_member`, gated at
`read` because any member may remove their own row, and the route checks for
the owner when the member removes someone else. That static test reads the
dispatch in `rust-api/server/src/mcp/tools/mod.rs` and each handler, and fails
when a handler's level does not match what the manifest's annotations imply
(or its `LEVEL_EXCEPTIONS` entry, or its listing in `NO_BOOK_GATE` for a tool
that works above a single book — books, issue reports, usage, system status).
It checks the matching HTTP routes the same way; see
[guides/api-route-patterns.md](api-route-patterns.md).

Owner-only tools: `add_book_member`, `update_book_member`,
`update_plaid_token`, `delete_plaid_token`, `set_plaid_token_accounts`.

Not a member: "You do not have access to this book". A member below the level:
the same message `authenticateBookRequest` gives on the HTTP side — "You have
read-only access to this book" (`write`) or "Only an owner can do this"
(`owner`). `tests/mcp/mcp-book-access.test.ts` covers each role.

## MCP Client Configuration

A local checkout, over stdio. `npm run mcp:dev` runs the same command, and
`mcp-dev-server.sh` runs it with the variables in `.env.local`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "cargo",
      "args": ["run", "--quiet", "--manifest-path", "rust-api/Cargo.toml", "-p", "counterpoise-rust-api", "--", "mcp"],
      "cwd": "/path/to/counterpoise",
      "env": {
        "COUNTERPOISE_API_KEY": "cpk_..."
      }
    }
  }
}
```

The process uses the file that `DATABASE_PATH` names (default
`data/counterpoise.db`, relative to `cwd`). It does not create the file:
start the server once first.

## Docker MCP Client Configuration

When Counterpoise runs with Docker Compose, the `rust-api` container holds
the server binary. Configure the MCP client to use `docker exec`, with the API
key passed by `-e`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "COUNTERPOISE_API_KEY=cpk_...", "counterpoise-rust-api-1", "counterpoise-rust-api", "mcp"]
    }
  }
}
```

**Prerequisites:**
- Generate an API key at `/account` in the web UI
- The `rust-api` container must be running
  (`docker compose --env-file .env.production.local up -d` — the service-level
  `env_file` does not feed the compose file's own `${VAR}` interpolation). The
  container already has `DATABASE_PATH` and `TZ`.
- The MCP process opens the same database file as the server, beside it. It
  does not take the server lock. Its writes also send live-update hints,
  because the `change_marks` triggers run for every writer.
- Each user provides their own API key in the MCP client config — no container rebuild needed

Or connect over HTTP, with no container access:

```bash
claude mcp add --transport http counterpoise https://<host>/api/mcp \
  --header "Authorization: Bearer cpk_..."
```

## Environment Variables

| Variable | Purpose |
| -------- | ------- |
| `COUNTERPOISE_API_KEY` | User API key, for the stdio transport |
| `DATABASE_PATH` | The SQLite database file. Default `data/counterpoise.db`; the image sets `/data/counterpoise.db` |
| `TZ` | The app time zone for calendar dates; the system zone when unset |

## Transports and Internals

`IMPLEMENTED` in `rust-api/server/src/mcp/tools/mod.rs` lists the tools, and a
unit test fails when it differs from the manifest.

- **HTTP auth:** only `Authorization: Bearer cpk_...`. The endpoint removes the
  session cookie before it reads the request, so a browser session cannot
  drive it. A missing, unknown or revoked key gets 401 with
  `WWW-Authenticate: Bearer`. No OAuth, so claude.ai and Claude Desktop custom
  connectors cannot use it.
- **Origin:** a request whose `Origin` names another host gets 403. That stops
  a web page on another site from calling it. A request without `Origin`
  passes, as in the cross-origin write check of `security.rs`. The host is
  `X-Forwarded-Host` when a trusted reverse proxy sets it (see `TRUST_PROXY`),
  and `Host` when not. The key is a
  bearer header, never a cookie, so this check is a second line of defense.
- **HTTP is stateless:** no session IDs. Each request gets a new handler, and
  the tools send no notifications.
- **Tool definitions:** `rust-api/server/mcp-tools.json` holds the name, title,
  description, annotations and input schema of every tool, and it is the
  source: edit it to change what a client sees. The TypeScript server wrote it
  from its zod schemas before that server was removed, so the schemas still
  have zod's shape and zod's messages. `tests/mcp/manifest.test.ts` checks that `tools/list`
  gives the file unchanged, and `tests/mcp/annotations.test.ts` checks each
  tool's annotation preset and that every input field has a description. The
  server validates the arguments against the schema before a handler runs,
  with the `MCP error -32602: Input validation error: ...` prefix of the MCP
  SDK.
- **Handlers:** a tool checks the key and the book role itself, then sends its
  requests through the Rust router in the same process, with the caller's
  bearer header (or, for WebMCP, the session cookie). The routes validate and
  write. A tool reshapes the route's JSON where the tool's contract gives a
  different shape, and it keeps each deliberate difference from the route
  (for example `delete_book` requires `confirmBookName`). When the difference
  is in the write itself, the tool calls a Rust function that the route shares,
  not the route: `create_payee` calls `create_exact()` in
  `routes/payees.rs`, because the route returns a case variant that already
  exists, and the tool creates a new payee. A read tool whose rows the route
  cannot give does the same: `GET /accounts` gives a tree that drops an
  account whose parent the filter leaves out, so `list_accounts` and
  `get_account_tree` call `accounts_with_balances()` in `routes/accounts.rs`.
  The same holds for `set_security_prices` (`set_prices()`, because the bulk
  route does not report the items it skipped), `get_realized_gains`
  (`realized_gains::report()`, because the route requires both dates), and
  `fetch_tiingo_prices` (the Tiingo client, because the route needs write
  access and the tool needs read). The report and search tools read
  `report_splits()`, `income_rows()` and `search_book()`: the routes check
  their dates more strictly and leave out fields that the tools report.
  `list_transactions` uses the register route with `includeMeta=true` and
  keeps the fields it reports. `get_account_balance_history` has no route.
- **Messages:** where the library names an ID or a date in an error and the
  route does not ("Security 5 not found", "Price entry for 2026-01-02 not
  found"), the tool reads the route's status with `Caller::send()` or
  `request_found()` and writes the library's message.
- **Numbers:** a tool that divides micros or cents into dollars writes each
  double with `js_double()`, so the text is what `JSON.stringify` writes
  (`150`, not `150.0`). A percentage uses `to_fixed_2_js()` from `ledger-core`,
  which rounds an exact tie as `toFixed(2)` does.
- **Analytics:** a tool records no PostHog event from the routes it calls:
  before the tools moved to Rust they called the library, not the route, and
  the contract stayed. `Caller` runs each route request inside the
  `TOOL_CALL` task-local, and `capture_event` records nothing while it is set.
  A header cannot set it. Any new analytics sink must check
  `mcp::in_tool_call()` too.
- **Schema refinements:** the manifest's JSON Schema cannot hold a zod
  transform or refine, and the tools keep the zod rules they had. A zod `.trim()` before `.min(1)` refuses a name of only
  whitespace, and `accountIconSchema` refuses an icon of more than one
  character, but the JSON Schema accepts both. The Rust handler must then
  refuse them with `invalid_arguments()`, so that the error is the same input
  error. A zod preprocess goes the other way: `createRuleSchema` turns an
  `endDate` of `""` into null, and the JSON Schema refuses `""`. `prepare()`
  in `tools/mod.rs` changes such an argument before the schema check. It does
  the same for a zod coercion: `list_pending_plaid_transactions` takes
  `accountId: "42"` as 42, as `z.coerce.number()` does.
- **Zod messages:** the JSON Schema check words a failure in its own text. A
  zod field with one custom `error` for any failure gives that text instead,
  so `ZOD_MESSAGES` in `mcp/mod.rs` maps `(tool, path)` to the zod message
  (for example `/fixedPriceMicros`, `/assignments/*/counterpoiseAccountId`).
  A missing required property counts as a failure of that property. Where
  zod checks items in order and then refines the array (repeats), the
  precheck does the same, so the first message is zod's first message. Where
  zod also refuses a value that the JSON Schema accepts, `precheck()` in
  `tools/mod.rs` refuses it first:
  `expectedUpdatedAt` is `z.iso.datetime()`, which refuses an offset such as
  `+02:00`.
  Do this check before `caller.book`: arguments are validated before the
  handler runs, so a caller without access gets the input error, not an
  access error. A change to one of these rules is a change to a tool's
  contract: change the manifest's schema, the Rust check, and the tests
  together.
- **Access levels:** a handler calls `caller.book(bookId, Level::...)` in its
  own body, not in a helper. `tests/lib/book-access-levels.test.ts` reads the
  dispatch in `tools/mod.rs` and each handler, and applies the rule above with
  the tool's annotations in the manifest.
- **Routing:** the Rust router registers `/api/mcp` and WebMCP by name, not
  from `rust-api/routes.json`. In development, Vite forwards them to Rust, as
  it forwards every `/api` request.
- **Unknown arguments:** as zod does, the dispatcher drops a key that the
  schema does not list before the handler runs, because a route may act on a
  key that the tool leaves out on
  purpose (`accessToken` of `update_plaid_token`, `refresh` of
  `list_plaid_token_accounts`, `typesafe` of `reconcile_plaid_transaction`).
- **TypeSafe:** a tool records no TypeSafe decision. Like
  `capture_event`, `record_decision` and `record_unlink` record nothing while
  `in_tool_call()` is true. `sync_plaid_token` calls `sync_token()` outside a
  route, so the auto-match events reach PostHog, as the library sends them.
- **Tests:** a tool suite connects through `connectMcpTestClient()` in
  `tests/helpers/mcp-client.ts`, which starts the Rust server. `npm run
  test:mcp:http` runs the suites in `tests/mcp` over HTTP, and `npm run
  test:mcp:stdio` runs them over stdio; CI runs both. They need the server
  binary (`cargo build -p counterpoise-rust-api`), so a plain `npm test` leaves
  them out, as it leaves out `tests/http`. A new suite named
  `tests/mcp/mcp-*.test.ts` joins them. The Rust server
  starts once for a suite, so a variable it reads (`STATUS_DIR`, the PostHog
  settings) goes in the `env` option of `connectMcpTestClient()`, not in a
  later change to `process.env`. A suite that calls as another user uses
  `callAs()`, or `callToolAs()` for a plain-text error result. A suite that
  replaces an outside service uses a local HTTP fake, not `vi.mock`, because a
  mock does not reach the Rust process: `mcp-usage-tools.test.ts` fakes the
  PostHog Query API. `tests/mcp/rust-transport.test.ts` covers the HTTP gate.
- **Stdio:** `counterpoise-rust-api mcp` serves the same registry over stdio.
  It reads `DATABASE_PATH`, `TZ` and `COUNTERPOISE_API_KEY`, and sends the key
  as the bearer header of each tool's route requests. A missing or unknown key
  does not stop the server; each tool answers with the auth error. Each call
  checks the key again, so a revoked key stops working without a restart.
  Stdout carries only the protocol, and the logs go to stderr (`rmcp` at
  warn). `npm run test:mcp:stdio` runs the tool suites over it, with one
  server process for each user; `tests/mcp/rust-stdio.test.ts` covers the key
  and the clean stdout.
- **`analyze_usage`** has no route. `rust-api/server/src/posthog_query.rs` is
  the Rust copy of `lib/posthog-query.ts`.

## WebMCP (Rust)

`components/WebMcpTools.tsx` gives an agent in the browser the tools of the
open book. The Rust server serves its endpoint from the same registry as
`/api/mcp` (`rust-api/server/src/mcp/webmcp.rs`):

- `GET /api/b/{bookId}/webmcp` lists the tools. `POST` with
  `{ name, arguments }` calls one and answers with the tool's JSON, or with
  `{ error }` and status 400 when the tool fails. A thrown error, such as an
  argument that fails the input schema, gives its text as the message.
- **Auth:** any credential a book route takes, usually the session cookie. The
  endpoint checks `read` access to the book. The tool then sends its route
  requests with the same cookie or key, so each route checks its own level: a
  viewer can list accounts, and gets "You have read-only access to this book"
  from `create_account`. The cross-origin write check is in the security
  layers of the Rust server (`security.rs`).
- **Book:** the route puts the URL's book in `bookId`, over any value the
  caller sends, and the list leaves `bookId` out of each schema.
- **Withheld tools:** `WEB_EXCLUDED_TOOLS` names the tools that are not listed
  and cannot be called: book and member management, issue reports, usage,
  system status, and Plaid connection administration. The page is pinned to
  one book, and the browser refuses a registry larger than 65,536 bytes.
  `tests/http/webmcp.test.ts` holds the list under 58,000 bytes.
- The list is in name order, the order of the manifest.


**Books:**
- `list_books` — List every book the authenticated user is a member of, each with the user's role
- `create_book` — Create a new accounting book
- `update_book` — Rename a book, and optionally change its recurring-transaction projection window. `name` is always required; resend the current name to leave it unchanged
- `create_demo_book` — Create a new book pre-filled with realistic sample data. The optional `dataset` parameter is `household` (the default, about three years of transactions) or `single` (about two years). The dates end today
- `delete_book` — Permanently delete a book and all of its data; requires `confirmBookName` to match the book's exact name

**Book members** (require `bookId`):
- `list_book_members` — List the users who can open a book, with each user's role. Any member can call this
- `add_book_member` — Give an existing user access to a book by exact username. Owner only, rate-limited
- `update_book_member` — Change a member's role. Owner only; the last owner cannot be demoted
- `remove_book_member` — Remove a member. An owner can remove anyone; any member can remove themself (leave). The last owner cannot be removed

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
- `get_system_status` — Report the health of Counterpoise's background jobs (backup, backup pruning, recurring processing, bank sync, security price sync, the monthly database compaction named reindex)

**Analytics:**
- `analyze_usage` — Query PostHog for the caller's own event summaries (requires PostHog env vars)

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
- `get_reconcile_candidates` — The reconciliation queue for one linked bank account, or for all of them when no link is given: staged transactions awaiting a decision, each with up to five ranked candidate matches and a suggested counter account
- `reconcile_plaid_transaction` — Resolve one staged bank transaction: match it to an existing transaction, match and rewrite that transaction's amount, create a new transaction from it, ignore it, keep what you already have, or unlink an already-resolved row (which also un-reconciles its transaction unless another bank row still matches it). Linking a row that is already linked is refused

## Changing a Tool

1. Edit the tool's entry in `rust-api/server/mcp-tools.json`: its title,
   description, annotations and input schema. Keep the entries in name order,
   and give every input field a description.
2. Change the handler in `rust-api/server/src/mcp/tools/`. A new tool also
   needs its dispatch arm and its name in `IMPLEMENTED` in `tools/mod.rs`.
3. Where the schema cannot hold a rule (a trim, a coercion, a custom
   message), add it to `prepare()`, `precheck()` or `ZOD_MESSAGES`.
4. Add the tool to `EXPECTED_ANNOTATIONS` in `tests/mcp/annotations.test.ts`,
   to `ROUTE_TOOLS` or `TOOLS_WITHOUT_ROUTES` in `tests/mcp/route-coverage.ts`,
   and to `WEB_EXCLUDED_TOOLS` in `mcp/webmcp.rs` when the browser must not
   have it. Keep the WebMCP list under its byte budget.

## Tool Annotations

Every tool in the manifest carries one annotation preset: `READ`, `READ_NETWORK`, `CREATE`, `UPDATE`, `DESTRUCTIVE`, `DESTRUCTIVE_NONIDEMPOTENT`, `WRITE_NETWORK`. A client can tell a query from a write without reading the description.

`WRITE_NETWORK` is for a tool that both changes data and leaves the process to do it. `sync_plaid_token` is currently its only user — distinct from `READ_NETWORK`, which is for a tool that reaches out but changes nothing (`fetch_tiingo_prices`, `analyze_usage`). The presets are defined in `tests/mcp/annotations.test.ts`, which gives each tool its preset and checks the manifest against it. Set every hint explicitly: `destructiveHint` and `openWorldHint` default to true, so an omitted hint claims more about a tool than saying nothing would.

## Shared Transaction Logic

The transaction tools send their writes through the Rust transaction routes
(`rust-api/server/src/routes/transactions.rs`), so a tool and the web client
get the same validation, the same lot rebuild, and the same messages.

## API Key Management

- **Routes**: `GET`/`POST /api/auth/api-keys` and `DELETE /api/auth/api-keys/[id]`, served by `list_keys()`, `create_key()` and `delete_key()` in `rust-api/server/src/routes/auth.rs`. They accept the cookie session only, so a key cannot mint or revoke keys
- **Verification**: `principal()` in `rust-api/server/src/auth.rs` checks a bearer key: its shape, then the scrypt hash of the candidates with the same `keyPrefix`
- **UI**: `/components/account/ApiKeyManager.tsx` on the `/account` page
- **Tests**: `tests/helpers/api-keys.ts` mints and hashes keys in the stored format — `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, `getKeyPrefix()`

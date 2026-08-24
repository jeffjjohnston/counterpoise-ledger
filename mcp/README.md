# Counterpoise MCP Server

An MCP (Model Context Protocol) server that provides read and write access to your Counterpoise accounting data. This allows AI assistants like Claude to query your accounts, transactions, investments, and financial reports — and create or update transactions.

## Authentication

All tools require a valid API key. Users create keys in the Counterpoise UI at the Account page, then provide the key to the MCP client via the `COUNTERPOISE_API_KEY` environment variable.

- Keys are prefixed with `cpk_` and verified against scrypt hashes stored in the `apiKeys` table
- Each key is scoped to the user who created it — they can only access books they own
- The key is verified at server startup, cached in memory, and periodically revalidated so revoked keys stop working without a process restart

## Available Tools

| Tool | Description |
|------|-------------|
| `list_books` | List the authenticated user's accounting books |
| `create_book` | Create a new accounting book |
| `update_book` | Rename a book, and optionally change its recurring transaction projection window (`name` is always required — resend the current name to leave it unchanged) |
| `create_demo_book` | Create a new book pre-filled with realistic sample data |
| `delete_book` | Permanently delete a book and all of its data |
| `list_accounts` | List accounts with balances (filter by type, date) |
| `get_account_tree` | Hierarchical account view by type |
| `create_account` | Create an account in the chart of accounts |
| `update_account` | Update an account's fields |
| `delete_account` | Delete an account (refuses if it has transactions or sub-accounts) |
| `list_transactions` | Query transactions with filters (account, payee, date range) |
| `search` | Free-text search across transactions, accounts, and payees |
| `create_transaction` | Create a double-entry transaction with splits (must sum to zero) |
| `update_transaction` | Update an existing transaction's fields or replace splits |
| `delete_transaction` | Delete a transaction and all of its splits |
| `list_payees` | List payees with transaction count and most recent transaction date; optional `search` and `limit` |
| `get_payee` | Get one payee, with its transaction count and last-used account |
| `create_payee` | Create a payee (refuses an exact-name repeat in the same book) |
| `delete_payee` | Delete a payee (refuses if it has transactions) |
| `list_recurring_rules` | List recurring transaction rules with their payees and template splits |
| `create_recurring_rule` | Create a recurring transaction rule (template splits must sum to zero) |
| `update_recurring_rule` | Update a rule; passing templateSplits replaces every existing split |
| `delete_recurring_rule` | Delete a rule and its template splits (transactions it created are kept) |
| `get_projected_transactions` | Project the transactions active rules will create over a date range |
| `list_recurring_transactions` | List transactions a recurring rule actually created in a date range |
| `process_recurring_rules` | Create the transactions rules are due for, or force one rule |
| `get_income_statement` | Income/expense report for a date range |
| `get_report_data` | Raw split data for custom analysis |
| `get_realized_gains` | Realized capital gains and losses per lot disposed of, with short and long-term totals |
| `get_account_balance_history` | Running balance over time for an account |
| `get_investment_positions` | Current portfolio positions with gain/loss |
| `get_security_detail` | Security info, prices, and transaction history |
| `create_security` | Create a new security (ETF, mutual fund, or stock) |
| `create_issue_report` | File a bug or improvement report about Counterpoise itself |
| `list_issue_reports` | List the authenticated user's own issue reports |
| `update_issue_report` | Change the description, type, or status of an issue report |
| `delete_issue_report` | Delete an issue report |
| `get_system_status` | Report the health of Counterpoise's background jobs |
| `analyze_usage` | Query PostHog for usage event summaries |

## Setup for Claude Code

Add to your project-level `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/path/to/counterpoise",
      "env": {
        "COUNTERPOISE_API_KEY": "cpk_your_key_here"
      }
    }
  }
}
```

## Setup for Claude Code (Docker)

If Counterpoise is running via Docker Compose, configure the MCP server to use `docker exec` with the API key passed via `-e`:

Add to your project-level `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "COUNTERPOISE_API_KEY=cpk_your_key_here", "counterpoise-app-1", "node", "/app/mcp-server.mjs"]
    }
  }
}
```

## Setup for Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/path/to/counterpoise",
      "env": {
        "COUNTERPOISE_API_KEY": "cpk_your_key_here"
      }
    }
  }
}
```

## Setup for Claude Desktop (Docker)

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "counterpoise": {
      "command": "docker",
      "args": ["exec", "-i", "-e", "COUNTERPOISE_API_KEY=cpk_your_key_here", "counterpoise-app-1", "node", "/app/mcp-server.mjs"]
    }
  }
}
```

**Prerequisites:**
- Generate an API key at `/account` in the web UI
- The `app` container must be running (`docker compose up -d`)

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `COUNTERPOISE_API_KEY` | Yes | User API key for authentication |
| `DATABASE_URL` | No | PostgreSQL connection (defaults to local dev DB) |
| `POSTHOG_PERSONAL_API_KEY` | No | Required only for `analyze_usage` tool |
| `NEXT_PUBLIC_POSTHOG_HOST` | No | Required only for `analyze_usage` tool |

## Testing

Run the MCP tool tests:

```bash
npx vitest tests/mcp/
```

Run the MCP Inspector to interactively test tools:

```bash
COUNTERPOISE_API_KEY=cpk_your_key npx @modelcontextprotocol/inspector npx tsx mcp/server.ts
```

## Example Queries

Once connected, try asking Claude:

- "What books do I have?" → uses `list_books`
- "Show me my account balances" → uses `list_accounts`
- "What did I spend on groceries last month?" → uses `search` or `list_transactions`
- "Give me an income statement for 2024" → uses `get_income_statement`
- "How are my investments doing?" → uses `get_investment_positions`
- "Show me VTI price history" → uses `get_security_detail`
- "Record a $50 grocery purchase from my checking account" → uses `create_transaction`

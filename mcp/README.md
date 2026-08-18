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
| `list_accounts` | List accounts with balances (filter by type, date) |
| `get_account_tree` | Hierarchical account view by type |
| `list_transactions` | Query transactions with filters (account, payee, date range) |
| `search` | Free-text search across transactions, accounts, and payees |
| `create_transaction` | Create a double-entry transaction with splits (must sum to zero) |
| `update_transaction` | Update an existing transaction's fields or replace splits |
| `get_income_statement` | Income/expense report for a date range |
| `get_report_data` | Raw split data for custom analysis |
| `get_account_balance_history` | Running balance over time for an account |
| `get_investment_positions` | Current portfolio positions with gain/loss |
| `get_security_detail` | Security info, prices, and transaction history |
| `create_security` | Create a new security (ETF, mutual fund, or stock) |
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

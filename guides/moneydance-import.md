# Moneydance Import System

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Import Architecture
Located in `/scripts/import-moneydance/`, the importer runs this flow:
1. **Accounts** - Creates chart of accounts + auto-generates investment cash accounts
2. **Opening Balances** - Sets initial balances for accounts (loans, etc.)
3. **Payees** - Imports and deduplicates payees
4. **Standard Transactions** - Non-investment transactions
5. **Investment Transactions** - Transactions, ledger splits and investment splits. Writes no lots
6. **Security Prices** - Historical price data
7. **Stock Splits** - Corporate actions
8. **Lot Rebuild** - Runs `rebuildLots` over every affected `(account, security)` pair, in `index.ts` (not inside the Investment Transactions phase). Must come after Stock Splits: a sell that follows an imported split needs the split's "split" action row on the books first, or the FIFO replay matches it against pre-split share counts and corrupts cost basis, realized gains, and holding term for that pair.
9. **Recurring Reminders** - Converts eligible reminders into recurring rules

## CLI Usage
```bash
npx tsx scripts/import-moneydance/index.ts <path-to-json> --book-id <id> [options]

Options:
  --book-id <id>    Book ID to import into (required)
  --dry-run         Parse and validate without writing to database
  --no-inactive     Skip inactive accounts
  --no-hidden       Skip hidden accounts
  --verbose         Show detailed progress
```

## Key Import Classes
- `IdMapper` (in `types.ts`) - Maps Moneydance UUIDs to Counterpoise integer IDs
- Phase parsers in `/parsers/` directory: `accounts.ts`, `opening-balances.ts`, `payees.ts`, `transactions.ts`, `investment-transactions.ts`, `security-prices.ts`, `stock-splits.ts`, `reminders.ts`

## Important Import Details
- The investment transactions phase writes **no** lots or allocations. It creates the transactions, their ledger splits and their investment splits; the Lot Rebuild phase derives everything else from those splits. Its former two-pass lot bookkeeping (Pass 1 created lots, Pass 2 matched sells FIFO) was deleted along with `investmentSplits.lotId` — see Lot Tracking in [guides/investments.md](investments.md)
- Share conversion: Moneydance uses variable precision (typically 10^5), Counterpoise uses micros (10^6)
- **Bug fix applied**: Sell transactions must store `sharesMicros` as positive values

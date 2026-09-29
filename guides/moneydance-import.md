# Moneydance Import System

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Import Architecture
The importer is `ledger-cli import-moneydance`, in `rust-api/cli/src/import_moneydance/`.
It replaced a TypeScript importer, and a test held the two to the same rows
until the TypeScript was removed. `tests/http/moneydance-import.test.ts` now
imports both fixtures in `tests/fixtures/` with the CLI. It checks the rows
that matter, and that two runs write the same rows.

The importer runs this flow:
1. **Accounts** - Creates chart of accounts + auto-generates investment cash accounts
2. **Opening Balances** - Sets initial balances for accounts (loans, etc.)
3. **Payees** - Imports and deduplicates payees
4. **Standard Transactions** - Non-investment transactions
5. **Investment Transactions** - Transactions, ledger splits and investment splits. Writes no lots
6. **Security Prices** - Historical price data
7. **Stock Splits** - Corporate actions
8. **Lot Rebuild** - Runs `ledger_db::lots::rebuild_lots()` over every affected `(account, security)` pair, after the Stock Splits phase and not inside the Investment Transactions phase. Must come after Stock Splits: a sell that follows an imported split needs the split's "split" action row on the books first, or the FIFO replay matches it against pre-split share counts and corrupts cost basis, realized gains, and holding term for that pair.
9. **Recurring Reminders** - Converts eligible reminders into recurring rules

## CLI Usage
```bash
npm run import:moneydance -- <path-to-json> --book-id <id> [options]
# or, with a built CLI:
rust-api/target/debug/ledger-cli import-moneydance <path-to-json> --book-id <id> [options]

Options:
  --book-id <id>    Book ID to import into (required). The book must exist
  --dry-run         Parse and validate without writing to database
  --no-inactive     Skip inactive accounts
  --no-hidden       Skip hidden accounts
  --verbose         Show detailed progress
  --overwrite       Delete the target book's existing data before import (destructive)
```

## Transactions and Failures
The importer reads and checks the file first. Then one database
transaction holds the `--overwrite` delete and every phase. A failure that
stops the run, such as a failed lot rebuild, rolls back all of it, so the
book stays as it was. A dry run rolls its transaction back too. A dry run
checks every stock split ratio and counts a bad one as an error.

A row that fails does not stop the run. Each unit that the importer writes
together (an account, a payee, a transaction with its splits, a batch of
prices) runs in a savepoint. A failed unit rolls back alone, and the summary
counts it as an error.

## Key Import Classes
- `IdMapper` - Maps Moneydance IDs to Counterpoise integer IDs. The cash child of investment account `X` is under the key `X_CASH`
- Phases in `rust-api/cli/src/import_moneydance/`: `accounts.rs` (accounts, securities, opening balances), `transactions.rs` (payees, standard transactions), `investments.rs`, `securities.rs` (prices, stock splits), `reminders.rs`. `mod.rs` holds the flow, `IdMapper`, and `overwrite_book()`. `values.rs` reads export values as JavaScript does

## Important Import Details
- The investment transactions phase writes **no** lots or allocations. It creates the transactions, their ledger splits and their investment splits; the Lot Rebuild phase derives everything else from those splits.  See Lot Tracking in [guides/investments.md](investments.md)
- Share conversion: Moneydance uses variable precision (typically 10^5), Counterpoise uses micros (10^6)
- Store the `sharesMicros` of a sell as a positive value (`Math.abs`); the `action` field gives the direction
- The export writes every value as a string. The importer does its arithmetic on them in `f64`, as the TypeScript importer did through `parseInt` and `parseFloat`, so the amounts of earlier imports agree to the cent. An unreadable amount stays a NaN until it reaches a column, and it fails at that statement
- An opening balance takes its date from the account's `creation_date`, in local time. An account without one gets today's date
- The "Imported Balance" offset account belongs to the target book. Each book gets its own

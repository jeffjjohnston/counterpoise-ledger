# Moneydance Import Script

This script imports data from Moneydance JSON exports into a Counterpoise book database.

## Features

- **Phase 1**: Import accounts with hierarchy + auto-create investment cash accounts
- **Phase 1.5**: Create opening balances for accounts with initial balances
- **Phase 2**: Extract and import payees
- **Phase 3**: Import standard (non-investment) transactions
- **Phase 4**: Import investment transactions (buy/sell/dividend) with FIFO lot tracking
- **Phase 5**: Import security price history
- **Phase 6**: Import stock splits
- **Phase 7**: Import recurring reminders as recurring rules
- **Safe**: Dry-run mode for validation
- **Progress**: Detailed statistics and error reporting
- **Fast**: Batch processing with progress tracking

## Installation

No additional dependencies needed. Uses existing project dependencies.

## Usage

### Basic Import

```bash
# Dry run to validate (recommended first step)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run

# Actual import
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>
```

The destination book must already exist. Create one in the app first, or run `npm run db:seed` to create a sample book, then use `npm run db:list-books` to find the ID.

### Options

```bash
--book-id <id>         # Book ID to import into (required)
--dry-run              # Parse and validate without writing to database
--overwrite            # Remove existing data in target book before import
--no-inactive          # Skip inactive accounts
--no-hidden            # Skip hidden accounts
--verbose              # Show detailed progress for each item
```

`--overwrite` is destructive and should only be used when you want a clean re-import into that `bookId`.

### Examples

```bash
# Validate your export before importing (verbose dry run)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run --verbose

# Import only active accounts
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --no-inactive --no-hidden

# Replace existing book data before import
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --overwrite

# Full import with detailed logging
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --verbose
```

## What Gets Imported

### Phase 1: Accounts
- Bank accounts -> `asset/bank`
- Credit cards -> `liability/credit_card`
- Investment accounts -> `asset/investment` (with auto-created cash sub-accounts)
- Loans -> `liability/loan`
- Income/expense categories
- Account hierarchy (parent-child relationships)
- Securities (stocks, ETFs, mutual funds)

**Skipped**:
- Root account (type 'r')
- Optionally: inactive/hidden accounts

### Phase 1.5: Opening Balances
- Creates opening balance transactions for accounts with initial balances
- Handles loan opening balances and other account types

### Phase 2: Payees
- Extracted from transaction descriptions
- Automatically deduplicated
- Normalized (trimmed whitespace)

### Phase 3: Standard Transactions
- Non-investment transactions
- All splits (multi-category support)
- Reconciliation status
- Payee linkage
- Descriptions

### Phase 4: Investment Transactions
- Buy/sell transactions with FIFO lot tracking
- Dividend payments
- Capital gain distributions
- Two-pass processing: buys first, then sells matched to lots

### Phase 5: Security Prices
- Historical price data from `csnap` objects
- Mapped to imported securities
- One price point per security per recorded date

### Phase 6: Stock Splits
- Corporate stock split events
- Split ratios applied to holdings

### Phase 7: Recurring Reminders
- Converts eligible Moneydance reminders into Counterpoise recurring rules
- Imports recurring template splits and scheduling metadata

## Output

The script provides:

1. **Progress updates** during import
2. **Statistics** for each phase
3. **Error reporting** with details
4. **ID mapping counts** (Moneydance -> Counterpoise)
5. **Total time** taken

## Error Handling

The script:
- Validates data before import
- Continues on individual errors (logs and skips)
- Reports all errors at the end
- Validates split balancing
- Checks account references exist

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "Referenced accounts not imported" | Transaction references inactive/hidden account | Import with `--no-inactive` removed, or accept skipping |
| "Invalid date format" | Corrupted date in source | Check source data quality |
| "Account mapping not found" | Split references unknown account | Verify all accounts imported in Phase 1 |

## File Structure

```
scripts/import-moneydance/
├── index.ts                        # Main entry point and orchestrator
├── types.ts                        # TypeScript type definitions + IdMapper
├── parsers/
│   ├── accounts.ts                 # Phase 1: Account import
│   ├── opening-balances.ts         # Phase 1.5: Opening balance creation
│   ├── payees.ts                   # Phase 2: Payee extraction
│   ├── transactions.ts             # Phase 3: Standard transaction import
│   ├── investment-transactions.ts  # Phase 4: Investment transaction import
│   ├── security-prices.ts          # Phase 5: Security price import
│   ├── stock-splits.ts             # Phase 6: Stock split import
│   └── reminders.ts                # Phase 7: Recurring reminder import
└── utils/
    ├── format.ts                   # Date/amount conversion utilities
    └── validation.ts               # Data validation helpers
```

## Development

### Testing

```bash
# Always dry-run first
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run --verbose

# Validate against real data (no writes)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run
```

## Database

The script uses:
- `getDb()` for the unified database connection
- Drizzle ORM for type-safe queries (all book-scoped queries filter by `bookId`)
- `--book-id` argument determines which book's data to import into

## Safety Features

1. **Dry run mode**: Validate before committing
2. **Error isolation**: One failed item doesn't stop import
3. **Detailed logging**: Track what happened
4. **Skip filters**: Control what gets imported
5. **Validation**: Check data integrity before writing

## Troubleshooting

### Script won't run
```bash
# Make sure you're in project root
cd /path/to/counterpoise

# Check tsx is available
npx tsx --version

# Run with full path
npx tsx scripts/import-moneydance/index.ts --help
```

### Database errors
```bash
# Ensure PostgreSQL is running
docker compose up -d

# Verify connection
PGPASSWORD=counterpoise psql -h localhost -U counterpoise -d counterpoise_dev -c '\dt'
```

### Memory errors
```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>
```

## Next Steps

After successful import:

1. Verify account hierarchy in UI
2. Spot-check transaction imports
3. Verify balances match Moneydance
4. Check investment positions and lot tracking
5. Verify security price history
6. Verify recurring reminders imported as expected

## Support

See documentation:
- Moneydance data model and field reference: `MONEYDANCE_DATA_MODEL.md`
- Investment cash account handling: `INVESTMENT_CASH_ACCOUNTS.md`
- Step-by-step walkthrough: `QUICKSTART.md`

# Quick Start Guide

## Get Started in 3 Steps

### Step 1: Test with Sample Data

```bash
# From project root
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run --verbose
```

The destination book must already exist. Create one in the app first, or run `npm run db:seed`, then use `npm run db:list-books` to find the ID you want to import into.

Expected output:
```
Dry run completed successfully
  Accounts imported: 15
  Payees imported: 2
  Transactions imported: 3
```

### Step 2: Preview Full Import

```bash
# Preview what will be imported (no database changes)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run
```

This will show you:
- How many accounts will be imported
- How many payees will be extracted
- How many transactions will be imported (standard and investment)
- Security prices and stock splits found
- Any errors or warnings

### Step 3: Perform Import

```bash
# Import everything
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>

# OR import only active accounts
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --no-inactive --no-hidden
```

## Command Options

| Option | Description | When to Use |
|--------|-------------|-------------|
| `--book-id <id>` | Target book ID (required) | Always - specifies which book to import into |
| `--dry-run` | Validate without writing | Always run first! |
| `--overwrite` | Clear existing data in the target book before importing | Clean re-import into an existing book |
| `--no-inactive` | Skip inactive accounts | Clean import, only current accounts |
| `--no-hidden` | Skip hidden accounts | Exclude archived data |
| `--verbose` | Show detailed progress | Debugging, watching import |

## What to Expect

### Import Times (approximate)

Import time scales with the size of your export. A small test file completes
in under a second. A full ledger of many years takes one to two minutes.

### What Gets Imported

**Phase 1 - Accounts**: Bank accounts, credit cards, investment accounts (with cash sub-accounts), loans, income/expense categories, securities, and account hierarchy.

**Phase 1.5 - Opening Balances**: Initial balances for accounts.

**Phase 2 - Payees**: Extracted from transaction descriptions, deduplicated.

**Phase 3 - Standard Transactions**: All non-investment transactions, with their splits, reconciliation status, and payee linkage.

**Phase 4 - Investment Transactions**: Buy/sell/dividend transactions with FIFO lot tracking.

**Phase 5 - Security Prices**: All historical price points found in the export.

**Phase 6 - Stock Splits**: Corporate stock split events.

**Phase 7 - Recurring Reminders**: Eligible reminders become Counterpoise recurring rules.

## Verify Import

After importing, check:

1. **Account count**: Compare with Moneydance (fewer if you filtered)
2. **Transaction count**: Compare with Moneydance
3. **Account balances**: Compare with Moneydance
4. **Account hierarchy**: Parent-child relationships preserved
5. **Investment positions**: Check holdings match Moneydance
6. **Security prices**: Verify price history is populated

## If Something Goes Wrong

### Script errors

```bash
# Check you're in project root
pwd  # Should show .../counterpoise

# Ensure PostgreSQL is running (create volume first if needed)
docker volume create counterpoise_pgdata
docker compose up -d

# Dry-run your export first
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run
```

### Import errors

The script will:
- Continue importing other items
- Log errors at the end
- Show total error count

### Undo import

To start fresh, re-import with the `--overwrite` flag which clears existing data for the target book:

```bash
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --overwrite
```

## Example Workflow

### Conservative Approach (Recommended)

```bash
# 1. Validate the export
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run

# 2. Preview full import
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run

# 3. Import for real (writes to the database)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>

# 4. Check results in app UI

# 5. Clear test data (delete and recreate book, or restore backup)

# 6. Full import
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id>
```

### Quick Approach (If confident)

```bash
# 1. Dry run full data
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --dry-run

# 2. Import (active accounts only)
npx tsx scripts/import-moneydance/index.ts path/to/export.json --book-id <existing-book-id> --no-inactive --no-hidden
```

## More Information

- **Full documentation**: `scripts/import-moneydance/README.md`
- **Data model and field reference**: `MONEYDANCE_DATA_MODEL.md`
- **Investment cash accounts**: `INVESTMENT_CASH_ACCOUNTS.md`

## Success Checklist

After import completes:

- [ ] No critical errors reported
- [ ] Account count matches expectation
- [ ] Transaction count matches Moneydance
- [ ] Sample transactions look correct in UI
- [ ] Account hierarchy displays properly
- [ ] Balances appear reasonable
- [ ] Investment positions match expectations
- [ ] Security prices populated
- [ ] Recurring reminders look correct

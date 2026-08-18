# Investment Cash Accounts

## Overview

Investment accounts (401k, IRA, HSA, brokerage, etc.) hold both securities and cash. In Counterpoise, these are tracked separately:
- **Securities**: Tracked in the `securities` table
- **Cash**: Tracked in a dedicated cash sub-account with `isInvestmentCash: true`

## Automatic Cash Account Creation

When importing an investment account from Moneydance (type `v`), the importer automatically creates:

1. **Parent Investment Account**
   - Type: `asset`
   - Subtype: `investment`
   - isInvestmentCash: `false`
   - Example: "Brokerage HSA"

2. **Cash Sub-Account** (automatically created)
   - Type: `asset`
   - Subtype: `cash`
   - isInvestmentCash: `true`
   - parentId: Points to investment account
   - Example: "Brokerage HSA - Cash"

## Investment Cash Transactions

Transactions with `xfer_type: "xfrtp_bank"` represent cash movements in investment accounts, such as:
- Deposits to investment account
- Withdrawals from investment account
- Transfers between investment and bank accounts
- Dividend payments received as cash
- Fee payments from cash

These transactions are automatically routed to the **cash sub-account**, not the parent investment account.

## Example Structure

### Moneydance
```
Brokerage HSA (type: v)
├── Cash (implicit, no separate account)
└── Securities
    ├── Total Stock Market Index (type: s)
    └── Total Bond Index (type: s)
```

### Counterpoise (After Import)
```
accounts:
  Brokerage HSA (id: 100, subtype: investment, isInvestmentCash: false)
  ├── Brokerage HSA - Cash (id: 101, subtype: cash, isInvestmentCash: true, parentId: 100)

securities:
  Total Stock Market Index (id: 1)
  Total Bond Index (id: 2)
```

## Transaction Routing

### Standard Cash Transfer
```json
{
  "xfer_type": "xfrtp_bank",
  "acctid": "brokerage-hsa-uuid",     // Parent investment account
  "0.acctid": "checking-uuid",       // Regular checking account
  "0.samt": "100000",                 // $1,000
  "0.pamt": "-100000"
}
```

**Imported as**:
- Split 1: Brokerage HSA - Cash: -$1,000 (withdrawal from cash account)
- Split 2: Checking: +$1,000 (deposit to checking)

### Deposit to Investment Account
```json
{
  "xfer_type": "xfrtp_bank",
  "acctid": "ira-uuid",               // Investment account
  "0.acctid": "checking-uuid",
  "0.samt": "-500000",                // -$5,000 from checking
  "0.pamt": "500000"                  // +$5,000 to IRA
}
```

**Imported as**:
- Split 1: IRA - Cash: +$5,000 (cash received)
- Split 2: Checking: -$5,000 (withdrawal from checking)

## Benefits

1. **Clear separation**: Cash vs securities are distinct
2. **Accurate reporting**: Can see cash positions separately from holdings
3. **Transaction clarity**: Cash movements don't affect security values
4. **Account hierarchy**: Investment account aggregates both cash and securities

## ID Mapping

The importer uses a special suffix for cash accounts:
```typescript
// Investment account mapping
idMapper.setAccount(mdAccount.id, investmentAccountId);

// Cash sub-account mapping
idMapper.setAccount(`${mdAccount.id}_CASH`, cashAccountId);
```

When processing `xfrtp_bank` transactions, the importer checks for the `_CASH` suffix and routes to the cash account.

## Account Count Impact

For each investment account imported:
- **Before**: 1 account created
- **After**: 2 accounts created (parent + cash)

Example: If you have 15 investment accounts, you'll see:
- 15 investment accounts
- 15 cash sub-accounts
- **Total**: 30 accounts (instead of 15)

## Querying Investment Cash

### Get all investment cash accounts
```sql
SELECT * FROM accounts
WHERE is_investment_cash = true;
```

### Get cash balance for an investment account
```sql
SELECT SUM(ts.amount) as cash_balance
FROM accounts a
JOIN accounts cash ON cash.parent_id = a.id AND cash.is_investment_cash = true
JOIN transaction_splits ts ON ts.account_id = cash.id
WHERE a.id = ?;  -- investment account ID
```

### Get total investment account value (cash + securities)
```sql
-- Cash portion
SELECT SUM(ts.amount) FROM transaction_splits ts
JOIN accounts a ON a.id = ts.account_id
WHERE a.parent_id = ? AND a.is_investment_cash = true;

-- Plus securities value from investment_lots and security_prices
```

## Migration Notes

If you previously imported investment accounts without cash sub-accounts:
1. Cash transactions may have been lost or misattributed
2. Re-import to create proper cash account structure
3. Cash transfers (`xfrtp_bank`) will now be properly tracked

## Future Enhancements

- Automatic cash-to-security conversion tracking
- Cash reserve requirements for investment accounts
- Interest accrual on cash positions
- Money market fund handling as cash equivalent

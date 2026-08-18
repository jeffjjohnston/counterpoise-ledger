# Moneydance Transaction Data Model

## Understanding Moneydance's Split Structure

Moneydance uses a unique transaction model that differs from traditional double-entry systems. Understanding this is crucial for correct import.

### Key Concepts

**Parent Account**:
- Every transaction has a main account stored in `acctid`
- This is NOT included in the numbered splits
- Its amount must be calculated from the split data

**Numbered Splits**:
- Each split has an index: `0`, `1`, `2`, etc.
- Each split has TWO amounts:
  - `samt` = **Split Amount** (from the split account's perspective)
  - `pamt` = **Parent Amount** (from the parent account's perspective)

### Example Transaction

```json
{
  "obj_type": "txn",
  "dt": "20190322",
  "desc": "Panera Bread",
  "acctid": "checking-account-uuid",    // Parent: checking account

  "0.acctid": "food-expense-uuid",       // Split: food expense
  "0.samt": "857",                        // Food expense increases by $8.57
  "0.pamt": "-857"                        // Checking decreases by $8.57
}
```

**Interpretation**:
- Checking account: -$8.57 (decreases)
- Food expense: +$8.57 (increases)
- Total: 0 ✓ (balanced)

### Why Two Amounts?

The dual amounts allow Moneydance to:
1. Track each split from its own account's perspective (`samt`)
2. Show how the parent account is affected (`pamt`)
3. Support multi-split transactions efficiently

### Double-Entry Balance Rule

For a transaction to balance in double-entry accounting:

```
(Sum of all pamt) + (Sum of all samt) = 0
```

Or equivalently:
```
Parent account amount + Split accounts amounts = 0
```

### Multi-Split Example

```json
{
  "acctid": "credit-card-uuid",          // Parent: credit card

  "0.acctid": "groceries-uuid",
  "0.samt": "2609",                       // Groceries: +$26.09
  "0.pamt": "-2609",                      // Credit card: -$26.09

  "1.acctid": "household-uuid",
  "1.samt": "10823",                      // Household: +$108.23
  "1.pamt": "-10823",                     // Credit card: -$108.23

  "2.acctid": "clothing-uuid",
  "2.samt": "2280",                       // Clothing: +$22.80
  "2.pamt": "-2280"                       // Credit card: -$22.80
}
```

**Balance verification**:
- Parent (credit card): -2609 + -10823 + -2280 = -15712
- Splits (expenses): +2609 + 10823 + 2280 = +15712
- Total: 0 ✓

### Import Strategy

To correctly import into Counterpoise's double-entry system:

1. **Create parent split**:
   ```typescript
   amount = sum of all N.pamt values
   accountId = parent acctid
   ```

2. **Create numbered splits**:
   ```typescript
   amount = N.samt (split amount)
   accountId = N.acctid
   ```

### Common Mistakes

❌ **Wrong**: Using `pamt` for split amounts
```typescript
// This reverses debits/credits!
for (const split of splits) {
  amount: split.pamt  // Wrong - this is parent's perspective
}
```

✅ **Correct**: Using `samt` for split amounts, `pamt` for parent
```typescript
// Parent split
amount: sum(all pamt values)

// Numbered splits
for (const split of splits) {
  amount: split.samt  // Correct - split's perspective
}
```

### Sign Conventions

| Account Type | Debit (Increase) | Credit (Decrease) |
|--------------|------------------|-------------------|
| Asset (checking) | Positive | Negative |
| Liability (credit card) | Negative | Positive |
| Expense | Positive | Negative |
| Income | Negative | Positive |

**Example: Deposit to checking**
```
Parent (checking/asset): +100 (debit, increase)
Split (income): -100 (credit, decrease... or increase from income's perspective)
```

**Example: Purchase with credit card**
```
Parent (credit card/liability): -100 (credit, increase liability)
Split (expense): +100 (debit, increase expense)
```

### Investment Transactions

Investment transactions (with `xfer_type` field) use a different model:
- `samt` = share quantity (in micros)
- `pamt` = cash amount
- These require separate handling (Phase 4)

### Validation

A transaction is valid if:
```
sum(all pamt) + sum(all samt) = 0
```

This is checked in `validateSplitBalance()` function.

## References

- See `utils/validation.ts` for split extraction logic
- See `parsers/transactions.ts` for import implementation

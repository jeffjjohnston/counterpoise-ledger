# Common Patterns & Gotchas

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## Transaction Balance Validation
The splits of a transaction must sum to zero. The Rust transaction routes
check this before they write, with `validate_splits()` in
`rust-api/core/src/accounting.rs`. The browser runs the same check through
the WASM core, and `validateSplits()` in `lib/accounting.ts` is the
TypeScript copy.

## Investment Shares Sign
Investment split `sharesMicros` is always positive. The `action` field determines direction:
- Buy: positive shares added to position
- Sell: positive shares subtracted from position (sign applied in calculation)

## Date Formatting
- Database stores dates as `YYYY-MM-DD` strings
- Use `toDateString()` from `lib/formatters.ts` to convert Date objects
- Use `formatDate()` for display formatting

## Payee Normalization
Payees are deduplicated using normalized names. `normalize_name()` in
`rust-api/server/src/routes/payees.rs` trims, collapses whitespace runs and
straightens curly quotes to `'`. It uses the JavaScript whitespace set
(`is_js_whitespace` in `rust-api/core/src/js.rs`), not Rust's.

**It does not lowercase**: the payee keeps the case that was first typed. But
a payee name **matches without letter case**: "IKEA" and "Ikea" are one payee.
`find_payee_by_name()` in `rust-api/server/src/book_scope.rs` finds it (the
exact spelling first, then the oldest payee), and every write path uses it or
the same rule: `resolve_payee()` (transactions, recurring rules, MCP
`create_transaction`, Plaid decisions), `POST /payees` (returns the existing
payee), MCP `create_payee` (refuses, and names the existing payee) and the
importer (`payee_key()`: the first spelling wins).

Why: the rule "deliberately distinct" came from a v1.17.1 documentation fix
that described the code, not a decision, and every lookup already ignored
case. The Moneydance import made 9 case-only pairs in one book, which split
the payee's history and its report row, and a typed name could link to either
spelling (2026-10-12). `ledger-cli merge-payee-case`
merges such pairs. Migration 0009 adds the unique index
`payees_book_name_nocase` on `(book_id, name COLLATE NOCASE)`. NOCASE folds
ASCII letters only, so the index refuses "PayPal" after "Paypal" but not
"éclair" after "ÉCLAIR"; `find_payee_by_name()` covers that case: it compares
`name_fold`, the Unicode fold of the name, so every path that creates a payee
writes `name_fold` too (see [schema.md](schema.md)). A database
that still has ASCII case-only duplicates must run `merge-payee-case` before
it applies 0009, or the migration stops.

The importer has its own copy, `normalize_name()` in
`rust-api/cli/src/import_moneydance/values.rs`, and the TypeScript copy is
`normalizePayeeName()` in `lib/payees.ts`. They must stay behaviorally
identical, or an import creates duplicates of payees the app already has.

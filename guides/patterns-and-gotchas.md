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

**It does not lowercase** — "IKEA" and "Ikea" are deliberately distinct
payees. The importer has its own copy, `normalize_name()` in
`rust-api/cli/src/import_moneydance/values.rs`, and the TypeScript copy is
`normalizePayeeName()` in `lib/payees.ts`. They must stay behaviorally
identical, or an import creates duplicates of payees the app already has.

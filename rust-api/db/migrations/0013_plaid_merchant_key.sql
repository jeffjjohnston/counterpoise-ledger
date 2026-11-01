-- The merchant key of a staged Plaid row: ledger_core::names::merchant_key()
-- of merchant_name, or of name when merchant_name is NULL. The app writes it
-- on every insert and update of either column, so no SQL function computes
-- it. The server's startup guard (ledger_db::folds) fills it on existing rows
-- and repairs a stale one.
ALTER TABLE plaid_transaction_reconciliation ADD COLUMN merchant_key TEXT;

CREATE INDEX plaid_transaction_reconciliation_book_merchant_key
    ON plaid_transaction_reconciliation (book_id, merchant_key);

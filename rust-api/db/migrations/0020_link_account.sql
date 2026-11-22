-- The Counterpoise account that a link was made on. A link joins equal
-- amounts: the bank amount and the total of the linked transaction on this
-- account. The amount checks used the current account of the bank account
-- (plaid_accounts.counterpoise_account_id). After a remap to another
-- account, each old link then had no split on that account, and the sync
-- banner listed every one of them. The writer that links a row sets this
-- column. The writers that remove a link set it to NULL.
ALTER TABLE plaid_transaction_reconciliation
    ADD COLUMN linked_account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL;

-- Each link that exists now was made on the current account of its bank
-- account.
UPDATE plaid_transaction_reconciliation
SET linked_account_id = (
    SELECT pa.counterpoise_account_id FROM plaid_accounts pa
    WHERE pa.id = plaid_transaction_reconciliation.plaid_account_link_id
)
WHERE resolution_status IN ('matched', 'created') AND matched_transaction_id IS NOT NULL;

-- A single-column reference between two rows of a book: the same triggers as
-- 0006_book_reference_checks.sql.
CREATE TRIGGER plaid_recon_linked_account_in_book_insert
BEFORE INSERT ON plaid_transaction_reconciliation
WHEN NEW.linked_account_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.linked_account_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.linked_account_id');
END;
CREATE TRIGGER plaid_recon_linked_account_in_book_update
BEFORE UPDATE OF linked_account_id, book_id ON plaid_transaction_reconciliation
WHEN NEW.linked_account_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.linked_account_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.linked_account_id');
END;

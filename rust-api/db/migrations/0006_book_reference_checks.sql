-- A reference from one book row to another row must stay in the same book.
--
-- The baseline gives most of these references a composite foreign key on
-- (book_id, id), so SQLite refuses a value of another book. The references
-- below have a single-column foreign key: a composite key with
-- ON DELETE SET NULL would also set book_id to null. Until this migration,
-- only the routes stopped a value of another book.
--
-- Each trigger refuses an insert, or an update of the reference or of
-- book_id, when the referenced row is not in NEW.book_id. The triggers run
-- for every writer: the routes, MCP, the importer, the seed and the CLI. The
-- routes still check first and give their 400 or 404; a trigger error means
-- that a writer skipped its check.
--
-- Not covered: investment_lots and investment_lot_allocations (derived
-- state; rebuild_lots() writes them only from book-scoped splits) and the
-- TypeSafe records (the server writes their references, never a client).
--
-- The text of each RAISE starts with 'cross-book reference:' so that a test
-- or a log search can find it.

CREATE TRIGGER transactions_payee_in_book_insert BEFORE INSERT ON transactions
WHEN NEW.payee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payees WHERE id = NEW.payee_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: transactions.payee_id');
END;
CREATE TRIGGER transactions_payee_in_book_update BEFORE UPDATE OF payee_id, book_id ON transactions
WHEN NEW.payee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payees WHERE id = NEW.payee_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: transactions.payee_id');
END;

CREATE TRIGGER transactions_rule_in_book_insert BEFORE INSERT ON transactions
WHEN NEW.recurring_rule_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM recurring_rules WHERE id = NEW.recurring_rule_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: transactions.recurring_rule_id');
END;
CREATE TRIGGER transactions_rule_in_book_update
BEFORE UPDATE OF recurring_rule_id, book_id ON transactions
WHEN NEW.recurring_rule_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM recurring_rules WHERE id = NEW.recurring_rule_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: transactions.recurring_rule_id');
END;

CREATE TRIGGER recurring_rules_payee_in_book_insert BEFORE INSERT ON recurring_rules
WHEN NEW.payee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payees WHERE id = NEW.payee_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: recurring_rules.payee_id');
END;
CREATE TRIGGER recurring_rules_payee_in_book_update
BEFORE UPDATE OF payee_id, book_id ON recurring_rules
WHEN NEW.payee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payees WHERE id = NEW.payee_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: recurring_rules.payee_id');
END;

CREATE TRIGGER plaid_accounts_token_in_book_insert BEFORE INSERT ON plaid_accounts
WHEN NOT EXISTS (SELECT 1 FROM plaid_tokens WHERE id = NEW.token_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_accounts.token_id');
END;
CREATE TRIGGER plaid_accounts_token_in_book_update
BEFORE UPDATE OF token_id, book_id ON plaid_accounts
WHEN NOT EXISTS (SELECT 1 FROM plaid_tokens WHERE id = NEW.token_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_accounts.token_id');
END;

CREATE TRIGGER plaid_accounts_account_in_book_insert BEFORE INSERT ON plaid_accounts
WHEN NEW.counterpoise_account_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.counterpoise_account_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_accounts.counterpoise_account_id');
END;
CREATE TRIGGER plaid_accounts_account_in_book_update
BEFORE UPDATE OF counterpoise_account_id, book_id ON plaid_accounts
WHEN NEW.counterpoise_account_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM accounts WHERE id = NEW.counterpoise_account_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_accounts.counterpoise_account_id');
END;

CREATE TRIGGER plaid_recon_link_in_book_insert BEFORE INSERT ON plaid_transaction_reconciliation
WHEN NOT EXISTS (
    SELECT 1 FROM plaid_accounts WHERE id = NEW.plaid_account_link_id AND book_id = NEW.book_id
)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.plaid_account_link_id');
END;
CREATE TRIGGER plaid_recon_link_in_book_update
BEFORE UPDATE OF plaid_account_link_id, book_id ON plaid_transaction_reconciliation
WHEN NOT EXISTS (
    SELECT 1 FROM plaid_accounts WHERE id = NEW.plaid_account_link_id AND book_id = NEW.book_id
)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.plaid_account_link_id');
END;

CREATE TRIGGER plaid_recon_match_in_book_insert BEFORE INSERT ON plaid_transaction_reconciliation
WHEN NEW.matched_transaction_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM transactions WHERE id = NEW.matched_transaction_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.matched_transaction_id');
END;
CREATE TRIGGER plaid_recon_match_in_book_update
BEFORE UPDATE OF matched_transaction_id, book_id ON plaid_transaction_reconciliation
WHEN NEW.matched_transaction_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM transactions WHERE id = NEW.matched_transaction_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_transaction_reconciliation.matched_transaction_id');
END;

CREATE TRIGGER plaid_link_sessions_token_in_book_insert BEFORE INSERT ON plaid_link_sessions
WHEN NEW.token_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plaid_tokens WHERE id = NEW.token_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_link_sessions.token_id');
END;
CREATE TRIGGER plaid_link_sessions_token_in_book_update
BEFORE UPDATE OF token_id, book_id ON plaid_link_sessions
WHEN NEW.token_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM plaid_tokens WHERE id = NEW.token_id AND book_id = NEW.book_id)
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_link_sessions.token_id');
END;

CREATE TRIGGER plaid_link_sessions_result_in_book_insert BEFORE INSERT ON plaid_link_sessions
WHEN NEW.result_token_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM plaid_tokens WHERE id = NEW.result_token_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_link_sessions.result_token_id');
END;
CREATE TRIGGER plaid_link_sessions_result_in_book_update
BEFORE UPDATE OF result_token_id, book_id ON plaid_link_sessions
WHEN NEW.result_token_id IS NOT NULL
    AND NOT EXISTS (
        SELECT 1 FROM plaid_tokens WHERE id = NEW.result_token_id AND book_id = NEW.book_id
    )
BEGIN
    SELECT RAISE(ABORT, 'cross-book reference: plaid_link_sessions.result_token_id');
END;

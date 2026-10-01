-- The schema of the last PostgreSQL release (Drizzle migration 0027),
-- written for SQLite. Every later change is a new numbered file.
--
-- Type mapping:
--   serial               INTEGER PRIMARY KEY AUTOINCREMENT. PostgreSQL
--                        sequences never give an id twice, and ids appear in
--                        URLs, sync cursors and native-client caches.
--   integer, bigint      INTEGER (64-bit).
--   boolean              INTEGER with CHECK (x IN (0, 1)).
--   timestamp            TEXT, a naive UTC value that the Rust code binds
--                        (YYYY-MM-DD HH:MM:SS[.fff]). No SQL default.
--   jsonb                TEXT with CHECK (json_valid(x)).
--
-- Text compares as bytes (BINARY), as the PostgreSQL images did: they are
-- Alpine, and musl collates en_US.utf8 as bytes.

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_username_unique ON users (username);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE issue_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'bug',
    page TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
);

CREATE TABLE books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    upcoming_days INTEGER NOT NULL DEFAULT 30,
    typesafe_reconciliation_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (typesafe_reconciliation_enabled IN (0, 1)),
    typesafe_revision INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT upcoming_days_range CHECK (upcoming_days >= 1 AND upcoming_days <= 365)
);

CREATE TABLE book_members (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (book_id, user_id)
);
CREATE INDEX book_members_user_id_idx ON book_members (user_id);

-- Every new book gets its creator as owner, whatever path inserts it.
CREATE TRIGGER book_creator_owner AFTER INSERT ON books
BEGIN
    INSERT INTO book_members (book_id, user_id, role, created_at)
    VALUES (NEW.id, NEW.user_id, 'owner', NEW.created_at)
    ON CONFLICT DO NOTHING;
END;

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT,
    parent_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    is_investment_cash INTEGER NOT NULL DEFAULT 0 CHECK (is_investment_cash IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    icon TEXT,
    CONSTRAINT accounts_book_id_id_unique UNIQUE (book_id, id),
    CONSTRAINT accounts_book_parent_fk FOREIGN KEY (book_id, parent_id)
        REFERENCES accounts (book_id, id)
);
CREATE UNIQUE INDEX accounts_name_book_unique ON accounts (name, book_id);

CREATE TABLE payees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX payees_name_book_unique ON payees (name, book_id);

CREATE TABLE recurring_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    frequency TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    days_of_week TEXT,
    week_of_month TEXT,
    days_of_month TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT,
    next_date TEXT NOT NULL,
    auto_create_days_before INTEGER NOT NULL DEFAULT 0,
    template_description TEXT,
    payee_id INTEGER REFERENCES payees (id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    business_days_only INTEGER NOT NULL DEFAULT 0 CHECK (business_days_only IN (0, 1)),
    CONSTRAINT recurring_rules_book_id_id_unique UNIQUE (book_id, id)
);
CREATE INDEX idx_recurring_rules_active_next ON recurring_rules (is_active, next_date);

CREATE TABLE recurring_template_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    recurring_rule_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    CONSTRAINT recurring_template_splits_book_account_fk FOREIGN KEY (book_id, account_id)
        REFERENCES accounts (book_id, id),
    CONSTRAINT recurring_template_splits_book_rule_fk FOREIGN KEY (book_id, recurring_rule_id)
        REFERENCES recurring_rules (book_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_recurring_template_splits_rule ON recurring_template_splits (recurring_rule_id);

CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    description TEXT,
    check_number TEXT,
    notes TEXT,
    payee_id INTEGER REFERENCES payees (id) ON DELETE SET NULL,
    is_reconciled INTEGER NOT NULL DEFAULT 0 CHECK (is_reconciled IN (0, 1)),
    recurring_rule_id INTEGER REFERENCES recurring_rules (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_floating INTEGER NOT NULL DEFAULT 0 CHECK (is_floating IN (0, 1)),
    created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT transactions_book_id_id_unique UNIQUE (book_id, id)
);
CREATE INDEX idx_transactions_book_date_id ON transactions (book_id, date, id);
CREATE INDEX idx_transactions_payee_date_id ON transactions (payee_id, date, id);

CREATE TABLE transaction_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    CONSTRAINT transaction_splits_book_account_fk FOREIGN KEY (book_id, account_id)
        REFERENCES accounts (book_id, id),
    CONSTRAINT transaction_splits_book_transaction_fk FOREIGN KEY (book_id, transaction_id)
        REFERENCES transactions (book_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_transaction_splits_account_txn ON transaction_splits (account_id, transaction_id);
CREATE INDEX idx_transaction_splits_txn_amount ON transaction_splits (transaction_id, amount);

CREATE TABLE securities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    security_type TEXT NOT NULL,
    fetch_prices INTEGER NOT NULL DEFAULT 1 CHECK (fetch_prices IN (0, 1)),
    created_at TEXT NOT NULL,
    fixed_price_micros INTEGER,
    CONSTRAINT securities_book_id_id_unique UNIQUE (book_id, id)
);
CREATE UNIQUE INDEX securities_name_symbol_book_unique ON securities (name, symbol, book_id);

CREATE TABLE security_prices (
    security_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    price_date TEXT NOT NULL,
    price_micros INTEGER NOT NULL,
    source TEXT,
    PRIMARY KEY (security_id, price_date),
    CONSTRAINT security_prices_book_security_fk FOREIGN KEY (book_id, security_id)
        REFERENCES securities (book_id, id) ON DELETE CASCADE
);

CREATE TABLE investment_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL,
    account_id INTEGER,
    security_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    shares_micros INTEGER NOT NULL,
    price_micros INTEGER NOT NULL,
    fees_cents INTEGER NOT NULL DEFAULT 0,
    split_numerator INTEGER,
    split_denominator INTEGER,
    CONSTRAINT investment_splits_book_account_fk FOREIGN KEY (book_id, account_id)
        REFERENCES accounts (book_id, id) ON DELETE CASCADE,
    CONSTRAINT investment_splits_book_security_fk FOREIGN KEY (book_id, security_id)
        REFERENCES securities (book_id, id) ON DELETE CASCADE,
    CONSTRAINT investment_splits_book_transaction_fk FOREIGN KEY (book_id, transaction_id)
        REFERENCES transactions (book_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_investment_splits_account_txn ON investment_splits (account_id, transaction_id);
CREATE INDEX idx_investment_splits_security_txn ON investment_splits (security_id, transaction_id);
CREATE INDEX idx_investment_splits_txn ON investment_splits (transaction_id);

CREATE TABLE investment_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    security_id INTEGER NOT NULL REFERENCES securities (id) ON DELETE CASCADE,
    opened_transaction_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    closed_transaction_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    acquired_date TEXT NOT NULL,
    opened_split_id INTEGER REFERENCES investment_splits (id) ON DELETE SET NULL,
    original_shares_micros INTEGER NOT NULL,
    original_basis_cents INTEGER NOT NULL,
    remaining_shares_micros INTEGER NOT NULL,
    remaining_basis_cents INTEGER NOT NULL
);
CREATE INDEX idx_investment_lots_open ON investment_lots (security_id, remaining_shares_micros);
CREATE UNIQUE INDEX idx_investment_lots_opened_split_unique ON investment_lots (opened_split_id);
CREATE INDEX idx_investment_lots_pair ON investment_lots (book_id, account_id, security_id);

CREATE TABLE investment_lot_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    lot_id INTEGER NOT NULL REFERENCES investment_lots (id) ON DELETE CASCADE,
    sell_split_id INTEGER NOT NULL REFERENCES investment_splits (id) ON DELETE CASCADE,
    transaction_id INTEGER NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    shares_micros INTEGER NOT NULL,
    basis_cents INTEGER NOT NULL,
    proceeds_cents INTEGER NOT NULL
);
CREATE INDEX idx_lot_allocations_book_txn ON investment_lot_allocations (book_id, transaction_id);
CREATE INDEX idx_lot_allocations_lot ON investment_lot_allocations (lot_id);
CREATE INDEX idx_lot_allocations_sell ON investment_lot_allocations (sell_split_id);

CREATE TABLE plaid_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    financial_institution TEXT NOT NULL,
    item_id TEXT NOT NULL,
    access_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sync_cursor TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
);
CREATE UNIQUE INDEX plaid_tokens_item_id_unique ON plaid_tokens (item_id);

CREATE TABLE plaid_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    token_id INTEGER NOT NULL REFERENCES plaid_tokens (id) ON DELETE CASCADE,
    plaid_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    official_name TEXT,
    mask TEXT,
    type TEXT NOT NULL,
    subtype TEXT,
    counterpoise_account_id INTEGER REFERENCES accounts (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX plaid_accounts_counterpoise_account_id_unique ON plaid_accounts (counterpoise_account_id);
CREATE UNIQUE INDEX plaid_accounts_plaid_account_id_unique ON plaid_accounts (plaid_account_id);
CREATE INDEX idx_plaid_accounts_token ON plaid_accounts (token_id);

CREATE TABLE plaid_transaction_reconciliation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    plaid_account_link_id INTEGER NOT NULL REFERENCES plaid_accounts (id) ON DELETE CASCADE,
    plaid_transaction_id TEXT NOT NULL,
    date TEXT NOT NULL,
    authorized_date TEXT,
    amount_cents INTEGER NOT NULL,
    name TEXT NOT NULL,
    merchant_name TEXT,
    original_description TEXT,
    pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
    pending_transaction_id TEXT,
    iso_currency_code TEXT,
    unofficial_currency_code TEXT,
    category_primary TEXT,
    category_detailed TEXT,
    raw_json TEXT NOT NULL,
    resolution_status TEXT NOT NULL DEFAULT 'pending',
    review_reason TEXT,
    review_metadata_json TEXT,
    matched_transaction_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    resolved_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX plaid_recon_link_matched_txn_unique
    ON plaid_transaction_reconciliation (plaid_account_link_id, matched_transaction_id);
CREATE INDEX plaid_recon_link_status_idx
    ON plaid_transaction_reconciliation (plaid_account_link_id, resolution_status, review_reason);
CREATE UNIQUE INDEX plaid_recon_link_txn_unique
    ON plaid_transaction_reconciliation (plaid_account_link_id, plaid_transaction_id);

CREATE TABLE typesafe_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    reconciliation_id INTEGER NOT NULL,
    link_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    attempt TEXT NOT NULL,
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    status TEXT NOT NULL,
    choice TEXT,
    probabilities TEXT CHECK (json_valid(probabilities)),
    confidence TEXT CHECK (json_valid(confidence)),
    usage TEXT CHECK (json_valid(usage)),
    error_code TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    displayed_at TEXT,
    latency_ms INTEGER,
    answers TEXT CHECK (json_valid(answers))
);
CREATE INDEX typesafe_evaluation_age ON typesafe_evaluations (started_at);
CREATE UNIQUE INDEX typesafe_evaluation_input ON typesafe_evaluations (book_id, fingerprint);

CREATE TABLE typesafe_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    reconciliation_id INTEGER NOT NULL,
    evaluation_id INTEGER REFERENCES typesafe_evaluations (id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    transaction_id INTEGER,
    suggestion_visible INTEGER NOT NULL DEFAULT 0 CHECK (suggestion_visible IN (0, 1)),
    accepted_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (accepted_suggestion IN (0, 1)),
    active_review_ms INTEGER,
    decided_at TEXT NOT NULL,
    proposal_payee_kept INTEGER CHECK (proposal_payee_kept IN (0, 1)),
    proposal_category_kept INTEGER CHECK (proposal_category_kept IN (0, 1))
);
CREATE INDEX typesafe_decision_book ON typesafe_decisions (book_id, reconciliation_id);

CREATE TABLE typesafe_quotas (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, day)
);

CREATE TABLE typesafe_aggregates (
    book_id INTEGER PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
    counts TEXT NOT NULL CHECK (json_valid(counts))
);

-- Live-update hints. A trigger on each table that an open page shows counts
-- each row change per (book, table). The server reads the counters while a
-- page listens (GET /api/b/{bookId}/events) and tells the page which tables
-- changed. Every writer runs the triggers: the server, ledger-cli, the MCP
-- process and the sqlite3 shell. A rolled back write rolls back its count.
CREATE TABLE change_marks (
    book_id INTEGER NOT NULL,
    table_name TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (book_id, table_name)
) WITHOUT ROWID;

CREATE TRIGGER transactions_insert_mark AFTER INSERT ON transactions
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'transactions', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER transactions_update_mark AFTER UPDATE ON transactions
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'transactions', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'transactions', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER transactions_delete_mark AFTER DELETE ON transactions
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'transactions', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER transaction_splits_insert_mark AFTER INSERT ON transaction_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'transaction_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER transaction_splits_update_mark AFTER UPDATE ON transaction_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'transaction_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'transaction_splits', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER transaction_splits_delete_mark AFTER DELETE ON transaction_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'transaction_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER investment_splits_insert_mark AFTER INSERT ON investment_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'investment_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER investment_splits_update_mark AFTER UPDATE ON investment_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'investment_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'investment_splits', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER investment_splits_delete_mark AFTER DELETE ON investment_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'investment_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER investment_lots_insert_mark AFTER INSERT ON investment_lots
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'investment_lots', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER investment_lots_update_mark AFTER UPDATE ON investment_lots
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'investment_lots', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'investment_lots', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER investment_lots_delete_mark AFTER DELETE ON investment_lots
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'investment_lots', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER books_insert_mark AFTER INSERT ON books
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.id, 'books', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER books_update_mark AFTER UPDATE ON books
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.id, 'books', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.id, 'books', 1 WHERE OLD.id IS NOT NEW.id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER books_delete_mark AFTER DELETE ON books
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.id, 'books', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER book_members_insert_mark AFTER INSERT ON book_members
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'book_members', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER book_members_update_mark AFTER UPDATE ON book_members
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'book_members', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'book_members', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER book_members_delete_mark AFTER DELETE ON book_members
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'book_members', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER accounts_insert_mark AFTER INSERT ON accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER accounts_update_mark AFTER UPDATE ON accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'accounts', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER accounts_delete_mark AFTER DELETE ON accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER payees_insert_mark AFTER INSERT ON payees
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'payees', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER payees_update_mark AFTER UPDATE ON payees
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'payees', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'payees', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER payees_delete_mark AFTER DELETE ON payees
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'payees', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER securities_insert_mark AFTER INSERT ON securities
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'securities', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER securities_update_mark AFTER UPDATE ON securities
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'securities', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'securities', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER securities_delete_mark AFTER DELETE ON securities
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'securities', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER security_prices_insert_mark AFTER INSERT ON security_prices
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'security_prices', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER security_prices_update_mark AFTER UPDATE ON security_prices
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'security_prices', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'security_prices', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER security_prices_delete_mark AFTER DELETE ON security_prices
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'security_prices', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER recurring_rules_insert_mark AFTER INSERT ON recurring_rules
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'recurring_rules', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER recurring_rules_update_mark AFTER UPDATE ON recurring_rules
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'recurring_rules', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'recurring_rules', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER recurring_rules_delete_mark AFTER DELETE ON recurring_rules
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'recurring_rules', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER recurring_template_splits_insert_mark AFTER INSERT ON recurring_template_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'recurring_template_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER recurring_template_splits_update_mark AFTER UPDATE ON recurring_template_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'recurring_template_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'recurring_template_splits', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER recurring_template_splits_delete_mark AFTER DELETE ON recurring_template_splits
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'recurring_template_splits', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER plaid_accounts_insert_mark AFTER INSERT ON plaid_accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'plaid_accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER plaid_accounts_update_mark AFTER UPDATE ON plaid_accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'plaid_accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'plaid_accounts', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER plaid_accounts_delete_mark AFTER DELETE ON plaid_accounts
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'plaid_accounts', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

CREATE TRIGGER plaid_transaction_reconciliation_insert_mark AFTER INSERT ON plaid_transaction_reconciliation
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'plaid_transaction_reconciliation', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER plaid_transaction_reconciliation_update_mark AFTER UPDATE ON plaid_transaction_reconciliation
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (NEW.book_id, 'plaid_transaction_reconciliation', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
    INSERT INTO change_marks (book_id, table_name, version)
        SELECT OLD.book_id, 'plaid_transaction_reconciliation', 1 WHERE OLD.book_id IS NOT NEW.book_id
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;
CREATE TRIGGER plaid_transaction_reconciliation_delete_mark AFTER DELETE ON plaid_transaction_reconciliation
BEGIN
    INSERT INTO change_marks (book_id, table_name, version) VALUES (OLD.book_id, 'plaid_transaction_reconciliation', 1)
        ON CONFLICT (book_id, table_name) DO UPDATE SET version = version + 1;
END;

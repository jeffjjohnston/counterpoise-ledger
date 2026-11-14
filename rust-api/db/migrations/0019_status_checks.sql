-- CHECK constraints for four status columns that accepted any text:
--
--   issue_reports.status                                new | resolved | wontfix
--   typesafe_evaluations.status                         pending | ready | skipped | error | stale
--   plaid_transaction_reconciliation.resolution_status  pending | matched | created | ignored
--   plaid_transaction_reconciliation.review_reason      NULL | plaid_modified | plaid_removed
--
-- SQLite cannot add a CHECK to a table, so each table is made again: create
-- the new table, copy the rows, drop the old table, rename the new table.
-- Each new table has the same columns in the same order, with the same
-- types, defaults and foreign keys. Only the CHECK clauses are new. The
-- indexes and triggers of a dropped table go with it, so this file makes
-- them again with the text of the migrations that first made them (0001,
-- 0006 and 0013).
--
-- The runner applies this file in one transaction with foreign keys on, and
-- a transaction cannot set them off. Thus:
--
--   * The copy fails when a row holds a value that is not in the lists above
--     (`CHECK constraint failed`). The transaction then rolls back, the
--     schema stays at version 18, and the server does not start.
--   * DROP TABLE deletes the rows of the table first, and that delete runs
--     the foreign key actions. typesafe_decisions.evaluation_id is the only
--     foreign key that points at one of these tables, and its action is ON
--     DELETE CASCADE. So that no decision is deleted, this file keeps the
--     references in a side table, sets them to NULL for the time of the
--     drop, and writes them back after the rename.
--   * The delete of a DROP TABLE fires no trigger, and a new table has no
--     trigger while the rows go in. Thus the change counts (change_marks) do
--     not move.
--
-- Each copy also carries the AUTOINCREMENT counter (sqlite_sequence) to the
-- new table. Without it, the counter would start again from the largest id
-- that is left, and the id of a deleted row could come back.

-- issue_reports

CREATE TABLE issue_reports_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'bug',
    page TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'resolved', 'wontfix')),
    created_at TEXT NOT NULL,
    github_issue_number INTEGER
);

INSERT INTO issue_reports_new
    (id, user_id, description, type, page, status, created_at, github_issue_number)
SELECT id, user_id, description, type, page, status, created_at, github_issue_number
FROM issue_reports;

DELETE FROM sqlite_sequence WHERE name = 'issue_reports_new';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'issue_reports_new', seq FROM sqlite_sequence WHERE name = 'issue_reports';

DROP TABLE issue_reports;
ALTER TABLE issue_reports_new RENAME TO issue_reports;

-- typesafe_evaluations

CREATE TABLE typesafe_decision_evaluations_0019 (
    decision_id INTEGER PRIMARY KEY,
    evaluation_id INTEGER NOT NULL
);
INSERT INTO typesafe_decision_evaluations_0019 (decision_id, evaluation_id)
    SELECT id, evaluation_id FROM typesafe_decisions WHERE evaluation_id IS NOT NULL;
UPDATE typesafe_decisions SET evaluation_id = NULL WHERE evaluation_id IS NOT NULL;

CREATE TABLE typesafe_evaluations_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    reconciliation_id INTEGER NOT NULL,
    link_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    attempt TEXT NOT NULL,
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'skipped', 'error', 'stale')),
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

INSERT INTO typesafe_evaluations_new
    (id, book_id, reconciliation_id, link_id, revision, fingerprint, attempt, snapshot, status,
     choice, probabilities, confidence, usage, error_code, started_at, completed_at,
     displayed_at, latency_ms, answers)
SELECT id, book_id, reconciliation_id, link_id, revision, fingerprint, attempt, snapshot, status,
     choice, probabilities, confidence, usage, error_code, started_at, completed_at,
     displayed_at, latency_ms, answers
FROM typesafe_evaluations;

DELETE FROM sqlite_sequence WHERE name = 'typesafe_evaluations_new';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'typesafe_evaluations_new', seq FROM sqlite_sequence
    WHERE name = 'typesafe_evaluations';

DROP TABLE typesafe_evaluations;
ALTER TABLE typesafe_evaluations_new RENAME TO typesafe_evaluations;

CREATE INDEX typesafe_evaluation_age ON typesafe_evaluations (started_at);
CREATE UNIQUE INDEX typesafe_evaluation_input ON typesafe_evaluations (book_id, fingerprint);

UPDATE typesafe_decisions
SET evaluation_id = (
    SELECT kept.evaluation_id FROM typesafe_decision_evaluations_0019 kept
    WHERE kept.decision_id = typesafe_decisions.id
)
WHERE id IN (SELECT decision_id FROM typesafe_decision_evaluations_0019);
DROP TABLE typesafe_decision_evaluations_0019;

-- plaid_transaction_reconciliation

CREATE TABLE plaid_transaction_reconciliation_new (
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
    resolution_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (resolution_status IN ('pending', 'matched', 'created', 'ignored')),
    review_reason TEXT CHECK (review_reason IN ('plaid_modified', 'plaid_removed')),
    review_metadata_json TEXT,
    matched_transaction_id INTEGER REFERENCES transactions (id) ON DELETE SET NULL,
    resolved_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    merchant_key TEXT
);

INSERT INTO plaid_transaction_reconciliation_new
    (id, book_id, plaid_account_link_id, plaid_transaction_id, date, authorized_date,
     amount_cents, name, merchant_name, original_description, pending, pending_transaction_id,
     iso_currency_code, unofficial_currency_code, category_primary, category_detailed, raw_json,
     resolution_status, review_reason, review_metadata_json, matched_transaction_id, resolved_at,
     first_seen_at, last_seen_at, created_at, updated_at, merchant_key)
SELECT id, book_id, plaid_account_link_id, plaid_transaction_id, date, authorized_date,
     amount_cents, name, merchant_name, original_description, pending, pending_transaction_id,
     iso_currency_code, unofficial_currency_code, category_primary, category_detailed, raw_json,
     resolution_status, review_reason, review_metadata_json, matched_transaction_id, resolved_at,
     first_seen_at, last_seen_at, created_at, updated_at, merchant_key
FROM plaid_transaction_reconciliation;

DELETE FROM sqlite_sequence WHERE name = 'plaid_transaction_reconciliation_new';
INSERT INTO sqlite_sequence (name, seq)
    SELECT 'plaid_transaction_reconciliation_new', seq FROM sqlite_sequence
    WHERE name = 'plaid_transaction_reconciliation';

DROP TABLE plaid_transaction_reconciliation;
ALTER TABLE plaid_transaction_reconciliation_new RENAME TO plaid_transaction_reconciliation;

CREATE UNIQUE INDEX plaid_recon_link_matched_txn_unique
    ON plaid_transaction_reconciliation (plaid_account_link_id, matched_transaction_id);
CREATE INDEX plaid_recon_link_status_idx
    ON plaid_transaction_reconciliation (plaid_account_link_id, resolution_status, review_reason);
CREATE UNIQUE INDEX plaid_recon_link_txn_unique
    ON plaid_transaction_reconciliation (plaid_account_link_id, plaid_transaction_id);
CREATE INDEX plaid_transaction_reconciliation_book_merchant_key
    ON plaid_transaction_reconciliation (book_id, merchant_key);

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

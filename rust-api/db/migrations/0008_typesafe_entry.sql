-- TypeSafe entry suggestions (guides/typesafe-experiment.md). A second
-- opt-in beside the reconciliation one; both share typesafe_revision.
ALTER TABLE books ADD COLUMN typesafe_entry_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (typesafe_entry_enabled IN (0, 1));

-- account_id and payee_id have no foreign key: a record must not block a
-- delete of the account or the payee.
CREATE TABLE typesafe_entry_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL,
    payee_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    attempt TEXT NOT NULL,
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'skipped', 'error', 'stale')),
    choice TEXT,
    probabilities TEXT CHECK (json_valid(probabilities)),
    confidence REAL,
    usage TEXT CHECK (json_valid(usage)),
    error_code TEXT,
    baseline_key TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    latency_ms INTEGER
);
CREATE UNIQUE INDEX typesafe_entry_evaluation_input
    ON typesafe_entry_evaluations (book_id, fingerprint);
CREATE INDEX typesafe_entry_evaluation_age ON typesafe_entry_evaluations (started_at);

-- SET NULL, not CASCADE: the cleanup counts and deletes old evaluations and
-- old outcomes apart, and a newer outcome must survive its evaluation.
CREATE TABLE typesafe_entry_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    evaluation_id INTEGER REFERENCES typesafe_entry_evaluations (id) ON DELETE SET NULL,
    outcome TEXT NOT NULL
        CHECK (outcome IN ('kept', 'changed_amount', 'picked_other', 'changed_accounts', 'abandoned')),
    source TEXT NOT NULL CHECK (source IN ('history', 'typesafe')),
    chip_visible INTEGER NOT NULL CHECK (chip_visible IN (0, 1)),
    picked_index INTEGER,
    transaction_id INTEGER,
    decided_at TEXT NOT NULL
);
CREATE INDEX typesafe_entry_outcome_age ON typesafe_entry_outcomes (decided_at);

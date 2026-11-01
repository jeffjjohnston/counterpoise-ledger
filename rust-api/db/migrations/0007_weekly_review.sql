-- The weekly review (guides/weekly-review.md): a scheduled Claude review of
-- the week of a book. Each book opts in. Only the server writes the two
-- tables, so they have no cross-book triggers.

ALTER TABLE books ADD COLUMN weekly_review_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (weekly_review_enabled IN (0, 1));
ALTER TABLE books ADD COLUMN weekly_review_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE weekly_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- Not "trigger": that is an SQL keyword.
    source TEXT NOT NULL CHECK (source IN ('schedule', 'manual')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    summary TEXT,
    error TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    -- weekly_review_revision of the book when the run started.
    revision INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    CONSTRAINT weekly_reviews_book_id_id_unique UNIQUE (book_id, id)
);
CREATE UNIQUE INDEX weekly_reviews_one_running ON weekly_reviews (book_id)
    WHERE status = 'running';
CREATE INDEX weekly_reviews_book_started ON weekly_reviews (book_id, started_at);

CREATE TABLE weekly_review_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    review_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('check', 'insight')),
    category TEXT NOT NULL CHECK (category IN (
        'duplicate', 'missed_payment', 'unusual_amount', 'price_change',
        'new_recurring', 'spending_change', 'other')),
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    transaction_ids TEXT NOT NULL CHECK (json_valid(transaction_ids)),
    -- No foreign key: the item is a record, and a deleted rule must not
    -- delete it.
    recurring_rule_id INTEGER,
    fingerprint TEXT NOT NULL,
    dismissed_at TEXT,
    dismissed_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT weekly_review_items_review_fk FOREIGN KEY (book_id, review_id)
        REFERENCES weekly_reviews (book_id, id) ON DELETE CASCADE
);
CREATE INDEX weekly_review_items_review ON weekly_review_items (review_id, position);
CREATE INDEX weekly_review_items_dismissed ON weekly_review_items (book_id, fingerprint)
    WHERE dismissed_at IS NOT NULL;

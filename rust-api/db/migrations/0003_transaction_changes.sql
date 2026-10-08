-- The transaction change log, for the delta sync of a native client
-- (GET /api/b/{bookId}/transactions/changes).
--
-- Each change to a transaction, a split or an investment split adds one row
-- with the book and the ID of the transaction. A split row logs the ID of its
-- parent transaction. An UPDATE that moves a row to a different transaction
-- or book logs the old and the new values. A client keeps the newest seq that
-- it read, and later reads the transactions with a larger seq. A logged
-- transaction that is not in `transactions` is deleted, so the log has no
-- operation column.
--
-- Every writer runs the triggers: the server, ledger-cli, the MCP process and
-- the sqlite3 shell. A rolled back write rolls back its log rows. SQLite has
-- one writer at a time, so the seq order is the commit order.
--
-- A client with no cursor downloads the full book, which gives it a cursor.
-- Nothing prunes the log: each row is three integers. The table has no
-- foreign key, so a deleted book keeps its rows.
--
-- A row with book_id 0 is a floor marker, not a change. A cursor below the
-- newest marker is from before a restore, and the route answers 410. Each
-- snapshot gets a marker above its newest seq (ledger_db::backup). This
-- migration starts the log with a marker at the current time in
-- microseconds. Thus, when a snapshot from before this migration is
-- restored, the migration runs again with a larger time, and the cursors
-- from before the restore are below the new marker.
CREATE TABLE transaction_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    transaction_id INTEGER NOT NULL
);
CREATE INDEX idx_transaction_changes_book_seq ON transaction_changes (book_id, seq);
INSERT INTO transaction_changes (seq, book_id, transaction_id)
    VALUES (unixepoch() * 1000000, 0, 0);

CREATE TRIGGER transactions_insert_change AFTER INSERT ON transactions
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id) VALUES (NEW.book_id, NEW.id);
END;
CREATE TRIGGER transactions_update_change AFTER UPDATE ON transactions
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id) VALUES (NEW.book_id, NEW.id);
    INSERT INTO transaction_changes (book_id, transaction_id)
        SELECT OLD.book_id, OLD.id WHERE OLD.book_id IS NOT NEW.book_id OR OLD.id IS NOT NEW.id;
END;
CREATE TRIGGER transactions_delete_change AFTER DELETE ON transactions
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id) VALUES (OLD.book_id, OLD.id);
END;

CREATE TRIGGER transaction_splits_insert_change AFTER INSERT ON transaction_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (NEW.book_id, NEW.transaction_id);
END;
CREATE TRIGGER transaction_splits_update_change AFTER UPDATE ON transaction_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (NEW.book_id, NEW.transaction_id);
    INSERT INTO transaction_changes (book_id, transaction_id)
        SELECT OLD.book_id, OLD.transaction_id
        WHERE OLD.book_id IS NOT NEW.book_id OR OLD.transaction_id IS NOT NEW.transaction_id;
END;
CREATE TRIGGER transaction_splits_delete_change AFTER DELETE ON transaction_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (OLD.book_id, OLD.transaction_id);
END;

CREATE TRIGGER investment_splits_insert_change AFTER INSERT ON investment_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (NEW.book_id, NEW.transaction_id);
END;
CREATE TRIGGER investment_splits_update_change AFTER UPDATE ON investment_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (NEW.book_id, NEW.transaction_id);
    INSERT INTO transaction_changes (book_id, transaction_id)
        SELECT OLD.book_id, OLD.transaction_id
        WHERE OLD.book_id IS NOT NEW.book_id OR OLD.transaction_id IS NOT NEW.transaction_id;
END;
CREATE TRIGGER investment_splits_delete_change AFTER DELETE ON investment_splits
BEGIN
    INSERT INTO transaction_changes (book_id, transaction_id)
        VALUES (OLD.book_id, OLD.transaction_id);
END;

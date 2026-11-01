-- Folded copies of the text that a lookup or search compares without letter
-- case. The app writes each one with ledger_core::names::fold() (Unicode
-- lowercase) on every insert and update: SQLite's built-in lower() folds
-- ASCII only, and a host without the app's SQL functions has no other. The
-- server's startup guard (ledger_db::folds) fills these new columns and
-- repairs any fold that no longer matches its column, such as after an edit
-- in the sqlite3 shell; `ledger-cli repair-folds` runs it by hand.
ALTER TABLE transactions ADD COLUMN description_fold TEXT;
ALTER TABLE transactions ADD COLUMN notes_fold TEXT;
ALTER TABLE transactions ADD COLUMN check_number_fold TEXT;
ALTER TABLE payees ADD COLUMN name_fold TEXT;
ALTER TABLE accounts ADD COLUMN name_fold TEXT;
ALTER TABLE securities ADD COLUMN symbol_fold TEXT;
ALTER TABLE recurring_rules ADD COLUMN name_fold TEXT;
ALTER TABLE recurring_rules ADD COLUMN template_description_fold TEXT;

-- Only the equality lookups use an index. The searches match a substring,
-- which no index serves.
CREATE INDEX payees_book_name_fold ON payees (book_id, name_fold);
CREATE INDEX securities_book_symbol_fold ON securities (book_id, symbol_fold);

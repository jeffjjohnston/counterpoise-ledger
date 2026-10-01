-- A covering index for the balance sums of one book.
--
-- The account list sums the splits of a book per account
-- (`WHERE book_id = ? GROUP BY account_id`), and the income statement sums
-- the splits of each income and expense account. Without this index, SQLite
-- reads each split row from the table, in account order, and the book filter
-- keeps only some of them. With it, both queries read the index only, in
-- the order that the GROUP BY needs. transaction_id is in the index so that
-- a query with a date filter can find the transaction without the split row.
--
-- On a copy of a production book (81,308 splits), the balance query of the
-- account list went from 14 ms to 2.4 ms.
CREATE INDEX idx_transaction_splits_book_account
    ON transaction_splits (book_id, account_id, transaction_id, amount);

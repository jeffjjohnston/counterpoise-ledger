-- The payee list (list_payees in rust-api/server/src/routes/payees.rs)
-- joins each transaction of the book to count the transactions of each
-- payee and to find the last effective date. The effective date needs
-- is_floating, and idx_transactions_payee_date_id did not hold it, so
-- each transaction was read from the table.
--
-- This index replaces it. Its first three columns are the same, in the same
-- order, so every query that used the old index can use this one. The added
-- is_floating makes the index cover the payee list. One index in place of
-- two keeps the cost of a write the same.
DROP INDEX idx_transactions_payee_date_id;
CREATE INDEX idx_transactions_payee_date_id_floating
    ON transactions (payee_id, date, id, is_floating);

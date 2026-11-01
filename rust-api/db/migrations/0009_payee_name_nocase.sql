-- A payee name matches without letter case: "IKEA" and "Ikea" are one payee
-- (guides/patterns-and-gotchas.md). find_payee_by_name() applies the rule
-- with the app's Unicode lower(). This index is the backstop for ASCII case:
-- NOCASE is built into SQLite, so every tool that writes the file keeps it
-- valid. Run `ledger-cli merge-payee-case` first on a database that still has
-- case-only duplicates, or this migration stops.
CREATE UNIQUE INDEX payees_book_name_nocase ON payees (book_id, name COLLATE NOCASE);

//! The `*_fold` columns (migration 0012): a case-folded copy of each text
//! column that a lookup or search compares without letter case. Also the
//! merchant key of a staged Plaid row (migration 0013), which the same rules
//! keep.
//!
//! Every write path stores the fold with [`fold`] beside its column, and the
//! merchant key with [`merchant_key`]. They are derived state, so a missed
//! write path or an edit in the sqlite3 shell leaves one stale. [`repair`] recomputes every fold and rewrites the
//! ones that differ: the server runs it at startup, after the migrations, and
//! `ledger-cli repair-folds` runs it by hand. [`check`] counts the stale folds
//! without writing; the test suites assert that it finds none.

use crate::store::{Database, Error, Row, Sql, params};
pub use ledger_core::names::{fold, merchant_key};

/// One derived column: its table, the columns it is computed from, the
/// column that stores it, and the computation.
#[derive(Clone, Copy, Debug)]
pub struct FoldColumn {
    pub table: &'static str,
    pub sources: &'static [&'static str],
    pub fold: &'static str,
    pub compute: fn(&[Option<String>]) -> Option<String>,
}

fn fold_first(sources: &[Option<String>]) -> Option<String> {
    fold_option(sources[0].as_deref())
}

fn merchant_key_of(sources: &[Option<String>]) -> Option<String> {
    sources[1]
        .as_deref()
        .map(|name| merchant_key(sources[0].as_deref(), name))
}

const fn column(
    table: &'static str,
    sources: &'static [&'static str],
    fold: &'static str,
) -> FoldColumn {
    FoldColumn {
        table,
        sources,
        fold,
        compute: fold_first,
    }
}

/// Every derived column. Each table has an integer `id`.
pub const FOLD_COLUMNS: [FoldColumn; 9] = [
    column("transactions", &["description"], "description_fold"),
    column("transactions", &["notes"], "notes_fold"),
    column("transactions", &["check_number"], "check_number_fold"),
    column("payees", &["name"], "name_fold"),
    column("accounts", &["name"], "name_fold"),
    column("securities", &["symbol"], "symbol_fold"),
    column("recurring_rules", &["name"], "name_fold"),
    column(
        "recurring_rules",
        &["template_description"],
        "template_description_fold",
    ),
    FoldColumn {
        table: "plaid_transaction_reconciliation",
        sources: &["merchant_name", "name"],
        fold: "merchant_key",
        compute: merchant_key_of,
    },
];

/// The fold of a column that may be NULL: NULL stays NULL.
pub fn fold_option(text: Option<&str>) -> Option<String> {
    text.map(fold)
}

/// A fold that differs from its column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaleFold {
    pub table: &'static str,
    pub fold: &'static str,
    pub id: i64,
    pub expected: Option<String>,
}

/// The stale folds of one column.
fn stale(sql: &impl Sql, column: FoldColumn) -> Result<Vec<StaleFold>, Error> {
    let select = format!(
        "SELECT id, {fold}, {sources} FROM {table}",
        sources = column.sources.join(", "),
        fold = column.fold,
        table = column.table,
    );
    let mut stale = Vec::new();
    for row in sql.query::<Row>(&select, &[])? {
        let sources = (0..column.sources.len())
            .map(|index| row.get(2 + index))
            .collect::<Result<Vec<Option<String>>, _>>()?;
        let stored: Option<String> = row.get(1)?;
        let expected = (column.compute)(&sources);
        if stored != expected {
            stale.push(StaleFold {
                table: column.table,
                fold: column.fold,
                id: row.get(0)?,
                expected,
            });
        }
    }
    Ok(stale)
}

/// Every stale fold in the file. Writes nothing.
pub fn check(database: &Database) -> Result<Vec<StaleFold>, Error> {
    let mut all = Vec::new();
    for column in FOLD_COLUMNS {
        all.extend(stale(database, column)?);
    }
    Ok(all)
}

/// Rewrites every stale fold in one write transaction, and returns how many
/// it rewrote. After migration 0012 every fold is NULL, so the first start
/// fills them all.
///
/// A fold is not data a client reads, so the repair leaves no trace in the
/// change logs: it removes the `transaction_changes` rows and restores the
/// `change_marks` versions that its updates' triggers wrote. Otherwise the
/// first start after 0012 would log every transaction, and each native
/// client would download its whole book on the next delta sync. The
/// transaction holds the write lock, so no other writer's rows fall in
/// between.
pub fn repair(database: &Database) -> Result<usize, Error> {
    database.transaction(|tx| {
        let last_change: i64 =
            tx.query_row("SELECT coalesce(max(seq), 0) FROM transaction_changes", &[])?;
        let marks: Vec<(i64, String, i64)> =
            tx.query("SELECT book_id, table_name, version FROM change_marks", &[])?;
        let mut repaired = 0;
        for column in FOLD_COLUMNS {
            let rows = stale(tx, column)?;
            let update = format!(
                "UPDATE {table} SET {fold} = ?1 WHERE id = ?2",
                table = column.table,
                fold = column.fold,
            );
            for row in &rows {
                tx.execute(&update, &params![row.expected.as_deref(), row.id])?;
            }
            repaired += rows.len();
        }
        if repaired > 0 {
            tx.execute(
                "DELETE FROM transaction_changes WHERE seq > ?1",
                &params![last_change],
            )?;
            tx.execute("DELETE FROM change_marks", &[])?;
            for (book_id, table_name, version) in &marks {
                tx.execute(
                    "INSERT INTO change_marks (book_id, table_name, version) VALUES (?1, ?2, ?3)",
                    &params![*book_id, table_name, *version],
                )?;
            }
        }
        Ok(repaired)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDatabase;

    const BOOK: &str = "INSERT INTO users (id, username, password_hash, created_at)
           VALUES (1, 'u', 'x', '2026-01-01 00:00:00');
         INSERT INTO books (id, user_id, name, created_at, updated_at)
           VALUES (1, 1, 'B', '2026-01-01 00:00:00', '2026-01-01 00:00:00');";

    #[test]
    fn repair_fills_and_corrects_the_folds() {
        let file = TempDatabase::new();
        let database = file.database();
        database.exec_batch(BOOK).unwrap();
        database
            .exec_batch(
                "INSERT INTO payees (book_id, name, name_fold, created_at) VALUES
                 (1, 'ÉCOLE', NULL, '2026-01-01 00:00:00'),
                 (1, 'Straße', 'wrong', '2026-01-01 00:00:00'),
                 (1, 'ok', 'ok', '2026-01-01 00:00:00')",
            )
            .unwrap();

        assert_eq!(check(database).unwrap().len(), 2);
        assert_eq!(repair(database).unwrap(), 2);
        assert!(check(database).unwrap().is_empty());
        let folds: Vec<String> = database
            .query("SELECT name_fold FROM payees ORDER BY id", &[])
            .unwrap();
        assert_eq!(folds, ["école", "straße", "ok"]);
    }

    #[test]
    fn repair_leaves_no_trace_in_the_change_logs() {
        let file = TempDatabase::new();
        let database = file.database();
        database.exec_batch(BOOK).unwrap();
        database
            .exec_batch(
                "INSERT INTO transactions (book_id, date, description, created_at, updated_at)
                 VALUES (1, '2026-01-02', 'CAFÉ', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
            )
            .unwrap();
        let changes = "SELECT seq, book_id, transaction_id FROM transaction_changes ORDER BY seq";
        let marks = "SELECT book_id, table_name, version FROM change_marks ORDER BY 1, 2";
        let changes_before: Vec<(i64, i64, i64)> = database.query(changes, &[]).unwrap();
        let marks_before: Vec<(i64, String, i64)> = database.query(marks, &[]).unwrap();

        assert!(repair(database).unwrap() > 0);
        assert!(check(database).unwrap().is_empty());
        let changes_after: Vec<(i64, i64, i64)> = database.query(changes, &[]).unwrap();
        let marks_after: Vec<(i64, String, i64)> = database.query(marks, &[]).unwrap();
        assert_eq!(changes_after, changes_before);
        assert_eq!(marks_after, marks_before);
    }
}

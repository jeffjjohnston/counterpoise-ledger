//! A throwaway database for tests: a new file with the migrations applied,
//! removed when the value drops.

use crate::{database::sidecar, store::Sql};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// A migrated database in a new file under the temporary directory.
pub struct TempDatabase {
    path: PathBuf,
    database: crate::Database,
}

impl TempDatabase {
    /// Creates the file and applies the migrations.
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "counterpoise-test-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        remove(&path);
        let database = crate::Database::open(&path, true).expect("create a test database");
        crate::migrate(&database).expect("migrate a test database");
        Self { path, database }
    }

    /// The database on the file. Another connection is
    /// `Database::open(self.path(), false)`.
    pub fn database(&self) -> &crate::Database {
        &self.database
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Default for TempDatabase {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        remove(&self.path);
    }
}

fn remove(path: &Path) {
    for suffix in ["", "-wal", "-shm", ".lock"] {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
}

/// The lots and allocations of the file, without the IDs and times that a
/// rebuild renews: what a second rebuild must leave as it was.
pub fn lot_rows(database: &crate::Database) -> String {
    database
        .query_row(
            "SELECT
               coalesce((SELECT group_concat(row, ';') FROM (SELECT concat_ws(',', book_id,
                  account_id, security_id, opened_split_id, closed_transaction_id,
                  acquired_date, original_shares_micros, original_basis_cents,
                  remaining_shares_micros, remaining_basis_cents) AS row
                FROM investment_lots ORDER BY opened_split_id)), '')
               || '|' ||
               coalesce((SELECT group_concat(row, ';') FROM (SELECT concat_ws(',', a.book_id,
                  l.opened_split_id, a.sell_split_id, a.shares_micros, a.basis_cents,
                  a.proceeds_cents) AS row
                FROM investment_lot_allocations a JOIN investment_lots l ON l.id = a.lot_id
                ORDER BY l.opened_split_id, a.sell_split_id)), '')",
            &[],
        )
        .unwrap()
}

#[cfg(test)]
mod tests {
    use crate::store::Sql;

    #[test]
    fn issue_reports_has_a_nullable_github_issue_number() {
        let database = crate::testing::TempDatabase::new();
        let row: (String, i64) = database
            .database()
            .query_row(
                "SELECT type, \"notnull\" FROM pragma_table_info('issue_reports') \
                 WHERE name = 'github_issue_number'",
                &[],
            )
            .expect("the column exists");
        assert_eq!(row, ("INTEGER".to_owned(), 0));
    }
}

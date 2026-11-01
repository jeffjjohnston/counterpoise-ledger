//! The database file: its pragma values, the file lock of the server, and
//! the safe publication of a new file. `engine.rs` opens it; the migrations
//! are in `migrations.rs`.

use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

/// How long a writer waits for another writer before SQLite reports
/// `SQLITE_BUSY`.
pub const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The largest part of the file, in bytes, that each connection reads through
/// a memory map (`PRAGMA mmap_size`).
///
/// Without a map, each connection copies the pages that it reads into its
/// own page cache of 2 MB. A query whose pages do not fit then reads each
/// page from the operating system again on each run. On a copy of a
/// production database (16 MB), a balance query that joins each split to its
/// transaction took 100 ms with the default cache and 21 ms with the map. The
/// connections share the mapped pages, so the memory cost is at most the size
/// of the file, and not the size of the file for each connection. A file that
/// is larger than the map is read without the map after this limit.
pub const MMAP_SIZE: i64 = 256 * 1024 * 1024;

/// The lock that keeps a second server off the same database file. It holds
/// while the value lives.
pub struct ServerLock {
    _file: File,
}

/// Takes the server lock of the database at `path`, or refuses when another
/// process holds it. The lock is `<path>.lock`, beside the database.
pub fn lock_server(path: &Path) -> Result<ServerLock, String> {
    let lock_path = sidecar(path, ".lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|cause| format!("cannot open {}: {cause}", lock_path.display()))?;
    file.try_lock().map_err(|cause| match cause {
        std::fs::TryLockError::WouldBlock => format!(
            "another server uses {} ({} is locked); only one server may open a database",
            path.display(),
            lock_path.display()
        ),
        std::fs::TryLockError::Error(cause) => {
            format!("cannot lock {}: {cause}", lock_path.display())
        }
    })?;
    Ok(ServerLock { _file: file })
}

/// Gives the complete file `from` the name `to`, and never replaces a file
/// that already has the name `to`.
///
/// It syncs `from` to the disk, makes the hard link `to` (the operating
/// system refuses the link when `to` exists, so a file that another process
/// made after the caller looked is not replaced), removes the name `from`,
/// and syncs the directory, so that the new name survives a power loss. A
/// `rename` would replace `to` without a message.
pub fn publish_file(from: &Path, to: &Path) -> Result<(), String> {
    File::open(from)
        .and_then(|file| file.sync_all())
        .map_err(|cause| format!("cannot sync {}: {cause}", from.display()))?;
    std::fs::hard_link(from, to).map_err(|cause| {
        if cause.kind() == std::io::ErrorKind::AlreadyExists {
            format!(
                "{} exists; it was not replaced, and {} is kept",
                to.display(),
                from.display()
            )
        } else {
            format!(
                "cannot link {} to {}: {cause}",
                from.display(),
                to.display()
            )
        }
    })?;
    std::fs::remove_file(from)
        .map_err(|cause| format!("cannot remove {}: {cause}", from.display()))?;
    sync_directory(to)
}

/// Syncs the directory that holds `path`, so that a new or removed name in
/// it survives a power loss.
pub fn sync_directory(path: &Path) -> Result<(), String> {
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|cause| format!("cannot sync the directory {}: {cause}", directory.display()))
}

/// `<path><suffix>`: a file beside the database.
pub(crate) fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use crate::store::{Database, Error, Sql, params};
    use crate::testing::TempDatabase;

    /// The migration starts the transaction change log with a floor marker
    /// (book 0) at the current time in microseconds. A restore of a snapshot
    /// from before the migration runs it again with a larger time.
    #[test]
    fn the_change_log_starts_at_a_floor_of_the_current_time() {
        let before = chrono::Utc::now().timestamp() * 1_000_000;
        let database = TempDatabase::new();
        let after = chrono::Utc::now().timestamp() * 1_000_000;
        let rows: Vec<(i64, i64, i64)> = database
            .database()
            .query(
                "SELECT seq, book_id, transaction_id FROM transaction_changes",
                &[],
            )
            .unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        let (seq, book_id, transaction_id) = rows[0];
        assert_eq!((book_id, transaction_id), (0, 0));
        assert!(
            (before..=after).contains(&seq),
            "{seq} not in {before}..={after}"
        );
    }

    /// No app function is registered: lower() and LIKE are SQLite's own, as
    /// on a Durable Object.
    #[test]
    fn a_connection_has_only_the_builtin_functions() {
        let file = TempDatabase::new();
        let builtins: (String, i64) = file
            .database()
            .query_row("SELECT lower('ÉCLAIR'), 'A' LIKE 'a' ESCAPE '\\'", &[])
            .unwrap();
        assert_eq!(builtins, ("Éclair".to_owned(), 1));
    }

    /// The bulk form that stays under the limit of 100 parameters: 2,000
    /// rows from one parameter, in order.
    #[test]
    fn json_rows_inserts_any_number_of_rows_from_one_parameter() {
        let file = TempDatabase::new();
        let database = file.database();
        database
            .exec_batch("CREATE TABLE bulk (id INTEGER PRIMARY KEY, n INTEGER, t TEXT, z TEXT)")
            .unwrap();
        let rows: Vec<(i64, String, Option<String>)> = (0..2_000)
            .map(|n| (n * 9_007_199_254, format!("row {n}"), None))
            .collect();
        database
            .execute(
                &format!(
                    "INSERT INTO bulk (n, t, z) {}",
                    crate::sql::json_rows(&["#0", "#1", "#2"], "?1")
                ),
                &params![crate::sql::json_array(&rows)],
            )
            .unwrap();
        let stored: Vec<(i64, i64, String, Option<String>)> = database
            .query("SELECT id, n, t, z FROM bulk ORDER BY id", &[])
            .unwrap();
        assert_eq!(stored.len(), 2_000);
        for (index, (id, n, t, z)) in stored.into_iter().enumerate() {
            assert_eq!(id, index as i64 + 1);
            assert_eq!((n, t, z), (rows[index].0, rows[index].1.clone(), None));
        }
    }

    /// Writers on many connections at once, as the server, the MCP stdio
    /// process and `ledger-cli` are: each opens `BEGIN IMMEDIATE`, waits for
    /// the others, and none fails with `SQLITE_BUSY`.
    #[test]
    fn parallel_write_transactions_all_commit() {
        let file = TempDatabase::new();
        let now = chrono::Utc::now().naive_utc();
        file.database()
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2026-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2026-01-01 00:00:00', '2026-01-01 00:00:00');",
            )
            .unwrap();
        let writers: Vec<_> = (0..8)
            .map(|thread| {
                let path = file.path().to_owned();
                std::thread::spawn(move || {
                    let database = Database::open(&path, false)?;
                    for index in 0..4 {
                        database.transaction(|tx| {
                            // A read, then a write that depends on it: the
                            // pattern that fails with SQLITE_BUSY under a
                            // deferred BEGIN.
                            let count: i64 = tx.query_row("SELECT COUNT(*) FROM payees", &[])?;
                            std::thread::yield_now();
                            tx.execute(
                                "INSERT INTO payees (book_id, name, created_at) VALUES (1, ?1, ?2)",
                                &params![format!("Payee {thread}.{index} after {count}"), now],
                            )
                        })?;
                    }
                    Ok::<_, Error>(())
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        let database = file.database();
        let count: i64 = database
            .query_row("SELECT COUNT(*) FROM payees", &[])
            .unwrap();
        assert_eq!(count, 32);
        let violations: i64 = database
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", &[])
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn publish_file_never_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("counterpoise-publish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("new.db.partial");
        let to = dir.join("new.db");
        std::fs::write(&from, b"new").unwrap();
        // Another process made the name after the caller looked.
        std::fs::write(&to, b"old").unwrap();
        let refused = super::publish_file(&from, &to);
        assert!(
            refused
                .as_ref()
                .is_err_and(|message| message.contains("was not replaced")),
            "{refused:?}"
        );
        assert_eq!(std::fs::read(&to).unwrap(), b"old");
        assert_eq!(std::fs::read(&from).unwrap(), b"new");

        std::fs::remove_file(&to).unwrap();
        super::publish_file(&from, &to).unwrap();
        assert_eq!(std::fs::read(&to).unwrap(), b"new");
        assert!(!from.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_second_server_lock_on_one_file_is_refused() {
        let path =
            std::env::temp_dir().join(format!("counterpoise-lock-{}.db", std::process::id()));
        let first = super::lock_server(&path).unwrap();
        let second = super::lock_server(&path);
        assert!(second.is_err_and(|message| message.contains("another server")));
        drop(first);
        assert!(super::lock_server(&path).is_ok());
        let _ = std::fs::remove_file(super::sidecar(&path, ".lock"));
    }
}

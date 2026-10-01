//! Opening the database file: pragmas, SQL functions, the file lock of the
//! server, and the embedded migrations.

use crate::{engine::DbPool, functions};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

/// The schema migrations, embedded in each binary from `rust-api/db/migrations`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

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

/// What a caller of [`open`] wants.
pub struct Open<'a> {
    pub path: &'a Path,
    pub max_connections: u32,
    /// Create the file when it is missing. Only a process that then applies
    /// the migrations should create it.
    pub create: bool,
}

/// Opens a pool on the database file. Each connection uses WAL, foreign keys,
/// a busy timeout of five seconds, `synchronous=FULL` and a memory map of
/// [`MMAP_SIZE`], and registers the SQL functions of [`functions`]. The pool
/// connects lazily.
///
/// `synchronous=FULL`: each commit syncs the WAL to the disk before it
/// returns. With `NORMAL`, a commit that returned can be lost when the power
/// fails or the machine stops. This is a ledger: a lost commit is a lost
/// transaction, so the cost of one sync for each commit is correct.
pub fn open(open: Open<'_>) -> Result<DbPool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(open.path)
        .create_if_missing(open.create)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(BUSY_TIMEOUT)
        .synchronous(SqliteSynchronous::Full)
        .pragma("mmap_size", MMAP_SIZE.to_string());
    Ok(SqlitePoolOptions::new()
        .max_connections(open.max_connections)
        .after_connect(|connection, _| {
            Box::pin(async move {
                let mut handle = connection.lock_handle().await?;
                functions::register(handle.as_raw_handle())?;
                Ok(())
            })
        })
        .connect_lazy_with(options))
}

/// Applies the migrations that the file does not have yet.
pub async fn migrate(pool: &DbPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

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
    use crate::testing::TempDatabase;
    use chrono::Local;

    /// Every pooled connection gets the pragmas and the SQL functions, not
    /// only the first one.
    #[tokio::test]
    async fn every_pooled_connection_has_the_pragmas_and_the_functions() {
        let database = TempDatabase::new(4).await;
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(database.pool().acquire().await.unwrap());
        }
        let today = Local::now().format("%Y-%m-%d").to_string();
        for connection in &mut held {
            let pragmas: (i64, String, i64, i64) = sqlx::query_as(
                "SELECT (SELECT foreign_keys FROM pragma_foreign_keys),
                        (SELECT journal_mode FROM pragma_journal_mode),
                        (SELECT timeout FROM pragma_busy_timeout),
                        (SELECT synchronous FROM pragma_synchronous)",
            )
            .fetch_one(&mut **connection)
            .await
            .unwrap();
            // synchronous: 2 is FULL. NORMAL (1) can lose a commit on power loss.
            assert_eq!(pragmas, (1, "wal".to_owned(), 5000, 2));
            // `PRAGMA mmap_size` has no table-valued form.
            let mmap_size: i64 = sqlx::query_scalar("PRAGMA mmap_size")
                .fetch_one(&mut **connection)
                .await
                .unwrap();
            assert_eq!(mmap_size, super::MMAP_SIZE);
            let functions: (String, i64, i64, i64, String, String) = sqlx::query_as(
                "SELECT lower('ÉCLAIR Straße'), 'A' LIKE 'a', '50% off' LIKE '50\\%%',
                        '500 off' LIKE '50\\%%', cp_today(),
                        cp_merchant_key(NULL, '  Blue\u{2019}s   CAFE ')",
            )
            .fetch_one(&mut **connection)
            .await
            .unwrap();
            assert_eq!(
                functions,
                (
                    "éclair straße".to_owned(),
                    0,
                    1,
                    0,
                    today.clone(),
                    "blue's cafe".to_owned()
                )
            );
        }
    }

    /// Writers from many tasks at once: each opens `BEGIN IMMEDIATE`, waits
    /// for the others, and none fails with `SQLITE_BUSY`.
    #[tokio::test]
    async fn parallel_write_transactions_all_commit() {
        let database = TempDatabase::new(8).await;
        let pool = database.pool().clone();
        let now = chrono::Utc::now().naive_utc();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', $1)",
        )
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (1, 1, 'B', $1, $1)",
        )
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
        let writers: Vec<_> = (0..32)
            .map(|index| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    let mut transaction = crate::locks::begin_pool(&pool).await?;
                    // A read, then a write that depends on it: the pattern
                    // that fails with SQLITE_BUSY under a deferred BEGIN.
                    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payees")
                        .fetch_one(transaction.as_mut())
                        .await?;
                    sqlx::query(
                        "INSERT INTO payees (book_id, name, created_at) VALUES (1, $1, $2)",
                    )
                    .bind(format!("Payee {index} after {count}"))
                    .bind(now)
                    .execute(transaction.as_mut())
                    .await?;
                    tokio::task::yield_now().await;
                    transaction.commit().await?;
                    Ok::<_, sqlx::Error>(())
                })
            })
            .collect();
        for writer in writers {
            writer.await.unwrap().unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payees")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 32);
        let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool)
            .await
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

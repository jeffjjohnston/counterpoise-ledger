//! Backups of the database file, and its upkeep.
//!
//! A backup is `VACUUM INTO <dir>/counterpoise-<UTC time>.db.partial`: a
//! complete, compacted copy that SQLite writes from one read transaction, so
//! writers go on while it runs. The copy is then opened read-only and must
//! pass `PRAGMA integrity_check`. Only then is it synced and given its name,
//! `counterpoise-<UTC time>.db`. A copy that fails the check gets the name
//! `counterpoise-<UTC time>.db.bad`. Thus a file with the normal name is
//! always complete and checked. A copy is a normal database file: to
//! restore, stop the server and put the copy at `DATABASE_PATH`.
//!
//! Before the check, the copy gets a floor marker in its transaction change
//! log (see [`mark_sync_floor`]). The live database does not get it.

use crate::engine::DbPool;
use sqlx::{
    ConnectOptions, Connection,
    sqlite::{SqliteConnectOptions, SqliteConnection, SqliteJournalMode, SqliteSynchronous},
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// The name of every backup file: `counterpoise-YYYYMMDD-HHMMSS.db`.
const PREFIX: &str = "counterpoise-";

/// One backup that [`snapshot`] wrote.
#[derive(Debug)]
pub struct Snapshot {
    pub path: PathBuf,
    pub bytes: u64,
    /// The copy passed `PRAGMA integrity_check`.
    pub verified: bool,
    /// The first problem that the check found, when it found one.
    pub problem: Option<String>,
}

/// The `book_id` of a floor marker in `transaction_changes`. No book has
/// this ID. A delta cursor below the newest marker is from before a restore.
pub const SYNC_FLOOR_BOOK_ID: i32 = 0;
/// The distance from the newest `seq` of a copy to its floor marker. The live
/// database must log fewer changes than this before the copy is restored.
const SYNC_FLOOR_GAP: i64 = 1 << 32;

/// The suffix of a copy that SQLite still writes or that is not checked yet.
const PARTIAL: &str = ".partial";
/// The suffix of a copy that failed `PRAGMA integrity_check`. It is kept for
/// inspection; the prune does not delete it.
const BAD: &str = ".bad";

/// Writes a backup of the database of `pool` into `dir`, then checks it.
/// The file name gives the time in UTC, so that a clock change cannot give
/// two snapshots the same name (guides/upgrade-to-sqlite.md tells the reader).
pub async fn snapshot(pool: &DbPool, dir: &Path) -> Result<Snapshot, String> {
    std::fs::create_dir_all(dir)
        .map_err(|cause| format!("cannot create {}: {cause}", dir.display()))?;
    let name = format!("{PREFIX}{}.db", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(&name);
    let partial = dir.join(format!("{name}{PARTIAL}"));
    for existing in [&path, &partial] {
        if existing.exists() {
            return Err(format!("{} already exists", existing.display()));
        }
    }
    let target = partial
        .to_str()
        .ok_or_else(|| format!("{} is not UTF-8", partial.display()))?
        .to_owned();
    if let Err(cause) = sqlx::query("VACUUM INTO $1")
        .bind(&target)
        .execute(pool)
        .await
    {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("VACUUM INTO failed: {cause}"));
    }
    if let Err(cause) = mark_sync_floor(&partial).await {
        let _ = std::fs::remove_file(&partial);
        return Err(cause);
    }
    finish(&partial, &path).await
}

/// Adds a floor marker to the transaction change log of the copy at `path`,
/// [`SYNC_FLOOR_GAP`] above its newest `seq`. The next change after a restore
/// of the copy gets a `seq` above the marker. Every cursor that a native
/// client got from the live database is below the marker, so the delta route
/// answers 410 and the client downloads the book again. Without the marker,
/// the restored log gives again `seq` values that a client already has, and
/// the client does not see the changes that the restore removed.
async fn mark_sync_floor(path: &Path) -> Result<(), String> {
    let fail =
        |cause: sqlx::Error| format!("cannot mark the sync floor of {}: {cause}", path.display());
    let mut connection: SqliteConnection = SqliteConnectOptions::new()
        .filename(path)
        .journal_mode(SqliteJournalMode::Delete)
        .synchronous(SqliteSynchronous::Full)
        .connect()
        .await
        .map_err(fail)?;
    let result = sqlx::query(
        "INSERT INTO transaction_changes (seq, book_id, transaction_id)
         SELECT coalesce(max(seq), 0) + $1, $2, 0 FROM transaction_changes",
    )
    .bind(SYNC_FLOOR_GAP)
    .bind(SYNC_FLOOR_BOOK_ID)
    .execute(&mut connection)
    .await;
    let closed = connection.close().await;
    result.map_err(fail)?;
    closed.map_err(fail)
}

/// Checks the copy at `partial`, syncs it, and gives it the name `path` when
/// the check passes, else `<path>.bad`. It never replaces a file.
async fn finish(partial: &Path, path: &Path) -> Result<Snapshot, String> {
    let bytes = std::fs::metadata(partial)
        .map_err(|cause| format!("cannot read {}: {cause}", partial.display()))?
        .len();
    // A copy that cannot be opened is not verified either.
    let problem = check(partial).await.unwrap_or_else(Some);
    let path = match problem {
        None => path.to_path_buf(),
        Some(_) => crate::database::sidecar(path, BAD),
    };
    crate::database::publish_file(partial, &path)?;
    Ok(Snapshot {
        path,
        bytes,
        verified: problem.is_none(),
        problem,
    })
}

/// `PRAGMA integrity_check` on the file at `path`, opened read-only. `None`
/// when the check says `ok`, else its first message.
pub async fn check(path: &Path) -> Result<Option<String>, String> {
    let mut connection: SqliteConnection = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .map_err(|cause| format!("cannot open {}: {cause}", path.display()))?;
    let messages: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|cause| format!("integrity_check failed: {cause}"))?;
    let _ = connection.close().await;
    Ok(match messages.as_slice() {
        [ok] if ok == "ok" => None,
        [] => Some("integrity_check returned nothing".to_owned()),
        [first, ..] => Some(first.clone()),
    })
}

/// `counterpoise-YYYYMMDD-HHMMSS.db`, the name of a checked snapshot, or
/// `counterpoise-YYYYMMDD-HHMMSS.dump`, the name of a dump of the PostgreSQL
/// scheduler. No other name: not a `.partial` or `.bad` copy, and not the
/// safety dump of the upgrade (`counterpoise-pre-sqlite-<time>.dump`), which
/// the user deletes by hand.
fn is_backup_name(name: &str) -> bool {
    let Some(stamp) = name.strip_prefix(PREFIX).and_then(|rest| {
        rest.strip_suffix(".db")
            .or_else(|| rest.strip_suffix(".dump"))
    }) else {
        return false;
    };
    stamp.len() == 15
        && stamp.bytes().enumerate().all(|(index, byte)| {
            if index == 8 {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// Deletes the backups in `dir` that are older than `days` days, by file
/// time, as `find -mtime +30` did. Only the names of [`is_backup_name`] are
/// candidates. Returns the number deleted.
pub fn prune(dir: &Path, days: u64) -> Result<usize, String> {
    let limit = SystemTime::now()
        .checked_sub(Duration::from_secs(days * 24 * 60 * 60))
        .ok_or("the prune age is too large")?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(cause) => return Err(format!("cannot read {}: {cause}", dir.display())),
    };
    let mut deleted = 0;
    for entry in entries {
        let entry = entry.map_err(|cause| format!("cannot read {}: {cause}", dir.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_backup_name(&name) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .map_err(|cause| format!("cannot read the time of {name}: {cause}"))?;
        if modified < limit {
            std::fs::remove_file(entry.path())
                .map_err(|cause| format!("cannot delete {name}: {cause}"))?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// `PRAGMA optimize`: lets SQLite refresh the statistics that the query
/// planner uses. Cheap when nothing is due.
pub async fn optimize(pool: &DbPool) -> Result<(), String> {
    sqlx::query("PRAGMA optimize")
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|cause| format!("PRAGMA optimize failed: {cause}"))
}

/// `VACUUM`: rebuilds the file, frees unused pages and defragments the
/// indexes. It replaces the monthly REINDEX of PostgreSQL. It needs the
/// write lock for its whole run, so writers wait.
pub async fn vacuum(pool: &DbPool) -> Result<(), String> {
    sqlx::query("VACUUM")
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|cause| format!("VACUUM failed: {cause}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDatabase;

    #[tokio::test]
    async fn a_backup_is_a_checked_copy_of_the_rows() {
        let database = TempDatabase::new(2).await;
        let now = chrono::Utc::now().naive_utc();
        sqlx::query(
            "INSERT INTO users (username, password_hash, created_at) VALUES ('u', 'h', $1)",
        )
        .bind(now)
        .execute(database.pool())
        .await
        .unwrap();
        let dir = std::env::temp_dir().join(format!("counterpoise-backups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let snapshot = snapshot(database.pool(), &dir).await.unwrap();
        assert!(snapshot.verified, "{:?}", snapshot.problem);
        assert!(snapshot.bytes > 0);
        // Only the checked copy is left, with its normal name.
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(is_backup_name(&names[0]), "{names:?}");
        assert_eq!(dir.join(&names[0]), snapshot.path);
        let copy = crate::connect(&snapshot.path, false).unwrap();
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&copy)
            .await
            .unwrap();
        assert_eq!(users, 1);
        // The copy has a floor marker above the newest seq of the live log,
        // and the live log has no new marker.
        let newest = "SELECT max(seq) FROM transaction_changes";
        let markers = "SELECT count(*) FROM transaction_changes WHERE book_id = 0";
        let live: i64 = sqlx::query_scalar(newest)
            .fetch_one(database.pool())
            .await
            .unwrap();
        let floor: i64 =
            sqlx::query_scalar("SELECT max(seq) FROM transaction_changes WHERE book_id = 0")
                .fetch_one(&copy)
                .await
                .unwrap();
        assert_eq!(floor, live + SYNC_FLOOR_GAP);
        let copy_markers: i64 = sqlx::query_scalar(markers).fetch_one(&copy).await.unwrap();
        let live_markers: i64 = sqlx::query_scalar(markers)
            .fetch_one(database.pool())
            .await
            .unwrap();
        assert_eq!((copy_markers, live_markers), (2, 1));
        // The next change after a restore is above the marker.
        sqlx::query("INSERT INTO transaction_changes (book_id, transaction_id) VALUES (1, 1)")
            .execute(&copy)
            .await
            .unwrap();
        let next: i64 = sqlx::query_scalar(newest).fetch_one(&copy).await.unwrap();
        assert_eq!(next, floor + 1);
        copy.close().await;

        // A copy with a damaged page fails the check.
        let mut bytes = std::fs::read(&snapshot.path).unwrap();
        let page = 4096;
        for byte in &mut bytes[page..page * 2] {
            *byte = 0xFF;
        }
        let damaged = dir.join("damaged.db");
        std::fs::write(&damaged, &bytes).unwrap();
        assert!(
            check(&damaged)
                .await
                .map_or(true, |problem| problem.is_some())
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A copy that fails its check never gets the normal name: it becomes
    /// `.bad`, and the snapshot says that it is not verified.
    #[tokio::test]
    async fn a_copy_that_fails_its_check_is_named_bad() {
        let database = TempDatabase::new(1).await;
        let dir = std::env::temp_dir().join(format!("counterpoise-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let good = snapshot(database.pool(), &dir).await.unwrap();
        let mut bytes = std::fs::read(&good.path).unwrap();
        std::fs::remove_file(&good.path).unwrap();
        let page = 4096;
        for byte in &mut bytes[page..page * 2] {
            *byte = 0xFF;
        }
        let path = dir.join("counterpoise-20250101-000000.db");
        let partial = dir.join("counterpoise-20250101-000000.db.partial");
        std::fs::write(&partial, &bytes).unwrap();
        let bad = finish(&partial, &path).await.unwrap();
        assert!(!bad.verified);
        assert!(bad.problem.is_some());
        assert_eq!(bad.path, dir.join("counterpoise-20250101-000000.db.bad"));
        assert!(bad.path.exists());
        assert!(!path.exists());
        assert!(!partial.exists());

        // A good copy never replaces a file with its name.
        let good = snapshot(database.pool(), &dir).await.unwrap();
        std::fs::copy(&good.path, &partial).unwrap();
        std::fs::write(&path, b"keep").unwrap();
        assert!(finish(&partial, &path).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prune_deletes_only_old_backups() {
        let dir = std::env::temp_dir().join(format!("counterpoise-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let old = SystemTime::now() - Duration::from_secs(31 * 24 * 60 * 60);
        for (name, time) in [
            ("counterpoise-20250101-000000.db", Some(old)),
            ("counterpoise-20250101-000000.dump", Some(old)),
            ("counterpoise-20260101-000000.db", None),
            ("pre-sqlite-upgrade.dump", Some(old)),
            // The safety dump of scripts/upgrade-to-sqlite.sh, by its real name.
            ("counterpoise-pre-sqlite-20250101-000000.dump", Some(old)),
            ("counterpoise-20250101-000000.db.partial", Some(old)),
            ("counterpoise-20250101-000000.db.bad", Some(old)),
            ("notes.txt", Some(old)),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, b"x").unwrap();
            if let Some(time) = time {
                std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_modified(time)
                    .unwrap();
            }
        }
        assert_eq!(prune(&dir, 30).unwrap(), 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [
                "counterpoise-20250101-000000.db.bad",
                "counterpoise-20250101-000000.db.partial",
                "counterpoise-20260101-000000.db",
                "counterpoise-pre-sqlite-20250101-000000.dump",
                "notes.txt",
                "pre-sqlite-upgrade.dump"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

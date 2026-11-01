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
//!
//! Once a day, the backup also writes a portable dump
//! (`counterpoise-<UTC time>.json`, [`crate::dump`]), so that the format
//! that moves the data to a Durable Object is tested on real data first.

use crate::{
    Database,
    store::{Sql, params},
    sync_floor,
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

/// The suffix of a dump ([`daily_dump`]).
const DUMP: &str = ".json";

/// The suffix of a copy that SQLite still writes or that is not checked yet.
const PARTIAL: &str = ".partial";
/// The suffix of a copy that failed `PRAGMA integrity_check`. It is kept for
/// inspection; the prune does not delete it.
const BAD: &str = ".bad";

/// Writes a backup of the file of `database` into `dir`, then checks it.
/// The file name gives the time in UTC, so that a clock change cannot give
/// two snapshots the same name (guides/upgrade-to-sqlite.md tells the reader).
///
/// The copy runs on a connection of its own, so `database` stays free for
/// the requests while it runs. It takes seconds on a large file: an async
/// caller runs it on a blocking thread.
pub fn snapshot(database: &Database, dir: &Path) -> Result<Snapshot, String> {
    let live = own_connection(database)?;
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
    let copied = live.execute("VACUUM INTO ?1", &params![target]);
    drop(live);
    if let Err(cause) = copied {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("VACUUM INTO failed: {cause}"));
    }
    if let Err(cause) = mark_sync_floor(&partial) {
        let _ = std::fs::remove_file(&partial);
        return Err(cause);
    }
    finish(&partial, &path)
}

/// Writes a dump of `database` into `dir` when `dir` has none from today
/// (UTC) yet. Returns the dump's path and size, or `None` when one exists.
/// The dump reads one snapshot on a connection of its own, as [`snapshot`]
/// does.
pub fn daily_dump(database: &Database, dir: &Path) -> Result<Option<(PathBuf, u64)>, String> {
    let now = chrono::Utc::now();
    let today = format!("{PREFIX}{}-", now.format("%Y%m%d"));
    let entries = std::fs::read_dir(dir)
        .map_err(|cause| format!("cannot read {}: {cause}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|cause| format!("cannot read {}: {cause}", dir.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&today) && name.ends_with(DUMP) && is_backup_name(&name) {
            return Ok(None);
        }
    }
    let path = dir.join(format!("{PREFIX}{}{DUMP}", now.format("%Y%m%d-%H%M%S")));
    let bytes = write_dump(database, &path)?;
    Ok(Some((path, bytes)))
}

/// Writes a dump of `database` at `path`, which must not exist, and returns
/// its size. The file appears complete or not at all.
pub fn write_dump(database: &Database, path: &Path) -> Result<u64, String> {
    let live = own_connection(database)?;
    let text = live
        .read_transaction(|tx| crate::dump::dump_json(tx))
        .map_err(|cause| format!("the dump failed: {cause}"))?;
    drop(live);
    // Each writer has its own partial file, made new, so two dumps to the
    // same name never write into one file. The process id and a counter
    // tell the writers apart.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let partial = crate::database::sidecar(
        path,
        &format!(
            ".{}-{}{PARTIAL}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
    );
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(&text)?;
            file.sync_all()
        });
    if let Err(cause) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("cannot write {}: {cause}", partial.display()));
    }
    if let Err(cause) = crate::database::publish_file(&partial, path) {
        let _ = std::fs::remove_file(&partial);
        return Err(cause);
    }
    Ok(text.len() as u64)
}

/// A second connection on the file of `database`.
fn own_connection(database: &Database) -> Result<Database, String> {
    let path = database
        .path()
        .ok_or("a database in memory has no file to copy")?;
    Database::open(path, false).map_err(|cause| format!("cannot open {}: {cause}", path.display()))
}

/// Adds a floor marker to the transaction change log of the copy at `path`,
/// [`sync_floor::GAP`] above its newest `seq`. The next change after a restore
/// of the copy gets a `seq` above the marker. Every cursor that a native
/// client got from the live database is below the marker, so the delta route
/// answers 410 and the client downloads the book again. Without the marker,
/// the restored log gives again `seq` values that a client already has, and
/// the client does not see the changes that the restore removed.
fn mark_sync_floor(path: &Path) -> Result<(), String> {
    let fail = |cause: crate::store::Error| {
        format!("cannot mark the sync floor of {}: {cause}", path.display())
    };
    let copy = Database::open_copy(path, false).map_err(fail)?;
    sync_floor::insert(&copy).map_err(fail)
}

/// Checks the copy at `partial`, syncs it, and gives it the name `path` when
/// the check passes, else `<path>.bad`. It never replaces a file.
fn finish(partial: &Path, path: &Path) -> Result<Snapshot, String> {
    let bytes = std::fs::metadata(partial)
        .map_err(|cause| format!("cannot read {}: {cause}", partial.display()))?
        .len();
    // A copy that cannot be opened is not verified either.
    let problem = check(partial).unwrap_or_else(Some);
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
pub fn check(path: &Path) -> Result<Option<String>, String> {
    let copy = Database::open_copy(path, true)
        .map_err(|cause| format!("cannot open {}: {cause}", path.display()))?;
    let messages: Vec<String> = copy
        .query("PRAGMA integrity_check", &[])
        .map_err(|cause| format!("integrity_check failed: {cause}"))?;
    Ok(match messages.as_slice() {
        [ok] if ok == "ok" => None,
        [] => Some("integrity_check returned nothing".to_owned()),
        [first, ..] => Some(first.clone()),
    })
}

/// `counterpoise-YYYYMMDD-HHMMSS.db`, the name of a checked snapshot,
/// `counterpoise-YYYYMMDD-HHMMSS.json`, the name of a daily dump, or
/// `counterpoise-YYYYMMDD-HHMMSS.dump`, the name of a dump of the PostgreSQL
/// scheduler. No other name: not a `.partial` or `.bad` copy, and not the
/// safety dump of the upgrade (`counterpoise-pre-sqlite-<time>.dump`), which
/// the user deletes by hand.
fn is_backup_name(name: &str) -> bool {
    let Some(stamp) = name.strip_prefix(PREFIX).and_then(|rest| {
        rest.strip_suffix(".db")
            .or_else(|| rest.strip_suffix(DUMP))
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
pub fn optimize(database: &Database) -> Result<(), String> {
    database
        .exec_batch("PRAGMA optimize")
        .map_err(|cause| format!("PRAGMA optimize failed: {cause}"))
}

/// `VACUUM`: rebuilds the file, frees unused pages and defragments the
/// indexes. It replaces the monthly REINDEX of PostgreSQL. It needs the
/// write lock for its whole run, so writers wait. It runs on a connection of
/// its own, so reads go on; an async caller runs it on a blocking thread.
pub fn vacuum(database: &Database) -> Result<(), String> {
    own_connection(database)?
        .exec_batch("VACUUM")
        .map_err(|cause| format!("VACUUM failed: {cause}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempDatabase;

    #[test]
    fn a_backup_is_a_checked_copy_of_the_rows() {
        let temp = TempDatabase::new();
        let database = temp.database();
        let now = chrono::Utc::now().naive_utc();
        database
            .execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES ('u', 'h', ?1)",
                &params![now],
            )
            .unwrap();
        let dir = std::env::temp_dir().join(format!("counterpoise-backups-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let snapshot = snapshot(database, &dir).unwrap();
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
        let copy = Database::open(&snapshot.path, false).unwrap();
        let users: i64 = copy.query_row("SELECT COUNT(*) FROM users", &[]).unwrap();
        assert_eq!(users, 1);
        // The copy has a floor marker above the newest seq of the live log,
        // and the live log has no new marker.
        let newest = "SELECT max(seq) FROM transaction_changes";
        let markers = "SELECT count(*) FROM transaction_changes WHERE book_id = 0";
        let live: i64 = database.query_row(newest, &[]).unwrap();
        let floor: i64 = copy
            .query_row(
                "SELECT max(seq) FROM transaction_changes WHERE book_id = 0",
                &[],
            )
            .unwrap();
        assert_eq!(floor, live + sync_floor::GAP);
        let copy_markers: i64 = copy.query_row(markers, &[]).unwrap();
        let live_markers: i64 = database.query_row(markers, &[]).unwrap();
        assert_eq!((copy_markers, live_markers), (2, 1));
        // The next change after a restore is above the marker.
        copy.execute(
            "INSERT INTO transaction_changes (book_id, transaction_id) VALUES (1, 1)",
            &[],
        )
        .unwrap();
        let next: i64 = copy.query_row(newest, &[]).unwrap();
        assert_eq!(next, floor + 1);
        drop(copy);

        // A copy with a damaged page fails the check.
        let mut bytes = std::fs::read(&snapshot.path).unwrap();
        let page = 4096;
        for byte in &mut bytes[page..page * 2] {
            *byte = 0xFF;
        }
        let damaged = dir.join("damaged.db");
        std::fs::write(&damaged, &bytes).unwrap();
        assert!(check(&damaged).map_or(true, |problem| problem.is_some()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A copy that fails its check never gets the normal name: it becomes
    /// `.bad`, and the snapshot says that it is not verified.
    #[test]
    fn a_copy_that_fails_its_check_is_named_bad() {
        let temp = TempDatabase::new();
        let database = temp.database();
        let dir = std::env::temp_dir().join(format!("counterpoise-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let good = snapshot(database, &dir).unwrap();
        let mut bytes = std::fs::read(&good.path).unwrap();
        std::fs::remove_file(&good.path).unwrap();
        let page = 4096;
        for byte in &mut bytes[page..page * 2] {
            *byte = 0xFF;
        }
        let path = dir.join("counterpoise-20250101-000000.db");
        let partial = dir.join("counterpoise-20250101-000000.db.partial");
        std::fs::write(&partial, &bytes).unwrap();
        let bad = finish(&partial, &path).unwrap();
        assert!(!bad.verified);
        assert!(bad.problem.is_some());
        assert_eq!(bad.path, dir.join("counterpoise-20250101-000000.db.bad"));
        assert!(bad.path.exists());
        assert!(!path.exists());
        assert!(!partial.exists());

        // A good copy never replaces a file with its name.
        let good = snapshot(database, &dir).unwrap();
        std::fs::copy(&good.path, &partial).unwrap();
        std::fs::write(&path, b"keep").unwrap();
        assert!(finish(&partial, &path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_database_in_memory_has_no_snapshot() {
        let database = Database::open_in_memory().unwrap();
        assert!(snapshot(&database, &std::env::temp_dir()).is_err());
    }

    #[test]
    fn the_daily_dump_is_written_once_a_day() {
        let temp = TempDatabase::new();
        let dir = std::env::temp_dir().join(format!("counterpoise-dumps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A dump of another day does not count.
        std::fs::write(dir.join("counterpoise-20250101-000000.json"), b"{}").unwrap();
        let (path, bytes) = daily_dump(temp.database(), &dir).unwrap().unwrap();
        assert!(is_backup_name(&path.file_name().unwrap().to_string_lossy()));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.len() as u64, bytes);
        let dump: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(dump["format"], crate::dump::FORMAT);
        assert!(daily_dump(temp.database(), &dir).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Two dumps to one name: one publishes a whole file, the other fails,
    /// and neither leaves a partial file behind.
    #[test]
    fn concurrent_dumps_to_one_name_never_share_a_file() {
        let temp = TempDatabase::new();
        let dir = std::env::temp_dir().join(format!("counterpoise-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("counterpoise-20260101-000000.json");
        let results: Vec<Result<u64, String>> = std::thread::scope(|scope| {
            let writers: Vec<_> = (0..4)
                .map(|_| scope.spawn(|| write_dump(temp.database(), &path)))
                .collect();
            writers.into_iter().map(|w| w.join().unwrap()).collect()
        });
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let text = std::fs::read_to_string(&path).unwrap();
        let dump: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(dump["format"], crate::dump::FORMAT);
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["counterpoise-20260101-000000.json"]);
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
            ("counterpoise-20250101-000000.json", Some(old)),
            ("counterpoise-20260101-000000.db", None),
            ("counterpoise-20260101-000000.json", None),
            ("pre-sqlite-upgrade.dump", Some(old)),
            // The safety dump of the v1.50.0 upgrade script, by its real name.
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
        assert_eq!(prune(&dir, 30).unwrap(), 3);
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
                "counterpoise-20260101-000000.json",
                "counterpoise-pre-sqlite-20250101-000000.dump",
                "notes.txt",
                "pre-sqlite-upgrade.dump"
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

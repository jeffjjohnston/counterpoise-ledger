//! The state of the scheduled jobs, in the database (migration
//! `0014_job_state.sql`):
//!
//! - **Leases** (`job_leases`). One run of a job, or one Plaid sync of a
//!   connection, holds a lease, and a second caller does not get it. The
//!   lease holds across processes on the file (the server, the MCP stdio
//!   process, `ledger-cli`). A lease is not a file lock: the system does not
//!   release it when its process dies. So it lapses at `expires_at`, and the
//!   holder renews it while the run lasts (the server's `leases` module). A
//!   crash frees the lease when its time runs out.
//! - **Runs** (`job_runs`). The last run of each job that records its
//!   status: the scheduler writes it after each run, and `/api/system/status`
//!   reads it. The `ledger-cli backup` command writes it too, so a manual
//!   backup shows there.
//! - **Slots and requests** (`job_slots`, `job_requests`, migration
//!   `0015_job_schedule.sql`). The scheduled minute that each job's latest
//!   run serves, whether that run finished, and where its next step starts;
//!   and the runs asked for outside the schedule. The scheduler reads them
//!   to find the jobs due now and its next wake. `attempts` (migration
//!   `0018_job_slot_attempts.sql`) counts the starts of the current step, so
//!   that the scheduler can stop a run that never finishes.

use crate::store::{Error, Sql, params};
use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

/// Takes the lease `name` for `holder` until `now + ttl`, when no one holds
/// it or its lease has lapsed. Returns whether `holder` has it.
///
/// One statement, so two callers cannot both take it.
pub fn acquire(
    sql: &impl Sql,
    name: &str,
    holder: &str,
    now: NaiveDateTime,
    ttl: Duration,
) -> Result<bool, Error> {
    let changed = sql.execute(
        "INSERT INTO job_leases (name, holder, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE job_leases.expires_at <= ?4",
        &params![name, holder, expiry(now, ttl)?, now],
    )?;
    Ok(changed == 1)
}

/// Moves the end of `holder`'s lease to `now + ttl`. Returns false when
/// `holder` no longer has it: it lapsed, and another caller took it.
pub fn renew(
    sql: &impl Sql,
    name: &str,
    holder: &str,
    now: NaiveDateTime,
    ttl: Duration,
) -> Result<bool, Error> {
    let changed = sql.execute(
        "UPDATE job_leases SET expires_at = ?3 WHERE name = ?1 AND holder = ?2",
        &params![name, holder, expiry(now, ttl)?],
    )?;
    Ok(changed == 1)
}

/// Gives up `holder`'s lease. A lease that another caller took after it
/// lapsed stays theirs.
pub fn release(sql: &impl Sql, name: &str, holder: &str) -> Result<(), Error> {
    sql.execute(
        "DELETE FROM job_leases WHERE name = ?1 AND holder = ?2",
        &params![name, holder],
    )?;
    Ok(())
}

fn expiry(now: NaiveDateTime, ttl: Duration) -> Result<NaiveDateTime, Error> {
    chrono::TimeDelta::from_std(ttl)
        .ok()
        .and_then(|ttl| now.checked_add_signed(ttl))
        .ok_or_else(|| Error::Invalid(format!("a lease of {ttl:?} has no end")))
}

/// The fields of one run record, apart from the job name and the time.
#[derive(Default)]
pub struct Status<'a> {
    /// The run succeeded. `lastOk` is the run time when true, else null.
    pub ok: bool,
    pub detail: Option<&'a str>,
    pub bytes: Option<u64>,
    pub verified: Option<bool>,
    /// The job had no secret and ran nothing.
    pub not_configured: bool,
}

/// Records a run of `job` at `at`, in place of its last one.
pub fn record_run(
    sql: &impl Sql,
    job: &str,
    status: &Status<'_>,
    at: DateTime<Utc>,
) -> Result<(), Error> {
    let at = at.naive_utc();
    // A display string: control characters would only make it harder to
    // read, so they become spaces.
    let detail = status
        .detail
        .map(|text| text.replace(['\n', '\r', '\t'], " "));
    let bytes = status.bytes.map(|bytes| bytes.min(i64::MAX as u64) as i64);
    sql.execute(
        "INSERT INTO job_runs (job, last_run_at, last_ok_at, verified, bytes, detail, not_configured)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at,
           verified = excluded.verified, bytes = excluded.bytes, detail = excluded.detail,
           not_configured = excluded.not_configured",
        &params![
            job,
            at,
            status.ok.then_some(at),
            status.verified,
            bytes,
            detail,
            status.not_configured
        ],
    )?;
    Ok(())
}

/// Every run record, as JSON: `job`, `lastRun`, `lastOk`, `verified`,
/// `bytes` and `detail`, the times in RFC 3339. `notConfigured` is present,
/// and true, only for a job that had no secret and ran nothing.
pub fn runs(sql: &impl Sql) -> Result<Vec<Value>, Error> {
    type Run = (
        String,
        String,
        Option<String>,
        Option<bool>,
        Option<i64>,
        Option<String>,
        bool,
    );
    let rows: Vec<Run> = sql.query(
        "SELECT job, last_run_at, last_ok_at, verified, bytes, detail, not_configured
         FROM job_runs ORDER BY job",
        &[],
    )?;
    rows.into_iter()
        .map(
            |(job, last_run_at, last_ok_at, verified, bytes, detail, not_configured)| {
                let mut record = json!({
                    "job": job,
                    "lastRun": rfc3339(&last_run_at)?,
                    "lastOk": last_ok_at.as_deref().map(rfc3339).transpose()?,
                    "verified": verified,
                    "bytes": bytes,
                    "detail": detail,
                });
                if not_configured {
                    record["notConfigured"] = json!(true);
                }
                Ok(record)
            },
        )
        .collect()
}

/// A stored UTC timestamp as RFC 3339, to the second.
fn rfc3339(text: &str) -> Result<String, Error> {
    let time = NaiveDateTime::parse_from_str(text, "%F %T%.f")
        .map_err(|_| Error::Invalid(format!("job_runs holds the time {text:?}")))?;
    Ok(time.and_utc().to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Copies the status files of an older release (`<dir>/<job>.json`) into
/// `job_runs`, for each job that has no row yet. A file that does not parse
/// is left out, as the status route left it out. Returns the number copied.
///
/// The server runs this when it starts, so the status page keeps the runs
/// from before the upgrade; the files are not read again after that.
pub fn import_status_files(sql: &impl Sql, dir: &Path) -> Result<usize, Error> {
    let Ok(names) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let mut copied = 0;
    for entry in names.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(record) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            continue;
        };
        let time = |key: &str| {
            record[key]
                .as_str()
                .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
                .map(|time| time.naive_utc())
        };
        let (Some(job), Some(last_run_at)) = (record["job"].as_str(), time("lastRun")) else {
            continue;
        };
        copied += sql.execute(
            "INSERT INTO job_runs (job, last_run_at, last_ok_at, verified, bytes, detail, not_configured)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (job) DO NOTHING",
            &params![
                job,
                last_run_at,
                time("lastOk"),
                record["verified"].as_bool(),
                record["bytes"].as_i64(),
                record["detail"].as_str(),
                record["notConfigured"] == true
            ],
        )? as usize;
    }
    Ok(copied)
}

/// The directory of an older release's status files: `STATUS_DIR`, else
/// `/backups/status` when `/backups` exists.
pub fn legacy_status_dir() -> Option<std::path::PathBuf> {
    match std::env::var_os("STATUS_DIR") {
        Some(dir) => Some(dir.into()),
        None => Path::new("/backups")
            .is_dir()
            .then(|| "/backups/status".into()),
    }
}

/// The latest slot of one job (`job_slots`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Slot {
    pub job: String,
    /// The scheduled minute that the run serves, in UTC.
    pub slot: NaiveDateTime,
    pub finished: bool,
    /// Where the next step of an unfinished run starts.
    pub cursor: Option<String>,
    /// How many times the step at `cursor` started ([`attempt`]).
    pub attempts: u32,
}

/// The latest slot of each job.
pub fn slots(sql: &impl Sql) -> Result<Vec<Slot>, Error> {
    let rows: Vec<(String, NaiveDateTime, bool, Option<String>, u32)> = sql.query(
        "SELECT job, slot, finished, cursor, attempts FROM job_slots ORDER BY job",
        &[],
    )?;
    Ok(rows
        .into_iter()
        .map(|(job, slot, finished, cursor, attempts)| Slot {
            job,
            slot,
            finished,
            cursor,
            attempts,
        })
        .collect())
}

/// Starts a run of `job` for `slot`, in place of its last one, and takes
/// the job's request: the run serves it. One transaction, so the request
/// is never lost between the two.
pub fn claim(
    database: &crate::store::Database,
    job: &str,
    slot: NaiveDateTime,
) -> Result<(), Error> {
    database.transaction(|tx| {
        tx.execute(
            "INSERT INTO job_slots (job, slot, finished, cursor, attempts) VALUES (?1, ?2, 0, NULL, 0)
             ON CONFLICT (job) DO UPDATE SET slot = excluded.slot, finished = 0, cursor = NULL,
               attempts = 0",
            &params![job, slot],
        )?;
        tx.execute("DELETE FROM job_requests WHERE job = ?1", &params![job])?;
        Ok(())
    })
}

/// Keeps where the next step of `job`'s run for `slot` starts. The step is
/// a new one, so its count of starts is zero. A run of a later slot has
/// replaced the row when nothing changes.
pub fn advance(sql: &impl Sql, job: &str, slot: NaiveDateTime, cursor: &str) -> Result<(), Error> {
    sql.execute(
        "UPDATE job_slots SET cursor = ?3, attempts = 0
         WHERE job = ?1 AND slot = ?2 AND finished = 0",
        &params![job, slot, cursor],
    )?;
    Ok(())
}

/// Counts one start of the current step of `job`'s run for `slot`, and
/// returns the new count. The caller counts before the step runs: a step
/// that stops before it returns cannot count itself. `None` when the run is
/// finished, or when a run of a later slot has replaced the row.
pub fn attempt(sql: &impl Sql, job: &str, slot: NaiveDateTime) -> Result<Option<u32>, Error> {
    sql.query_optional(
        "UPDATE job_slots SET attempts = attempts + 1
         WHERE job = ?1 AND slot = ?2 AND finished = 0 RETURNING attempts",
        &params![job, slot],
    )
}

/// Marks `job`'s run for `slot` finished.
pub fn finish(sql: &impl Sql, job: &str, slot: NaiveDateTime) -> Result<(), Error> {
    sql.execute(
        "UPDATE job_slots SET finished = 1, cursor = NULL WHERE job = ?1 AND slot = ?2",
        &params![job, slot],
    )?;
    Ok(())
}

/// Asks for a run of `job` outside its schedule. A request that waits
/// already keeps its time.
pub fn request(sql: &impl Sql, job: &str, at: NaiveDateTime) -> Result<(), Error> {
    sql.execute(
        "INSERT INTO job_requests (job, requested_at) VALUES (?1, ?2) ON CONFLICT (job) DO NOTHING",
        &params![job, at],
    )?;
    Ok(())
}

/// Whether the last recorded run of `job` failed. A job with no record did
/// not fail.
pub fn last_run_failed(sql: &impl Sql, job: &str) -> Result<bool, Error> {
    let failed: Option<bool> = sql.query_optional(
        "SELECT last_ok_at IS NULL FROM job_runs WHERE job = ?1",
        &params![job],
    )?;
    Ok(failed.unwrap_or(false))
}

/// The jobs that have a request waiting, with the time of each request.
pub fn requests(sql: &impl Sql) -> Result<Vec<(String, NaiveDateTime)>, Error> {
    sql.query(
        "SELECT job, requested_at FROM job_requests ORDER BY job",
        &[],
    )
}

/// The names of the leases that someone holds at `now`.
pub fn held(sql: &impl Sql, now: NaiveDateTime) -> Result<Vec<String>, Error> {
    sql.query(
        "SELECT name FROM job_leases WHERE expires_at > ?1 ORDER BY name",
        &params![now],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Database;
    use chrono::TimeZone;

    fn migrated() -> Database {
        let database = Database::open_in_memory().unwrap();
        crate::migrate(&database).unwrap();
        database
    }

    fn at(second: u32) -> NaiveDateTime {
        Utc.with_ymd_and_hms(2026, 10, 21, 12, 0, 0)
            .unwrap()
            .naive_utc()
            + chrono::TimeDelta::seconds(i64::from(second))
    }

    const TTL: Duration = Duration::from_secs(60);

    #[test]
    fn a_lease_has_one_holder_until_it_is_released() {
        let database = migrated();
        assert!(acquire(&database, "job:recurring", "a", at(0), TTL).unwrap());
        assert!(!acquire(&database, "job:recurring", "b", at(1), TTL).unwrap());
        // Another name is another lease.
        assert!(acquire(&database, "job:backup", "b", at(1), TTL).unwrap());
        // Only the holder releases it.
        release(&database, "job:recurring", "b").unwrap();
        assert!(!acquire(&database, "job:recurring", "b", at(2), TTL).unwrap());
        release(&database, "job:recurring", "a").unwrap();
        assert!(acquire(&database, "job:recurring", "b", at(3), TTL).unwrap());
    }

    /// A holder that dies keeps its lease until the lease lapses: the
    /// system does not release a row as it releases a file lock.
    #[test]
    fn a_crashed_holder_frees_its_lease_when_it_lapses() {
        let database = migrated();
        assert!(acquire(&database, "plaid-sync:7", "crashed", at(0), TTL).unwrap());
        // The holder renews while it runs; then it stops renewing.
        assert!(renew(&database, "plaid-sync:7", "crashed", at(20), TTL).unwrap());
        assert!(!acquire(&database, "plaid-sync:7", "next", at(79), TTL).unwrap());
        assert!(acquire(&database, "plaid-sync:7", "next", at(80), TTL).unwrap());
        // The old holder has lost it: its renewal and its release do nothing.
        assert!(!renew(&database, "plaid-sync:7", "crashed", at(81), TTL).unwrap());
        release(&database, "plaid-sync:7", "crashed").unwrap();
        assert!(!acquire(&database, "plaid-sync:7", "third", at(82), TTL).unwrap());
    }

    #[test]
    fn a_run_record_replaces_the_last_one() {
        let database = migrated();
        let time = Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 5).unwrap();
        let ok = Status {
            ok: true,
            bytes: Some(9),
            verified: Some(true),
            ..Status::default()
        };
        record_run(&database, "backup", &ok, time).unwrap();
        assert_eq!(
            runs(&database).unwrap(),
            [json!({
                "job": "backup", "lastRun": "2026-09-29T10:00:05Z",
                "lastOk": "2026-09-29T10:00:05Z", "verified": true, "bytes": 9, "detail": null,
            })]
        );
        let none = Status {
            ok: true,
            detail: Some("a\nb"),
            not_configured: true,
            ..Status::default()
        };
        record_run(&database, "backup", &none, time).unwrap();
        let records = runs(&database).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["notConfigured"], true);
        assert_eq!(records[0]["detail"], "a b");
        assert_eq!(records[0]["verified"], Value::Null);
        let failed = Status {
            detail: Some("disk full"),
            ..Status::default()
        };
        record_run(&database, "backup", &failed, time).unwrap();
        let records = runs(&database).unwrap();
        assert_eq!(records[0]["lastOk"], Value::Null);
        assert!(records[0].get("notConfigured").is_none());
    }

    #[test]
    fn the_status_files_of_an_older_release_are_copied_once() {
        let database = migrated();
        let dir =
            std::env::temp_dir().join(format!("counterpoise-status-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
        write(
            "backup.json",
            r#"{"job":"backup","lastRun":"2026-09-29T10:00:05Z","lastOk":"2026-09-29T10:00:05Z","verified":true,"bytes":9,"detail":null}"#,
        );
        write(
            "plaid-sync.json",
            r#"{"job":"plaid-sync","lastRun":"2026-09-29T06:00:01Z","lastOk":"2026-09-29T06:00:01Z","verified":null,"bytes":null,"detail":"not configured: PLAID_SECRET is not set","notConfigured":true}"#,
        );
        write("bad.json", "invalid JSON");
        write("notes.txt", "not a record");
        // A job that already has a row keeps it.
        let newer = Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap();
        let failed = Status::default();
        record_run(&database, "backup", &failed, newer).unwrap();

        assert_eq!(import_status_files(&database, &dir).unwrap(), 1);
        assert_eq!(import_status_files(&database, &dir).unwrap(), 0);
        let records = runs(&database).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["lastRun"], "2026-10-01T00:00:00Z");
        assert_eq!(records[1]["job"], "plaid-sync");
        assert_eq!(records[1]["lastOk"], "2026-09-29T06:00:01Z");
        assert_eq!(records[1]["notConfigured"], true);
        assert_eq!(
            import_status_files(&database, &dir.join("missing")).unwrap(),
            0
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_claim_replaces_the_slot_and_takes_the_request() {
        let database = migrated();
        request(&database, "weekly-review", at(0)).unwrap();
        // A second request keeps the time of the first.
        request(&database, "weekly-review", at(5)).unwrap();
        assert_eq!(
            requests(&database).unwrap(),
            [("weekly-review".to_owned(), at(0))]
        );
        claim(&database, "weekly-review", at(10)).unwrap();
        assert!(requests(&database).unwrap().is_empty());
        advance(&database, "weekly-review", at(10), "4").unwrap();
        // A step of an older slot changes nothing.
        advance(&database, "weekly-review", at(0), "9").unwrap();
        let slot = |finished, cursor: Option<&str>| Slot {
            job: "weekly-review".to_owned(),
            slot: at(10),
            finished,
            cursor: cursor.map(str::to_owned),
            attempts: 0,
        };
        assert_eq!(slots(&database).unwrap(), [slot(false, Some("4"))]);
        finish(&database, "weekly-review", at(10)).unwrap();
        assert_eq!(slots(&database).unwrap(), [slot(true, None)]);
        // A finished run takes no more steps.
        advance(&database, "weekly-review", at(10), "5").unwrap();
        assert_eq!(slots(&database).unwrap(), [slot(true, None)]);
        // The next claim starts afresh.
        claim(&database, "weekly-review", at(20)).unwrap();
        assert_eq!(
            slots(&database).unwrap(),
            [Slot {
                slot: at(20),
                ..slot(false, None)
            }]
        );
    }

    #[test]
    fn a_slot_counts_the_starts_of_its_current_step() {
        let database = migrated();
        // No run to count.
        assert_eq!(attempt(&database, "plaid-sync", at(0)).unwrap(), None);
        claim(&database, "plaid-sync", at(0)).unwrap();
        assert_eq!(attempt(&database, "plaid-sync", at(0)).unwrap(), Some(1));
        assert_eq!(attempt(&database, "plaid-sync", at(0)).unwrap(), Some(2));
        assert_eq!(slots(&database).unwrap()[0].attempts, 2);
        // Another slot is another run.
        assert_eq!(attempt(&database, "plaid-sync", at(5)).unwrap(), None);
        // A step that keeps its cursor starts the count of the next step.
        advance(&database, "plaid-sync", at(0), "3").unwrap();
        assert_eq!(attempt(&database, "plaid-sync", at(0)).unwrap(), Some(1));
        // A finished run takes no more starts, and a new claim counts afresh.
        finish(&database, "plaid-sync", at(0)).unwrap();
        assert_eq!(attempt(&database, "plaid-sync", at(0)).unwrap(), None);
        claim(&database, "plaid-sync", at(10)).unwrap();
        assert_eq!(slots(&database).unwrap()[0].attempts, 0);
    }

    #[test]
    fn the_last_run_failed_only_when_its_record_has_no_success() {
        let database = migrated();
        let time = Utc.with_ymd_and_hms(2026, 11, 9, 10, 0, 5).unwrap();
        assert!(!last_run_failed(&database, "lot-rebuild").unwrap());
        record_run(&database, "lot-rebuild", &Status::default(), time).unwrap();
        assert!(last_run_failed(&database, "lot-rebuild").unwrap());
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        record_run(&database, "lot-rebuild", &ok, time).unwrap();
        assert!(!last_run_failed(&database, "lot-rebuild").unwrap());
    }

    #[test]
    fn a_lapsed_lease_is_not_held() {
        let database = migrated();
        assert!(acquire(&database, "job:recurring", "a", at(0), TTL).unwrap());
        assert!(acquire(&database, "job:backup", "a", at(30), TTL).unwrap());
        assert_eq!(
            held(&database, at(59)).unwrap(),
            ["job:backup", "job:recurring"]
        );
        assert_eq!(held(&database, at(60)).unwrap(), ["job:backup"]);
    }
}

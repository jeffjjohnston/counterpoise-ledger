//! The scheduled jobs, run in this process on the schedule that the crontab
//! of the `scheduler` container used, in the local time zone (`TZ`):
//!
//! - recurring transactions: hourly at :00;
//! - Plaid sync: 00:00, 06:00, 12:00 and 18:00;
//! - security prices: 06:00, Tuesday to Saturday;
//! - TypeSafe cleanup: hourly at :15;
//! - backup: hourly from 06:00 to 21:00 (`ledger_db::backup::snapshot` into
//!   `BACKUP_DIR`, default `/backups`);
//! - prune: 04:00 daily, backups older than 30 days, then `PRAGMA optimize`;
//! - reindex: `VACUUM` at 03:00 on the first of the month. The job keeps
//!   the name of the PostgreSQL REINDEX that it replaces.
//!
//! `COUNTERPOISE_SCHEDULER=on` starts it. The binary default is off, so that
//! a test server or a development server never runs a job on its own. The
//! production image sets it on.
//!
//! A job that is still running when its next time comes is not started
//! again: the run is skipped. Backup, prune and reindex share one lock, so
//! none of them overlaps another. Each run of a job that records status
//! writes `<STATUS_DIR>/<job>.json`, the record that `/api/system/status`
//! reads: `job`, `lastRun`, `lastOk`, `verified`, `bytes` and `detail`. A job
//! that has no secret to work with (Plaid sync, price sync) runs nothing and
//! records `notConfigured: true`, with the missing setting in `detail`. The
//! manual `/api/cron/*` routes record a run the same way (`record_run`), but
//! only when the install has a status directory.

use crate::{
    routes::{
        cron::{run_plaid_sync, run_price_sync, run_recurring},
        typesafe::run_cleanup,
    },
    state::AppState,
};
use chrono::{DateTime, Datelike, Local, Timelike, Utc, Weekday};
use ledger_db::job_status::{Status, record_text, status_dir};
use std::{future::Future, path::PathBuf, pin::Pin, time::Duration};
use tokio::sync::Mutex;

/// What a run gives for its status record.
#[derive(Default)]
struct Report {
    detail: Option<String>,
    bytes: Option<u64>,
    verified: Option<bool>,
    /// The job had no secret and ran nothing.
    not_configured: bool,
}

/// What a route job gives for its status record. A skipped run that names a
/// missing setting is "not configured". Any other `Ok` is a success.
fn report_of(result: &crate::error::ApiResult) -> Result<Report, String> {
    match result {
        // A price sync that Tiingo stopped with a 429 left prices out.
        Ok(body) if body.0["rateLimited"] == true => Err(format!(
            "Tiingo request limit reached: {} of {} securities have a new price",
            body.0["pricesInserted"], body.0["securitiesFound"]
        )),
        Ok(body) => Ok(match body.0["missingSetting"].as_str() {
            Some(setting) if body.0["skipped"] == true => Report {
                detail: Some(format!("not configured: {setting} is not set")),
                not_configured: true,
                ..Report::default()
            },
            _ => Report::default(),
        }),
        Err(failure) => Err(failure.message().to_owned()),
    }
}

type JobRun =
    for<'a> fn(&'a AppState) -> Pin<Box<dyn Future<Output = Result<Report, String>> + Send + 'a>>;

/// A route job, whose result is an HTTP body or an HTTP error.
async fn route_job(run: impl Future<Output = crate::error::ApiResult>) -> Result<Report, String> {
    report_of(&run.await)
}

/// Records a manual run of a route job, with the rules of a scheduled run.
/// The scheduler records its own runs in `run_once`, so a run is never
/// recorded twice. Without a status directory (a development checkout or a
/// CI runner), the run records nothing and logs nothing.
pub(crate) async fn record_run(job: &str, result: &crate::error::ApiResult) {
    if let Some(dir) = ledger_db::job_status::configured_status_dir() {
        record_outcome(&dir, job, &report_of(result)).await;
    }
}

fn backup_dir() -> PathBuf {
    PathBuf::from(std::env::var("BACKUP_DIR").unwrap_or_else(|_| "/backups".to_owned()))
}

async fn backup(state: &AppState) -> Result<Report, String> {
    backup_into(state, &backup_dir()).await
}

async fn backup_into(state: &AppState, dir: &std::path::Path) -> Result<Report, String> {
    let snapshot = ledger_db::backup::snapshot(&state.pool, dir).await?;
    tracing::info!(path = %snapshot.path.display(), bytes = snapshot.bytes, "Backup written");
    // A copy that fails its check is still a copy: the run succeeds, and the
    // record says that the copy is not verified, as for a dump that
    // pg_restore could not read.
    Ok(Report {
        detail: snapshot
            .problem
            .map(|problem| format!("integrity_check: {problem}")),
        bytes: Some(snapshot.bytes),
        verified: Some(snapshot.verified),
        ..Report::default()
    })
}

async fn prune(state: &AppState) -> Result<Report, String> {
    let deleted = ledger_db::backup::prune(&backup_dir(), 30)?;
    ledger_db::backup::optimize(&state.pool).await?;
    tracing::info!(deleted, "Old backups pruned");
    Ok(Report::default())
}

async fn reindex(state: &AppState) -> Result<Report, String> {
    ledger_db::backup::vacuum(&state.pool).await?;
    Ok(Report::default())
}

#[derive(Clone, Copy)]
struct Job {
    /// The name in logs and in the status file.
    name: &'static str,
    /// Whether the job writes a status file.
    records_status: bool,
    due: fn(&DateTime<Local>) -> bool,
    lock: fn(&AppState) -> &Mutex<()>,
    run: JobRun,
}

const JOBS: [Job; 7] = [
    Job {
        name: "recurring",
        records_status: true,
        due: |time| time.minute() == 0,
        lock: |state| &state.jobs.recurring,
        run: |state| Box::pin(route_job(run_recurring(state))),
    },
    Job {
        name: "plaid-sync",
        records_status: true,
        due: |time| time.minute() == 0 && time.hour() % 6 == 0,
        lock: |state| &state.jobs.plaid_sync,
        run: |state| Box::pin(route_job(run_plaid_sync(state))),
    },
    Job {
        name: "price-sync",
        records_status: true,
        due: |time| {
            time.minute() == 0
                && time.hour() == 6
                && !matches!(time.weekday(), Weekday::Sun | Weekday::Mon)
        },
        lock: |state| &state.jobs.price_sync,
        run: |state| Box::pin(route_job(run_price_sync(state))),
    },
    Job {
        name: "typesafe-cleanup",
        records_status: false,
        due: |time| time.minute() == 15,
        lock: |state| &state.jobs.typesafe_cleanup,
        run: |state| Box::pin(route_job(run_cleanup(state))),
    },
    Job {
        name: "backup",
        records_status: true,
        due: |time| time.minute() == 0 && (6..=21).contains(&time.hour()),
        lock: |state| &state.jobs.maintenance,
        run: |state| Box::pin(backup(state)),
    },
    Job {
        name: "prune",
        records_status: true,
        due: |time| time.minute() == 0 && time.hour() == 4,
        lock: |state| &state.jobs.maintenance,
        run: |state| Box::pin(prune(state)),
    },
    Job {
        name: "reindex",
        records_status: true,
        due: |time| time.minute() == 0 && time.hour() == 3 && time.day() == 1,
        lock: |state| &state.jobs.maintenance,
        run: |state| Box::pin(reindex(state)),
    },
];

/// Whether `COUNTERPOISE_SCHEDULER` asks for the scheduler.
pub(crate) fn enabled() -> bool {
    std::env::var("COUNTERPOISE_SCHEDULER").is_ok_and(|value| value == "on")
}

/// Starts the scheduler task. It runs until the process ends.
pub(crate) fn start(state: AppState) {
    tracing::info!("Scheduler started");
    tokio::spawn(async move {
        loop {
            let now = Local::now();
            tokio::time::sleep(until_next_minute(&now)).await;
            // The minute that has just begun. A small late wake-up still
            // lands in it.
            let minute = Local::now();
            for job in JOBS.iter().filter(|job| (job.due)(&minute)) {
                let (state, job) = (state.clone(), *job);
                tokio::spawn(async move { run_once(&state, job).await });
            }
        }
    });
}

fn until_next_minute(now: &DateTime<Local>) -> Duration {
    let into_minute = Duration::from_secs(u64::from(now.second()))
        + Duration::from_nanos(u64::from(now.nanosecond() % 1_000_000_000));
    // A second past the boundary, so the clock read after the sleep is in
    // the new minute even when the timer fires early.
    Duration::from_secs(61).saturating_sub(into_minute)
}

async fn run_once(state: &AppState, job: Job) {
    let Ok(_running) = (job.lock)(state).try_lock() else {
        tracing::warn!(
            job = job.name,
            "Scheduled job skipped: the previous run is still running"
        );
        return;
    };
    tracing::info!(job = job.name, "Scheduled job started");
    let outcome = (job.run)(state).await;
    match &outcome {
        Ok(_) => tracing::info!(job = job.name, "Scheduled job finished"),
        Err(failure) => {
            tracing::error!(job = job.name, error = %failure, "Scheduled job failed")
        }
    }
    if job.records_status {
        record_outcome(&status_dir(), job.name, &outcome).await;
    }
}

async fn record_outcome(dir: &std::path::Path, job: &str, outcome: &Result<Report, String>) {
    let status = match outcome {
        Ok(report) => Status {
            ok: true,
            detail: report.detail.as_deref(),
            bytes: report.bytes,
            verified: report.verified,
            not_configured: report.not_configured,
        },
        Err(failure) => Status {
            detail: Some(failure.as_str()),
            ..Status::default()
        },
    };
    write_status(dir, job, &status, Utc::now()).await;
}

/// Writes the status record of a job (`ledger_db::job_status`). A failure to
/// write is logged, never raised: the bookkeeping of a job must not fail the
/// job.
pub(crate) async fn write_status(
    dir: &std::path::Path,
    job: &str,
    status: &Status<'_>,
    at: DateTime<Utc>,
) {
    let text = record_text(job, status, at);
    let (dir, name) = (dir.to_owned(), job.to_owned());
    let result = tokio::task::spawn_blocking(move || {
        ledger_db::job_status::write_record(&dir, &name, &text)
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(cause)) => tracing::warn!(job, error = %cause, "Could not record the job status"),
        Err(cause) => tracing::warn!(job, error = %cause, "Could not record the job status"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn due(name: &str, time: &DateTime<Local>) -> bool {
        let job = JOBS.iter().find(|job| job.name == name).expect("a job");
        (job.due)(time)
    }

    #[test]
    fn jobs_are_due_on_the_crontab_schedule() {
        // The schedule reads local time; these checks do not depend on the
        // zone because they read the same local time that they build.
        let at = |day: u32, hour: u32, minute: u32| {
            Local
                .with_ymd_and_hms(2026, 9, day, hour, minute, 0)
                .single()
                .expect("an unambiguous local time")
        };
        // 2026-09-29 is a Tuesday, 2026-09-27 a Sunday, 2026-09-28 a Monday.
        assert!(due("recurring", &at(29, 13, 0)));
        assert!(!due("recurring", &at(29, 13, 1)));
        assert!(due("plaid-sync", &at(29, 0, 0)));
        assert!(due("plaid-sync", &at(29, 18, 0)));
        assert!(!due("plaid-sync", &at(29, 7, 0)));
        assert!(due("price-sync", &at(29, 6, 0)));
        assert!(!due("price-sync", &at(27, 6, 0)));
        assert!(!due("price-sync", &at(28, 6, 0)));
        assert!(!due("price-sync", &at(29, 7, 0)));
        assert!(due("typesafe-cleanup", &at(29, 9, 15)));
        assert!(!due("typesafe-cleanup", &at(29, 9, 0)));
        assert!(due("backup", &at(29, 6, 0)));
        assert!(due("backup", &at(29, 21, 0)));
        assert!(!due("backup", &at(29, 22, 0)));
        assert!(!due("backup", &at(29, 5, 0)));
        assert!(!due("backup", &at(29, 12, 30)));
        assert!(due("prune", &at(29, 4, 0)));
        assert!(!due("prune", &at(29, 3, 0)));
        assert!(due("reindex", &at(1, 3, 0)));
        assert!(!due("reindex", &at(2, 3, 0)));
    }

    #[test]
    fn the_sleep_ends_after_the_next_minute_boundary() {
        let time = Local
            .with_ymd_and_hms(2026, 9, 29, 10, 0, 59)
            .single()
            .unwrap();
        assert_eq!(until_next_minute(&time), Duration::from_secs(2));
        let time = Local
            .with_ymd_and_hms(2026, 9, 29, 10, 0, 0)
            .single()
            .unwrap();
        assert_eq!(until_next_minute(&time), Duration::from_secs(61));
    }

    #[tokio::test]
    async fn a_job_that_is_still_running_is_not_started_again() {
        // The pool is lazy and points at no server: a run that starts would
        // wait for a connection, and the timeout below would fail the test.
        let state = AppState::new(std::path::Path::new("/nonexistent/counterpoise.db")).unwrap();
        let _running = state.jobs.recurring.lock().await;
        let job = JOBS
            .iter()
            .find(|job| job.name == "recurring")
            .copied()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), run_once(&state, job))
            .await
            .expect("the run is skipped at once");
    }

    #[tokio::test]
    async fn a_backup_run_reports_a_verified_copy_and_its_size() {
        let database = ledger_db::testing::TempDatabase::new(2).await;
        let state = AppState::with_pool(
            database.pool().clone(),
            crate::book_changes::BookChangeHub::detached(),
        );
        let dir =
            std::env::temp_dir().join(format!("counterpoise-job-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let report = backup_into(&state, &dir).await.unwrap();
        assert_eq!(report.verified, Some(true));
        assert!(report.bytes.is_some_and(|bytes| bytes > 0));
        assert!(report.detail.is_none());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn unconfigured_state() -> AppState {
        let mut state =
            AppState::new(std::path::Path::new("/nonexistent/counterpoise.db")).unwrap();
        state.plaid = crate::plaid::Plaid::new(None, None, None, None);
        state.tiingo = crate::tiingo::Tiingo::new(None, None);
        state
    }

    fn read_record(dir: &std::path::Path, job: &str) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{job}.json"))).unwrap())
            .unwrap()
    }

    #[tokio::test]
    async fn a_job_with_no_secret_records_not_configured() {
        let state = unconfigured_state();
        let dir =
            std::env::temp_dir().join(format!("counterpoise-unconfigured-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (name, setting) in [
            ("plaid-sync", "PLAID_CLIENT_ID"),
            ("price-sync", "TIINGO_API_KEY"),
        ] {
            let job = JOBS.iter().find(|job| job.name == name).copied().unwrap();
            let outcome = (job.run)(&state).await;
            record_outcome(&dir, name, &outcome).await;
            let record = read_record(&dir, name);
            assert_eq!(record["notConfigured"], true);
            assert_eq!(
                record["detail"],
                format!("not configured: {setting} is not set")
            );
            assert_eq!(record["lastOk"], record["lastRun"]);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_manual_run_records_its_outcome_like_a_scheduled_run() {
        let state = unconfigured_state();
        let dir = std::env::temp_dir().join(format!("counterpoise-manual-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let skipped = crate::routes::cron::run_plaid_sync(&state).await;
        record_outcome(&dir, "plaid-sync", &report_of(&skipped)).await;
        assert_eq!(read_record(&dir, "plaid-sync")["notConfigured"], true);

        let done: crate::error::ApiResult = Ok(axum::Json(json!({ "success": true })));
        record_outcome(&dir, "recurring", &report_of(&done)).await;
        let record = read_record(&dir, "recurring");
        assert!(record.get("notConfigured").is_none());
        assert_eq!(record["lastOk"], record["lastRun"]);

        let failed: crate::error::ApiResult = Err(crate::error::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to process recurring rules",
        ));
        record_outcome(&dir, "recurring", &report_of(&failed)).await;
        let record = read_record(&dir, "recurring");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(record["detail"], "Failed to process recurring rules");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_rate_limited_price_sync_records_a_failure() {
        let dir = std::env::temp_dir().join(format!("counterpoise-limited-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let limited: crate::error::ApiResult = Ok(axum::Json(json!({
            "success": true, "securitiesFound": 5, "pricesInserted": 1, "pricesSkipped": 0,
            "errors": [{}, {}, {}], "rateLimited": true,
        })));
        record_outcome(&dir, "price-sync", &report_of(&limited)).await;
        let record = read_record(&dir, "price-sync");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(
            record["detail"],
            "Tiingo request limit reached: 1 of 5 securities have a new price"
        );

        // Other symbol errors leave the run ok. The log has each of them.
        let partial: crate::error::ApiResult = Ok(axum::Json(json!({
            "success": true, "securitiesFound": 5, "pricesInserted": 3, "pricesSkipped": 0,
            "errors": [{}, {}],
        })));
        record_outcome(&dir, "price-sync", &report_of(&partial)).await;
        let record = read_record(&dir, "price-sync");
        assert_eq!(record["lastOk"], record["lastRun"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_status_record_has_the_fields_that_the_status_route_reads() {
        let dir = std::env::temp_dir().join(format!("counterpoise-status-{}", std::process::id()));
        let at = Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 5).unwrap();
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        write_status(&dir, "recurring", &ok, at).await;
        let bad = Status {
            detail: Some("bad\ntoken"),
            ..Status::default()
        };
        write_status(&dir, "plaid-sync", &bad, at).await;
        let ok: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("recurring.json")).unwrap())
                .unwrap();
        assert_eq!(
            ok,
            json!({
                "job": "recurring", "lastRun": "2026-09-29T10:00:05Z",
                "lastOk": "2026-09-29T10:00:05Z", "verified": null, "bytes": null, "detail": null,
            })
        );
        let failed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("plaid-sync.json")).unwrap())
                .unwrap();
        assert_eq!(failed["lastOk"], serde_json::Value::Null);
        assert_eq!(failed["detail"], "bad token");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

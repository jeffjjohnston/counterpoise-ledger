//! The scheduled jobs, run in this process on the schedule that the crontab
//! of the `scheduler` container used, in the local time zone (`TZ`):
//!
//! - recurring transactions: hourly at :00;
//! - Plaid sync: 00:00, 06:00, 12:00 and 18:00;
//! - security prices: 06:00, Tuesday to Saturday;
//! - TypeSafe cleanup: hourly at :15;
//! - issue sync: hourly at :30, when `ISSUE_SYNC_GITHUB_REPO` and
//!   `ISSUE_SYNC_GITHUB_TOKEN` are set (guides/issue-sync.md);
//! - weekly review: Monday 05:00, for each book that opted in, and again
//!   at 06:00 and 07:00 for each book that still has no review;
//! - backup: hourly from 06:00 to 21:00 (`ledger_db::backup::snapshot` into
//!   `BACKUP_DIR`, default `/backups`), and the first run of each UTC day
//!   also writes a portable dump (`ledger_db::backup::daily_dump`);
//! - prune: 04:00 daily, backups older than 30 days, then `PRAGMA optimize`;
//! - reindex: `VACUUM` at 03:00 on the first of the month. The job keeps
//!   the name of the PostgreSQL REINDEX that it replaces;
//! - lot rebuild: never on the schedule. A Durable Object asks for it when
//!   it starts on a file that has trades and no lots, or whose last
//!   rebuild failed ([`request_lot_rebuild`]), and it rebuilds
//!   [`LOT_PAIRS_PER_STEP`] pairs per step.
//!
//! `COUNTERPOISE_SCHEDULER=on` starts it. The binary default is off, so that
//! a test server or a development server never runs a job on its own. The
//! production image sets it on.
//!
//! On a Durable Object the object's alarm runs the jobs instead ([`alarm`]):
//! each alarm runs one step of one due job, and the object sets the next
//! alarm from the plan that follows. The plan puts a run that failed to
//! finish after the other due jobs, so it does not block them. Reindex needs
//! the native server's file, so a Durable Object leaves it off its schedule.
//! Its backup is a daily dump into the export bucket at 03:45 ([`export`]).
//!
//! At each minute the loop reads the job tables and asks [`plan::plan`]
//! which jobs are due. A run claims its slot, the scheduled minute that it
//! serves, in `job_slots` before it starts, and marks it finished when it
//! ends. So a run that stopped half way (the process died) runs again at a
//! later wake, and every job must leave things as they are when it runs a
//! second time. The slot counts the starts of its current step. When a step
//! has started [`MAX_ATTEMPTS`] times and the run is still unfinished, the
//! scheduler finishes the slot and records a failed run, so a run that
//! never finishes does not start again without end. A job that works in
//! steps (the weekly review, one book per step; the Plaid sync,
//! [`PLAID_TOKENS_PER_STEP`] connections per step) keeps where its next step
//! starts in the slot's cursor; the loop runs the steps one after the other.
//! A run asked for outside the schedule waits in `job_requests`.
//!
//! A job that is still running when its next time comes is not started
//! twice: each run holds the job's lease (`crate::leases`); backup, prune
//! and reindex share one, so none of them overlaps another. The new slot
//! starts when the run ends, if it is no more than [`plan::GRACE`] old by
//! then. Each run of a job that records status writes its row
//! of `job_runs` (`ledger_db::jobs`), the record that `/api/system/status`
//! reads: `job`, `lastRun`, `lastOk`, `verified`, `bytes` and `detail`. A job
//! that has no secret to work with (Plaid sync, price sync) runs nothing and
//! records `notConfigured: true`, with the missing setting in `detail`. The
//! manual `/api/cron/*` routes record a run the same way (`record_run`, and
//! [`backup_now`] for the backup).

mod offsite;
mod plan;

use crate::leases;
use crate::{
    issue_sync::run_issue_sync,
    platform,
    routes::{
        cron::{run_price_sync, run_recurring, sync_connections},
        typesafe::run_cleanup,
        weekly_review::review_books,
    },
    state::AppState,
};
use chrono::{DateTime, Datelike, Timelike, Utc, Weekday};
use ledger_db::clock::Tz;
use ledger_db::{
    Database,
    jobs::{self, Status},
};
use plan::{Due, Known, Last, Plan, Schedule};
use std::{
    collections::HashMap, future::Future, path::Path, path::PathBuf, pin::Pin, time::Duration,
};

/// How many Plaid connections one step of the scheduled sync syncs.
const PLAID_TOKENS_PER_STEP: usize = 3;

/// How many (account, security) pairs one step of the lot rebuild rebuilds.
const LOT_PAIRS_PER_STEP: usize = 50;

/// How long an alarm waits before it tries again a job that it could not
/// start (another run holds its lease, or the job tables could not be read).
const RETRY: chrono::TimeDelta = chrono::TimeDelta::minutes(1);

/// How many times the scheduler starts one step of a run. A step that
/// stops before it returns (an alarm that passed its time limit, a panic, a
/// crash), or that fails in a job that resumes its failures, starts again
/// until it has started this many times. The scheduler then finishes the
/// slot and records a failed run.
const MAX_ATTEMPTS: u32 = 3;

/// What a run gives for its status record.
#[derive(Default)]
struct Report {
    detail: Option<String>,
    bytes: Option<u64>,
    verified: Option<bool>,
    /// The job had no secret and ran nothing.
    not_configured: bool,
    /// The job has more steps to run, and the next one starts here.
    more: Option<String>,
    /// The name of the file or the object that a backup wrote.
    name: Option<String>,
}

/// What a route job gives for its status record. A skipped run that names a
/// missing setting is "not configured". Any other `Ok` is a success.
fn report_of(result: &crate::error::ApiResult) -> Result<Report, String> {
    match result {
        // A weekly review run that left a book with no review of the week:
        // its review failed, or a manual review of the book was running.
        Ok(body)
            if body.0["booksWithoutReview"]
                .as_u64()
                .is_some_and(|books| books > 0) =>
        {
            let books = body.0["booksWithoutReview"].as_u64().unwrap_or_default();
            Err(if books == 1 {
                "1 book that opted in has no review of this week".to_owned()
            } else {
                format!("{books} books that opted in have no review of this week")
            })
        }
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

/// One step of a job. It takes the cursor where the step starts, `None` for
/// the first.
type JobRun = for<'a> fn(
    &'a AppState,
    Option<String>,
) -> Pin<Box<dyn Future<Output = Result<Report, String>> + Send + 'a>>;

/// A route job, whose result is an HTTP body or an HTTP error.
async fn route_job(run: impl Future<Output = crate::error::ApiResult>) -> Result<Report, String> {
    report_of(&run.await)
}

/// A route job that works in steps over rows in ID order. The cursor is the
/// ID of the last row that the previous step handled.
async fn route_steps<F>(
    cursor: Option<String>,
    step: impl FnOnce(Option<i32>) -> F,
) -> Result<Report, String>
where
    F: Future<
        Output = Result<(axum::Json<serde_json::Value>, Option<i32>), crate::error::ApiError>,
    >,
{
    let after = cursor.and_then(|cursor| cursor.parse().ok());
    let (result, next) = match step(after).await {
        Ok((body, next)) => (Ok(body), next),
        Err(failure) => (Err(failure), None),
    };
    Ok(Report {
        more: next.map(|id| id.to_string()),
        ..report_of(&result)?
    })
}

/// Records a manual run of a route job, with the rules of a scheduled run.
/// The scheduler records its own runs in `run_due`, so a run is never
/// recorded twice.
pub(crate) fn record_run(state: &AppState, job: &str, result: &crate::error::ApiResult) {
    record_outcome(&state.database, job, &report_of(result));
}

#[cfg(feature = "native")]
fn backup_dir() -> PathBuf {
    PathBuf::from(ledger_db::env::var("BACKUP_DIR").unwrap_or_else(|_| "/backups".to_owned()))
}

#[cfg(feature = "native")]
async fn backup(state: &AppState) -> Result<Report, String> {
    backup_into(state, &backup_dir()).await
}

#[cfg(feature = "native")]
async fn backup_into(state: &AppState, dir: &std::path::Path) -> Result<Report, String> {
    let (database, dir) = (state.database.clone(), dir.to_path_buf());
    let (snapshot, dumped) = blocking(move || {
        let snapshot = ledger_db::backup::snapshot(&database, &dir)?;
        Ok((snapshot, ledger_db::backup::daily_dump(&database, &dir)))
    })
    .await?;
    tracing::info!(path = %snapshot.path.display(), bytes = snapshot.bytes, "Backup written");
    // A failed dump does not fail the copy: the record names it.
    let dump_problem = match dumped {
        Ok(Some((path, bytes))) => {
            tracing::info!(path = %path.display(), bytes, "Dump written");
            None
        }
        Ok(None) => None,
        Err(cause) => {
            tracing::error!(%cause, "Dump failed");
            Some(format!("dump: {cause}"))
        }
    };
    // A copy that fails its check is still a copy: the run succeeds, and the
    // record says that the copy is not verified, as for a dump that
    // pg_restore could not read.
    Ok(Report {
        detail: snapshot
            .problem
            .map(|problem| format!("integrity_check: {problem}"))
            .into_iter()
            .chain(dump_problem)
            .reduce(|first, second| format!("{first}; {second}")),
        bytes: Some(snapshot.bytes),
        verified: Some(snapshot.verified),
        name: snapshot
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        ..Report::default()
    })
}

#[cfg(feature = "native")]
async fn prune(state: &AppState) -> Result<Report, String> {
    prune_in(state, &backup_dir()).await
}

#[cfg(feature = "native")]
async fn prune_in(state: &AppState, dir: &Path) -> Result<Report, String> {
    let deleted = ledger_db::backup::prune(dir, 30)?;
    ledger_db::backup::optimize(&state.database)?;
    tracing::info!(deleted, "Old backups pruned");
    prune_rate_limits(state)
}

/// The failures of the rate limiter prune its table as they come; this
/// catches the rows of a quiet day.
fn prune_rate_limits(state: &AppState) -> Result<Report, String> {
    let expired = state
        .rate_limits
        .prune(platform::timestamp())
        .map_err(|cause| format!("prune the rate limits: {cause}"))?;
    tracing::info!(expired, "Expired rate limits deleted");
    Ok(Report::default())
}

#[cfg(feature = "native")]
async fn reindex(state: &AppState) -> Result<Report, String> {
    let database = state.database.clone();
    blocking(move || ledger_db::backup::vacuum(&database)).await?;
    Ok(Report::default())
}

/// One step of the lot rebuild. The cursor is the last pair rebuilt.
async fn lot_rebuild(state: &AppState, cursor: Option<String>) -> Result<Report, String> {
    let after = cursor
        .map(|cursor| cursor.parse::<ledger_db::lots::RebuildCursor>())
        .transpose()
        .map_err(|cause| cause.to_string())?;
    let next = ledger_db::lots::rebuild_lots_step(&state.database, after, LOT_PAIRS_PER_STEP)
        .map_err(|cause| format!("rebuild the lots: {cause}"))?;
    if next.is_none() {
        tracing::info!("Lots rebuilt");
    }
    Ok(Report {
        more: next.map(|next| next.to_string()),
        ..Report::default()
    })
}

/// The backup of a Durable Object, which has no file to copy: the day's
/// dump (`ledger-cli dump` format) into the export bucket, as
/// `counterpoise-YYYY-MM-DD.json`, then the same bytes under the same name
/// into the S3 bucket of `offsite`, when its settings are set. A second run
/// on one day writes the same names again. The lifecycle rule of each bucket
/// deletes a dump after 30 days.
#[cfg(not(feature = "native"))]
async fn backup(state: &AppState) -> Result<Report, String> {
    export_as(state, export_name(platform::today())).await
}

/// Exports the dump as `name` into the export bucket, and into the S3
/// bucket of `offsite` when its settings are set.
#[cfg(not(feature = "native"))]
async fn export_as(state: &AppState, name: String) -> Result<Report, String> {
    let copy = match offsite::Target::from_env() {
        Ok(None) => Copy::Off,
        Err(fault) => Copy::Faulty(fault),
        Ok(Some(target)) => Copy::On(move |name: String, text: Vec<u8>| async move {
            offsite::put(&target, &name, text).await
        }),
    };
    export(&state.database, name, platform::put_export, copy).await
}

/// The backup that a manual run makes. The native server makes the copy
/// that its scheduled run makes: the name of a snapshot has its time, so a
/// copy never replaces another.
#[cfg(feature = "native")]
async fn manual_backup(state: &AppState) -> Result<Report, String> {
    backup(state).await
}

/// The backup that a manual run makes. A Durable Object exports the dump
/// under a name that has the time ([`manual_export_name`]), so the run does
/// not replace the dump of the day.
#[cfg(not(feature = "native"))]
async fn manual_backup(state: &AppState) -> Result<Report, String> {
    export_as(state, manual_export_name(platform::now())).await
}

/// Runs the backup now, for `GET /api/cron/backup`. The run waits for the
/// lease that backup, prune and reindex share, and records its status as a
/// scheduled run does. The answer gives the name of the file or the object
/// that the run wrote.
///
/// A failure answers 500 with its cause, which is the `detail` that the
/// status record gets. The caller has the cron secret, and must know, for
/// example, that a dump is in R2 but not in S3.
pub(crate) async fn backup_now(state: &AppState) -> crate::error::ApiResult {
    let running = leases::wait(&state.database, leases::Job::Maintenance.lease_name())
        .await
        .map_err(|cause| crate::error::internal_error(cause, "Failed to start the job"))?;
    let outcome = running
        .guard(manual_backup(state))
        .await
        .unwrap_or_else(|lost| Err(lost.to_string()));
    record_outcome(&state.database, "backup", &outcome);
    match outcome {
        Ok(report) => {
            let mut body = serde_json::json!({ "success": true });
            for (key, value) in [
                ("name", report.name.map(serde_json::Value::from)),
                ("bytes", report.bytes.map(serde_json::Value::from)),
                ("verified", report.verified.map(serde_json::Value::from)),
                ("detail", report.detail.map(serde_json::Value::from)),
            ] {
                if let Some(value) = value {
                    body[key] = value;
                }
            }
            Ok(axum::Json(body))
        }
        Err(failure) => {
            tracing::error!(error = %failure, "Manual backup failed");
            Err(crate::error::error_owned(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                failure,
            ))
        }
    }
}

/// The second copy of the dump, outside Cloudflare (`offsite`).
#[cfg_attr(feature = "native", allow(dead_code))]
enum Copy<P> {
    /// No setting of the copy is set.
    Off,
    /// Some settings are set, and the copy cannot run: the fault.
    Faulty(String),
    /// Writes the copy: it takes the name and the JSON text.
    On(P),
}

/// A [`Copy`] that is never `On`.
#[cfg(test)]
type NoCopy = fn(String, Vec<u8>) -> std::future::Ready<Result<(), String>>;

/// Writes the dump of `database` as `name` with `put`, which takes the name
/// and the JSON text, then with `copy`. A copy that fails, or that cannot
/// run, makes the run a failure, but the first dump stays stored. Without a
/// copy the text is the one copy of the dump in memory; with one there are
/// two.
#[cfg_attr(feature = "native", allow(dead_code))]
async fn export<F, G, P>(
    database: &Database,
    name: String,
    put: impl FnOnce(String, Vec<u8>) -> F,
    copy: Copy<P>,
) -> Result<Report, String>
where
    F: Future<Output = Result<(), String>>,
    G: Future<Output = Result<(), String>>,
    P: FnOnce(String, Vec<u8>) -> G,
{
    let dump = database
        .read_transaction(|tx| ledger_db::dump::dump_json(tx))
        .map_err(|cause| format!("the dump failed: {cause}"))?;
    let bytes = dump.len() as u64;
    let copy = match copy {
        Copy::Off => None,
        Copy::Faulty(fault) => Some(Err(fault)),
        Copy::On(put_copy) => Some(Ok((put_copy, dump.clone()))),
    };
    put(name.clone(), dump)
        .await
        .map_err(|cause| format!("the dump was not stored: {cause}"))?;
    tracing::info!(name, bytes, "Dump exported");
    let detail = match copy {
        None => None,
        Some(copy) => {
            let (put_copy, text) =
                copy.map_err(|fault| format!("the dump is in R2 but not in S3: {fault}"))?;
            put_copy(name.clone(), text)
                .await
                .map_err(|cause| format!("the dump is in R2 but not in S3: {cause}"))?;
            tracing::info!(name, bytes, "Dump copied to S3");
            Some("stored in R2 and S3".to_owned())
        }
    };
    Ok(Report {
        bytes: Some(bytes),
        detail,
        name: Some(name),
        ..Report::default()
    })
}

/// The name of the dump that the scheduled run of `day` exports.
#[cfg_attr(feature = "native", allow(dead_code))]
fn export_name(day: chrono::NaiveDate) -> String {
    format!("counterpoise-{day}.json")
}

/// The name of the dump that a manual run at `now` exports. It has the UTC
/// time in the form of a native snapshot's name, and the word `manual`, so
/// it is never the name of a day's dump ([`export_name`]). It starts with
/// `counterpoise-`, as the lifecycle rule and the write permission of the
/// S3 bucket need.
#[cfg_attr(feature = "native", allow(dead_code))]
fn manual_export_name(now: DateTime<Utc>) -> String {
    format!("counterpoise-manual-{}.json", now.format("%Y%m%d-%H%M%S"))
}

/// The prune of a Durable Object, which has no backup folder: the rate
/// limits, which are in the database.
#[cfg(not(feature = "native"))]
async fn prune(state: &AppState) -> Result<Report, String> {
    prune_rate_limits(state)
}

/// `VACUUM` needs the native server's file.
#[cfg(not(feature = "native"))]
async fn reindex(_state: &AppState) -> Result<Report, String> {
    Err("the reindex job needs the native server".to_owned())
}

/// Runs a job step that takes seconds (a copy of the file, a `VACUUM`) on
/// a blocking thread, so no worker of the async runtime waits on it.
async fn blocking<T: Send + 'static>(
    step: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    platform::blocking(step)
        .await
        .map_err(|cause| format!("the job step stopped: {cause}"))?
}

/// The native server copies its file hourly by day. A Durable Object
/// exports one dump a day.
#[cfg(feature = "native")]
const BACKUP_DUE: Schedule = |time| time.minute() == 0 && (6..=21).contains(&time.hour());
#[cfg(not(feature = "native"))]
const BACKUP_DUE: Schedule = |time| time.minute() == 45 && time.hour() == 3;

#[derive(Clone, Copy)]
struct Job {
    /// The name in logs and in the status file.
    name: &'static str,
    /// Whether the job writes a status file.
    records_status: bool,
    /// Whether the job needs the native server's file. A Durable Object
    /// leaves it off its schedule.
    native_only: bool,
    /// Whether a failed step stays unfinished, so that the next plan goes on
    /// with it from its cursor, until the step has started [`MAX_ATTEMPTS`]
    /// times. A scheduled job's next slot runs it again; a job off the
    /// schedule has no next slot.
    resumes_failures: bool,
    due: Schedule,
    lease: leases::Job,
    run: JobRun,
}

const JOBS: [Job; 10] = [
    Job {
        name: "recurring",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |time| time.minute() == 0,
        lease: leases::Job::Recurring,
        run: |state, _| Box::pin(route_job(run_recurring(state))),
    },
    Job {
        name: "plaid-sync",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |time| time.minute() == 0 && time.hour() % 6 == 0,
        lease: leases::Job::PlaidSync,
        run: |state, cursor| {
            Box::pin(route_steps(cursor, |after| {
                sync_connections(state, after, PLAID_TOKENS_PER_STEP)
            }))
        },
    },
    Job {
        name: "price-sync",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |time| {
            time.minute() == 0
                && time.hour() == 6
                && !matches!(time.weekday(), Weekday::Sun | Weekday::Mon)
        },
        lease: leases::Job::PriceSync,
        run: |state, _| Box::pin(route_job(run_price_sync(state))),
    },
    Job {
        name: "weekly-review",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        // The runs at 06:00 and 07:00 review the books that the run before
        // left with no review. They ask nothing when each book has one.
        due: |time| {
            time.minute() == 0 && (5..=7).contains(&time.hour()) && time.weekday() == Weekday::Mon
        },
        lease: leases::Job::WeeklyReview,
        run: |state, cursor| Box::pin(route_steps(cursor, |after| review_books(state, after, 1))),
    },
    Job {
        name: "typesafe-cleanup",
        records_status: false,
        native_only: false,
        resumes_failures: false,
        due: |time| time.minute() == 15,
        lease: leases::Job::TypesafeCleanup,
        run: |state, _| Box::pin(route_job(run_cleanup(state))),
    },
    Job {
        name: "issue-sync",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |time| time.minute() == 30,
        lease: leases::Job::IssueSync,
        run: |state, _| Box::pin(route_job(run_issue_sync(state))),
    },
    Job {
        name: "backup",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: BACKUP_DUE,
        lease: leases::Job::Maintenance,
        run: |state, _| Box::pin(backup(state)),
    },
    Job {
        name: "prune",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |time| time.minute() == 0 && time.hour() == 4,
        lease: leases::Job::Maintenance,
        run: |state, _| Box::pin(prune(state)),
    },
    Job {
        name: "reindex",
        records_status: true,
        native_only: true,
        resumes_failures: false,
        due: |time| time.minute() == 0 && time.hour() == 3 && time.day() == 1,
        lease: leases::Job::Maintenance,
        run: |state, _| Box::pin(reindex(state)),
    },
    Job {
        name: "lot-rebuild",
        records_status: true,
        native_only: false,
        resumes_failures: true,
        due: |_| false,
        lease: leases::Job::LotRebuild,
        run: |state, cursor| Box::pin(lot_rebuild(state, cursor)),
    },
];

/// The jobs that this build schedules.
fn jobs() -> impl Iterator<Item = &'static Job> {
    JOBS.iter()
        .filter(|job| cfg!(feature = "native") || !job.native_only)
}

/// Whether `COUNTERPOISE_SCHEDULER` asks for the scheduler.
pub(crate) fn enabled() -> bool {
    ledger_db::env::var("COUNTERPOISE_SCHEDULER").is_ok_and(|value| value == "on")
}

/// Starts the scheduler task. It runs until the process ends.
pub(crate) fn start(state: AppState) {
    tracing::info!("Scheduler started");
    platform::spawn(async move {
        loop {
            let now = platform::local_now();
            platform::sleep(until_next_minute(&now)).await;
            // The minute that has just begun. A small late wake-up still
            // lands in it.
            let Some(plan) = plan_now(&state.database, platform::now()) else {
                continue;
            };
            tracing::debug!(next_wake = %plan.next_wake, "Scheduler planned");
            for due in plan.due {
                let Some(job) = job_named(due.job) else {
                    continue;
                };
                let state = state.clone();
                platform::spawn(async move { run_due(&state, job, due).await });
            }
        }
    });
}

fn job_named(name: &str) -> Option<Job> {
    jobs().find(|job| job.name == name).copied()
}

fn schedules() -> Vec<(&'static str, Schedule)> {
    jobs().map(|job| (job.name, job.due)).collect()
}

/// Asks for a run of `job` outside its schedule: the next wake runs it.
pub(crate) fn request(database: &Database, job: &str) -> Result<(), ledger_db::store::Error> {
    jobs::request(database, job, platform::timestamp())
}

/// Asks for the lot rebuild when the file needs it, and returns whether it
/// asked. The file needs it when it has trades and no lots (`lots_absent`),
/// or when the last rebuild failed: the scheduler stopped that rebuild part
/// way, so some lots exist and the file does not read as "no lots".
///
/// It does not ask while a run is unfinished. The plan resumes that run, and
/// a request would start a new run with a new count of starts, so a rebuild
/// that never finishes would never reach [`MAX_ATTEMPTS`].
pub(crate) fn request_lot_rebuild(
    database: &Database,
    lots_absent: bool,
) -> Result<bool, ledger_db::store::Error> {
    const JOB: &str = "lot-rebuild";
    if !lots_absent && !jobs::last_run_failed(database, JOB)? {
        return Ok(false);
    }
    let unfinished = jobs::slots(database)?
        .iter()
        .any(|slot| slot.job == JOB && !slot.finished);
    if unfinished {
        return Ok(false);
    }
    request(database, JOB)?;
    Ok(true)
}

/// When a Durable Object's next alarm is due: the plan's next wake, or a
/// minute from now when the job tables could not be read.
pub(crate) fn next_wake(database: &Database) -> DateTime<Utc> {
    let now = platform::now();
    plan_now(database, now).map_or(now + RETRY, |plan| plan.next_wake)
}

/// The alarm of a Durable Object: runs one step of the first due job and
/// returns when the next alarm is due. That is now when a job ran a step,
/// so the next alarm plans again at once and takes the next step or the
/// next due job. Each alarm's step fits in the alarm's time limit (15
/// minutes): the jobs that work in steps keep their steps short. A step
/// that does not fit stops with its alarm. The plan then puts its run after
/// the other due jobs, and [`step`] stops the run at its last attempt.
pub(crate) async fn alarm(state: &AppState) -> DateTime<Utc> {
    let now = platform::now();
    let Some(plan) = plan_now(&state.database, now) else {
        return now + RETRY;
    };
    let mut ready = plan
        .due
        .into_iter()
        .filter_map(|due| Some((job_named(due.job)?, due)));
    let Some((job, due)) = ready.next() else {
        return plan.next_wake;
    };
    // The other jobs due now claim their slots before this step runs. A
    // step can outlast the minute, and the next plan would then leave out a
    // job with no slot on record; a claimed slot is a run to resume.
    for (other, waiting) in ready.filter(|(_, due)| !due.resume) {
        if let Err(cause) = jobs::claim(&state.database, other.name, waiting.slot.naive_utc()) {
            tracing::error!(job = other.name, error = %cause, "Could not claim the job's slot");
        }
    }
    let Some(running) = begin(state, job, &due) else {
        return platform::now() + RETRY;
    };
    let slot = due.slot.naive_utc();
    match step(state, job, slot, due.cursor, &running).await {
        Step::More(_) | Step::Ended => platform::now(),
        Step::Unfinished => platform::now() + RETRY,
    }
}

/// The plan at `now`, from the job tables. A failure to read them is
/// logged, and nothing runs until the next wake.
fn plan_now(database: &Database, now: DateTime<Utc>) -> Option<Plan> {
    match known(database, now) {
        Ok(known) => Some(plan::plan(
            now,
            ledger_db::clock::zone(),
            &schedules(),
            &known,
        )),
        Err(cause) => {
            tracing::error!(error = %cause, "Scheduler could not read the job tables");
            None
        }
    }
}

/// What the job tables say of each job at `now`.
fn known(
    database: &Database,
    now: DateTime<Utc>,
) -> Result<HashMap<&'static str, Known>, ledger_db::store::Error> {
    let slots = jobs::slots(database)?;
    let requests = jobs::requests(database)?;
    let held = jobs::held(database, now.naive_utc())?;
    Ok(jobs()
        .map(|job| {
            let last = slots
                .iter()
                .find(|slot| slot.job == job.name)
                .map(|slot| Last {
                    at: slot.slot.and_utc(),
                    finished: slot.finished,
                    cursor: slot.cursor.clone(),
                    attempts: slot.attempts,
                });
            let known = Known {
                last,
                requested: requests.iter().any(|(name, _)| name == job.name),
                running: held.iter().any(|name| name == job.lease.lease_name()),
            };
            (job.name, known)
        })
        .collect())
}

fn until_next_minute(now: &DateTime<Tz>) -> Duration {
    let into_minute = Duration::from_secs(u64::from(now.second()))
        + Duration::from_nanos(u64::from(now.nanosecond() % 1_000_000_000));
    // A second past the boundary, so the clock read after the sleep is in
    // the new minute even when the timer fires early.
    Duration::from_secs(61).saturating_sub(into_minute)
}

/// Runs a due job: claims its slot (or goes on with an unfinished one), runs
/// its steps, then marks the slot finished and records the run.
async fn run_due(state: &AppState, job: Job, due: Due) {
    let Some(running) = begin(state, job, &due) else {
        return;
    };
    let slot = due.slot.naive_utc();
    let mut cursor = due.cursor;
    while let Step::More(next) = step(state, job, slot, cursor.take(), &running).await {
        cursor = Some(next);
    }
}

/// Takes the lease of a due job and, unless it goes on with an unfinished
/// run, claims its slot. `None` when the job cannot start.
fn begin(state: &AppState, job: Job, due: &Due) -> Option<leases::Held> {
    let running = match leases::try_take(&state.database, job.lease.lease_name()) {
        Ok(Some(held)) => held,
        Ok(None) => {
            tracing::warn!(
                job = job.name,
                "Scheduled job skipped: the previous run is still running"
            );
            return None;
        }
        Err(cause) => {
            tracing::error!(job = job.name, error = %cause, "Scheduled job skipped: no lease");
            return None;
        }
    };
    if !due.resume
        && let Err(cause) = jobs::claim(&state.database, job.name, due.slot.naive_utc())
    {
        tracing::error!(job = job.name, error = %cause, "Scheduled job skipped: no slot");
        return None;
    }
    tracing::info!(
        job = job.name,
        resume = due.resume,
        cursor = due.cursor.as_deref(),
        "Scheduled job step started"
    );
    Some(running)
}

/// How a step of a run ended.
enum Step {
    /// The run has more steps, and the next one starts here.
    More(String),
    /// The run ended: its slot is finished and its run recorded.
    Ended,
    /// The lease lapsed, or a job that resumes its failures failed. The
    /// slot stays unfinished, and a later run goes on with it.
    Unfinished,
}

/// Runs one step of the run of `job` for `slot`, under its lease. A step
/// that leaves more to do keeps its cursor in the slot; the last step marks
/// the slot finished and records the run.
///
/// The slot counts each start before the step runs, because a step that
/// stops with its alarm or its process cannot count itself. A step that has
/// used its [`MAX_ATTEMPTS`] starts does not run: the run ends as a failure.
async fn step(
    state: &AppState,
    job: Job,
    slot: chrono::NaiveDateTime,
    cursor: Option<String>,
    running: &leases::Held,
) -> Step {
    let attempts = match jobs::attempt(&*state.database, job.name, slot) {
        Ok(Some(attempts)) => attempts,
        Ok(None) => {
            tracing::warn!(
                job = job.name,
                "Scheduled job step skipped: a later run has its slot"
            );
            return Step::Unfinished;
        }
        // Without the count the run has no limit, so the step waits.
        Err(cause) => {
            tracing::error!(job = job.name, error = %cause, "Scheduled job step skipped: no count");
            return Step::Unfinished;
        }
    };
    if attempts > MAX_ATTEMPTS {
        let stopped = Err(format!(
            "the run did not finish in {MAX_ATTEMPTS} attempts, and the scheduler stopped it"
        ));
        return end(state, job, slot, &stopped);
    }
    let outcome = match running.guard((job.run)(state, cursor)).await {
        Ok(Ok(Report {
            more: Some(next), ..
        })) => {
            if let Err(cause) = jobs::advance(&*state.database, job.name, slot, &next) {
                // A rerun repeats the steps since the last cursor kept.
                tracing::warn!(job = job.name, error = %cause, "Could not keep the job's step");
            }
            return Step::More(next);
        }
        Ok(outcome) => outcome,
        Err(lost) => {
            tracing::error!(job = job.name, error = %lost, "Scheduled job failed");
            if job.records_status {
                record_outcome(&state.database, job.name, &Err(lost.to_string()));
            }
            return Step::Unfinished;
        }
    };
    let outcome = match outcome {
        Err(failure) if job.resumes_failures && attempts < MAX_ATTEMPTS => {
            tracing::error!(job = job.name, error = %failure, attempts, "Scheduled job step failed: it runs again");
            if job.records_status {
                record_outcome(&state.database, job.name, &Err(failure));
            }
            return Step::Unfinished;
        }
        Err(failure) if job.resumes_failures => Err(format!(
            "{failure}; the scheduler stopped the run after {MAX_ATTEMPTS} attempts"
        )),
        outcome => outcome,
    };
    end(state, job, slot, &outcome)
}

/// Ends the run of `job` for `slot`: marks the slot finished and records the
/// run.
fn end(
    state: &AppState,
    job: Job,
    slot: chrono::NaiveDateTime,
    outcome: &Result<Report, String>,
) -> Step {
    if let Err(cause) = jobs::finish(&*state.database, job.name, slot) {
        tracing::warn!(job = job.name, error = %cause, "Could not finish the job's slot");
    }
    match outcome {
        Ok(_) => tracing::info!(job = job.name, "Scheduled job finished"),
        Err(failure) => {
            tracing::error!(job = job.name, error = %failure, "Scheduled job failed")
        }
    }
    if job.records_status {
        record_outcome(&state.database, job.name, outcome);
    }
    Step::Ended
}

fn record_outcome(database: &Database, job: &str, outcome: &Result<Report, String>) {
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
    write_status(database, job, &status, platform::now());
}

/// Records the run of a job (`ledger_db::jobs`). A failure to write is
/// logged, never raised: the bookkeeping of a job must not fail the job.
pub(crate) fn write_status(database: &Database, job: &str, status: &Status<'_>, at: DateTime<Utc>) {
    if let Err(cause) = ledger_db::jobs::record_run(database, job, status, at) {
        tracing::warn!(job, error = %cause, "Could not record the job status");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use ledger_db::store::Sql;
    use serde_json::json;

    fn due(name: &str, time: &DateTime<Tz>) -> bool {
        let job = JOBS.iter().find(|job| job.name == name).expect("a job");
        (job.due)(time)
    }

    #[test]
    fn jobs_are_due_on_the_crontab_schedule() {
        // The schedule reads local time; these checks do not depend on the
        // zone because they read the same local time that they build.
        let at = |day: u32, hour: u32, minute: u32| {
            ledger_db::clock::zone()
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
        let time = ledger_db::clock::zone()
            .with_ymd_and_hms(2026, 9, 29, 10, 0, 59)
            .single()
            .unwrap();
        assert_eq!(until_next_minute(&time), Duration::from_secs(2));
        let time = ledger_db::clock::zone()
            .with_ymd_and_hms(2026, 9, 29, 10, 0, 0)
            .single()
            .unwrap();
        assert_eq!(until_next_minute(&time), Duration::from_secs(61));
    }

    #[tokio::test]
    async fn a_job_that_is_still_running_is_not_started_again() {
        // A run that starts would process the recurring rules and record
        // its run; the lease of the previous run stops it first.
        let file = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(file.path()).unwrap();
        let _running = leases::try_take(&state.database, leases::Job::Recurring.lease_name())
            .unwrap()
            .unwrap();
        let job = JOBS
            .iter()
            .find(|job| job.name == "recurring")
            .copied()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), run_due(&state, job, due_now(job)))
            .await
            .expect("the run is skipped at once");
        // It did not claim the slot, so it runs once the lease is free.
        assert!(jobs::slots(&*state.database).unwrap().is_empty());
    }

    fn due_now(job: Job) -> Due {
        Due {
            job: job.name,
            slot: Utc.with_ymd_and_hms(2026, 10, 21, 10, 0, 0).unwrap(),
            resume: false,
            cursor: None,
        }
    }

    /// The cursors that the steps of `STEPPED` were given.
    static STEPS: std::sync::Mutex<Vec<Option<String>>> = std::sync::Mutex::new(Vec::new());

    /// A job of three steps, whose cursor counts the steps done.
    const STEPPED: Job = Job {
        name: "stepped",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |_| false,
        lease: leases::Job::IssueSync,
        run: |_, cursor| {
            Box::pin(async move {
                STEPS.lock().unwrap().push(cursor.clone());
                let done = cursor.map_or(1, |cursor| cursor.parse::<u32>().unwrap() + 1);
                Ok(Report {
                    more: (done < 3).then(|| done.to_string()),
                    ..Report::default()
                })
            })
        },
    };

    #[tokio::test]
    async fn a_run_claims_its_slot_runs_each_step_and_finishes() {
        let file = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(file.path()).unwrap();
        STEPS.lock().unwrap().clear();
        run_due(&state, STEPPED, due_now(STEPPED)).await;
        assert_eq!(
            *STEPS.lock().unwrap(),
            [None, Some("1".to_owned()), Some("2".to_owned())]
        );
        let slots = jobs::slots(&*state.database).unwrap();
        assert_eq!(
            slots,
            [jobs::Slot {
                job: "stepped".to_owned(),
                slot: due_now(STEPPED).slot.naive_utc(),
                finished: true,
                cursor: None,
                // The last step started one time.
                attempts: 1,
            }]
        );
        // One record, for the whole run.
        assert!(read_record(&state.database, "stepped")["lastOk"].is_string());

        // A run that stopped after its first step goes on from its cursor.
        STEPS.lock().unwrap().clear();
        let slot = Utc.with_ymd_and_hms(2026, 10, 21, 11, 0, 0).unwrap();
        jobs::claim(&state.database, "stepped", slot.naive_utc()).unwrap();
        jobs::advance(&*state.database, "stepped", slot.naive_utc(), "1").unwrap();
        let resume = Due {
            job: "stepped",
            slot,
            resume: true,
            cursor: Some("1".to_owned()),
        };
        run_due(&state, STEPPED, resume).await;
        assert_eq!(
            *STEPS.lock().unwrap(),
            [Some("1".to_owned()), Some("2".to_owned())]
        );
        assert!(jobs::slots(&*state.database).unwrap()[0].finished);
    }

    /// Whether `FLAKY` fails its next step.
    static FAIL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

    /// A job of two steps that resumes its failures, whose second step fails
    /// while `FAIL` is set.
    const FLAKY: Job = Job {
        name: "flaky",
        records_status: false,
        native_only: false,
        resumes_failures: true,
        due: |_| false,
        lease: leases::Job::IssueSync,
        run: |_, cursor| {
            Box::pin(async move {
                match cursor {
                    None => Ok(Report {
                        more: Some("1".to_owned()),
                        ..Report::default()
                    }),
                    Some(_) if FAIL.swap(false, std::sync::atomic::Ordering::SeqCst) => {
                        Err("the storage failed".to_owned())
                    }
                    Some(_) => Ok(Report::default()),
                }
            })
        },
    };

    #[tokio::test]
    async fn a_failed_step_of_a_job_that_resumes_its_failures_runs_again() {
        let file = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(file.path()).unwrap();
        run_due(&state, FLAKY, due_now(FLAKY)).await;
        // The slot keeps the cursor of the step that failed.
        let slots = jobs::slots(&*state.database).unwrap();
        assert!(!slots[0].finished);
        assert_eq!(slots[0].cursor.as_deref(), Some("1"));
        let resume = Due {
            job: "flaky",
            slot: due_now(FLAKY).slot,
            resume: true,
            cursor: slots[0].cursor.clone(),
        };
        run_due(&state, FLAKY, resume).await;
        assert!(jobs::slots(&*state.database).unwrap()[0].finished);
    }

    /// How many times a step of `HANGS` started.
    static HANG_STARTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// A job whose step never ends.
    const HANGS: Job = Job {
        name: "hangs",
        records_status: true,
        native_only: false,
        resumes_failures: false,
        due: |_| false,
        lease: leases::Job::TypesafeCleanup,
        run: |_, _| {
            Box::pin(async {
                HANG_STARTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::future::pending().await
            })
        },
    };

    #[tokio::test]
    async fn a_run_that_never_finishes_is_stopped_and_recorded_as_failed() {
        let file = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(file.path()).unwrap();
        // Each start stops before its step returns, as when an alarm passes
        // its time limit or the process stops. The slot stays unfinished and
        // nothing records the run.
        let mut due = due_now(HANGS);
        let mut runs = 0;
        let stopped = loop {
            let run = run_due(&state, HANGS, due.clone());
            if tokio::time::timeout(Duration::from_millis(200), run)
                .await
                .is_ok()
            {
                break true;
            }
            runs += 1;
            if runs == 10 {
                break false;
            }
            due.resume = true;
        };
        assert!(stopped, "the scheduler stops a run that never finishes");
        assert_eq!(
            HANG_STARTS.load(std::sync::atomic::Ordering::SeqCst),
            MAX_ATTEMPTS
        );
        // The slot is finished, so the plan has no run to resume.
        let slots = jobs::slots(&*state.database).unwrap();
        assert!(slots[0].finished);
        // The status page shows the failure.
        let record = read_record(&state.database, "hangs");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(
            record["detail"],
            "the run did not finish in 3 attempts, and the scheduler stopped it"
        );
    }

    /// How many times a step of `BROKEN` ran.
    static BROKEN_RUNS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// A job that resumes its failures, whose step fails each time.
    const BROKEN: Job = Job {
        name: "broken",
        records_status: true,
        native_only: false,
        resumes_failures: true,
        due: |_| false,
        lease: leases::Job::TypesafeCleanup,
        run: |_, _| {
            Box::pin(async {
                BROKEN_RUNS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err("the storage failed".to_owned())
            })
        },
    };

    #[tokio::test]
    async fn a_job_that_resumes_its_failures_stops_after_the_last_attempt() {
        let file = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(file.path()).unwrap();
        let mut due = due_now(BROKEN);
        for _ in 0..10 {
            run_due(&state, BROKEN, due.clone()).await;
            if jobs::slots(&*state.database).unwrap()[0].finished {
                break;
            }
            // Each failed step is on record while the run can still go on.
            let record = read_record(&state.database, "broken");
            assert_eq!(record["detail"], "the storage failed");
            due.resume = true;
        }
        assert_eq!(
            BROKEN_RUNS.load(std::sync::atomic::Ordering::SeqCst),
            MAX_ATTEMPTS
        );
        assert!(jobs::slots(&*state.database).unwrap()[0].finished);
        let record = read_record(&state.database, "broken");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(
            record["detail"],
            "the storage failed; the scheduler stopped the run after 3 attempts"
        );
    }

    #[tokio::test]
    async fn a_lot_rebuild_that_fails_each_time_stops_and_shows_on_the_status_page() {
        let (_file, state) = unconfigured_state().await;
        // A cursor that the rebuild cannot read: each step fails.
        let slot = Utc.with_ymd_and_hms(2026, 11, 9, 10, 0, 0).unwrap();
        jobs::claim(&state.database, "lot-rebuild", slot.naive_utc()).unwrap();
        jobs::advance(&*state.database, "lot-rebuild", slot.naive_utc(), "no pair").unwrap();
        let rebuild = || {
            jobs::slots(&*state.database)
                .unwrap()
                .into_iter()
                .find(|slot| slot.job == "lot-rebuild")
                .unwrap()
        };
        // A job on the schedule may be due this minute and take an alarm.
        for _ in 0..20 {
            if rebuild().finished {
                break;
            }
            alarm(&state).await;
        }
        let rebuild = rebuild();
        assert!(rebuild.finished, "the alarms stop the rebuild");
        assert_eq!(rebuild.attempts, MAX_ATTEMPTS);
        let result = crate::routes::system::evaluate_now(&state.database);
        let job = result["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["job"] == "lot-rebuild")
            .expect("the status lists the lot rebuild");
        assert_eq!(job["state"], "failed");
        assert!(
            job["detail"]
                .as_str()
                .unwrap()
                .ends_with("the scheduler stopped the run after 3 attempts"),
            "{job}"
        );
        assert_eq!(result["overall"], "attention");
    }

    #[test]
    fn a_failed_lot_rebuild_is_asked_for_again_but_not_while_a_run_is_unfinished() {
        let database = memory();
        let at = Utc.with_ymd_and_hms(2026, 11, 9, 10, 0, 0).unwrap();
        let requested = |database: &Database| !jobs::requests(database).unwrap().is_empty();
        // Lots present and no failed rebuild: nothing to ask for.
        request_lot_rebuild(&database, false).unwrap();
        assert!(!requested(&database));
        // The scheduler stopped a rebuild part way: some lots exist, so the
        // guard for absent lots reads the file as done.
        write_status(&database, "lot-rebuild", &Status::default(), at);
        request_lot_rebuild(&database, false).unwrap();
        assert!(requested(&database));
        // An unfinished run keeps its cursor and its count of starts: a
        // request would start a new run with a count of zero.
        database.execute("DELETE FROM job_requests", &[]).unwrap();
        jobs::claim(&database, "lot-rebuild", at.naive_utc()).unwrap();
        for absent in [false, true] {
            request_lot_rebuild(&database, absent).unwrap();
            assert!(!requested(&database));
        }
        jobs::finish(&database, "lot-rebuild", at.naive_utc()).unwrap();
        request_lot_rebuild(&database, true).unwrap();
        assert!(requested(&database));
        // A rebuild that succeeded is not asked for again.
        database.execute("DELETE FROM job_requests", &[]).unwrap();
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        write_status(&database, "lot-rebuild", &ok, at);
        request_lot_rebuild(&database, false).unwrap();
        assert!(!requested(&database));
    }

    #[test]
    fn a_weekly_review_run_that_leaves_a_book_with_no_review_records_a_failure() {
        let database = memory();
        let left: crate::error::ApiResult = Ok(axum::Json(json!({
            "success": true, "booksReviewed": 1, "booksFailed": 1, "booksWithoutReview": 2,
        })));
        record_outcome(&database, "weekly-review", &report_of(&left));
        let record = read_record(&database, "weekly-review");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(
            record["detail"],
            "2 books that opted in have no review of this week"
        );
        let done: crate::error::ApiResult = Ok(axum::Json(json!({
            "success": true, "booksReviewed": 2, "booksFailed": 0, "booksWithoutReview": 0,
        })));
        record_outcome(&database, "weekly-review", &report_of(&done));
        let record = read_record(&database, "weekly-review");
        assert_eq!(record["lastOk"], record["lastRun"]);
    }

    #[test]
    fn the_plan_reads_the_job_tables() {
        let database = memory();
        let at = |minute| Utc.with_ymd_and_hms(2026, 10, 21, 10, minute, 0).unwrap();
        jobs::claim(&database, "backup", at(0).naive_utc()).unwrap();
        jobs::request(&database, "weekly-review", at(1).naive_utc()).unwrap();
        // A manual sync of one connection is not the job's lease.
        jobs::acquire(
            &database,
            &leases::plaid_sync(4),
            "other",
            at(0).naive_utc(),
            leases::TTL,
        )
        .unwrap();
        let known = known(&database, at(5)).unwrap();
        assert_eq!(known.len(), JOBS.len());
        assert_eq!(
            known["backup"].last,
            Some(Last {
                at: at(0),
                finished: false,
                cursor: None,
                attempts: 0,
            })
        );
        assert!(known["weekly-review"].requested);
        assert!(known.values().all(|known| !known.running));
        // The unfinished backup resumes, and the request runs.
        let plan = plan_now(&database, at(5)).unwrap();
        let mut due: Vec<_> = plan.due.iter().map(|due| (due.job, due.resume)).collect();
        due.sort_unstable();
        assert_eq!(due, [("backup", true), ("weekly-review", false)]);

        // Prune shares the backup's lease.
        jobs::acquire(
            &database,
            leases::Job::Maintenance.lease_name(),
            "other",
            at(5).naive_utc(),
            leases::TTL,
        )
        .unwrap();
        let known = super::known(&database, at(5)).unwrap();
        assert!(known["backup"].running && known["prune"].running && known["reindex"].running);
        assert!(!known["recurring"].running);
    }

    /// The rows of the data tables, without the job tables, which record
    /// each run. The lots are derived state: a rebuild gives them new IDs
    /// and times, which advances `sqlite_sequence` and marks the book
    /// changed, so they are compared without those.
    fn data(database: &Database) -> serde_json::Value {
        let mut dump = ledger_db::dump::dump(database).unwrap();
        dump["tables"].as_array_mut().unwrap().retain(|table| {
            let name = table["name"].as_str().unwrap();
            !name.starts_with("job_")
                && !name.starts_with("investment_lot")
                && !["sqlite_sequence", "change_marks"].contains(&name)
        });
        json!({
            "tables": dump["tables"],
            "lots": ledger_db::testing::lot_rows(database),
        })
    }

    #[tokio::test]
    async fn the_export_stores_the_days_dump_and_it_loads_into_the_same_data() {
        let file = ledger_db::testing::TempDatabase::new();
        seed_household(&file);
        let day = chrono::NaiveDate::from_ymd_opt(2026, 10, 22).unwrap();
        let stored = std::sync::Mutex::new(Vec::new());
        let report = export(
            file.database(),
            export_name(day),
            |name, text| {
                stored.lock().unwrap().push((name, text));
                async { Ok(()) }
            },
            Copy::<NoCopy>::Off,
        )
        .await
        .unwrap();
        let (name, text) = stored.into_inner().unwrap().pop().unwrap();
        assert_eq!(name, "counterpoise-2026-10-22.json");
        assert_eq!(report.bytes, Some(text.len() as u64));

        // The text is the dump of the file, and `ledger-cli load` takes it
        // (`ledger_db::dump` tests the round trip).
        let dump: serde_json::Value = serde_json::from_slice(&text).unwrap();
        assert_eq!(dump, ledger_db::dump::dump(file.database()).unwrap());
        let target = std::env::temp_dir().join(format!(
            "counterpoise-export-load-{}.db",
            std::process::id()
        ));
        let loaded = {
            let empty = Database::open(&target, true).unwrap();
            ledger_db::dump::load(&empty, std::str::from_utf8(&text).unwrap()).unwrap()
        };
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", target.display()));
        }
        assert!(loaded.rows > 0, "{loaded:?}");

        assert_eq!(report.detail, None);

        let failed = export(
            file.database(),
            export_name(day),
            |_, _| async { Err("the bucket said no".to_owned()) },
            Copy::<NoCopy>::Off,
        )
        .await;
        assert_eq!(
            failed.err().as_deref(),
            Some("the dump was not stored: the bucket said no")
        );
    }

    #[test]
    fn a_manual_export_has_a_name_that_no_days_dump_has() {
        let now = Utc.with_ymd_and_hms(2026, 10, 22, 3, 45, 9).unwrap();
        let name = manual_export_name(now);
        assert_eq!(name, "counterpoise-manual-20261022-034509.json");
        assert_ne!(name, export_name(now.date_naive()));
        // The lifecycle rule and the write permission of the S3 bucket are
        // for the names that start with `counterpoise-`.
        assert!(name.starts_with("counterpoise-"));
    }

    #[tokio::test]
    async fn a_manual_export_keeps_the_days_dump_and_loads_into_the_same_data() {
        let file = ledger_db::testing::TempDatabase::new();
        seed_household(&file);
        let now = Utc.with_ymd_and_hms(2026, 10, 22, 14, 30, 0).unwrap();
        // The bucket: a `put` of a name that is there replaces its object.
        let bucket = std::sync::Mutex::new(std::collections::BTreeMap::new());
        let put = |name: String, text: Vec<u8>| {
            bucket.lock().unwrap().insert(name, text);
            async { Ok(()) }
        };
        export(
            file.database(),
            export_name(now.date_naive()),
            put,
            Copy::<NoCopy>::Off,
        )
        .await
        .unwrap();
        let daily = bucket.lock().unwrap()["counterpoise-2026-10-22.json"].clone();

        // A write after the scheduled dump, which only the manual dump has.
        file.database()
            .exec_batch("UPDATE books SET name = 'After the daily dump' WHERE id = 1")
            .unwrap();
        let report = export(
            file.database(),
            manual_export_name(now),
            put,
            Copy::<NoCopy>::Off,
        )
        .await
        .unwrap();
        assert_eq!(
            report.name.as_deref(),
            Some("counterpoise-manual-20261022-143000.json")
        );

        let bucket = bucket.into_inner().unwrap();
        assert_eq!(
            bucket.keys().collect::<Vec<_>>(),
            [
                "counterpoise-2026-10-22.json",
                "counterpoise-manual-20261022-143000.json"
            ]
        );
        assert_eq!(bucket["counterpoise-2026-10-22.json"], daily);
        let manual = &bucket["counterpoise-manual-20261022-143000.json"];
        assert_ne!(manual, &daily);
        assert_eq!(report.bytes, Some(manual.len() as u64));

        // `ledger-cli load` calls `ledger_db::dump::load` on the text.
        let target = std::env::temp_dir().join(format!(
            "counterpoise-manual-export-load-{}.db",
            std::process::id()
        ));
        let name = {
            let loaded = Database::open(&target, true).unwrap();
            ledger_db::dump::load(&loaded, std::str::from_utf8(manual).unwrap()).unwrap();
            loaded
                .query_row::<String>("SELECT name FROM books ORDER BY id LIMIT 1", &[])
                .unwrap()
        };
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", target.display()));
        }
        assert_eq!(name, "After the daily dump");
    }

    #[tokio::test]
    async fn the_export_copies_the_dump_to_s3_and_reports_a_copy_that_fails() {
        let file = ledger_db::testing::TempDatabase::new();
        seed_household(&file);
        let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        let stored = std::sync::Mutex::new(Vec::new());
        let copied = std::sync::Mutex::new(Vec::new());
        let store = |name: String, text: Vec<u8>| {
            stored.lock().unwrap().push((name, text));
            async { Ok(()) }
        };

        // Both copies: the same name and the same bytes.
        let report = export(
            file.database(),
            export_name(day),
            store,
            Copy::On(|name: String, text: Vec<u8>| {
                copied.lock().unwrap().push((name, text));
                async { Ok(()) }
            }),
        )
        .await
        .unwrap();
        assert_eq!(report.detail.as_deref(), Some("stored in R2 and S3"));
        let first = stored.lock().unwrap().pop().unwrap();
        let second = copied.lock().unwrap().pop().unwrap();
        assert_eq!(first.0, "counterpoise-2026-11-04.json");
        assert_eq!(first, second);
        assert_eq!(report.bytes, Some(first.1.len() as u64));

        // A copy that fails: the run fails, and the first dump is stored.
        let failed = export(
            file.database(),
            export_name(day),
            store,
            Copy::On(|_, _| async { Err("S3 answered 403 (AccessDenied)".to_owned()) }),
        )
        .await;
        assert_eq!(
            failed.err().as_deref(),
            Some("the dump is in R2 but not in S3: S3 answered 403 (AccessDenied)")
        );
        assert_eq!(stored.lock().unwrap().len(), 1);

        // A copy whose settings are not complete: the same.
        let faulty = export(
            file.database(),
            export_name(day),
            store,
            Copy::<NoCopy>::Faulty("BACKUP_S3_REGION is not set".to_owned()),
        )
        .await;
        assert_eq!(
            faulty.err().as_deref(),
            Some("the dump is in R2 but not in S3: BACKUP_S3_REGION is not set")
        );
        assert_eq!(stored.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_second_run_of_each_job_changes_nothing() {
        // The jobs that call a service (Plaid, Tiingo, GitHub, Claude) have
        // their reruns tested against a mock of it: tests/http/cron.test.ts,
        // tests/http/weekly-review.test.ts and the issue sync's tests.
        let file = ledger_db::testing::TempDatabase::new();
        seed_household(&file);
        let (_unused, mut state) = unconfigured_state().await;
        state.database = AppState::new(file.path()).unwrap().database;
        let dir =
            std::env::temp_dir().join(format!("counterpoise-job-rerun-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for job in JOBS {
            let run = || async {
                match job.name {
                    "backup" => backup_into(&state, &dir).await,
                    "prune" => prune_in(&state, &dir).await,
                    _ => (job.run)(&state, None).await,
                }
            };
            run()
                .await
                .unwrap_or_else(|failure| panic!("{}: {failure}", job.name));
            let first = data(&state.database);
            if job.name == "backup" {
                // A copy is named by its second, and a second copy of the
                // same second is refused.
                tokio::time::sleep(Duration::from_millis(1100)).await;
            }
            run()
                .await
                .unwrap_or_else(|failure| panic!("{}: {failure}", job.name));
            assert_eq!(
                data(&state.database),
                first,
                "the second run of {}",
                job.name
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn alarms_run_a_requested_job_a_step_at_a_time_then_wait_for_the_schedule() {
        let file = ledger_db::testing::TempDatabase::new();
        seed_household(&file);
        let (_unused, mut state) = unconfigured_state().await;
        state.database = AppState::new(file.path()).unwrap().database;
        let count = |table: &str| -> i64 {
            state
                .database
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), &[])
                .unwrap()
        };
        let allocations = count("investment_lot_allocations");
        state
            .database
            .exec_batch("DELETE FROM investment_lot_allocations; DELETE FROM investment_lots;")
            .unwrap();
        request(&state.database, "lot-rebuild").unwrap();
        assert!(next_wake(&state.database) <= platform::now());

        // Each alarm that runs a step asks for the next alarm at once. The
        // first alarm that finds nothing due gives the next scheduled slot.
        let mut steps = 0;
        let wake = loop {
            let wake = alarm(&state).await;
            if wake > platform::now() {
                break wake;
            }
            steps += 1;
            assert!(steps < 20, "the alarms stop asking for more");
        };
        assert!(steps >= 1);
        // A scheduled slot is a whole minute; a wake "at once" is not. The
        // next slot can be seconds away, so its distance from now proves
        // nothing.
        assert_eq!((wake.second(), wake.nanosecond()), (0, 0), "{wake}");
        assert_eq!(count("investment_lot_allocations"), allocations);
        let slots = jobs::slots(&*state.database).unwrap();
        let rebuild = slots.iter().find(|slot| slot.job == "lot-rebuild").unwrap();
        assert!(rebuild.finished);
        assert!(jobs::requests(&*state.database).unwrap().is_empty());
        // Unless that slot came while the checks ran: its job is due now.
        let next = next_wake(&state.database);
        assert!(
            next == wake || wake <= platform::now(),
            "{next} after {wake}"
        );
    }

    #[tokio::test]
    async fn an_alarm_keeps_the_slots_of_the_jobs_that_wait_for_its_step() {
        let (_file, state) = unconfigured_state().await;
        for job in ["typesafe-cleanup", "prune"] {
            request(&state.database, job).unwrap();
        }
        alarm(&state).await;
        // The alarm ran one step, and each requested job that did not run
        // holds its slot, so a step that crosses the minute does not lose
        // it. The step is one of the two unless a job on the schedule is
        // due this minute (the native backup is, on the hour).
        let slots = jobs::slots(&*state.database).unwrap();
        let slot = |name: &str| slots.iter().find(|slot| slot.job == name).cloned();
        let (cleanup, prune) = (slot("typesafe-cleanup").unwrap(), slot("prune").unwrap());
        assert!(!(cleanup.finished && prune.finished));
        assert!(jobs::requests(&*state.database).unwrap().is_empty());
        // A job on the schedule may share the minute: run until none waits.
        for _ in 0..10 {
            if alarm(&state).await > platform::now() {
                break;
            }
        }
        let slots = jobs::slots(&*state.database).unwrap();
        assert!(slots.iter().all(|slot| slot.finished));
    }

    #[tokio::test]
    async fn a_backup_run_reports_a_verified_copy_and_its_size() {
        let database = ledger_db::testing::TempDatabase::new();
        let state = AppState::new(database.path()).unwrap();
        let dir =
            std::env::temp_dir().join(format!("counterpoise-job-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let report = backup_into(&state, &dir).await.unwrap();
        assert_eq!(report.verified, Some(true));
        assert!(report.bytes.is_some_and(|bytes| bytes > 0));
        assert!(report.detail.is_none());
        // The copy, and the day's first dump.
        let mut suffixes: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                name.rsplit('.').next().unwrap().to_owned()
            })
            .collect();
        suffixes.sort();
        assert_eq!(suffixes, ["db", "json"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// One book of the household sample.
    fn seed_household(file: &ledger_db::testing::TempDatabase) {
        file.database()
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');",
            )
            .unwrap();
        file.database()
            .transaction(|tx| {
                ledger_db::seed::seed_book(
                    tx,
                    1,
                    ledger_db::seed::DemoDataset::Household,
                    ledger_db::clock::today(),
                    &mut |_| {},
                )
            })
            .unwrap();
    }

    async fn unconfigured_state() -> (ledger_db::testing::TempDatabase, AppState) {
        let database = ledger_db::testing::TempDatabase::new();
        let mut state = AppState::new(database.path()).unwrap();
        state.plaid = crate::plaid::Plaid::new(None, None, None, None);
        state.tiingo = crate::tiingo::Tiingo::new(None, None);
        state.issue_sync = crate::issue_sync::github::GitHub::new(None, None, None);
        (database, state)
    }

    fn memory() -> Database {
        let database = Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        database
    }

    fn read_record(database: &Database, job: &str) -> serde_json::Value {
        ledger_db::jobs::runs(database)
            .unwrap()
            .into_iter()
            .find(|record| record["job"] == job)
            .expect("a record of the job")
    }

    #[test]
    fn the_issue_sync_runs_hourly_at_half_past() {
        let at = |hour, minute| {
            ledger_db::clock::zone()
                .with_ymd_and_hms(2026, 10, 14, hour, minute, 0)
                .unwrap()
        };
        assert!(due("issue-sync", &at(9, 30)));
        assert!(due("issue-sync", &at(0, 30)));
        assert!(!due("issue-sync", &at(9, 0)));
        assert!(!due("issue-sync", &at(9, 31)));
    }

    #[tokio::test]
    async fn a_job_with_no_secret_records_not_configured() {
        let (_file, state) = unconfigured_state().await;
        let database = memory();
        for (name, setting) in [
            ("plaid-sync", "PLAID_CLIENT_ID"),
            ("price-sync", "TIINGO_API_KEY"),
            ("issue-sync", "ISSUE_SYNC_GITHUB_REPO"),
        ] {
            let job = JOBS.iter().find(|job| job.name == name).copied().unwrap();
            let outcome = (job.run)(&state, None).await;
            record_outcome(&database, name, &outcome);
            let record = read_record(&database, name);
            assert_eq!(record["notConfigured"], true);
            assert_eq!(
                record["detail"],
                format!("not configured: {setting} is not set")
            );
            assert_eq!(record["lastOk"], record["lastRun"]);
        }
    }

    #[tokio::test]
    async fn a_manual_run_records_its_outcome_like_a_scheduled_run() {
        let (_file, state) = unconfigured_state().await;
        let database = memory();
        let skipped = crate::routes::cron::run_plaid_sync(&state).await;
        record_outcome(&database, "plaid-sync", &report_of(&skipped));
        assert_eq!(read_record(&database, "plaid-sync")["notConfigured"], true);

        let done: crate::error::ApiResult = Ok(axum::Json(json!({ "success": true })));
        record_outcome(&database, "recurring", &report_of(&done));
        let record = read_record(&database, "recurring");
        assert!(record.get("notConfigured").is_none());
        assert_eq!(record["lastOk"], record["lastRun"]);

        let failed: crate::error::ApiResult = Err(crate::error::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to process recurring rules",
        ));
        record_outcome(&database, "recurring", &report_of(&failed));
        let record = read_record(&database, "recurring");
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(record["detail"], "Failed to process recurring rules");
    }

    #[tokio::test]
    async fn a_rate_limited_price_sync_records_a_failure() {
        let database = memory();
        let limited: crate::error::ApiResult = Ok(axum::Json(json!({
            "success": true, "securitiesFound": 5, "pricesInserted": 1, "pricesSkipped": 0,
            "errors": [{}, {}, {}], "rateLimited": true,
        })));
        record_outcome(&database, "price-sync", &report_of(&limited));
        let record = read_record(&database, "price-sync");
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
        record_outcome(&database, "price-sync", &report_of(&partial));
        let record = read_record(&database, "price-sync");
        assert_eq!(record["lastOk"], record["lastRun"]);
    }

    #[tokio::test]
    async fn a_status_record_has_the_fields_that_the_status_route_reads() {
        let database = memory();
        let at = Utc.with_ymd_and_hms(2026, 9, 29, 10, 0, 5).unwrap();
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        write_status(&database, "recurring", &ok, at);
        let bad = Status {
            detail: Some("bad\ntoken"),
            ..Status::default()
        };
        write_status(&database, "plaid-sync", &bad, at);
        let ok = read_record(&database, "recurring");
        assert_eq!(
            ok,
            json!({
                "job": "recurring", "lastRun": "2026-09-29T10:00:05Z",
                "lastOk": "2026-09-29T10:00:05Z", "verified": null, "bytes": null, "detail": null,
            })
        );
        let failed = read_record(&database, "plaid-sync");
        assert_eq!(failed["lastOk"], serde_json::Value::Null);
        assert_eq!(failed["detail"], "bad token");
    }

    #[test]
    fn the_weekly_review_runs_on_monday_at_five_and_tries_again_at_six_and_seven() {
        let at = |day: u32, hour: u32, minute: u32| {
            ledger_db::clock::zone()
                .with_ymd_and_hms(2026, 10, day, hour, minute, 0)
                .single()
                .expect("a local time")
        };
        // 2026-10-12 is a Monday.
        assert!(due("weekly-review", &at(12, 5, 0)));
        assert!(!due("weekly-review", &at(12, 5, 1)));
        assert!(!due("weekly-review", &at(13, 5, 0)));
        // The runs at 06:00 and 07:00 try again a book whose review failed.
        assert!(due("weekly-review", &at(12, 6, 0)));
        assert!(due("weekly-review", &at(12, 7, 0)));
        assert!(!due("weekly-review", &at(12, 4, 0)));
        assert!(!due("weekly-review", &at(12, 8, 0)));
        assert!(!due("weekly-review", &at(13, 6, 0)));
    }
}

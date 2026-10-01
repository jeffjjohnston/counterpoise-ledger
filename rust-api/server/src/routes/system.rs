use crate::{auth::session_user, error::ApiResult, state::AppState};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{collections::HashMap, io::ErrorKind, path::PathBuf, sync::LazyLock};

static VERSION_INFO: LazyLock<(String, i32)> = LazyLock::new(|| {
    let package = serde_json::from_str::<Value>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../package.json"
    )))
    .expect("package.json must be valid JSON");
    let version = package["version"]
        .as_str()
        .expect("package.json must have a string version")
        .to_owned();
    let contract = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../lib/api-contract.ts"
    ))
    .lines()
    .find_map(|line| line.trim().strip_prefix("export const API_CONTRACT = "))
    .and_then(|value| value.trim_end_matches(';').parse().ok())
    .expect("API_CONTRACT declaration must be a numeric constant");
    (version, contract)
});

pub(crate) fn validate_version_metadata() {
    LazyLock::force(&VERSION_INFO);
}

/// The package version and `API_CONTRACT`.
pub(crate) fn version_info() -> (String, i32) {
    (VERSION_INFO.0.clone(), VERSION_INFO.1)
}

pub(crate) async fn version() -> Json<Value> {
    Json(json!({ "version": VERSION_INFO.0.as_str(), "apiContract": VERSION_INFO.1 }))
}

/// A query that reads the schema page of the file. `SELECT 1` reads no page,
/// so it passes on a file that is not a database.
const HEALTH_QUERY: &str = "SELECT count(*) FROM sqlite_schema";

pub(crate) async fn health(State(state): State<AppState>) -> Result<StatusCode, StatusCode> {
    sqlx::query(HEALTH_QUERY)
        .execute(&state.pool)
        .await
        .map(|_| StatusCode::OK)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

/// `GET /api/health`: the unauthenticated liveness check of the deploy check, which reads `"ok":true`. It carries no
/// operational detail: "backups last succeeded 40 days ago" is reconnaissance
/// on an internet-exposed fork. Job status is behind a session at
/// `/api/system/status`.
pub(crate) async fn api_health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query(HEALTH_QUERY).execute(&state.pool).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true, "db": true }))),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "db": false })),
        ),
    }
}

struct JobConfig {
    name: &'static str,
    label: &'static str,
    schedule: &'static str,
    stale_after_ms: i64,
}

const HOUR: i64 = 60 * 60 * 1000;
const DAY: i64 = 24 * HOUR;
const JOBS: [JobConfig; 6] = [
    JobConfig {
        name: "backup",
        label: "Database backup",
        schedule: "Hourly, 6am–9pm",
        stale_after_ms: 12 * HOUR,
    },
    JobConfig {
        name: "recurring",
        label: "Recurring transactions",
        schedule: "Hourly",
        stale_after_ms: 3 * HOUR,
    },
    JobConfig {
        name: "plaid-sync",
        label: "Bank sync",
        schedule: "Every 6h",
        stale_after_ms: 13 * HOUR,
    },
    JobConfig {
        name: "price-sync",
        label: "Security prices",
        schedule: "Tue–Sat 6am",
        stale_after_ms: 4 * DAY,
    },
    JobConfig {
        name: "prune",
        label: "Backup pruning",
        schedule: "Daily 4am",
        stale_after_ms: 2 * DAY,
    },
    JobConfig {
        name: "reindex",
        label: "Reindex",
        schedule: "Monthly, 1st 3am",
        stale_after_ms: 35 * DAY,
    },
];

fn timestamp(value: Option<&Value>) -> Option<i64> {
    DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|time| time.timestamp_millis())
}

fn evaluate(entries: Option<Vec<Value>>, now_ms: i64, unreadable: Option<String>) -> Value {
    let by_name: HashMap<String, Value> = entries
        .as_ref()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| Some((row.get("job")?.as_str()?.to_owned(), row.clone())))
                .collect()
        })
        .unwrap_or_default();
    let jobs: Vec<Value> = JOBS
        .iter()
        .map(|config| {
            let entry = by_name.get(config.name);
            // A run with no secret is not a success: it did nothing. The
            // record does not use the name of a state, so a detail text
            // cannot fake it.
            let not_configured =
                entry.is_some_and(|row| row.get("notConfigured") == Some(&Value::Bool(true)));
            let last_ok = entry
                .and_then(|row| row.get("lastOk"))
                .filter(|value| !value.is_null() && !not_configured);
            let (state, age) = match (entries.as_ref(), entry) {
                (None, _) => ("unknown", None),
                (Some(_), None) => ("missing", None),
                (Some(_), Some(_)) if not_configured => ("not_configured", None),
                (Some(_), Some(row)) => match timestamp(last_ok) {
                    None => (
                        if timestamp(row.get("lastRun")).is_some() {
                            "failed"
                        } else {
                            "missing"
                        },
                        None,
                    ),
                    Some(time) => {
                        let age = now_ms - time;
                        let state = if age > config.stale_after_ms {
                            "stale"
                        } else if row.get("verified") == Some(&Value::Bool(false)) {
                            "unverified"
                        } else {
                            "ok"
                        };
                        (state, Some(age))
                    }
                },
            };
            json!({
                "job": config.name,
                "label": config.label,
                "schedule": config.schedule,
                "state": state,
                "lastOk": last_ok,
                "ageMs": age,
                "detail": entry.and_then(|row| row.get("detail")).filter(|value| !value.is_null()),
            })
        })
        .collect();
    let overall = if unreadable.is_some()
        || jobs.iter().any(|job| {
            !matches!(
                job["state"].as_str(),
                Some("ok" | "unknown" | "not_configured")
            )
        }) {
        "attention"
    } else if entries.is_none() {
        "unknown"
    } else {
        "ok"
    };
    let mut result = json!({"overall": overall, "jobs": jobs});
    if let Some(message) = unreadable {
        result["error"] = json!(message);
    }
    result
}

fn unreadable(cause: &std::io::Error) -> String {
    let code = match cause.raw_os_error() {
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EINTR) => "EINTR",
        Some(libc::EIO) => "EIO",
        Some(libc::EBADF) => "EBADF",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::EFAULT) => "EFAULT",
        Some(libc::EBUSY) => "EBUSY",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::EISDIR) => "EISDIR",
        Some(libc::ENODEV) => "ENODEV",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENFILE) => "ENFILE",
        Some(libc::EMFILE) => "EMFILE",
        Some(libc::ENOSPC) => "ENOSPC",
        Some(libc::EROFS) => "EROFS",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ESTALE) => "ESTALE",
        Some(libc::EOVERFLOW) => "EOVERFLOW",
        _ => "UNKNOWN",
    };
    format!("Status directory unreadable ({code})")
}

async fn read_entries() -> Result<Option<Vec<Value>>, String> {
    let dir =
        PathBuf::from(std::env::var("STATUS_DIR").unwrap_or_else(|_| "/backups/status".to_owned()));
    read_entries_in(&dir).await
}

async fn read_entries_in(dir: &std::path::Path) -> Result<Option<Vec<Value>>, String> {
    let mut names = match tokio::fs::read_dir(dir).await {
        Ok(names) => names,
        Err(cause) if cause.kind() == ErrorKind::NotFound => return Ok(None),
        Err(cause) => return Err(unreadable(&cause)),
    };
    let mut entries = Vec::new();
    while let Some(item) = names
        .next_entry()
        .await
        .map_err(|cause| unreadable(&cause))?
    {
        if !item.file_name().to_string_lossy().ends_with(".json") {
            continue;
        }
        let Ok(raw) = tokio::fs::read_to_string(item.path()).await else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if parsed.get("job").is_some_and(Value::is_string) {
            entries.push(parsed);
        }
    }
    Ok(Some(entries))
}

pub(crate) async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    session_user(&state, &headers, "Failed to read job status").await?;
    let now = Utc::now().timestamp_millis();
    let result = match read_entries().await {
        Ok(entries) => evaluate(entries, now, None),
        Err(message) => evaluate(None, now, Some(message)),
    };
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::{api_health, evaluate, health, read_entries_in, unreadable};

    fn job<'a>(result: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
        result["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|job| job["job"] == name)
            .unwrap()
    }

    /// The seam test. The status writer and the evaluator were once each
    /// tested against fixtures, and both passed while the pipeline between
    /// them was broken: "unverified" was unreachable for the case that it
    /// exists to detect. So this feeds the scheduler's real records to the
    /// evaluator of /api/system/status. No hand-written entries.
    #[tokio::test]
    async fn the_scheduler_records_reach_the_status_evaluator() {
        use crate::scheduler::write_status;
        use ledger_db::job_status::Status;
        let dir = std::env::temp_dir().join(format!("counterpoise-seam-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let at = chrono::Utc::now();
        let now = at.timestamp_millis();

        let backup = |ok, detail, bytes, verified| Status {
            ok,
            detail,
            bytes,
            verified,
            not_configured: false,
        };
        let copy = backup(true, None, Some(1_874_345), Some(true));
        write_status(&dir, "backup", &copy, at).await;
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        assert_eq!(job(&result, "backup")["state"], "ok");
        // A job that never ran is missing, not failed.
        assert_eq!(job(&result, "reindex")["state"], "missing");

        // A copy that fails integrity_check: the run completed, the copy is bad.
        let problem = Some("integrity_check: row 3 missing from index");
        let bad_copy = backup(true, problem, Some(512), Some(false));
        write_status(&dir, "backup", &bad_copy, at).await;
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        assert_eq!(job(&result, "backup")["state"], "unverified");
        assert_eq!(result["overall"], "attention");

        let full = backup(false, Some("disk full"), None, None);
        write_status(&dir, "backup", &full, at).await;
        let detail = Some("line one\nline \"two\"\\three");
        let broken = backup(false, detail, None, None);
        write_status(&dir, "plaid-sync", &broken, at).await;
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        assert_eq!(job(&result, "backup")["state"], "failed");
        assert_eq!(job(&result, "backup")["detail"], "disk full");
        assert_eq!(job(&result, "plaid-sync")["state"], "failed");
        // Control characters become spaces; quotes and backslashes stay.
        assert_eq!(
            job(&result, "plaid-sync")["detail"],
            "line one line \"two\"\\three"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
    use crate::state::AppState;
    use axum::{extract::State, http::StatusCode};
    use ledger_db::engine::DbPoolOptions;
    use std::time::Duration;

    /// An install without Plaid or Tiingo is normal. The state differs from
    /// ok and from missing, and it does not need attention.
    #[tokio::test]
    async fn a_job_with_no_secret_is_not_configured_and_needs_no_attention() {
        use crate::scheduler::write_status;
        use ledger_db::job_status::Status;
        let dir = std::env::temp_dir().join(format!(
            "counterpoise-not-configured-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let at = chrono::Utc::now();
        let now = at.timestamp_millis();
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        for name in ["backup", "recurring", "prune", "reindex", "price-sync"] {
            write_status(&dir, name, &ok, at).await;
        }
        let none = Status {
            ok: true,
            detail: Some("not configured: PLAID_SECRET is not set"),
            not_configured: true,
            ..Status::default()
        };
        write_status(&dir, "plaid-sync", &none, at).await;
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        let plaid = job(&result, "plaid-sync");
        assert_eq!(plaid["state"], "not_configured");
        assert_eq!(plaid["detail"], "not configured: PLAID_SECRET is not set");
        assert_eq!(plaid["lastOk"], serde_json::Value::Null);
        assert_eq!(job(&result, "price-sync")["state"], "ok");
        assert_eq!(result["overall"], "ok");

        // A record from before the field existed reads as before.
        write_status(&dir, "plaid-sync", &ok, at).await;
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        assert_eq!(job(&result, "plaid-sync")["state"], "ok");

        // Another job in a bad state still needs attention.
        write_status(&dir, "plaid-sync", &none, at).await;
        std::fs::remove_file(dir.join("reindex.json")).unwrap();
        let result = evaluate(read_entries_in(&dir).await.unwrap(), now, None);
        assert_eq!(job(&result, "plaid-sync")["state"], "not_configured");
        assert_eq!(job(&result, "reindex")["state"], "missing");
        assert_eq!(result["overall"], "attention");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_status_retains_os_error_names() {
        for (number, name) in [
            (libc::ELOOP, "ELOOP"),
            (libc::EMFILE, "EMFILE"),
            (libc::ENFILE, "ENFILE"),
            (libc::ENAMETOOLONG, "ENAMETOOLONG"),
        ] {
            let cause = std::io::Error::from_raw_os_error(number);
            assert_eq!(
                unreadable(&cause),
                format!("Status directory unreadable ({name})")
            );
        }
    }

    /// A file that is not a database: `SELECT 1` passes on it, because it
    /// reads no page. The pool has no pragmas, so that it can connect.
    #[tokio::test]
    async fn health_reads_the_file() {
        let path =
            std::env::temp_dir().join(format!("counterpoise-health-{}.db", std::process::id()));
        std::fs::write(&path, vec![0x5a_u8; 8192]).unwrap();
        let mut state = AppState::new(&path).expect("lazy pool");
        state.pool = DbPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_millis(500))
            .connect_lazy_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path));
        assert!(sqlx::query("SELECT 1").execute(&state.pool).await.is_ok());
        assert_eq!(
            health(State(state.clone())).await,
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(
            api_health(State(state)).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn rust_health_reports_database_failure() {
        let path = std::path::Path::new("/nonexistent/counterpoise.db");
        let mut state = AppState::new(path).expect("lazy pool");
        state.pool = DbPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy_with(sqlx::sqlite::SqliteConnectOptions::new().filename(path));
        assert_eq!(
            health(State(state)).await,
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
    }
}

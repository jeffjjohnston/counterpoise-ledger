use crate::{auth::session_user, error::ApiResult, platform, state::AppState};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use chrono::DateTime;
use ledger_db::Sql;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};

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

/// `GET /api/version`. A deploy that names its commit (`BUILD_COMMIT`) adds
/// it: commits between releases share a version, and an open page compares
/// the commit with its own build (`client/version-check.ts`).
pub(crate) async fn version() -> Json<Value> {
    let mut body = json!({ "version": VERSION_INFO.0.as_str(), "apiContract": VERSION_INFO.1 });
    if let Some(commit) = ledger_db::env::var("BUILD_COMMIT")
        .ok()
        .filter(|commit| !commit.is_empty())
    {
        body["commit"] = Value::String(commit);
    }
    Json(body)
}

/// A query that reads the schema page of the file. `SELECT 1` reads no page,
/// so it passes on a file that is not a database.
const HEALTH_QUERY: &str = "SELECT count(*) FROM sqlite_schema";

pub(crate) async fn health(State(state): State<AppState>) -> Result<StatusCode, StatusCode> {
    state
        .database
        .query_row::<i64>(HEALTH_QUERY, &[])
        .map(|_| StatusCode::OK)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

/// `GET /api/health`: the unauthenticated liveness check of the deploy check, which reads `"ok":true`. It carries no
/// operational detail: "backups last succeeded 40 days ago" is reconnaissance
/// on an internet-exposed fork. Job status is behind a session at
/// `/api/system/status`.
pub(crate) async fn api_health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match state.database.query_row::<i64>(HEALTH_QUERY, &[]) {
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
/// The native server's jobs: hourly backups into the backup folder, their
/// pruning, and the monthly reindex.
#[cfg(feature = "native")]
const JOBS: [JobConfig; 8] = [
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
    JobConfig {
        name: "weekly-review",
        label: "Weekly review",
        schedule: "Mondays 5am",
        stale_after_ms: 8 * DAY,
    },
    JobConfig {
        name: "issue-sync",
        label: "Issue sync",
        schedule: "Hourly at :30",
        stale_after_ms: 3 * HOUR,
    },
];
/// A Durable Object's jobs: the daily export to the bucket (whose lifecycle
/// rule deletes old dumps), the rate limits' pruning, and no reindex.
#[cfg(not(feature = "native"))]
const JOBS: [JobConfig; 7] = [
    JobConfig {
        name: "backup",
        label: "Database export",
        schedule: "Daily 3:45am",
        stale_after_ms: 2 * DAY,
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
        label: "Rate limit pruning",
        schedule: "Daily 4am",
        stale_after_ms: 2 * DAY,
    },
    JobConfig {
        name: "weekly-review",
        label: "Weekly review",
        schedule: "Mondays 5am",
        stale_after_ms: 8 * DAY,
    },
    JobConfig {
        name: "issue-sync",
        label: "Issue sync",
        schedule: "Hourly at :30",
        stale_after_ms: 3 * HOUR,
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

pub(crate) async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    session_user(&state, &headers, "Failed to read job status").await?;
    let now = platform::now().timestamp_millis();
    let result = match ledger_db::jobs::runs(&*state.database) {
        // No run recorded yet: nothing has run here (a new install, or a
        // development server), so there is nothing to report.
        Ok(entries) if entries.is_empty() => evaluate(None, now, None),
        Ok(entries) => evaluate(Some(entries), now, None),
        Err(cause) => {
            tracing::error!(error = %cause, "Could not read the job runs");
            evaluate(None, now, Some("Job status unreadable".to_owned()))
        }
    };
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::{api_health, evaluate, health};

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
        use ledger_db::jobs::Status;
        let database = memory();
        let read = || Some(ledger_db::jobs::runs(&database).unwrap());
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
        write_status(&database, "backup", &copy, at);
        let result = evaluate(read(), now, None);
        assert_eq!(job(&result, "backup")["state"], "ok");
        // A job that never ran is missing, not failed.
        assert_eq!(job(&result, "reindex")["state"], "missing");

        // A copy that fails integrity_check: the run completed, the copy is bad.
        let problem = Some("integrity_check: row 3 missing from index");
        let bad_copy = backup(true, problem, Some(512), Some(false));
        write_status(&database, "backup", &bad_copy, at);
        let result = evaluate(read(), now, None);
        assert_eq!(job(&result, "backup")["state"], "unverified");
        assert_eq!(result["overall"], "attention");

        let full = backup(false, Some("disk full"), None, None);
        write_status(&database, "backup", &full, at);
        let detail = Some("line one\nline \"two\"\\three");
        let broken = backup(false, detail, None, None);
        write_status(&database, "plaid-sync", &broken, at);
        let result = evaluate(read(), now, None);
        assert_eq!(job(&result, "backup")["state"], "failed");
        assert_eq!(job(&result, "backup")["detail"], "disk full");
        assert_eq!(job(&result, "plaid-sync")["state"], "failed");
        // Control characters become spaces; quotes and backslashes stay.
        assert_eq!(
            job(&result, "plaid-sync")["detail"],
            "line one line \"two\"\\three"
        );
    }
    use crate::state::AppState;
    use axum::{extract::State, http::StatusCode};
    use ledger_db::{Database, Sql};

    fn memory() -> Database {
        let database = Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        database
    }

    /// An install without Plaid or Tiingo is normal. The state differs from
    /// ok and from missing, and it does not need attention.
    #[tokio::test]
    async fn a_job_with_no_secret_is_not_configured_and_needs_no_attention() {
        use crate::scheduler::write_status;
        use ledger_db::jobs::Status;
        let database = memory();
        let read = || Some(ledger_db::jobs::runs(&database).unwrap());
        let at = chrono::Utc::now();
        let now = at.timestamp_millis();
        let ok = Status {
            ok: true,
            ..Status::default()
        };
        for name in [
            "backup",
            "recurring",
            "prune",
            "reindex",
            "price-sync",
            "weekly-review",
            "issue-sync",
        ] {
            write_status(&database, name, &ok, at);
        }
        let none = Status {
            ok: true,
            detail: Some("not configured: PLAID_SECRET is not set"),
            not_configured: true,
            ..Status::default()
        };
        write_status(&database, "plaid-sync", &none, at);
        let result = evaluate(read(), now, None);
        let plaid = job(&result, "plaid-sync");
        assert_eq!(plaid["state"], "not_configured");
        assert_eq!(plaid["detail"], "not configured: PLAID_SECRET is not set");
        assert_eq!(plaid["lastOk"], serde_json::Value::Null);
        assert_eq!(job(&result, "price-sync")["state"], "ok");
        assert_eq!(result["overall"], "ok");

        // A record from before the field existed reads as before.
        write_status(&database, "plaid-sync", &ok, at);
        let result = evaluate(read(), now, None);
        assert_eq!(job(&result, "plaid-sync")["state"], "ok");

        // Another job in a bad state still needs attention.
        write_status(&database, "plaid-sync", &none, at);
        database
            .execute("DELETE FROM job_runs WHERE job = 'reindex'", &[])
            .unwrap();
        let result = evaluate(read(), now, None);
        assert_eq!(job(&result, "plaid-sync")["state"], "not_configured");
        assert_eq!(job(&result, "reindex")["state"], "missing");
        assert_eq!(result["overall"], "attention");
    }

    /// A schema that cannot be read: the health query reads the schema
    /// page, so it fails, as on a file that is not a database.
    #[tokio::test]
    async fn health_reads_the_schema() {
        let state = AppState::in_memory();
        assert_eq!(health(State(state.clone())).await, Ok(StatusCode::OK));
        let version: i64 = state
            .database
            .query_row("PRAGMA schema_version", &[])
            .unwrap();
        state
            .database
            .exec_batch(&format!(
                "PRAGMA writable_schema = ON;
                 UPDATE sqlite_schema SET sql = 'not sql' WHERE name = 'users';
                 PRAGMA writable_schema = OFF;
                 PRAGMA schema_version = {};",
                version + 1
            ))
            .unwrap();
        assert_eq!(
            health(State(state.clone())).await,
            Err(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(
            api_health(State(state)).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}

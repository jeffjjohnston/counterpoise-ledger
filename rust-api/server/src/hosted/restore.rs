//! The point-in-time restore of a Durable Object: `POST /api/admin/restore`
//! takes the object's database back to a time of the last 30 days, or to a
//! bookmark that an earlier restore returned. It is off unless the object
//! has the secret `IMPORT_SECRET`, as the admin import is, and turned off
//! the path is a 404.
//!
//! The host does the restore, because only it holds the storage: it asks
//! for the bookmark of the time, leaves [`MARKER`] in the export bucket,
//! tells the storage to restore the bookmark at the next start, records
//! the bookmarks, and resets the object; the Worker answers. The restore takes back the whole database,
//! the change log with it, so the marker is what tells the next start that a
//! restore ran. That start calls [`App::after_restore`] before it serves
//! anything, and then removes the marker.

use super::App;
use crate::{cron_auth::verify_cron_secret, error::error};
/// The answer of the route, which the host converts.
pub use axum::response::Response;
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use chrono::{DateTime, TimeDelta, Utc};
use ledger_db::Database;
use serde::Deserialize;
use serde_json::json;

/// The path of the route, which the host serves itself.
pub const PATH: &str = "/api/admin/restore";

/// The export bucket's key of the marker that a restore leaves for the
/// next start. The bucket survives the restore; the database does not.
pub const MARKER: &str = "restore-pending";

/// The export bucket's key of the bookmarks of the last restore, which
/// `GET` on [`PATH`] gives.
pub const LAST: &str = "restore-last";

/// The header that names a restore request. The Worker sets it, and drops
/// any copy that the client sent; the marker and the record carry it, so
/// that the Worker can tell its own restore from an earlier one.
pub const REQUEST_HEADER: &str = "x-counterpoise-restore";

/// How far back Cloudflare keeps the object's history.
const KEPT_DAYS: i64 = 30;

/// Where a restore takes the database.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// The state at this time.
    Time(DateTime<Utc>),
    /// A bookmark, such as the `undo` of an earlier restore.
    Bookmark(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    at: Option<String>,
    bookmark: Option<String>,
}

/// Checks the secret before the host reads the body: a 404 when the route
/// is off, a 401 for another secret.
pub fn authorize(headers: &HeaderMap) -> Result<(), Box<Response>> {
    authorize_with(headers, super::import::secret().as_deref())
}

fn authorize_with(headers: &HeaderMap, secret: Option<&str>) -> Result<(), Box<Response>> {
    let Some(secret) = secret else {
        return Err(Box::new(StatusCode::NOT_FOUND.into_response()));
    };
    if !verify_cron_secret(headers, Some(secret)) {
        return Err(Box::new(
            error(StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
        ));
    }
    Ok(())
}

/// The target of a body `{"at": "<RFC 3339 time>"}` or
/// `{"bookmark": "<bookmark>"}`, or the 400 that refuses it.
pub fn target(body: &[u8], now: DateTime<Utc>) -> Result<Target, Box<Response>> {
    let body: Body = serde_json::from_slice(body).map_err(|cause| {
        refusal(
            StatusCode::BAD_REQUEST,
            format!("The body is not a restore: {cause}"),
        )
    })?;
    match (body.at, body.bookmark) {
        (Some(at), None) => {
            let at = DateTime::parse_from_rfc3339(&at)
                .map_err(|cause| {
                    refusal(
                        StatusCode::BAD_REQUEST,
                        format!("at is not an RFC 3339 time: {cause}"),
                    )
                })?
                .with_timezone(&Utc);
            if at >= now {
                return Err(refusal(
                    StatusCode::BAD_REQUEST,
                    "at must be in the past".to_owned(),
                ));
            }
            if at < now - TimeDelta::days(KEPT_DAYS) {
                return Err(refusal(
                    StatusCode::BAD_REQUEST,
                    format!("at must be within the last {KEPT_DAYS} days"),
                ));
            }
            Ok(Target::Time(at))
        }
        (None, Some(bookmark)) if !bookmark.trim().is_empty() => Ok(Target::Bookmark(bookmark)),
        _ => Err(refusal(
            StatusCode::BAD_REQUEST,
            "Give either at or bookmark".to_owned(),
        )),
    }
}

/// The marker of a restore that `request` asked for, which the object
/// leaves before it tells the storage to restore.
pub fn marker(request: &str, bookmark: &str) -> String {
    json!({ "request": request, "bookmark": bookmark }).to_string()
}

/// The record of a restore that the storage accepted: the request, the
/// bookmark that the next start restores, the bookmark of the state before
/// it, which undoes the restore, and when it was asked for.
pub fn record(request: &str, bookmark: &str, undo: &str, at: DateTime<Utc>) -> String {
    json!({
        "request": request,
        "bookmark": bookmark,
        "undo": undo,
        "requestedAt": at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })
    .to_string()
}

/// The answer of `GET` on [`PATH`]: the [`record`] of the last restore, or a
/// 404 when there is none.
pub fn recorded(record: Option<&str>) -> Response {
    match record.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok()) {
        Some(record) => Json(record).into_response(),
        None => *refusal(StatusCode::NOT_FOUND, "No restore is recorded".to_owned()),
    }
}

/// What the Worker answers when the object failed `request`, a restore
/// request: the object resets once it has scheduled a restore. A record of
/// this request is a 202 with the bookmarks. A marker of it with no record
/// means that the restore was scheduled and its bookmarks were not stored:
/// the object logged them. With neither, the restore never started, and the
/// Worker passes the failure on (`None`).
pub fn outcome(request: &str, record: Option<&str>, marker: Option<&str>) -> Option<Response> {
    let of_request = |text: Option<&str>| {
        text.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .filter(|value| value["request"] == request)
    };
    if let Some(record) = of_request(record) {
        return Some((StatusCode::ACCEPTED, Json(record)).into_response());
    }
    of_request(marker).map(|_| {
        *refusal(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The restore was scheduled and its bookmarks were not stored: the Worker's logs \
             have them"
                .to_owned(),
        )
    })
}

/// A JSON error with `message`.
pub fn refusal(status: StatusCode, message: String) -> Box<Response> {
    Box::new((status, Json(json!({ "error": message }))).into_response())
}

impl App {
    /// What the first start after a restore does before it serves anything.
    /// It adds a floor marker to the change log, so that every native
    /// client's cursor is below it and the client downloads its book again,
    /// rather than missing the changes that the restore took back. It then
    /// readies the rows as the start does (`super::prepare`): the restored
    /// database can show a weekly review as running.
    pub fn after_restore(&self) -> Result<(), String> {
        after_restore(&self.state.database)
    }
}

fn after_restore(database: &Database) -> Result<(), String> {
    ledger_db::sync_floor::insert(database)
        .map_err(|cause| format!("the floor marker was not added: {cause}"))?;
    super::prepare(database).map_err(|cause| format!("the rows were not prepared: {cause}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use ledger_db::Sql;

    const SECRET: &str = "restore-test-secret";

    fn headers(secret: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {secret}").parse().unwrap());
        headers
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-23T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn status(refused: &Response) -> StatusCode {
        refused.status()
    }

    #[test]
    fn the_route_is_off_without_the_secret_and_refuses_another() {
        assert_eq!(
            status(&authorize_with(&headers(SECRET), None).unwrap_err()),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status(&authorize_with(&headers("guess"), Some(SECRET)).unwrap_err()),
            StatusCode::UNAUTHORIZED
        );
        assert!(authorize_with(&headers(SECRET), Some(SECRET)).is_ok());
    }

    #[test]
    fn a_target_is_a_past_time_of_the_kept_days_or_a_bookmark() {
        assert_eq!(
            target(br#"{"at": "2026-10-23T09:30:00-02:00"}"#, now()).unwrap(),
            Target::Time(
                DateTime::parse_from_rfc3339("2026-10-23T11:30:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
            )
        );
        assert_eq!(
            target(br#"{"bookmark": "0000-abc"}"#, now()).unwrap(),
            Target::Bookmark("0000-abc".to_owned())
        );
        for body in [
            r#"{"at": "2026-10-23T12:00:01Z"}"#,
            r#"{"at": "2026-09-22T12:00:00Z"}"#,
            r#"{"at": "yesterday"}"#,
            r#"{"at": "2026-10-23T09:00:00Z", "bookmark": "0000-abc"}"#,
            r#"{"bookmark": " "}"#,
            r#"{"time": "2026-10-23T09:00:00Z"}"#,
            "{}",
            "",
        ] {
            assert_eq!(
                status(&target(body.as_bytes(), now()).unwrap_err()),
                StatusCode::BAD_REQUEST,
                "{body}"
            );
        }
    }

    #[test]
    fn the_last_restore_is_read_back_from_its_record() {
        let record = record("r1", "0001-b", "0000-a", now());
        let response = recorded(Some(&record));
        assert_eq!(response.status(), StatusCode::OK);
        let record: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(
            record,
            json!({
                "request": "r1",
                "bookmark": "0001-b",
                "undo": "0000-a",
                "requestedAt": "2026-10-23T12:00:00Z",
            })
        );
        assert_eq!(recorded(None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_failed_restore_request_is_accepted_only_by_its_own_record() {
        let marker = marker("r2", "0001-b");
        let earlier = record("r1", "0001-a", "0000-a", now());
        let own = record("r2", "0001-b", "0000-b", now());
        assert_eq!(
            outcome("r2", Some(&own), Some(&marker)).unwrap().status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(
            outcome("r2", Some(&earlier), Some(&marker))
                .unwrap()
                .status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "scheduled, and the record is an earlier restore's"
        );
        assert!(outcome("r2", Some(&earlier), None).is_none());
        assert!(outcome("r2", None, Some(&self::marker("r1", "0001-a"))).is_none());
    }

    #[test]
    fn the_start_after_a_restore_puts_every_cursor_below_a_floor() {
        let state = AppState::in_memory();
        let database = &state.database;
        database
            .execute(
                "INSERT INTO transaction_changes (seq, book_id, transaction_id) VALUES (7, 1, 1)",
                &[],
            )
            .unwrap();
        after_restore(database).unwrap();
        let (floor, book): (i64, i32) = database
            .query_row(
                "SELECT seq, book_id FROM transaction_changes ORDER BY seq DESC LIMIT 1",
                &[],
            )
            .unwrap();
        assert_eq!(book, ledger_db::sync_floor::SYNC_FLOOR_BOOK_ID);
        assert!(floor > 7 + (1 << 31), "{floor}");
    }
}

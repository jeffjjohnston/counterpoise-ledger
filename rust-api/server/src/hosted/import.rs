//! The admin import of a Durable Object: `POST /api/admin/import` with a
//! dump (`ledger-cli dump`) as its body loads it into an object that holds no
//! user and no book. It moves the data of a native server into the object
//! (`ledger_db::dump::import`), and it is off unless the object has the
//! secret `IMPORT_SECRET`. Turned off, the path is a 404 like any other
//! unrouted path.
//!
//! The caller is whoever holds the secret, as with `CRON_SECRET`: an empty
//! object has no user to sign in. The secret is checked before the body is
//! read. The whole dump is one request and one write transaction, so a
//! dump that fails leaves the object as it was. The server then readies the
//! rows as its start readies a file (`super::prepare`); when that fails, the
//! route removes the imported rows again, so that the object neither keeps
//! data it cannot serve nor refuses a corrected dump.

use crate::{
    cron_auth::verify_cron_secret,
    error::{error, internal_error},
    state::AppState,
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use ledger_db::{Database, dump::DumpError};
use serde_json::json;
use std::error::Error;

/// The path of the route. The host sets the alarm again after an import,
/// whose job tables can hold due work.
pub const PATH: &str = "/api/admin/import";

/// The largest dump that the route reads. A Worker takes a request body of
/// up to 100 MB, and the object has 128 MB for all of its memory.
pub(super) const MOST_BYTES: usize = 64 * 1024 * 1024;

/// The setting that turns the route on.
pub(super) fn secret() -> Option<String> {
    ledger_db::env::var("IMPORT_SECRET")
        .ok()
        .filter(|secret| !secret.is_empty())
}

pub(super) async fn import(State(state): State<AppState>, request: Request) -> Response {
    respond(&state, request, secret().as_deref(), super::prepare).await
}

type Prepare = fn(&Database) -> Result<(), Box<dyn Error>>;

async fn respond(
    state: &AppState,
    request: Request,
    secret: Option<&str>,
    prepare: Prepare,
) -> Response {
    let Some(secret) = secret else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !verify_cron_secret(request.headers(), Some(secret)) {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let Ok(body) = to_bytes(request.into_body(), MOST_BYTES).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "The dump is too large").into_response();
    };
    let Ok(text) = std::str::from_utf8(&body) else {
        return error(StatusCode::BAD_REQUEST, "The dump is not UTF-8").into_response();
    };
    let loaded = match ledger_db::dump::import(&state.database, text) {
        Ok(loaded) => loaded,
        Err(DumpError::NotEmpty(table)) => {
            return refused(
                StatusCode::CONFLICT,
                format!("The server holds data: {table} has rows"),
            );
        }
        Err(DumpError::Invalid(message)) => {
            return refused(StatusCode::BAD_REQUEST, format!("Invalid dump: {message}"));
        }
        Err(cause) => return internal_error(cause, "The import failed").into_response(),
    };
    tracing::warn!(
        tables = loaded.tables,
        rows = loaded.rows,
        "A dump was imported"
    );
    // What the object's start does for a file that it opens: the rows came
    // in after it.
    if let Err(cause) = prepare(&state.database) {
        tracing::error!(error = %cause, "The imported data was not prepared");
        if let Err(cause) = ledger_db::dump::clear(&state.database) {
            return internal_error(
                cause,
                "The dump was imported, its data was not prepared, and it was not removed",
            )
            .into_response();
        }
        return refused(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The dump was not imported: its data was not prepared: {cause}"),
        );
    }
    Json(json!({ "tables": loaded.tables, "rows": loaded.rows })).into_response()
}

fn refused(status: StatusCode, message: String) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use ledger_db::Sql;

    const SECRET: &str = "import-test-secret";

    fn prepared(database: &Database) -> Result<(), Box<dyn Error>> {
        super::super::prepare(database)
    }

    fn unprepared(_: &Database) -> Result<(), Box<dyn Error>> {
        Err("no key opens the Plaid tokens".into())
    }

    fn request(secret: &str, body: impl Into<Body>) -> Request {
        Request::builder()
            .method("POST")
            .uri(PATH)
            .header("authorization", format!("Bearer {secret}"))
            .body(body.into())
            .unwrap()
    }

    async fn answer(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    /// A dump of a database with a user, a book and its rows, among them a
    /// weekly review that the source server was running.
    fn dump() -> String {
        let source = ledger_db::testing::TempDatabase::new();
        let database = source.database();
        database
            .exec_batch(
                "INSERT INTO users (id, username, password_hash, created_at)
                   VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
                 INSERT INTO accounts (book_id, name, type, created_at, updated_at)
                   VALUES (1, 'Checking', 'asset', '2025-01-01 00:00:00', '2025-01-01 00:00:00');
                 INSERT INTO weekly_reviews
                   (book_id, source, period_start, period_end, status, revision, started_at)
                   VALUES (1, 'manual', '2025-01-01', '2025-01-07', 'running', 0,
                     '2025-01-08 00:00:00');",
            )
            .unwrap();
        String::from_utf8(ledger_db::dump::dump_json(database).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn the_route_is_off_without_the_secret_and_refuses_another() {
        let state = AppState::in_memory();
        let (status, body) =
            answer(respond(&state, request(SECRET, dump()), None, prepared).await).await;
        assert_eq!((status, body.as_str()), (StatusCode::NOT_FOUND, ""));
        let (status, _) =
            answer(respond(&state, request("guess", dump()), Some(SECRET), prepared).await).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let users: i64 = state
            .database
            .query_row("SELECT COUNT(*) FROM users", &[])
            .unwrap();
        assert_eq!(users, 0);
    }

    #[tokio::test]
    async fn a_dump_goes_in_once() {
        let state = AppState::in_memory();
        let text = dump();
        let (status, body) = answer(
            respond(
                &state,
                request(SECRET, text.clone()),
                Some(SECRET),
                prepared,
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(body["rows"].as_u64().unwrap() >= 3, "{body}");
        let account: String = state
            .database
            .query_row("SELECT name FROM accounts", &[])
            .unwrap();
        assert_eq!(account, "Checking");
        let review: String = state
            .database
            .query_row("SELECT status FROM weekly_reviews", &[])
            .unwrap();
        assert_eq!(review, "failed", "no task of the object runs it");

        // The object now holds data.
        let (status, body) =
            answer(respond(&state, request(SECRET, text), Some(SECRET), prepared).await).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body, r#"{"error":"The server holds data: users has rows"}"#);
    }

    #[tokio::test]
    async fn a_dump_whose_data_is_not_prepared_is_removed_again() {
        let state = AppState::in_memory();
        let text = dump();
        let (status, body) = answer(
            respond(
                &state,
                request(SECRET, text.clone()),
                Some(SECRET),
                unprepared,
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(body.contains("no key opens the Plaid tokens"), "{body}");
        let users: i64 = state
            .database
            .query_row("SELECT COUNT(*) FROM users", &[])
            .unwrap();
        assert_eq!(users, 0);

        let (status, body) =
            answer(respond(&state, request(SECRET, text), Some(SECRET), prepared).await).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn a_dump_that_is_not_one_is_a_bad_request() {
        let state = AppState::in_memory();
        let (status, body) = answer(
            respond(
                &state,
                request(SECRET, "{\"format\": 2}"),
                Some(SECRET),
                prepared,
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("Invalid dump: format 2 is not 1"), "{body}");
    }
}

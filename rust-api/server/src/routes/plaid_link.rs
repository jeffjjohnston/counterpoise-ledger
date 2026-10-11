//! Plaid Hosted Link: connect a bank, or reconnect one in update mode, from
//! the Sync page.
//!
//! The server makes every Plaid call. `POST sync/link-sessions` starts a
//! session and gives the browser the Hosted Link URL, which opens in a new
//! tab. Hosted Link sends no callback to the page, so the browser polls
//! `POST sync/link-sessions/[id]/check`, and the server asks
//! `/link/token/get` for the result. When a new Item is complete, the
//! server exchanges the public token and writes the access token into
//! `plaid_tokens`. When an update-mode session is complete, the access token
//! stays the same. No response contains an access token, a public token or a
//! link token, and no log line contains one.
//!
//! Both routes need the owner, as the other connection writes do: they make
//! or change the bank credentials of the book.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    plaid::{LinkOutcome, is_configuration_error, is_definitive_error},
    routes::sync::{
        DUPLICATE_ITEM, TOKEN_NOT_FOUND, bad_request, database_id, finite_path_id, iso_timestamp,
        refresh_accounts,
    },
    routes::transactions::now_millis,
    state::AppState,
    validation::{js_number, parse_json_body},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDateTime, TimeDelta};
use ledger_db::engine::DbConnection;
use serde_json::{Value, json};
use sqlx::FromRow;

/// A session expires four hours after it starts, or when its link token
/// expires, if that is earlier.
const SESSION_LIFETIME: TimeDelta = TimeDelta::hours(4);
/// The server deletes a session one day after it expires.
const SESSION_RETENTION: TimeDelta = TimeDelta::days(1);
/// The lease of a `completing` claim. A claim older than this is stale: the
/// request that took it stopped (for example, the server exited), and the
/// next check takes the claim again.
///
/// The request that holds a claim makes one Plaid call, the exchange of the
/// public token. The Plaid client stops a call after 120 seconds. Then the
/// request writes the result in one transaction, and each statement waits
/// for the database lock for 5 seconds at most. The account load after it
/// runs when the claim is gone. Thus a live claim is held for approximately
/// two minutes at most. Ten minutes is more than four times that, so a check
/// does not take the claim of a request that is still live.
const CLAIM_LEASE: TimeDelta = TimeDelta::minutes(10);
/// The tries to save a new connection after the exchange, and the wait
/// between two tries. Each statement already waits 5 seconds for the lock,
/// so three tries are well inside `CLAIM_LEASE`.
const SAVE_ATTEMPTS: u32 = 3;
const SAVE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

const INVALID_SESSION_ID: &str = "Invalid link session id";
const SESSION_NOT_FOUND: &str = "Link session not found";
const BODY_NOT_OBJECT: &str = "The request body must be a JSON object";
const TOKEN_ID_INVALID: &str = "tokenId must be a positive integer or null";
const RESTART_INVALID: &str = "restart must be a boolean";
const DEMO_TOKEN: &str = "A demo connection cannot be reconnected";
const SAVE_FAILED: &str = "The bank connection could not be saved. The server log has the cause.";
/// The name of a new connection when Plaid does not name the institution.
/// The owner can change it on the connections page.
const UNNAMED_INSTITUTION: &str = "Bank";

/// The columns of a session, with the name of its connection when it has
/// one. A new connection has none until the session is complete.
const SESSION_QUERY: &str = "
    SELECT s.id, s.token_id, s.result_token_id, s.link_token, s.hosted_link_url, s.status,
           s.error, s.expires_at, s.updated_at, t.financial_institution
    FROM plaid_link_sessions s
    LEFT JOIN plaid_tokens t
           ON t.id = COALESCE(s.result_token_id, s.token_id) AND t.book_id = s.book_id
    WHERE s.id = $1 AND s.book_id = $2";

#[derive(FromRow)]
struct SessionRow {
    id: i32,
    token_id: Option<i32>,
    result_token_id: Option<i32>,
    link_token: String,
    hosted_link_url: String,
    status: String,
    error: Option<String>,
    expires_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    financial_institution: Option<String>,
}

impl SessionRow {
    /// `completing` is a claim inside the server. A client sees `pending`.
    fn is_open(&self) -> bool {
        self.status == "pending" || self.status == "completing"
    }
}

/// The response. It never holds the link token or an access token.
fn session_body(row: &SessionRow) -> Value {
    let open = row.is_open();
    json!({
        "id": row.id,
        "mode": if row.token_id.is_some() { "update" } else { "create" },
        "status": if open { "pending" } else { row.status.as_str() },
        "tokenId": row.result_token_id.or(row.token_id),
        "financialInstitution": row.financial_institution,
        "hostedLinkUrl": open.then_some(row.hosted_link_url.as_str()),
        "expiresAt": iso_timestamp(row.expires_at),
        "error": row.error,
    })
}

async fn load_session(
    state: &AppState,
    book_id: i32,
    session_id: i32,
    failure_message: &'static str,
) -> Result<SessionRow, ApiError> {
    sqlx::query_as(SESSION_QUERY)
        .bind(session_id)
        .bind(book_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, failure_message))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, SESSION_NOT_FOUND))
}

/// A Plaid failure: a configuration fault is the installation's (500), and
/// every other failure is reported as Plaid's (502). The message holds no
/// token: it is the Plaid error message and code, or a fixed text.
fn plaid_failure(message: String) -> ApiError {
    tracing::error!(error = %message, "Plaid Hosted Link request failed");
    let status = if is_configuration_error(&message) {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::BAD_GATEWAY
    };
    error_owned(status, message)
}

/// The body of `POST sync/link-sessions`.
struct LinkBody {
    /// Absent or null for a new connection, and a positive integer for
    /// update mode.
    token_id: Option<f64>,
    /// True stops the open sessions and starts a new one. Absent or false
    /// continues the newest open session, if there is one.
    restart: bool,
}

/// Reads `tokenId` and `restart`, the two fields of the body. The route
/// writes no other field.
fn validate_link_body(body: &Value) -> Result<LinkBody, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| bad_request(BODY_NOT_OBJECT))?;
    let token_id = match object.get("tokenId") {
        None | Some(Value::Null) => None,
        Some(Value::Number(number)) => {
            let value = js_number(number);
            if value.fract() != 0.0 || value <= 0.0 || value > 9_007_199_254_740_991.0 {
                return Err(bad_request(TOKEN_ID_INVALID));
            }
            Some(value)
        }
        _ => return Err(bad_request(TOKEN_ID_INVALID)),
    };
    let restart = match object.get("restart") {
        None => false,
        Some(Value::Bool(restart)) => *restart,
        _ => return Err(bad_request(RESTART_INVALID)),
    };
    Ok(LinkBody { token_id, restart })
}

/// The open sessions of one connection of a book, newest first. A session
/// of a new connection has no `token_id`: `IS` matches NULL to NULL.
///
/// The list has the sessions of all the owners of the book, not only the
/// sessions of the caller. The connection is the book's, and two open
/// sessions for one connection can add the same Item two times.
///
/// A live claim is open also after `expires_at`: its request still saves a
/// result that the user finished at Plaid, so a restart must not start a
/// second session next to it.
///
/// With `include_expired`, the list also has the sessions that are past
/// `expires_at` but not yet marked `expired`. `advance_session` asks Plaid
/// one time for their result, so that a connection that the user finished
/// just before the expiry is saved, not made again.
async fn open_session_ids(
    state: &AppState,
    book_id: i32,
    token_id: Option<i32>,
    include_expired: bool,
    failure_message: &'static str,
) -> Result<Vec<i32>, ApiError> {
    let now = now_millis();
    sqlx::query_scalar(
        "SELECT id FROM plaid_link_sessions
         WHERE book_id = $1 AND token_id IS $2 AND status IN ('pending', 'completing')
           AND ($5 OR expires_at > $3 OR (status = 'completing' AND updated_at >= $4))
         ORDER BY id DESC",
    )
    .bind(book_id)
    .bind(token_id)
    .bind(now)
    .bind(now - CLAIM_LEASE)
    .bind(include_expired)
    .fetch_all(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, failure_message))
}

/// Starts a Hosted Link session, or continues one.
///
/// The browser can lose the ID of a session, for example when the user
/// reloads the page while the Plaid tab stays open. Thus the route first
/// advances each open session of the same connection (`advance_session`,
/// which asks Plaid). If one becomes complete, the route answers it, so the
/// modal shows the saved connection. Otherwise, without `restart`, the route
/// answers the newest open session: the same ID and the same URL, and no new
/// Plaid session. With `restart`, the route expires the pending sessions and
/// the stale claims, and starts a new one. A live claim stays: see the
/// transaction below.
pub(crate) async fn create_link_session(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to start the bank connection";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let body = parse_json_body(&body, FAILURE)?;
    let LinkBody { token_id, restart } = validate_link_body(&body)?;
    let token_id = match token_id {
        Some(token_id) => Some(database_id(token_id, FAILURE)?),
        None => None,
    };

    // Update mode: the connection must be in this book. Its access token
    // goes to Plaid only.
    let access_token = match token_id {
        None => None,
        Some(token_id) => {
            let token: Option<(String, bool)> = sqlx::query_as(
                "SELECT access_token, is_demo FROM plaid_tokens WHERE id = $1 AND book_id = $2",
            )
            .bind(token_id)
            .bind(book.book_id())
            .fetch_optional(&state.pool)
            .await
            .map_err(|cause| internal_error(cause, FAILURE))?;
            match token {
                None => return Err(error(StatusCode::NOT_FOUND, TOKEN_NOT_FOUND)),
                Some((_, true)) => return Err(bad_request(DEMO_TOKEN)),
                Some((access_token, false)) => Some(access_token),
            }
        }
    };

    // The user can have finished an open session at Plaid. A failure here
    // does not stop the request: the session stays as it is, and the log
    // has the cause. The cause holds no token.
    //
    // The exception is a session past `expires_at` that a transient failure
    // left open: it can still hold a connection that the user finished. A new
    // session next to it could save the same bank two times, so without
    // `restart` the request answers the failure, and the client tries again.
    let mut completed = None;
    let mut late_failure = None;
    for session_id in open_session_ids(&state, book.book_id(), token_id, true, FAILURE).await? {
        let Ok(session) = load_session(&state, book.book_id(), session_id, FAILURE).await else {
            continue;
        };
        if let Err(cause) = advance_session(&state, book.book_id(), &session, FAILURE).await {
            tracing::warn!(
                session_id,
                error = %cause.message(),
                "An open Plaid link session could not be advanced"
            );
            // Only a session that stays open blocks a new one. A failure that
            // ended the session (a duplicate Item, a failed save) does not.
            if session.expires_at <= now_millis()
                && late_failure.is_none()
                && load_session(&state, book.book_id(), session_id, FAILURE)
                    .await
                    .is_ok_and(|session| session.is_open())
            {
                late_failure = Some(cause);
            }
            continue;
        }
        // The IDs are newest first, so the first complete session is the
        // newest.
        if completed.is_none()
            && let Ok(session) = load_session(&state, book.book_id(), session_id, FAILURE).await
            && session.status == "complete"
        {
            completed = Some(session);
        }
    }
    if let Some(session) = completed {
        return Ok(Json(session_body(&session)));
    }
    if !restart && let Some(cause) = late_failure {
        return Err(cause);
    }
    if !restart
        && let Some(&session_id) =
            open_session_ids(&state, book.book_id(), token_id, false, FAILURE)
                .await?
                .first()
    {
        let session = load_session(&state, book.book_id(), session_id, FAILURE).await?;
        return Ok(Json(session_body(&session)));
    }

    // Plaid asks for a stable ID of the user that is not personal data.
    let client_user_id = format!("counterpoise-user-{}", book.user_id());
    let link = state
        .plaid
        .create_hosted_link(&client_user_id, access_token.as_deref())
        .await
        .map_err(plaid_failure)?;

    let now = now_millis();
    let mut expires_at = now + SESSION_LIFETIME;
    if let Some(expiration) = link
        .expiration
        .and_then(|time| DateTime::from_timestamp_millis(time.timestamp_millis()))
        .map(|time| time.naive_utc())
    {
        expires_at = expires_at.min(expiration);
    }
    let database = |cause| internal_error(cause, FAILURE);
    sqlx::query("DELETE FROM plaid_link_sessions WHERE expires_at < $1")
        .bind(now - SESSION_RETENTION)
        .execute(&state.pool)
        .await
        .map_err(database)?;
    // The checks above ran without the write lock, so another request can
    // have started a session for this connection since then (two tabs that
    // start at the same time). Thus this transaction, which holds the write
    // lock, looks at the open sessions again before it inserts.
    let mut transaction = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(database)?;
    // A restart stops the pending sessions and the stale claims. It does not
    // stop a live claim: that request exchanges a result that the user
    // finished at Plaid, and it completes the session. The open sessions stop
    // only after Plaid gave the new one, so a failed start leaves them open.
    if restart {
        sqlx::query(
            "UPDATE plaid_link_sessions SET status = 'expired', updated_at = $3
             WHERE book_id = $1 AND token_id IS $2
               AND (status = 'pending' OR (status = 'completing' AND updated_at < $4))",
        )
        .bind(book.book_id())
        .bind(token_id)
        .bind(now)
        .bind(now - CLAIM_LEASE)
        .execute(transaction.as_mut())
        .await
        .map_err(database)?;
    }
    // Without `restart`, an open session is continued. After a restart, the
    // only open session can be a live claim, and the route answers it: the
    // client polls it and sees the saved connection. In both cases the route
    // inserts nothing. The new link token is not used, and it expires at
    // Plaid.
    let open: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM plaid_link_sessions
         WHERE book_id = $1 AND token_id IS $2 AND status IN ('pending', 'completing')
           AND (expires_at > $3 OR (status = 'completing' AND updated_at >= $4))
         ORDER BY id DESC LIMIT 1",
    )
    .bind(book.book_id())
    .bind(token_id)
    .bind(now)
    .bind(now - CLAIM_LEASE)
    .fetch_optional(transaction.as_mut())
    .await
    .map_err(database)?;
    if let Some(session_id) = open {
        transaction.commit().await.map_err(database)?;
        let session = load_session(&state, book.book_id(), session_id, FAILURE).await?;
        return Ok(Json(session_body(&session)));
    }
    let session_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_link_sessions
           (book_id, user_id, token_id, link_token, hosted_link_url, status, expires_at,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $7)
         RETURNING id",
    )
    .bind(book.book_id())
    .bind(book.user_id())
    .bind(token_id)
    .bind(&link.link_token)
    .bind(&link.hosted_link_url)
    .bind(expires_at)
    .bind(now)
    .fetch_one(transaction.as_mut())
    .await
    .map_err(database)?;
    transaction.commit().await.map_err(database)?;
    let session = load_session(&state, book.book_id(), session_id, FAILURE).await?;
    Ok(Json(session_body(&session)))
}

/// Polls a Hosted Link session, and completes it when the user finished it
/// at Plaid. A session that is not open answers its stored state, with no
/// Plaid call.
pub(crate) async fn check_link_session(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to check the bank connection";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Owner, FAILURE).await?;
    let session_id = database_id(finite_path_id(&raw_id, INVALID_SESSION_ID)?, FAILURE)?;
    let session = load_session(&state, book.book_id(), session_id, FAILURE).await?;
    if !session.is_open() {
        return Ok(Json(session_body(&session)));
    }
    advance_session(&state, book.book_id(), &session, FAILURE).await?;
    let session = load_session(&state, book.book_id(), session_id, FAILURE).await?;
    Ok(Json(session_body(&session)))
}

/// Advances one open session as far as it can go now. The caller reads the
/// stored state after it.
///
/// - A session past `expires_at` gets one Plaid answer. Plaid keeps the
///   result of a session after its link token expires, and the public token
///   can still work. When the user finished, the function completes the
///   session as below. When there is no result, or Plaid refuses the call or
///   the exchange (`is_definitive_error`), the session becomes `expired`, so
///   that no later check calls Plaid again. A transient failure (network,
///   rate limit, Plaid server error) leaves the session as it is, and a later
///   check tries again. A live claim stays: its request completes the
///   session.
/// - A `completing` claim that is newer than `CLAIM_LEASE` belongs to a
///   request that completes the session. Nothing changes.
/// - Otherwise the function asks Plaid for the result. When the user
///   finished, it claims the session and completes it.
///
/// A stale claim counts as `pending`, because its request stopped. If that
/// request stopped after the exchange, the public token is used: the new
/// exchange fails, the claim goes back, and the session stays `pending`
/// until it expires. The user then starts again. No saved data is lost: a
/// connection is saved in one transaction, which also completes the session
/// when the claim still holds (`save_new_item`).
async fn advance_session(
    state: &AppState,
    book_id: i32,
    session: &SessionRow,
    failure_message: &'static str,
) -> Result<(), ApiError> {
    if !session.is_open() {
        return Ok(());
    }
    let session_id = session.id;
    let now = now_millis();
    let stale_before = now - CLAIM_LEASE;
    let expired = session.expires_at <= now;
    let expire = || async {
        sqlx::query(
            "UPDATE plaid_link_sessions SET status = 'expired', updated_at = $2
             WHERE id = $1
               AND (status = 'pending' OR (status = 'completing' AND updated_at < $3))",
        )
        .bind(session_id)
        .bind(now)
        .bind(stale_before)
        .execute(&state.pool)
        .await
        .map(|_| ())
        .map_err(|cause| internal_error(cause, failure_message))
    };
    // Another request holds the claim and completes the session.
    if session.status == "completing" && session.updated_at >= stale_before {
        return Ok(());
    }

    let outcome = match state.plaid.link_session_outcome(&session.link_token).await {
        Ok(outcome) => outcome,
        Err(message) if expired && is_definitive_error(&message) => {
            tracing::warn!(error = %message, session_id, "The result of an expired Plaid link session could not be read");
            return expire().await;
        }
        Err(message) => return Err(plaid_failure(message)),
    };
    let new_item = match (session.token_id, outcome) {
        (_, LinkOutcome::Pending)
        | (
            None,
            LinkOutcome::Success {
                public_token: None, ..
            },
        ) => return if expired { expire().await } else { Ok(()) },
        (
            None,
            LinkOutcome::Success {
                public_token: Some(public_token),
                institution,
            },
        ) => Some((public_token, institution)),
        (Some(_), LinkOutcome::Success { .. }) => None,
    };

    // The claim: only one request exchanges the result. A request that
    // loses the claim answers the state that the winner wrote. One statement
    // takes a stale claim again, so two requests that both see it stale
    // cannot both win.
    let claimed: Option<i32> = sqlx::query_scalar(
        "UPDATE plaid_link_sessions SET status = 'completing', updated_at = $2
         WHERE id = $1
           AND (status = 'pending' OR (status = 'completing' AND updated_at < $3))
         RETURNING id",
    )
    .bind(session_id)
    .bind(now)
    .bind(stale_before)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, failure_message))?;
    if claimed.is_none() {
        return Ok(());
    }
    match (session.token_id, new_item) {
        (None, Some((public_token, institution))) => {
            complete_new_item(
                state,
                book_id,
                session_id,
                &public_token,
                institution,
                expired,
            )
            .await
        }
        (Some(token_id), _) => complete_update(state, book_id, session_id, token_id).await,
        (None, None) => unreachable!("a new item has a public token"),
    }
}

/// Gives the claim back, so that a later check tries again.
async fn release_claim(state: &AppState, session_id: i32) {
    if let Err(cause) = sqlx::query(
        "UPDATE plaid_link_sessions SET status = 'pending', updated_at = $2
         WHERE id = $1 AND status = 'completing'",
    )
    .bind(session_id)
    .bind(now_millis())
    .execute(&state.pool)
    .await
    {
        tracing::error!(error = %cause, session_id, "Could not release a Plaid link session");
    }
}

/// Expires a claimed session whose result cannot be saved any more.
async fn expire_claim(state: &AppState, session_id: i32) {
    if let Err(cause) = sqlx::query(
        "UPDATE plaid_link_sessions SET status = 'expired', updated_at = $2
         WHERE id = $1 AND status = 'completing'",
    )
    .bind(session_id)
    .bind(now_millis())
    .execute(&state.pool)
    .await
    {
        tracing::error!(error = %cause, session_id, "Could not expire a Plaid link session");
    }
}

/// Records a failure after the public token was used. The token cannot be
/// exchanged again, so the session stops. Only a claim changes: a session
/// that a restart expired stays expired.
async fn fail_session(state: &AppState, session_id: i32, message: &str) {
    if let Err(cause) = sqlx::query(
        "UPDATE plaid_link_sessions SET status = 'failed', error = $2, updated_at = $3
         WHERE id = $1 AND status = 'completing'",
    )
    .bind(session_id)
    .bind(message)
    .bind(now_millis())
    .execute(&state.pool)
    .await
    {
        tracing::error!(error = %cause, session_id, "Could not record a failed Plaid link session");
    }
}

/// A new Item: exchanges the public token, writes the connection, and loads
/// its accounts.
///
/// A failed exchange gives the claim back, so that a later check tries
/// again. For a session past `expires_at` (`expired`), a definitive refusal
/// expires the session: its public token does not become valid again.
async fn complete_new_item(
    state: &AppState,
    book_id: i32,
    session_id: i32,
    public_token: &str,
    institution: Option<String>,
    expired: bool,
) -> Result<(), ApiError> {
    let (access_token, item_id) = match state.plaid.exchange_public_token(public_token).await {
        Ok(pair) => pair,
        Err(message) if expired && is_definitive_error(&message) => {
            tracing::warn!(error = %message, session_id, "The public token of an expired Plaid link session could not be exchanged");
            expire_claim(state, session_id).await;
            return Ok(());
        }
        Err(message) => {
            release_claim(state, session_id).await;
            return Err(plaid_failure(message));
        }
    };
    let institution = institution.unwrap_or_else(|| UNNAMED_INSTITUTION.to_owned());

    // From here, the public token is used: this access token is the only
    // one. A database failure (for example a lock that another writer holds
    // for longer than the busy timeout) is tried again. The save is one
    // transaction, so a failed try writes nothing.
    let mut attempt = 1;
    let saved = loop {
        let result = save_new_item(
            state,
            book_id,
            session_id,
            &institution,
            &item_id,
            &access_token,
        )
        .await;
        match result {
            Err(cause) if attempt < SAVE_ATTEMPTS => {
                tracing::warn!(error = %cause, session_id, attempt, "Could not save a Plaid connection; trying again");
                tokio::time::sleep(SAVE_RETRY_DELAY).await;
                attempt += 1;
            }
            result => break result,
        }
    };
    let token_id = match saved {
        Ok(Some(token_id)) => token_id,
        Ok(None) => {
            fail_session(state, session_id, DUPLICATE_ITEM).await;
            return Err(error(StatusCode::CONFLICT, DUPLICATE_ITEM));
        }
        Err(cause) => {
            tracing::error!(error = %cause, session_id, "Could not save a Plaid connection");
            // An Item that a book of this installation has stored (Item IDs
            // are unique across it) is a duplicate: it must stay at Plaid,
            // because that connection uses it.
            let stored: Result<bool, sqlx::Error> =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM plaid_tokens WHERE item_id = $1)")
                    .bind(&item_id)
                    .fetch_one(&state.pool)
                    .await;
            match stored {
                Ok(true) => {
                    fail_session(state, session_id, DUPLICATE_ITEM).await;
                    return Err(error(StatusCode::CONFLICT, DUPLICATE_ITEM));
                }
                // The access token is not kept, so the Item ends at Plaid
                // too. Otherwise it would stay there with no connection.
                Ok(false) => {
                    if let Err(message) = state.plaid.remove_item(&access_token).await {
                        tracing::error!(error = %message, session_id, "Could not remove the Plaid Item of an unsaved connection");
                    }
                }
                // Without the answer, the Item can belong to a connection:
                // it stays at Plaid.
                Err(cause) => {
                    tracing::error!(error = %cause, session_id, "Could not check the Plaid Item of an unsaved connection; it stays at Plaid");
                }
            }
            fail_session(state, session_id, SAVE_FAILED).await;
            return Err(error(StatusCode::INTERNAL_SERVER_ERROR, SAVE_FAILED));
        }
    };
    // The connection is saved. The owner can load the accounts again from
    // the connections page, so a failure here does not fail the session.
    if let Err(message) = refresh_accounts(state, book_id, token_id, &access_token, false).await {
        tracing::error!(error = %message, session_id, "Plaid account load after a new connection failed");
    }
    Ok(())
}

/// Writes the connection and completes the session in one transaction.
/// `None` when the book already has a connection for this Item. Item IDs
/// are unique across the installation, so a duplicate in another book fails
/// the insert.
///
/// The session becomes `complete` only when it is still `completing`. It is
/// not when the claim went stale and a restart expired the session during
/// the exchange. The connection is saved all the same, and the session keeps
/// the state that the other request wrote. The public token is already
/// exchanged, so Plaid has the Item: to drop the access token would leave
/// that Item at Plaid with no connection in the book, and the user would
/// have to sign in to the bank again. To write `complete` over the other
/// state would undo a decision of the other request. With this choice the
/// bank data stays, and each session state comes from one request.
async fn save_new_item(
    state: &AppState,
    book_id: i32,
    session_id: i32,
    institution: &str,
    item_id: &str,
    access_token: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let now = now_millis();
    let mut transaction = ledger_db::locks::begin_pool(&state.pool).await?;
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plaid_tokens WHERE book_id = $1 AND item_id = $2)",
    )
    .bind(book_id)
    .bind(item_id)
    .fetch_one(transaction.as_mut())
    .await?;
    if duplicate {
        return Ok(None);
    }
    let token_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_tokens
           (financial_institution, item_id, access_token, book_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5) RETURNING id",
    )
    .bind(institution)
    .bind(item_id)
    .bind(access_token)
    .bind(book_id)
    .bind(now)
    .fetch_one(transaction.as_mut())
    .await?;
    complete_claimed_session(transaction.as_mut(), session_id, token_id, now).await?;
    transaction.commit().await?;
    Ok(Some(token_id))
}

/// Makes a claimed session `complete`, inside the transaction that writes its
/// connection. When the session is no longer `completing`, it changes
/// nothing and logs it; `save_new_item` gives the reason.
async fn complete_claimed_session(
    connection: &mut DbConnection,
    session_id: i32,
    token_id: i32,
    now: NaiveDateTime,
) -> Result<(), sqlx::Error> {
    let completed = sqlx::query(
        "UPDATE plaid_link_sessions
         SET status = 'complete', result_token_id = $2, completed_at = $3, updated_at = $3
         WHERE id = $1 AND status = 'completing'",
    )
    .bind(session_id)
    .bind(token_id)
    .bind(now)
    .execute(connection)
    .await?
    .rows_affected();
    if completed == 0 {
        tracing::warn!(
            session_id,
            token_id,
            "A Plaid link session stopped during its completion. The connection is saved, and the session keeps its state"
        );
    }
    Ok(())
}

/// Update mode: Plaid keeps the access token, so the connection keeps its
/// ID, its account links and its history. The last sync error goes away,
/// and the account list gets the accounts that the user added. As for a new
/// Item, the connection changes also when the session is no longer
/// `completing`: the user signed in to the bank again, so the last error is
/// not true any more.
async fn complete_update(
    state: &AppState,
    book_id: i32,
    session_id: i32,
    token_id: i32,
) -> Result<(), ApiError> {
    const FAILURE: &str = "Failed to check the bank connection";
    let now = now_millis();
    let written: Result<Option<String>, sqlx::Error> = async {
        let mut transaction = ledger_db::locks::begin_pool(&state.pool).await?;
        let access_token: Option<String> = sqlx::query_scalar(
            "UPDATE plaid_tokens SET last_error = NULL, updated_at = $3
             WHERE id = $1 AND book_id = $2 RETURNING access_token",
        )
        .bind(token_id)
        .bind(book_id)
        .bind(now)
        .fetch_optional(transaction.as_mut())
        .await?;
        complete_claimed_session(transaction.as_mut(), session_id, token_id, now).await?;
        transaction.commit().await?;
        Ok(access_token)
    }
    .await;
    let access_token = match written {
        Ok(access_token) => access_token,
        Err(cause) => {
            release_claim(state, session_id).await;
            return Err(internal_error(cause, FAILURE));
        }
    };
    // The session cascades with its connection, so the row is there.
    if let Some(access_token) = access_token
        && let Err(message) = refresh_accounts(state, book_id, token_id, &access_token, false).await
    {
        tracing::error!(error = %message, session_id, "Plaid account load after a reconnect failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_names_only_token_id_and_restart() {
        let check = |body: Value| match validate_link_body(&body) {
            Ok(LinkBody { token_id, restart }) => format!("{token_id:?} {restart}"),
            Err(error) => format!("{error:?}"),
        };
        assert_eq!(check(json!({})), "None false");
        assert_eq!(check(json!({ "tokenId": null })), "None false");
        assert_eq!(
            check(json!({ "tokenId": 7, "bookId": 2 })),
            "Some(7.0) false"
        );
        assert_eq!(check(json!({ "restart": true })), "None true");
        assert_eq!(
            check(json!({ "tokenId": 7, "restart": false })),
            "Some(7.0) false"
        );
        assert!(check(json!([])).contains(BODY_NOT_OBJECT));
        for invalid in [json!(0), json!(-1), json!(1.5), json!("7"), json!(true)] {
            assert!(
                check(json!({ "tokenId": invalid })).contains(TOKEN_ID_INVALID),
                "{invalid}"
            );
        }
        for invalid in [json!(null), json!(1), json!("true"), json!({})] {
            assert!(
                check(json!({ "restart": invalid })).contains(RESTART_INVALID),
                "{invalid}"
            );
        }
    }
}

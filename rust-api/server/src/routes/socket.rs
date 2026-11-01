//! `GET /api/b/{bookId}/socket`: the book's change hints over a WebSocket.
//!
//! It authenticates as any book `GET` does, then sends the book's change hints
//! as JSON text messages: `{"type":"ready"}` first, then
//! `{"type":"change","tables":[...]}`. A WebSocket replaced the server-sent
//! events stream because a Durable Object can hibernate with one open.
//!
//! The socket checks its credential again when one is revoked in this process
//! ([`crate::revocations`]: a logout, a deleted API key, a password change), when the
//! book's members change, and every [`RECHECK`]. A credential that no longer
//! reads the book closes the socket with code 4000 + the HTTP status that a
//! request would get: 4401, 4403 or 4404.

use crate::{
    auth::cookie_token,
    book_auth::{AccessLevel, authenticate_book},
    book_changes::{BookChange, Subscription},
    error::error,
    platform,
    security::is_cross_origin,
    state::AppState,
};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{
            CloseFrame, Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection,
        },
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::time::Duration;
use tokio::{
    sync::watch,
    time::{Instant, MissedTickBehavior},
};

const FAILURE: &str = "Live updates unavailable";
const STARTUP: Duration = Duration::from_secs(10);
/// A ping keeps proxies from closing an idle socket.
const HEARTBEAT: Duration = Duration::from_secs(25);
/// The longest that an expired session keeps its socket.
const RECHECK: Duration = Duration::from_secs(5 * 60);
/// How long the close handshake may take.
const CLOSING: Duration = Duration::from_secs(5);
/// How long one send may wait on a client that does not read. A send waits
/// inside a `select!` branch, where shutdown, revocation and the recheck
/// are not polled, so a client that stops reading loses its socket.
const SENDING: Duration = Duration::from_secs(10);

pub(crate) async fn book_socket(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // Subscribe before the check: a revocation between the check and the
    // upgrade then still reaches the socket. A new receiver counts the
    // current value as seen.
    let revoked = state.revocations.subscribe();
    // A page of another site can open a WebSocket with the user's cookie: the
    // browser applies no same-origin rule to it. A bearer key is not sent by
    // a browser on its own.
    if cookie_token(&headers).is_some() && is_cross_origin(&uri, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Cross-origin request rejected" })),
        )
            .into_response();
    }
    // A failure to check (the database) is 503.
    let book_id =
        match authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await {
            Ok(book) => book.book_id(),
            Err(denied) if denied.status() == StatusCode::INTERNAL_SERVER_ERROR => {
                return error(StatusCode::SERVICE_UNAVAILABLE, FAILURE).into_response();
            }
            Err(denied) => return denied.into_response(),
        };
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let subscription = state.book_changes.subscribe(book_id);
    if platform::timeout(STARTUP, subscription.ready())
        .await
        .is_none()
    {
        tracing::error!("Error opening the book socket: book change listener unavailable");
        return error(StatusCode::SERVICE_UNAVAILABLE, FAILURE).into_response();
    }
    upgrade.on_upgrade(move |socket| async move {
        serve(socket, state, headers, raw_book_id, subscription, revoked).await;
    })
}

/// Why the socket ends.
enum End {
    /// The client closed it, or it broke.
    Gone,
    /// The server sends this close frame.
    Close(u16, String),
}

async fn serve(
    mut socket: WebSocket,
    state: AppState,
    headers: HeaderMap,
    raw_book_id: String,
    mut subscription: Subscription,
    mut revoked: watch::Receiver<u64>,
) {
    let mut closing = state.book_changes.closing();
    let mut heartbeat = tokio::time::interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut recheck = tokio::time::interval_at(Instant::now() + RECHECK, RECHECK);
    recheck.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // The hub took the book's change counts when the subscription became
    // ready. A member removed between the check in `book_socket` and then is
    // in those counts, not a hint, so check again before `ready`.
    let mut end = still_allowed(&state, &headers, &raw_book_id).await;
    if end.is_none() {
        let ready = json!({ "type": "ready" }).to_string();
        if !send(&mut socket, Message::text(ready)).await {
            end = Some(End::Gone);
        }
    }
    while end.is_none() {
        let mut check_again = false;
        tokio::select! {
            biased;
            // The guard that `wait_for` returns is not `Send`: drop it here.
            () = async { let _ = closing.wait_for(|closing| *closing).await; } => {
                end = Some(End::Close(1001, "The server is shutting down".to_owned()));
            }
            changed = revoked.changed() => {
                check_again = changed.is_ok();
            }
            change = subscription.receiver.recv() => match change {
                Some(change) => {
                    let BookChange::Change(tables) = &change;
                    check_again = tables.iter().any(|table| table == "book_members");
                    if !send(&mut socket, Message::text(message(&change))).await {
                        end = Some(End::Gone);
                    }
                }
                // The hub dropped a subscriber that fell behind. The client
                // connects again and reads everything afresh.
                None => end = Some(End::Close(1013, "Live updates fell behind".to_owned())),
            },
            _ = recheck.tick() => check_again = true,
            _ = heartbeat.tick() => {
                if !send(&mut socket, Message::Ping(Default::default())).await {
                    end = Some(End::Gone);
                }
            }
            received = socket.recv() => match received {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => end = Some(End::Gone),
                // The client sends nothing that the server reads.
                Some(Ok(_)) => {}
            },
        }
        if check_again && end.is_none() {
            end = still_allowed(&state, &headers, &raw_book_id).await;
        }
    }
    if let Some(End::Close(code, reason)) = end {
        let frame = CloseFrame {
            code,
            reason: reason.into(),
        };
        send(&mut socket, Message::Close(Some(frame))).await;
    }
    // Read until the socket ends. A read sends the reply that the library
    // queued to a client's close, and waits for the client's reply to ours.
    // Without it the client sees 1006, an abnormal close.
    let _ = platform::timeout(CLOSING, async {
        while let Some(Ok(_)) = socket.recv().await {}
    })
    .await;
}

/// Whether `message` went out within [`SENDING`].
async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        platform::timeout(SENDING, socket.send(message)).await,
        Some(Ok(()))
    )
}

/// `None` while the credential still reads the book. A failure to check
/// keeps the socket: the next check decides.
async fn still_allowed(state: &AppState, headers: &HeaderMap, raw_book_id: &str) -> Option<End> {
    match authenticate_book(state, headers, raw_book_id, AccessLevel::Read, FAILURE).await {
        Ok(_) => None,
        Err(denied) if denied.status() == StatusCode::INTERNAL_SERVER_ERROR => None,
        Err(denied) => Some(End::Close(
            4000 + denied.status().as_u16(),
            denied.message().to_owned(),
        )),
    }
}

/// The text message of a hint.
fn message(change: &BookChange) -> String {
    let BookChange::Change(tables) = change;
    json!({ "type": "change", "tables": tables }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hint_is_its_tables_with_its_type() {
        let change = BookChange::Change(vec!["transactions".into(), "payees".into()]);
        assert_eq!(
            message(&change),
            r#"{"type":"change","tables":["transactions","payees"]}"#
        );
    }
}

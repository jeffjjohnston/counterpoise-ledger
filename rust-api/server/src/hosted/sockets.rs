//! The book sockets of a Durable Object: `GET /api/b/{bookId}/socket` with
//! hibernation, in place of the native route (`routes/socket.rs`).
//!
//! The object accepts each socket with `ctx.acceptWebSocket()`, tagged
//! with [`book_tag`], and keeps the socket's [`Attachment`] with it, so that
//! a socket outlives the object's memory. The object holds no timer and
//! polls nothing, both of which would keep it awake. Instead it calls
//! [`App::socket_updates`] after each request and each alarm: the change
//! counts (`change_marks`) of the books that have a socket give the hints
//! of that event, and a credential is checked again when one was revoked,
//! before a hint goes out (a change to the book's members is one), and at
//! each alarm. A credential that no longer reads the book closes its socket
//! with 4000 + the HTTP status, as on the native server.

use super::App;
use crate::{
    auth::{bearer_token, cookie_token, principal_with, valid_key_shape},
    book_auth::{AccessLevel, authenticate_book},
    book_changes::{CHANGE_TABLES, read_counts},
    client_ip,
    error::error,
    security::is_cross_origin,
};
use axum::{
    Json,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const FAILURE: &str = "Live updates unavailable";

/// The first message of each socket.
pub const READY: &str = r#"{"type":"ready"}"#;

/// What the object keeps with a socket: the book, and the credential that
/// opened it, which each check uses again with the client's rate-limit key.
/// Only the session token is kept of the cookies, and only an API key of the
/// `Authorization` header (no other bearer reads a book on this route): the
/// runtime takes at most 16 KiB of attachment.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attachment {
    book_id: i32,
    session: Option<String>,
    api_key: Option<String>,
    client: Option<String>,
}

impl Attachment {
    /// The book that the socket listens to.
    pub fn book_id(&self) -> i32 {
        self.book_id
    }

    fn headers(&self) -> HeaderMap {
        let cookie = self.session.as_deref().map(|token| {
            format!(
                "counterpoise_session={}",
                utf8_percent_encode(token, NON_ALPHANUMERIC)
            )
        });
        let authorization = self.api_key.as_deref().map(|key| format!("Bearer {key}"));
        let mut headers = HeaderMap::new();
        for (name, value) in [
            (header::COOKIE, &cookie),
            (header::AUTHORIZATION, &authorization),
            (
                HeaderName::from_static(client_ip::CLIENT_IP_HEADER),
                &self.client,
            ),
        ] {
            if let Some(value) = value.as_deref().and_then(|value| value.parse().ok()) {
                headers.insert(name, value);
            }
        }
        headers
    }
}

/// Why a request is not a WebSocket upgrade, in the words of axum's
/// rejection on the native route. The runtime checks the rest of the
/// handshake.
fn not_an_upgrade(headers: &HeaderMap) -> Option<&'static str> {
    let has = |name, token: &str| {
        headers.get_all(name).iter().any(|value| {
            value.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .any(|part| part.trim().eq_ignore_ascii_case(token))
            })
        })
    };
    if has(header::UPGRADE, "websocket") {
        None
    } else if has(header::CONNECTION, "upgrade") {
        Some("`Upgrade` header did not include 'websocket'")
    } else {
        Some("Connection header did not include 'upgrade'")
    }
}

/// The tag of the sockets of a book.
pub fn book_tag(book_id: i32) -> String {
    format!("book:{book_id}")
}

/// What the object does with one socket after an event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Update {
    /// Send this text message.
    Send(String),
    /// Close with this code and reason.
    Close(u16, String),
}

/// What the sockets of this object have seen: the change counts of each
/// book with a socket, and the revocations. The object's memory holds it,
/// so a wake starts it again ([`App::watch_books`]).
#[derive(Clone, Default)]
pub(super) struct Seen(Arc<Mutex<SeenState>>);

#[derive(Default)]
struct SeenState {
    counts: HashMap<i32, HashMap<String, i64>>,
    revocations: u64,
}

impl Seen {
    fn lock(&self) -> std::sync::MutexGuard<'_, SeenState> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl App {
    /// Checks a socket request as the native route does: a cookie from
    /// another site is refused, and the credential must read the book. The
    /// attachment of the socket to accept, or the response that refuses it.
    pub async fn admit_socket(
        &self,
        uri: &Uri,
        headers: &HeaderMap,
        raw_book_id: &str,
    ) -> Result<Attachment, Box<Response>> {
        // The route does not pass through the router, so this does what
        // `client_ip::record` does for each request on this target: the
        // client is `CF-Connecting-IP`, and no proxy header is trusted.
        let mut headers = headers.clone();
        let peer = headers
            .get("cf-connecting-ip")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse().ok());
        client_ip::rewrite(false, &mut headers, peer);
        if cookie_token(&headers).is_some() && is_cross_origin(uri, &headers) {
            return Err(Box::new(
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "Cross-origin request rejected" })),
                )
                    .into_response(),
            ));
        }
        let state = &self.state;
        let book_id =
            match authenticate_book(state, &headers, raw_book_id, AccessLevel::Read, FAILURE).await
            {
                Ok(book) => book.book_id(),
                Err(denied) if denied.status() == StatusCode::INTERNAL_SERVER_ERROR => {
                    return Err(Box::new(
                        error(StatusCode::SERVICE_UNAVAILABLE, FAILURE).into_response(),
                    ));
                }
                Err(denied) => return Err(Box::new(denied.into_response())),
            };
        if let Some(missing) = not_an_upgrade(&headers) {
            return Err(Box::new((StatusCode::BAD_REQUEST, missing).into_response()));
        }
        // A change after this point is a hint for the new socket.
        self.watch_books(&[book_id]);
        let text = |name| {
            headers
                .get(name)
                .and_then(|value: &HeaderValue| value.to_str().ok())
                .map(str::to_owned)
        };
        // The session is kept only when it signs a user in: a request that
        // reads the book with its API key can carry a stale cookie of any
        // length.
        let mut session = cookie_token(&headers);
        if let Some(token) = &session {
            let only = Attachment {
                book_id,
                session: Some(token.clone()),
                api_key: None,
                client: None,
            };
            if !matches!(
                principal_with(state, &only.headers(), false).await,
                Ok(Some(_))
            ) {
                session = None;
            }
        }
        Ok(Attachment {
            book_id,
            session,
            api_key: bearer_token(&headers)
                .filter(|key| valid_key_shape(key))
                .map(str::to_owned),
            client: text(HeaderName::from_static(client_ip::CLIENT_IP_HEADER)),
        })
    }

    /// Reads the change counts of the books in `books` that this memory has
    /// none of. The object calls it before each event, so that a change in
    /// the first event after a wake is a hint.
    pub fn watch_books(&self, books: &[i32]) {
        let missing: Vec<i32> = {
            let seen = self.seen.lock();
            let mut missing: Vec<i32> = books
                .iter()
                .copied()
                .filter(|book| !seen.counts.contains_key(book))
                .collect();
            missing.sort_unstable();
            missing.dedup();
            missing
        };
        if missing.is_empty() {
            return;
        }
        match read_counts(&self.state.database, &missing) {
            Ok(mut counts) => {
                let mut seen = self.seen.lock();
                for book in missing {
                    let counts = counts.remove(&book).unwrap_or_default();
                    seen.counts.entry(book).or_insert(counts);
                }
            }
            Err(cause) => tracing::warn!(error = %cause, "Book change counts unreadable"),
        }
    }

    /// What to do with each of `sockets` after an event: the hints of the
    /// writes since the last call, and the close of a socket whose
    /// credential no longer reads its book. `check_all` checks every
    /// credential, as the alarm does, so that an expired session loses its
    /// socket. The result holds the index of each socket that has an update.
    pub async fn socket_updates(
        &self,
        sockets: &[Attachment],
        check_all: bool,
    ) -> Vec<(usize, Update)> {
        let mut books: Vec<i32> = sockets.iter().map(Attachment::book_id).collect();
        books.sort_unstable();
        books.dedup();
        let changed = self.changed_tables(&books);
        let revoked = {
            let count = self.state.revocations.count();
            let mut seen = self.seen.lock();
            let revoked = seen.revocations != count;
            seen.revocations = count;
            revoked
        };
        let mut updates = Vec::new();
        for (index, socket) in sockets.iter().enumerate() {
            let tables = changed.get(&socket.book_id);
            // A change to the book's members is a hint, so it is checked.
            if (check_all || revoked || tables.is_some())
                && let Some(close) = self.still_allowed(socket).await
            {
                updates.push((index, close));
                continue;
            }
            if let Some(tables) = tables {
                let message = json!({ "type": "change", "tables": tables }).to_string();
                updates.push((index, Update::Send(message)));
            }
        }
        // A book with no socket left is not read again.
        self.seen
            .lock()
            .counts
            .retain(|book, _| books.binary_search(book).is_ok());
        updates
    }

    /// The tables of each of `books` whose counts moved since the last read,
    /// in the order of [`CHANGE_TABLES`]. A book read for the first time has
    /// none.
    fn changed_tables(&self, books: &[i32]) -> HashMap<i32, Vec<String>> {
        if books.is_empty() {
            return HashMap::new();
        }
        let counts = match read_counts(&self.state.database, books) {
            Ok(counts) => counts,
            Err(cause) => {
                tracing::warn!(error = %cause, "Book change counts unreadable");
                return HashMap::new();
            }
        };
        let mut seen = self.seen.lock();
        let mut changed = HashMap::new();
        for &book in books {
            let now = counts.get(&book).cloned().unwrap_or_default();
            if let Some(before) = seen.counts.get(&book) {
                let tables: Vec<String> = CHANGE_TABLES
                    .iter()
                    .filter(|table| {
                        now.get(**table)
                            .is_some_and(|count| before.get(**table) != Some(count))
                    })
                    .map(|table| (*table).to_owned())
                    .collect();
                if !tables.is_empty() {
                    changed.insert(book, tables);
                }
            }
            seen.counts.insert(book, now);
        }
        changed
    }

    /// `None` while the socket's credential still reads its book. A failure
    /// to check keeps the socket: the next check decides.
    async fn still_allowed(&self, socket: &Attachment) -> Option<Update> {
        let headers = socket.headers();
        // The parsed id, not the path: a book id is read by its leading
        // digits, so the path can carry a suffix of any length.
        match authenticate_book(
            &self.state,
            &headers,
            &socket.book_id.to_string(),
            AccessLevel::Read,
            FAILURE,
        )
        .await
        {
            Ok(_) => None,
            Err(denied) if denied.status() == StatusCode::INTERNAL_SERVER_ERROR => None,
            Err(denied) => Some(Update::Close(
                4000 + denied.status().as_u16(),
                denied.message().to_owned(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{App, Attachment, Seen, Update, book_tag};
    use crate::{auth::token_hash, state::AppState};
    use axum::{
        body::to_bytes,
        http::{HeaderMap, StatusCode, Uri},
        response::Response,
    };
    use ledger_db::{Sql, params};

    const NOW: &str = "2026-10-21 00:00:00";

    /// An app on a database with an owner (user 1, session `owner`), a
    /// viewer (user 2, session `viewer`) and book 7.
    fn app() -> App {
        let state = AppState::in_memory();
        state
            .database
            .exec_batch(&format!(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES
                   (1, 'owner', 'unused', '{NOW}'), (2, 'viewer', 'unused', '{NOW}');
                 INSERT INTO books (id, user_id, name, created_at, updated_at)
                   VALUES (7, 1, 'Shared', '{NOW}', '{NOW}');
                 INSERT INTO book_members (book_id, user_id, role, created_at)
                   VALUES (7, 2, 'viewer', '{NOW}');"
            ))
            .unwrap();
        for (token, user_id) in [("owner", 1), ("viewer", 2)] {
            session(&state, token, user_id, chrono::Duration::hours(1));
        }
        again(&state)
    }

    /// Another app on the same state with nothing seen: the object after a
    /// wake.
    fn again(state: &AppState) -> App {
        App {
            router: axum::Router::new(),
            state: state.clone(),
            seen: Seen::default(),
        }
    }

    fn session(state: &AppState, token: &str, user_id: i32, life: chrono::Duration) {
        state
            .database
            .execute(
                "INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                &params![
                    token_hash(token),
                    user_id,
                    (chrono::Utc::now() + life).naive_utc(),
                    NOW
                ],
            )
            .unwrap();
    }

    /// An API key of the viewer.
    fn key(app: &App) -> String {
        let key = format!("cpk_{}", "b".repeat(48));
        let salt = "socket-test-salt";
        let mut derived = [0_u8; 32];
        scrypt::scrypt(
            key.as_bytes(),
            salt.as_bytes(),
            &scrypt::Params::new(14, 8, 1, 32).unwrap(),
            &mut derived,
        )
        .unwrap();
        app.state
            .database
            .execute(
                "INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at)
                 VALUES (2, 'socket', ?1, ?2, ?3)",
                &params![format!("{salt}:{}", hex::encode(derived)), &key[..8], NOW],
            )
            .unwrap();
        key
    }

    fn upgrade(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            format!("counterpoise_session={token}").parse().unwrap(),
        );
        headers.insert("connection", "Upgrade".parse().unwrap());
        headers.insert("upgrade", "websocket".parse().unwrap());
        headers
    }

    async fn admit(
        app: &App,
        headers: &HeaderMap,
        book: &str,
    ) -> Result<Attachment, Box<Response>> {
        let uri: Uri = format!("http://localhost/api/b/{book}/socket")
            .parse()
            .unwrap();
        app.admit_socket(&uri, headers, book).await
    }

    async fn refusal(response: Box<Response>) -> (StatusCode, String) {
        let status = response.status();
        let body = to_bytes((*response).into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    fn add_payee(app: &App, name: &str) {
        app.state
            .database
            .execute(
                "INSERT INTO payees (book_id, name, created_at) VALUES (7, ?1, ?2)",
                &params![name, NOW],
            )
            .unwrap();
    }

    fn change(tables: &[&str]) -> Update {
        Update::Send(serde_json::json!({ "type": "change", "tables": tables }).to_string())
    }

    #[tokio::test]
    async fn a_socket_is_admitted_as_the_native_route_admits_it() {
        let app = app();
        let socket = admit(&app, &upgrade("viewer"), "7").await.unwrap();
        assert_eq!(socket.book_id(), 7);
        assert_eq!(book_tag(socket.book_id()), "book:7");
        // The attachment round-trips, as the runtime stores it.
        let stored = serde_json::to_string(&socket).unwrap();
        assert_eq!(serde_json::from_str::<Attachment>(&stored).unwrap(), socket);

        for (headers, book, status, body) in [
            (upgrade("viewer"), "8", 404, r#"{"error":"Book not found"}"#),
            (
                upgrade("viewer"),
                "x",
                400,
                r#"{"error":"Invalid book ID"}"#,
            ),
            (
                upgrade("gone"),
                "7",
                401,
                r#"{"error":"Not authenticated"}"#,
            ),
        ] {
            let denied = admit(&app, &headers, book).await.unwrap_err();
            assert_eq!(
                refusal(denied).await,
                (StatusCode::from_u16(status).unwrap(), body.into())
            );
        }
        let mut plain = upgrade("viewer");
        plain.remove("upgrade");
        plain.remove("connection");
        let denied = admit(&app, &plain, "7").await.unwrap_err();
        assert_eq!(
            refusal(denied).await,
            (
                StatusCode::BAD_REQUEST,
                "Connection header did not include 'upgrade'".into()
            )
        );
        let mut cross = upgrade("viewer");
        cross.insert("sec-fetch-site", "cross-site".parse().unwrap());
        let denied = admit(&app, &cross, "7").await.unwrap_err();
        assert_eq!(
            refusal(denied).await,
            (
                StatusCode::FORBIDDEN,
                r#"{"error":"Cross-origin request rejected"}"#.into()
            )
        );
    }

    #[tokio::test]
    async fn the_attachment_keeps_the_session_and_the_client_the_worker_saw() {
        let app = app();
        let mut headers = upgrade("viewer");
        // Other cookies of the host, and a client key that a caller sent.
        let cookie = format!(
            "other={}; counterpoise_session=viewer; more=1",
            "x".repeat(20_000)
        );
        headers.insert("cookie", cookie.parse().unwrap());
        headers.insert("x-counterpoise-client-ip", "198.51.100.9".parse().unwrap());
        headers.insert("cf-connecting-ip", "203.0.113.7".parse().unwrap());
        // A bearer that is not an API key, beside the session that admits.
        let bearer = format!("Bearer {}", "y".repeat(20_000));
        headers.insert("authorization", bearer.parse().unwrap());
        let socket = admit(&app, &headers, "7").await.unwrap();
        assert_eq!(socket.api_key, None);
        assert_eq!(socket.session.as_deref(), Some("viewer"));
        assert_eq!(socket.client.as_deref(), Some("203.0.113.7"));
        assert!(serde_json::to_string(&socket).unwrap().len() < 1024);
        let again = socket.headers();
        assert_eq!(again["cookie"], "counterpoise_session=viewer");
        assert_eq!(again["x-counterpoise-client-ip"], "203.0.113.7");
        assert_eq!(app.still_allowed(&socket).await, None);

        // A book id is read by its leading digits; the rest of a long path
        // is not kept.
        let long = format!("7{}", "z".repeat(20_000));
        let socket = admit(&app, &headers, &long).await.unwrap();
        assert_eq!(socket.book_id(), 7);
        assert!(serde_json::to_string(&socket).unwrap().len() < 1024);
        assert_eq!(app.still_allowed(&socket).await, None);

        // A session that signs no one in is not kept beside the key that
        // read the book.
        let mut keyed = upgrade("viewer");
        keyed.remove("cookie");
        keyed.insert(
            "authorization",
            format!("Bearer {}", key(&app)).parse().unwrap(),
        );
        keyed.insert(
            "cookie",
            format!("counterpoise_session={}", "s".repeat(20_000))
                .parse()
                .unwrap(),
        );
        let socket = admit(&app, &keyed, "7").await.unwrap();
        assert_eq!(socket.session, None);
        assert!(socket.api_key.is_some());
        assert!(serde_json::to_string(&socket).unwrap().len() < 1024);
        assert_eq!(app.still_allowed(&socket).await, None);

        // No `CF-Connecting-IP`: no key, rather than the caller's.
        headers.remove("cf-connecting-ip");
        let socket = admit(&app, &headers, "7").await.unwrap();
        assert_eq!(socket.client, None);
    }

    #[tokio::test]
    async fn a_write_is_a_hint_for_the_sockets_of_its_book_after_a_wake_too() {
        let app = app();
        let sockets = [admit(&app, &upgrade("viewer"), "7").await.unwrap()];
        assert_eq!(app.socket_updates(&sockets, false).await, []);
        add_payee(&app, "Grocer");
        assert_eq!(
            app.socket_updates(&sockets, false).await,
            [(0, change(&["payees"]))]
        );
        assert_eq!(app.socket_updates(&sockets, false).await, []);

        // The object wakes with nothing in memory: the counts before the
        // event are read first.
        let woken = again(&app.state);
        woken.watch_books(&[7]);
        add_payee(&woken, "Baker");
        assert_eq!(
            woken.socket_updates(&sockets, false).await,
            [(0, change(&["payees"]))]
        );
    }

    #[tokio::test]
    async fn a_revoked_credential_closes_its_socket_and_no_other() {
        let app = app();
        let sockets = [
            admit(&app, &upgrade("viewer"), "7").await.unwrap(),
            admit(&app, &upgrade("owner"), "7").await.unwrap(),
        ];
        app.state
            .database
            .execute(
                "DELETE FROM sessions WHERE token_hash = ?1",
                &params![token_hash("viewer")],
            )
            .unwrap();
        app.state.revocations.notify();
        assert_eq!(
            app.socket_updates(&sockets, false).await,
            [(0, Update::Close(4401, "Not authenticated".into()))]
        );
    }

    #[tokio::test]
    async fn a_member_who_leaves_the_book_loses_the_socket_and_the_hint() {
        let app = app();
        let sockets = [
            admit(&app, &upgrade("viewer"), "7").await.unwrap(),
            admit(&app, &upgrade("owner"), "7").await.unwrap(),
        ];
        app.state
            .database
            .execute("DELETE FROM book_members WHERE user_id = 2", &[])
            .unwrap();
        assert_eq!(
            app.socket_updates(&sockets, false).await,
            [
                (0, Update::Close(4404, "Book not found".into())),
                (1, change(&["book_members"])),
            ]
        );
    }

    #[tokio::test]
    async fn an_expired_session_loses_its_socket_at_the_alarm() {
        let app = app();
        let sockets = [admit(&app, &upgrade("viewer"), "7").await.unwrap()];
        session(&app.state, "viewer", 2, chrono::Duration::hours(-1));
        // No event names it: only the check of every socket finds it.
        assert_eq!(app.socket_updates(&sockets, false).await, []);
        assert_eq!(
            app.socket_updates(&sockets, true).await,
            [(0, Update::Close(4401, "Not authenticated".into()))]
        );
    }
}

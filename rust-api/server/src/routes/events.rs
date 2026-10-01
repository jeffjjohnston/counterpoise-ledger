//! `GET /api/b/{bookId}/events`: invalidation hints as server-sent events.

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    book_changes::{BookChange, Subscription},
    error::error,
    state::AppState,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::stream::{self, Stream};
use std::{convert::Infallible, time::Duration};
use tokio::{
    sync::watch,
    time::{Instant, Interval, MissedTickBehavior, Sleep},
};

const FAILURE: &str = "Live updates unavailable";
const STARTUP: Duration = Duration::from_secs(10);
const HEARTBEAT: Duration = Duration::from_secs(25);
/// Authorization is checked again by the next request, at most five minutes
/// after a revocation. The browser also closes its stream on logout.
const LIFETIME: Duration = Duration::from_secs(5 * 60);

pub(crate) async fn book_events(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let book =
        match authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await {
            Ok(book) => book,
            // The Node route answers every thrown error with 503.
            Err(denied) if denied.status() == StatusCode::INTERNAL_SERVER_ERROR => {
                return error(StatusCode::SERVICE_UNAVAILABLE, FAILURE).into_response();
            }
            Err(denied) => return denied.into_response(),
        };
    let subscription = state.book_changes.subscribe(book.book_id);
    if tokio::time::timeout(STARTUP, subscription.ready())
        .await
        .is_err()
    {
        tracing::error!("Error opening book events: book change listener unavailable");
        return error(StatusCode::SERVICE_UNAVAILABLE, FAILURE).into_response();
    }
    let mut response =
        Body::from_stream(frames(subscription, state.book_changes.closing())).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, no-transform"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

struct Frames {
    subscription: Subscription,
    closing: watch::Receiver<bool>,
    heartbeat: Interval,
    lifetime: std::pin::Pin<Box<Sleep>>,
    ready_sent: bool,
}

/// `ready` first, then hints and heartbeats until the lifetime ends, the hub
/// drops a stalled subscriber, or the server shuts down. Dropping the stream
/// (the client went away) drops the subscription.
fn frames(
    subscription: Subscription,
    closing: watch::Receiver<bool>,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let mut heartbeat = tokio::time::interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let state = Frames {
        subscription,
        closing,
        heartbeat,
        lifetime: Box::pin(tokio::time::sleep(LIFETIME)),
        ready_sent: false,
    };
    stream::unfold(state, |mut state| async move {
        if !state.ready_sent {
            state.ready_sent = true;
            return Some((Ok(Bytes::from_static(b"event: ready\ndata: {}\n\n")), state));
        }
        let frame = tokio::select! {
            biased;
            _ = state.closing.wait_for(|closing| *closing) => return None,
            () = &mut state.lifetime => return None,
            change = state.subscription.receiver.recv() => change.as_ref().map(BookChange::frame)?,
            _ = state.heartbeat.tick() => ": heartbeat\n\n".to_owned(),
        };
        Some((Ok(Bytes::from(frame)), state))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book_changes::BookChangeHub;
    use futures_util::StreamExt;

    fn hub() -> BookChangeHub {
        BookChangeHub::detached()
    }

    async fn next(
        stream: &mut (impl Stream<Item = Result<Bytes, Infallible>> + Unpin),
    ) -> Option<String> {
        let bytes = stream.next().await?.unwrap();
        Some(String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_then_close_at_the_lifetime() {
        let hub = hub();
        let mut stream = Box::pin(frames(hub.subscribe(1), hub.closing()));
        assert_eq!(
            next(&mut stream).await.unwrap(),
            "event: ready\ndata: {}\n\n"
        );
        let started = Instant::now();
        assert_eq!(next(&mut stream).await.unwrap(), ": heartbeat\n\n");
        assert_eq!(started.elapsed(), HEARTBEAT);
        let mut heartbeats = 1;
        while next(&mut stream).await.is_some() {
            heartbeats += 1;
        }
        assert_eq!(started.elapsed(), LIFETIME);
        assert_eq!(heartbeats, 11);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_ends_open_streams() {
        let hub = hub();
        let mut stream = Box::pin(frames(hub.subscribe(1), hub.closing()));
        next(&mut stream).await;
        hub.close();
        assert_eq!(next(&mut stream).await, None);
    }
}

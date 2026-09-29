//! Live-update hints for `GET /api/b/{bookId}/events`, as in
//! `lib/book-change-hub.ts`. One hub serves the process. It opens no
//! connection until the first subscription, and it then keeps one LISTEN
//! connection for the life of the process.

use serde_json::{Value, json};
use sqlx::{
    Executor, PgPool,
    postgres::{PgConnectOptions, PgListener, PgPoolOptions},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, Once, Weak},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

const CHANNEL: &str = "counterpoise_changes";

/// The tables whose triggers send a hint (migrations 0023 and 0024).
const CHANGE_TABLES: [&str; 14] = [
    "transactions",
    "transaction_splits",
    "investment_splits",
    "investment_lots",
    "books",
    "book_members",
    "accounts",
    "payees",
    "securities",
    "security_prices",
    "recurring_rules",
    "recurring_template_splits",
    "plaid_accounts",
    "plaid_transaction_reconciliation",
];

/// Fixed windows, not a trailing debounce that a continuous import can
/// postpone without end. Updates arrive at a bounded rate.
const WINDOW: Duration = Duration::from_millis(250);

/// The frames that one subscriber can hold before the hub drops it. This is
/// the `highWaterMark` of the Node stream. Invalidation has no replay
/// requirement: the stalled reader reconnects and gets `ready`.
const QUEUE: usize = 8;

const RETRY_MIN: Duration = Duration::from_millis(250);
const RETRY_MAX: Duration = Duration::from_secs(10);

/// The liveness probe of the LISTEN connection. SQLx sets no TCP keepalive,
/// so a connection that a network device drops without a FIN or RST looks
/// idle, not lost. After `idle` with no message, the hub sends `SELECT 1` on
/// the connection. If no answer comes in `timeout`, it replaces the
/// connection and sends `reset`. postgres.js sends a keepalive every 60
/// seconds, so Node finds the loss in about the same time.
#[derive(Clone, Copy)]
struct Probe {
    idle: Duration,
    timeout: Duration,
}

const PROBE: Probe = Probe {
    idle: Duration::from_secs(60),
    timeout: Duration::from_secs(10),
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BookChange {
    Change(Vec<String>),
    Reset,
}

impl BookChange {
    /// The SSE frame, byte for byte as the Node route writes it.
    pub(crate) fn frame(&self) -> String {
        let (event, tables): (&str, &[String]) = match self {
            Self::Change(tables) => ("change", tables),
            Self::Reset => ("reset", &[]),
        };
        format!("event: {event}\ndata: {}\n\n", json!({ "tables": tables }))
    }
}

#[derive(Default)]
struct Book {
    subscribers: HashMap<u64, mpsc::Sender<BookChange>>,
    window: Option<Window>,
}

struct Window {
    id: u64,
    tables: Vec<String>,
    timer: JoinHandle<()>,
}

#[derive(Default)]
struct Books {
    books: HashMap<i32, Book>,
    next_id: u64,
}

struct Inner {
    books: Mutex<Books>,
    pool: PgPool,
    probe: Probe,
    start: Once,
    listening: watch::Sender<bool>,
    closing: watch::Sender<bool>,
}

#[derive(Clone)]
pub(crate) struct BookChangeHub {
    inner: Arc<Inner>,
}

pub(crate) struct Subscription {
    inner: Arc<Inner>,
    book_id: i32,
    id: u64,
    pub(crate) receiver: mpsc::Receiver<BookChange>,
}

impl Subscription {
    /// Resolves while the hub has a live LISTEN. A subscriber that starts
    /// during a reconnect waits for it, so it cannot miss a hint.
    pub(crate) async fn ready(&self) {
        let mut listening = self.inner.listening.subscribe();
        let _ = listening.wait_for(|listening| *listening).await;
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut books = lock(&self.inner.books);
        let Some(book) = books.books.get_mut(&self.book_id) else {
            return;
        };
        book.subscribers.remove(&self.id);
        if book.subscribers.is_empty() {
            remove_book(&mut books, self.book_id);
        }
    }
}

impl BookChangeHub {
    pub(crate) fn new(pool: PgPool) -> Self {
        Self::with_probe(pool, PROBE)
    }

    fn with_probe(pool: PgPool, probe: Probe) -> Self {
        Self {
            inner: Arc::new(Inner {
                books: Mutex::default(),
                pool,
                probe,
                start: Once::new(),
                listening: watch::Sender::new(false),
                closing: watch::Sender::new(false),
            }),
        }
    }

    pub(crate) fn subscribe(&self, book_id: i32) -> Subscription {
        self.inner.start.call_once(|| {
            tokio::spawn(listen(
                Arc::downgrade(&self.inner),
                self.inner.pool.connect_options().as_ref().clone(),
                self.inner.probe,
            ));
        });
        let (sender, receiver) = mpsc::channel(QUEUE);
        let mut books = lock(&self.inner.books);
        let id = books.next_id;
        books.next_id += 1;
        books
            .books
            .entry(book_id)
            .or_default()
            .subscribers
            .insert(id, sender);
        Subscription {
            inner: self.inner.clone(),
            book_id,
            id,
            receiver,
        }
    }

    /// Ends every open stream, so that a graceful shutdown does not wait for
    /// the five-minute stream lifetime.
    pub(crate) fn close(&self) {
        self.inner.closing.send_replace(true);
    }

    pub(crate) fn closing(&self) -> watch::Receiver<bool> {
        self.inner.closing.subscribe()
    }

    /// A hub that the test drives by hand, with no LISTEN connection.
    #[cfg(test)]
    pub(crate) fn without_listener(self) -> Self {
        self.inner.start.call_once(|| {});
        self
    }
}

impl Inner {
    fn notify(self: &Arc<Self>, payload: &str) {
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        // A positive safe integer, as in Node. A book ID beyond int4 cannot
        // have a subscriber.
        let Some(book_id) = value
            .get("bookId")
            .and_then(Value::as_i64)
            .filter(|id| *id > 0)
            .and_then(|id| i32::try_from(id).ok())
        else {
            return;
        };
        let Some(table) = value
            .get("table")
            .and_then(Value::as_str)
            .filter(|table| CHANGE_TABLES.contains(table))
        else {
            return;
        };
        let mut books = lock(&self.books);
        let next_id = books.next_id;
        let Some(book) = books.books.get_mut(&book_id) else {
            return;
        };
        if let Some(window) = &mut book.window {
            if !window.tables.iter().any(|seen| seen == table) {
                window.tables.push(table.to_owned());
            }
            return;
        }
        let inner = Arc::downgrade(self);
        book.window = Some(Window {
            id: next_id,
            tables: vec![table.to_owned()],
            timer: tokio::spawn(async move {
                tokio::time::sleep(WINDOW).await;
                if let Some(inner) = inner.upgrade() {
                    inner.flush(book_id, next_id);
                }
            }),
        });
        books.next_id += 1;
    }

    fn flush(&self, book_id: i32, window_id: u64) {
        let mut books = lock(&self.books);
        let Some(book) = books.books.get_mut(&book_id) else {
            return;
        };
        // A reset can clear this window, and a new one can open, while this
        // timer waits for the lock.
        if book
            .window
            .as_ref()
            .is_none_or(|window| window.id != window_id)
        {
            return;
        }
        let tables = book.window.take().map(|window| window.tables);
        emit(
            &mut books,
            book_id,
            BookChange::Change(tables.unwrap_or_default()),
        );
    }

    /// After a reconnect, hints committed during the gap are lost. Tell every
    /// subscriber to fetch again.
    fn reset(&self) {
        let mut books = lock(&self.books);
        let ids: Vec<i32> = books.books.keys().copied().collect();
        for book_id in ids {
            if let Some(window) = books
                .books
                .get_mut(&book_id)
                .and_then(|book| book.window.take())
            {
                window.timer.abort();
            }
            emit(&mut books, book_id, BookChange::Reset);
        }
    }
}

fn lock(books: &Mutex<Books>) -> MutexGuard<'_, Books> {
    // No code under this lock can leave the map half changed.
    books
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remove_book(books: &mut Books, book_id: i32) {
    if let Some(window) = books.books.remove(&book_id).and_then(|book| book.window) {
        window.timer.abort();
    }
}

/// A subscriber whose queue is full, or whose stream has ended, is dropped.
/// Dropping its sender ends its stream after the frames already queued.
fn emit(books: &mut Books, book_id: i32, change: BookChange) {
    let Some(book) = books.books.get_mut(&book_id) else {
        return;
    };
    book.subscribers
        .retain(|_, sender| sender.try_send(change.clone()).is_ok());
    if book.subscribers.is_empty() {
        remove_book(books, book_id);
    }
}

/// Holds one LISTEN connection and replaces it when it fails or does not
/// answer the probe. The connection never takes a slot from the request pool.
async fn listen(inner: Weak<Inner>, options: PgConnectOptions, probe: Probe) {
    let mut retry = RETRY_MIN;
    let mut connected_before = false;
    loop {
        match connect(&options).await {
            Ok(mut listener) => {
                retry = RETRY_MIN;
                let Some(hub) = inner.upgrade() else { return };
                hub.listening.send_replace(true);
                if connected_before {
                    hub.reset();
                }
                drop(hub);
                connected_before = true;
                loop {
                    // `try_recv` is cancel-safe: SQLx takes a message from its
                    // buffer only when the whole message has arrived.
                    let received = match tokio::time::timeout(probe.idle, listener.try_recv()).await
                    {
                        Ok(received) => received,
                        Err(_) => match check(&mut listener, probe.timeout).await {
                            Ok(()) => continue,
                            Err(cause) => {
                                tracing::warn!(error = %cause, "Book change listener did not answer");
                                break;
                            }
                        },
                    };
                    match received {
                        Ok(Some(notification)) => match inner.upgrade() {
                            Some(hub) => hub.notify(notification.payload()),
                            None => return,
                        },
                        Ok(None) => {
                            tracing::warn!("Book change listener lost its connection");
                            break;
                        }
                        Err(cause) => {
                            tracing::warn!(error = %cause, "Book change listener failed");
                            break;
                        }
                    }
                }
                let Some(hub) = inner.upgrade() else { return };
                hub.listening.send_replace(false);
            }
            Err(cause) => {
                tracing::error!(error = %cause, "Book change listener could not connect");
                retry = (retry * 2).min(RETRY_MAX);
            }
        }
        tokio::time::sleep(retry).await;
    }
}

/// Sends `SELECT 1` on the LISTEN connection. A notification that arrives
/// during the query stays in the listener's buffer for the next `try_recv`.
async fn check(listener: &mut PgListener, limit: Duration) -> Result<(), String> {
    match tokio::time::timeout(limit, listener.execute("SELECT 1")).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(cause)) => Err(cause.to_string()),
        Err(_) => Err(format!("no answer to the probe in {limit:?}")),
    }
}

/// Each listener has its own one-connection pool. A dropped listener runs
/// `UNLISTEN *` on its connection before it gives the connection back. On a
/// connection that a network device dropped, that waits until TCP gives up,
/// and a shared slot would hold back the next connection for as long.
async fn connect(options: &PgConnectOptions) -> Result<PgListener, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .max_lifetime(None)
        .idle_timeout(None)
        .connect_lazy_with(options.clone());
    let mut listener = PgListener::connect_with(&pool).await?;
    // This loop replaces a lost connection itself and then sends reset.
    listener.eager_reconnect(false);
    listener.listen(CHANNEL).await?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::net::{TcpListener, TcpStream};

    /// A TCP proxy to PostgreSQL. `silence()` stops every connection open
    /// now: the proxy keeps both sockets open and forwards nothing, as a
    /// network device that drops a connection without a FIN or RST.
    async fn silent_proxy(target: String) -> (u16, impl Fn()) {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = proxy.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicU64::new(0));
        let (cutoff, _) = watch::channel(0_u64);
        let silence = {
            let accepted = accepted.clone();
            let cutoff = cutoff.clone();
            move || {
                cutoff.send_replace(accepted.load(Ordering::SeqCst));
            }
        };
        tokio::spawn(async move {
            loop {
                let (mut client, _) = proxy.accept().await.unwrap();
                let index = accepted.fetch_add(1, Ordering::SeqCst);
                let mut server = TcpStream::connect(&target).await.unwrap();
                let mut cutoff = cutoff.subscribe();
                tokio::spawn(async move {
                    tokio::select! {
                        _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                        _ = async { cutoff.wait_for(|cutoff| index < *cutoff).await.is_ok() } => {
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
        });
        (port, silence)
    }

    async fn next_change(subscription: &mut Subscription) -> BookChange {
        tokio::time::timeout(Duration::from_secs(10), subscription.receiver.recv())
            .await
            .expect("a frame within 10 seconds")
            .expect("an open stream")
    }

    #[tokio::test]
    async fn a_connection_that_stops_answering_is_replaced_and_resets() {
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let direct: PgConnectOptions = url.parse().unwrap();
        let target = format!("{}:{}", direct.get_host(), direct.get_port());
        let (port, silence) = silent_proxy(target).await;
        let pool =
            PgPoolOptions::new().connect_lazy_with(direct.clone().host("127.0.0.1").port(port));
        let probe = Probe {
            idle: Duration::from_millis(200),
            timeout: Duration::from_millis(200),
        };
        let hub = BookChangeHub::with_probe(pool, probe);
        // No other test sends hints for this book.
        const BOOK: i32 = 987_654;
        let mut subscription = hub.subscribe(BOOK);
        tokio::time::timeout(Duration::from_secs(10), subscription.ready())
            .await
            .unwrap();
        let notifier = PgPoolOptions::new().connect_lazy_with(direct);
        let hint = format!(r#"{{"bookId":{BOOK},"table":"payees"}}"#);
        let notify = || {
            sqlx::query("SELECT pg_notify($1, $2)")
                .bind(CHANNEL)
                .bind(&hint)
                .execute(&notifier)
        };

        // Probes that the connection answers change nothing.
        tokio::time::sleep(probe.idle * 3).await;
        notify().await.unwrap();
        assert_eq!(
            next_change(&mut subscription).await,
            BookChange::Change(vec!["payees".into()])
        );

        // The connection goes silent. The probe finds it, the hub connects
        // again, and every subscriber gets reset.
        silence();
        assert_eq!(next_change(&mut subscription).await, BookChange::Reset);
        notify().await.unwrap();
        assert_eq!(
            next_change(&mut subscription).await,
            BookChange::Change(vec!["payees".into()])
        );
    }

    fn hub() -> BookChangeHub {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://unused@127.0.0.1:1/unused")
            .unwrap();
        BookChangeHub::new(pool).without_listener()
    }

    fn subscribe(hub: &BookChangeHub, book_id: i32) -> Subscription {
        hub.subscribe(book_id)
    }

    #[test]
    fn frames_match_the_node_route() {
        assert_eq!(
            BookChange::Change(vec!["transactions".into()]).frame(),
            "event: change\ndata: {\"tables\":[\"transactions\"]}\n\n"
        );
        assert_eq!(
            BookChange::Reset.frame(),
            "event: reset\ndata: {\"tables\":[]}\n\n"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn windows_collect_tables_per_book_and_ignore_invalid_hints() {
        let hub = hub();
        let mut first = subscribe(&hub, 1);
        let mut second = subscribe(&hub, 2);
        for payload in [
            r#"{"bookId":1,"table":"transactions"}"#,
            r#"{"bookId":1,"table":"accounts"}"#,
            r#"{"bookId":1,"table":"transactions"}"#,
            r#"{"bookId":1,"table":"users"}"#,
            r#"{"bookId":"1","table":"payees"}"#,
            r#"{"bookId":0,"table":"payees"}"#,
            r#"{"bookId":1.5,"table":"payees"}"#,
            r#"{"bookId":3,"table":"payees"}"#,
            r#"[1]"#,
            "not json",
        ] {
            hub.inner.notify(payload);
        }
        tokio::time::sleep(WINDOW - Duration::from_millis(1)).await;
        assert!(first.receiver.try_recv().is_err());
        tokio::time::sleep(Duration::from_millis(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            first.receiver.try_recv().unwrap(),
            BookChange::Change(vec!["transactions".into(), "accounts".into()])
        );
        assert!(second.receiver.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn reset_cancels_open_windows_and_reaches_every_book() {
        let hub = hub();
        let mut first = subscribe(&hub, 1);
        let mut second = subscribe(&hub, 2);
        hub.inner.notify(r#"{"bookId":1,"table":"payees"}"#);
        hub.inner.reset();
        assert_eq!(first.receiver.try_recv().unwrap(), BookChange::Reset);
        assert_eq!(second.receiver.try_recv().unwrap(), BookChange::Reset);
        tokio::time::sleep(WINDOW * 2).await;
        assert!(first.receiver.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_stalled_subscriber_is_dropped_and_the_last_one_releases_the_book() {
        let hub = hub();
        let mut stalled = subscribe(&hub, 1);
        for _ in 0..=QUEUE {
            hub.inner.notify(r#"{"bookId":1,"table":"payees"}"#);
            tokio::time::sleep(WINDOW).await;
            tokio::task::yield_now().await;
        }
        assert!(lock(&hub.inner.books).books.is_empty());
        let mut frames = 0;
        while stalled.receiver.recv().await.is_some() {
            frames += 1;
        }
        assert_eq!(frames, QUEUE);

        let subscription = subscribe(&hub, 2);
        hub.inner.notify(r#"{"bookId":2,"table":"payees"}"#);
        drop(subscription);
        assert!(lock(&hub.inner.books).books.is_empty());
    }
}

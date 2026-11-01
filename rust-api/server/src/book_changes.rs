//! Live-update hints for `GET /api/b/{bookId}/socket`. One hub serves the
//! process.
//!
//! Triggers on each table of [`CHANGE_TABLES`] count the row changes of each
//! (book, table) in `change_marks` (migration 0001). Every writer runs them:
//! this server, `ledger-cli`, the MCP process and the sqlite3 shell. A
//! rolled back write rolls back its count. While a page listens, the hub
//! reads the counts of the books that have a subscriber every [`POLL`], and
//! a count that moved is a hint for that table. The hints are invalidation
//! hints only: a book and a table, never row data.

use crate::platform;
use ledger_db::{
    Database, Sql, sql,
    store::{self, params},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, Once, Weak},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

/// The tables that send a hint. Each has the `*_mark` triggers.
pub(crate) const CHANGE_TABLES: [&str; 14] = [
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

/// How often the hub reads the counts while a page listens.
const POLL: Duration = Duration::from_millis(100);

/// The frames that one subscriber can hold before the hub drops it. This is
/// the `highWaterMark` of the Node stream. Invalidation has no replay
/// requirement: the stalled reader reconnects and gets `ready`.
const QUEUE: usize = 8;

/// The hint that a subscriber gets. The PostgreSQL server also sent a
/// `reset` event after it lost its LISTEN connection. The counts cannot be
/// lost, so this server does not send one; the client still accepts one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BookChange {
    Change(Vec<String>),
}

#[derive(Default)]
struct Book {
    subscribers: HashMap<u64, mpsc::Sender<BookChange>>,
    window: Option<Window>,
    /// The counts that the hub last read for this book, by table. `None`
    /// until the first read, which sends no hint.
    counts: Option<HashMap<String, i64>>,
}

struct Window {
    id: u64,
    tables: Vec<String>,
    timer: platform::Task,
}

#[derive(Default)]
struct Books {
    books: HashMap<i32, Book>,
    next_id: u64,
}

struct Inner {
    books: Mutex<Books>,
    /// `None` for a hub that the tests drive by hand.
    database: Option<Arc<Database>>,
    poller: Once,
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
    /// Reads the counts of this book, when no other subscriber has, so that
    /// a change after this point is a hint. The route sends `ready` after
    /// this, and the page fetches after `ready`, so the page misses nothing.
    pub(crate) async fn ready(&self) {
        let Some(database) = &self.inner.database else {
            return;
        };
        let known = lock(&self.inner.books)
            .books
            .get(&self.book_id)
            .is_some_and(|book| book.counts.is_some());
        if known {
            return;
        }
        match read_counts(database, &[self.book_id]) {
            Ok(mut counts) => {
                let mut books = lock(&self.inner.books);
                if let Some(book) = books.books.get_mut(&self.book_id)
                    && book.counts.is_none()
                {
                    book.counts = Some(counts.remove(&self.book_id).unwrap_or_default());
                }
            }
            // The poller reads the counts on its next turn.
            Err(cause) => tracing::warn!(error = %cause, "Book change counts unreadable"),
        }
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
    pub(crate) fn new(database: Arc<Database>) -> Self {
        Self::with_database(Some(database))
    }

    fn with_database(database: Option<Arc<Database>>) -> Self {
        Self {
            inner: Arc::new(Inner {
                books: Mutex::default(),
                database,
                poller: Once::new(),
                closing: watch::Sender::new(false),
            }),
        }
    }

    /// A hub with no database: it never polls. A test drives it with
    /// `notify`; a Durable Object uses it so that it can hibernate.
    pub(crate) fn detached() -> Self {
        Self::with_database(None)
    }

    pub(crate) fn subscribe(&self, book_id: i32) -> Subscription {
        if let Some(database) = &self.inner.database {
            self.inner.poller.call_once(|| {
                platform::spawn(poll(Arc::downgrade(&self.inner), database.clone()));
            });
        }
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
}

/// The counts of `books`, by book, then by table.
pub(crate) fn read_counts(
    database: &Database,
    books: &[i32],
) -> Result<HashMap<i32, HashMap<String, i64>>, store::Error> {
    let rows: Vec<(i32, String, i64)> = database.query(
        &format!(
            "SELECT book_id, table_name, version FROM change_marks WHERE book_id {}",
            sql::in_integers("?1")
        ),
        &params![sql::json_array(books)],
    )?;
    let mut counts: HashMap<i32, HashMap<String, i64>> = HashMap::new();
    for (book_id, table, version) in rows {
        counts.entry(book_id).or_default().insert(table, version);
    }
    Ok(counts)
}

/// Reads the counts of the books that have a subscriber, and sends a hint
/// for each count that moved. Ends when the hub is gone.
async fn poll(inner: Weak<Inner>, database: Arc<Database>) {
    loop {
        platform::sleep(POLL).await;
        let Some(hub) = inner.upgrade() else { return };
        let books: Vec<i32> = lock(&hub.books).books.keys().copied().collect();
        if books.is_empty() {
            continue;
        }
        let counts = match read_counts(&database, &books) {
            Ok(counts) => counts,
            Err(cause) => {
                tracing::warn!(error = %cause, "Book change counts unreadable");
                continue;
            }
        };
        let mut hints = Vec::new();
        {
            let mut state = lock(&hub.books);
            for book_id in books {
                let Some(book) = state.books.get_mut(&book_id) else {
                    continue;
                };
                let now = counts.get(&book_id).cloned().unwrap_or_default();
                if let Some(before) = &book.counts {
                    // In the order of CHANGE_TABLES, so that one poll gives
                    // its tables in a fixed order.
                    for table in CHANGE_TABLES {
                        if now
                            .get(table)
                            .is_some_and(|version| before.get(table) != Some(version))
                        {
                            hints.push((book_id, table.to_owned()));
                        }
                    }
                }
                book.counts = Some(now);
            }
        }
        for (book_id, table) in hints {
            hub.notify(i64::from(book_id), &table);
        }
    }
}

impl Inner {
    fn notify(self: &Arc<Self>, book_id: i64, table: &str) {
        // A book ID beyond int4 cannot have a subscriber.
        let Some(book_id) = i32::try_from(book_id).ok().filter(|id| *id > 0) else {
            return;
        };
        if !CHANGE_TABLES.contains(&table) {
            return;
        }
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
            timer: platform::spawn(async move {
                platform::sleep(WINDOW).await;
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
        // A new window can open while this timer waits for the lock.
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

#[cfg(test)]
mod tests {
    use super::*;
    use ledger_db::testing::TempDatabase;

    fn subscribe(hub: &BookChangeHub, book_id: i32) -> Subscription {
        hub.subscribe(book_id)
    }

    async fn receive(subscription: &mut Subscription) -> BookChange {
        tokio::time::timeout(Duration::from_secs(5), subscription.receiver.recv())
            .await
            .expect("a frame")
            .expect("an open stream")
    }

    #[tokio::test(start_paused = true)]
    async fn windows_collect_tables_per_book_and_ignore_invalid_hints() {
        let hub = BookChangeHub::detached();
        let mut first = subscribe(&hub, 1);
        let mut second = subscribe(&hub, 2);
        for (book_id, table) in [
            (1, "transactions"),
            (1, "accounts"),
            (1, "transactions"),
            (1, "users"),
            (0, "payees"),
            (-1, "payees"),
            (i64::from(i32::MAX) + 1, "payees"),
            (3, "payees"),
        ] {
            hub.inner.notify(book_id, table);
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
    async fn a_stalled_subscriber_is_dropped_and_the_last_one_releases_the_book() {
        let hub = BookChangeHub::detached();
        let mut stalled = subscribe(&hub, 1);
        for _ in 0..=QUEUE {
            hub.inner.notify(1, "payees");
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
        hub.inner.notify(2, "payees");
        drop(subscription);
        assert!(lock(&hub.inner.books).books.is_empty());
    }

    /// Every table of CHANGE_TABLES has the three triggers, and no other
    /// table has one.
    #[tokio::test]
    async fn each_change_table_has_its_triggers() {
        let database = Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        let mut marked: Vec<String> = database
            .query(
                "SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name GLOB '*_mark'",
                &[],
            )
            .unwrap();
        marked.sort();
        let mut expected: Vec<String> = CHANGE_TABLES.iter().map(|t| (*t).to_owned()).collect();
        expected.sort();
        assert_eq!(marked, expected);
        let triggers: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name GLOB '*_mark'",
                &[],
            )
            .unwrap();
        assert_eq!(triggers, 3 * CHANGE_TABLES.len() as i64);
    }

    /// A committed write sends its tables, from this database or from another
    /// connection (another process). A rolled back write sends nothing, and
    /// a row that moves to another book tells both books.
    #[tokio::test]
    async fn committed_writes_of_any_connection_reach_the_hub() {
        let file = TempDatabase::new();
        let database = Arc::new(Database::open(file.path(), false).unwrap());
        // Another writer on the same file, as ledger-cli would be.
        let other = Database::open(file.path(), false).unwrap();
        let hub = BookChangeHub::new(database.clone());
        let now = crate::platform::timestamp();
        database
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', ?1)",
                &params![now],
            )
            .unwrap();
        for id in [1, 2] {
            database
                .execute(
                    "INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES (?1, 1, ?2, ?3, ?3)",
                    &params![id, format!("Book {id}"), now],
                )
                .unwrap();
        }
        let mut first = subscribe(&hub, 1);
        let mut second = subscribe(&hub, 2);
        first.ready().await;
        second.ready().await;

        let rolled_back: Result<(), store::Error> = database.transaction(|tx| {
            tx.execute(
                "INSERT INTO payees (book_id, name, created_at) VALUES (1, 'Rolled back', ?1)",
                &params![now],
            )?;
            Err(store::Error::Invalid("roll back".into()))
        });
        assert!(rolled_back.is_err());
        tokio::time::sleep(POLL * 3 + WINDOW).await;
        assert!(
            first.receiver.try_recv().is_err(),
            "the rollback sent nothing"
        );

        other
            .execute(
                "INSERT INTO payees (book_id, name, created_at) VALUES (1, 'Kept', ?1)",
                &params![now],
            )
            .unwrap();
        assert_eq!(
            receive(&mut first).await,
            BookChange::Change(vec!["payees".into()])
        );

        database
            .execute("UPDATE payees SET book_id = 2 WHERE name = 'Kept'", &[])
            .unwrap();
        assert_eq!(
            receive(&mut first).await,
            BookChange::Change(vec!["payees".into()])
        );
        assert_eq!(
            receive(&mut second).await,
            BookChange::Change(vec!["payees".into()])
        );
    }
}

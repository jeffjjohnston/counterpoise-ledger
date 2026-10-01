//! Every lock that serializes writers, in one module.
//!
//! Three kinds:
//!
//! - A **transaction lock** ([`lock_transaction`]) lasts until the
//!   transaction commits or rolls back. The caller must be inside a
//!   transaction that [`begin`] opened.
//! - A **session lock** ([`with_session_lock`]) spans several transactions,
//!   for example a Plaid sync that calls the network between them. A second
//!   caller does not wait: it gets `None`.
//! - A **row lock** ([`FOR_UPDATE`]) on a `SELECT` that reads a row the
//!   transaction then changes.
//!
//! Each transaction opens with [`begin`], [`begin_pool`] or [`savepoint`],
//! never with `Connection::begin` (clippy refuses it).
//!
//! On SQLite a write transaction opens with `BEGIN IMMEDIATE`, which takes
//! the write lock of the database file at once. Two write transactions,
//! from this process or another, cannot overlap: the second waits up to the
//! busy timeout. A transaction lock and `FOR UPDATE` then add nothing, so
//! they are empty, and every `FOR UPDATE` site is inside a transaction from
//! [`begin`] or [`begin_pool`]. A session lock is a file lock beside the
//! database, so it also holds against the MCP process (`counterpoise-rust-api
//! mcp`), and the system releases it when the process ends.

use crate::{
    database::sidecar,
    engine::{Db, DbConnection, DbPool},
};
use sqlx::{Connection, Transaction};
use std::{fs::OpenOptions, future::Future, path::PathBuf, pin::Pin};

pub type DbFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, sqlx::Error>> + Send + 'a>>;

/// Appended to a `SELECT` that reads a row which the transaction then
/// changes. Empty: `BEGIN IMMEDIATE` already holds the write lock.
pub const FOR_UPDATE: &str = "";

/// Appended to a `SELECT` that reads rows which another writer must not
/// change or delete before the transaction ends. Empty, as [`FOR_UPDATE`].
pub const FOR_SHARE: &str = "";

/// A lock that lasts until the end of the current transaction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransactionLock {
    /// The lots of one (account, security) pair. `rebuild_lots` takes it
    /// before it reads the splits that drive the inserts.
    LotPair { account_id: i32, security_id: i32 },
    /// The first-user check and the user insert of a registration.
    Registration,
}

/// Takes `lock` until the current transaction ends. On SQLite the
/// transaction that [`begin`] opened already holds the write lock of the
/// file, so no other writer runs until it ends.
pub async fn lock_transaction(
    _connection: &mut DbConnection,
    _lock: TransactionLock,
) -> Result<(), sqlx::Error> {
    Ok(())
}

/// A lock that spans several transactions.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SessionLock {
    namespace: i32,
    key: i32,
}

impl SessionLock {
    /// The namespace of the Plaid sync lock.
    pub const PLAID_SYNC_NAMESPACE: i32 = 1_000_001;

    /// One sync of one Plaid connection at a time.
    pub fn plaid_sync(token_id: i32) -> Self {
        Self::new(Self::PLAID_SYNC_NAMESPACE, token_id)
    }

    /// A lock in any namespace. Tests use a namespace of their own.
    pub fn new(namespace: i32, key: i32) -> Self {
        Self { namespace, key }
    }

    /// `<database>.locks/<namespace>-<key>.lock`.
    fn path(&self, pool: &DbPool) -> PathBuf {
        sidecar(pool.connect_options().get_filename(), ".locks")
            .join(format!("{}-{}.lock", self.namespace, self.key))
    }
}

/// Runs `callback` while this process holds `lock`, or returns `None` at
/// once when another caller holds it.
///
/// The callback receives one connection from the pool for its whole run, so
/// that its transactions and queries use one connection.
pub async fn with_session_lock<T, F>(
    pool: &DbPool,
    lock: SessionLock,
    callback: F,
) -> Result<Option<T>, sqlx::Error>
where
    F: for<'a> FnOnce(&'a mut DbConnection) -> DbFuture<'a, T>,
{
    // A try-lock does not wait, so these file calls are short.
    let path = lock.path(pool);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    let file = match file.try_lock() {
        Ok(()) => Some(file),
        Err(std::fs::TryLockError::WouldBlock) => None,
        Err(std::fs::TryLockError::Error(cause)) => return Err(sqlx::Error::Io(cause)),
    };
    // Dropping the file releases the lock, also when the callback is
    // cancelled.
    let Some(_held) = file else {
        return Ok(None);
    };
    let mut connection = pool.acquire().await?;
    callback(&mut connection).await.map(Some)
}

/// Opens a transaction that may write: `BEGIN IMMEDIATE`, so that the write
/// lock is held from the first statement and a later write cannot fail with
/// `SQLITE_BUSY` in the middle of the transaction.
pub async fn begin(connection: &mut DbConnection) -> Result<Transaction<'_, Db>, sqlx::Error> {
    #[allow(clippy::disallowed_methods)]
    connection.begin_with("BEGIN IMMEDIATE").await
}

/// Opens a transaction that may write, on a connection from `pool`, as
/// [`begin`].
pub async fn begin_pool(pool: &DbPool) -> Result<Transaction<'static, Db>, sqlx::Error> {
    #[allow(clippy::disallowed_methods)]
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// Opens a savepoint inside the transaction that `connection` is already in.
/// A rollback of the savepoint keeps the outer transaction.
pub async fn savepoint(connection: &mut DbConnection) -> Result<Transaction<'_, Db>, sqlx::Error> {
    #[allow(clippy::disallowed_methods)]
    connection.begin().await
}

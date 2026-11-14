//! The native backend: rusqlite on one connection, on a file or in memory.

use crate::{
    database::{BUSY_TIMEOUT, MMAP_SIZE},
    limits,
    store::{Error, Row, Sql, Value},
};
use rusqlite::{
    OpenFlags, TransactionBehavior,
    types::{ToSqlOutput, ValueRef},
};
use std::{
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

/// The database: one connection behind a mutex, as a Durable Object runs one
/// statement at a time on one thread.
///
/// Each call holds the mutex until its statement finishes, and
/// [`Database::transaction`] holds it for the whole closure. Inside the
/// closure, use the [`Transaction`] it receives: a call on the `Database`
/// itself waits for the mutex that the closure holds, and never returns.
pub struct Database {
    connection: Mutex<rusqlite::Connection>,
    /// The file, or `None` in memory.
    path: Option<PathBuf>,
}

impl Database {
    /// Opens the database file with WAL, foreign keys, a busy timeout of
    /// [`BUSY_TIMEOUT`], `synchronous=FULL` and a memory map of
    /// [`MMAP_SIZE`], and lowers the SQLite limits to a Durable Object's
    /// ([`limits::LIMITS`]). It registers no SQL function: a Durable Object
    /// has none, so the SQL uses only SQLite's own.
    ///
    /// `synchronous=FULL`: each commit syncs the WAL to the disk before it
    /// returns. With `NORMAL`, a commit that returned can be lost when the
    /// power fails or the machine stops. This is a ledger: a lost commit is a
    /// lost transaction, so the cost of one sync for each commit is correct. `create` makes a missing file; apply the migrations
    /// after.
    pub fn open(path: &Path, create: bool) -> Result<Self, Error> {
        Self::open_with(path, create, BUSY_TIMEOUT)
    }

    pub(crate) fn open_with(
        path: &Path,
        create: bool,
        busy_timeout: Duration,
    ) -> Result<Self, Error> {
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let connection = rusqlite::Connection::open_with_flags(path, flags).map_err(sql_error)?;
        connection.busy_timeout(busy_timeout).map_err(sql_error)?;
        // The journal mode pragma returns the new mode as a row.
        let mode: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .map_err(sql_error)?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(Error::Sql {
                message: format!("journal_mode is {mode}, not wal"),
            });
        }
        connection
            .execute_batch(&format!(
                "PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA mmap_size = {MMAP_SIZE};"
            ))
            .map_err(sql_error)?;
        Ok(Self::new(connection, Some(path.to_path_buf())))
    }

    /// Opens a copy of the database, such as a backup, with no change to its
    /// journal mode. `read_only` opens it read-only; otherwise it writes
    /// with a rollback journal and `synchronous=FULL`, as a copy that is
    /// moved as one file must. It has the limits and no SQL function.
    pub fn open_copy(path: &Path, read_only: bool) -> Result<Self, Error> {
        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let connection = rusqlite::Connection::open_with_flags(path, flags).map_err(sql_error)?;
        connection.busy_timeout(BUSY_TIMEOUT).map_err(sql_error)?;
        if !read_only {
            connection
                .execute_batch("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;")
                .map_err(sql_error)?;
        }
        Ok(Self::new(connection, Some(path.to_path_buf())))
    }

    /// The file of the database, or `None` for one in memory. A job that
    /// must not hold this connection for long (a backup, a `VACUUM`) opens
    /// its own on the same file.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// A database in memory, for tests. It has the limits and foreign keys,
    /// and no file pragmas.
    pub fn open_in_memory() -> Result<Self, Error> {
        let connection = rusqlite::Connection::open_in_memory().map_err(sql_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sql_error)?;
        Ok(Self::new(connection, None))
    }

    fn new(connection: rusqlite::Connection, path: Option<PathBuf>) -> Self {
        limits::limit_native(&connection);
        Self {
            connection: Mutex::new(connection),
            path,
        }
    }

    /// Runs `body` in one write transaction: it commits when `body` returns
    /// `Ok`, and rolls back when it returns `Err` or panics.
    ///
    /// Natively it is `BEGIN IMMEDIATE`, which takes the write lock at the
    /// start: the MCP stdio process and `ledger-cli` write the same file,
    /// and a deferred transaction that reads first fails with `SQLITE_BUSY`
    /// when one of them writes in between. A Durable Object has one writer.
    pub fn transaction<R, E: From<Error>>(
        &self,
        body: impl FnOnce(&Transaction<'_>) -> Result<R, E>,
    ) -> Result<R, E> {
        let mut connection = self.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let transaction = Transaction { transaction };
        // Dropping the transaction without a commit rolls it back.
        let result = body(&transaction)?;
        transaction.transaction.commit().map_err(sql_error)?;
        Ok(result)
    }

    /// Runs `body` in one read transaction (`BEGIN DEFERRED`): its reads see
    /// one snapshot of the file, taken at the first read, even while another
    /// process writes. It commits at the end, and writes nothing a caller
    /// should rely on: use [`Database::transaction`] to write.
    pub fn read_transaction<R, E: From<Error>>(
        &self,
        body: impl FnOnce(&Transaction<'_>) -> Result<R, E>,
    ) -> Result<R, E> {
        let mut connection = self.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql_error)?;
        let transaction = Transaction { transaction };
        let result = body(&transaction)?;
        transaction.transaction.commit().map_err(sql_error)?;
        Ok(result)
    }

    /// The connection. A panic inside a transaction poisons the mutex after
    /// its rollback, so the connection is in a clean state and is used again.
    fn lock(&self) -> MutexGuard<'_, rusqlite::Connection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Sql for Database {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        for_each_row(&self.lock(), sql, params, each)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        execute(&self.lock(), sql, params)
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        self.lock().execute_batch(sql).map_err(sql_error)
    }
}

/// An open write transaction of [`Database::transaction`].
pub struct Transaction<'a> {
    transaction: rusqlite::Transaction<'a>,
}

impl Transaction<'_> {
    /// Runs `body` in a savepoint of this transaction: its writes stay when
    /// it returns `Ok`, and only they roll back when it returns `Err`; the
    /// transaction goes on either way. The inner result is `body`'s; the
    /// outer error is a failure of the savepoint itself. Savepoints nest.
    ///
    /// For a native batch that must skip a failed unit and keep the rest,
    /// such as one row of an import. A Durable Object has no savepoint, so
    /// the server does not use it.
    pub fn savepoint<T, E>(
        &self,
        body: impl FnOnce(&Self) -> Result<T, E>,
    ) -> Result<Result<T, E>, Error> {
        self.exec_batch("SAVEPOINT unit")?;
        let outcome = body(self);
        match &outcome {
            Ok(_) => self.exec_batch("RELEASE unit")?,
            Err(_) => self.exec_batch("ROLLBACK TO unit; RELEASE unit")?,
        }
        Ok(outcome)
    }
}

impl Sql for Transaction<'_> {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        for_each_row(&self.transaction, sql, params, each)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        execute(&self.transaction, sql, params)
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        self.transaction.execute_batch(sql).map_err(sql_error)
    }
}

fn for_each_row(
    connection: &rusqlite::Connection,
    sql: &str,
    params: &[Value],
    each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
) -> Result<(), Error> {
    let mut statement = connection.prepare_cached(sql).map_err(sql_error)?;
    let names: Arc<[String]> = statement.column_names().map(str::to_owned).collect();
    let columns = names.len();
    let mut rows = statement.query(checked(params)?).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let values = (0..columns)
            .map(|index| {
                let value = row.get_ref(index).map_err(sql_error)?;
                from_sqlite(value).checked()
            })
            .collect::<Result<Vec<_>, _>>()?;
        if each(Row::new(names.clone(), values))?.is_break() {
            break;
        }
    }
    Ok(())
}

fn execute(connection: &rusqlite::Connection, sql: &str, params: &[Value]) -> Result<u64, Error> {
    let mut statement = connection.prepare_cached(sql).map_err(sql_error)?;
    let changed = statement.execute(checked(params)?).map_err(sql_error)?;
    Ok(changed as u64)
}

/// The bound values, each refused when a Durable Object would round it.
fn checked(params: &[Value]) -> Result<rusqlite::ParamsFromIter<Vec<Value>>, Error> {
    let values = params
        .iter()
        .cloned()
        .map(Value::checked)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rusqlite::params_from_iter(values))
}

fn from_sqlite(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Integer(n),
        ValueRef::Real(x) => Value::Real(x),
        ValueRef::Text(text) => Value::Text(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(bytes) => Value::Blob(bytes.to_vec()),
    }
}

impl rusqlite::ToSql for Value {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self {
            Value::Null => ValueRef::Null,
            Value::Integer(n) => ValueRef::Integer(*n),
            Value::Real(x) => ValueRef::Real(*x),
            Value::Text(text) => ValueRef::Text(text.as_bytes()),
            Value::Blob(bytes) => ValueRef::Blob(bytes),
        }))
    }
}

fn sql_error(error: rusqlite::Error) -> Error {
    match error {
        rusqlite::Error::SqliteFailure(_, Some(message)) => Error::Sql { message },
        error => Error::Sql {
            message: error.to_string(),
        },
    }
}

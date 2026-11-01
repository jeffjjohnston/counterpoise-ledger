//! The backend of a build without the `native` feature: the host supplies
//! the connection. On Cloudflare Workers it is the `SqlStorage` of the
//! Durable Object, whose `transactionSync` commits when its callback returns
//! and rolls back when it throws.
//!
//! The native tests run this module over rusqlite, so both backends answer
//! to the same tests of the transaction rules.

use crate::store::{Error, Row, Sql, Value};
use std::ops::ControlFlow;

/// A connection that runs one statement at a time.
///
/// `Send` and `Sync`, as the server's state is: a host whose handle is
/// neither (a JavaScript object) runs on one thread and wraps it.
pub trait Connection: Send + Sync {
    /// Runs one statement and passes each row to `each`, as
    /// [`Sql::for_each_row`] does.
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error>;

    /// Runs one statement and returns the number of rows it changed.
    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error>;

    /// Runs several statements with no bound values.
    fn exec_batch(&self, sql: &str) -> Result<(), Error>;

    /// Runs `body` once in one transaction. It commits when `body` returns
    /// `true` and rolls back when it returns `false`. The error is a failure
    /// of the transaction itself, not of `body`.
    fn transaction(&self, body: &mut dyn FnMut() -> bool) -> Result<(), Error>;
}

/// The database: the host's connection.
pub struct Database {
    connection: Box<dyn Connection>,
}

impl Database {
    /// The database on the host's connection, which has the schema or gets
    /// it from the migrations.
    pub fn new(connection: Box<dyn Connection>) -> Self {
        Self { connection }
    }

    /// Runs `body` in one write transaction: it commits when `body` returns
    /// `Ok` and rolls back when it returns `Err`.
    pub fn transaction<R, E: From<Error>>(
        &self,
        body: impl FnOnce(&Transaction<'_>) -> Result<R, E>,
    ) -> Result<R, E> {
        let transaction = Transaction {
            connection: &*self.connection,
        };
        let mut body = Some(body);
        let mut outcome = None;
        self.connection.transaction(&mut || {
            let Some(body) = body.take() else {
                return false;
            };
            let result = body(&transaction);
            let commit = result.is_ok();
            outcome = Some(result);
            commit
        })?;
        outcome.unwrap_or_else(|| {
            Err(Error::Sql {
                message: "the transaction did not run its body".to_owned(),
            }
            .into())
        })
    }

    /// Runs `body` in one transaction for its reads. A Durable Object has one
    /// writer, so its reads see one state either way; this keeps the native
    /// signature.
    pub fn read_transaction<R, E: From<Error>>(
        &self,
        body: impl FnOnce(&Transaction<'_>) -> Result<R, E>,
    ) -> Result<R, E> {
        self.transaction(body)
    }
}

impl Sql for Database {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        self.connection.for_each_row(sql, params, each)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        self.connection.execute(sql, params)
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        self.connection.exec_batch(sql)
    }
}

/// An open transaction of [`Database::transaction`]. A Durable Object has
/// no savepoint, so it has none either.
pub struct Transaction<'a> {
    connection: &'a dyn Connection,
}

impl Sql for Transaction<'_> {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        self.connection.for_each_row(sql, params, each)
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        self.connection.execute(sql, params)
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        self.connection.exec_batch(sql)
    }
}

#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;
    use crate::store::params;
    use std::sync::Mutex;

    /// The hosted backend over a native in-memory database: `transaction`
    /// is `BEGIN`, then `COMMIT` or `ROLLBACK`, as `transactionSync` does.
    struct Native(Mutex<crate::engine::native::Database>);

    impl Connection for Native {
        fn for_each_row(
            &self,
            sql: &str,
            params: &[Value],
            each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
        ) -> Result<(), Error> {
            self.0.lock().unwrap().for_each_row(sql, params, each)
        }

        fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
            self.0.lock().unwrap().execute(sql, params)
        }

        fn exec_batch(&self, sql: &str) -> Result<(), Error> {
            self.0.lock().unwrap().exec_batch(sql)
        }

        fn transaction(&self, body: &mut dyn FnMut() -> bool) -> Result<(), Error> {
            self.exec_batch("BEGIN")?;
            let commit = body();
            self.exec_batch(if commit { "COMMIT" } else { "ROLLBACK" })
        }
    }

    fn database() -> Database {
        let native = crate::engine::native::Database::open_in_memory().unwrap();
        native
            .exec_batch("CREATE TABLE t (n INTEGER NOT NULL)")
            .unwrap();
        Database::new(Box::new(Native(Mutex::new(native))))
    }

    fn count(database: &Database) -> i64 {
        database.query_row("SELECT COUNT(*) FROM t", &[]).unwrap()
    }

    #[test]
    fn a_transaction_commits_its_writes_on_ok() {
        let database = database();
        let seen: i64 = database
            .transaction(|tx| {
                tx.execute("INSERT INTO t (n) VALUES (?1)", &params![1])?;
                tx.query_row("SELECT COUNT(*) FROM t", &[])
            })
            .unwrap();
        assert_eq!((seen, count(&database)), (1, 1));
    }

    #[test]
    fn a_transaction_rolls_back_on_err_and_returns_the_body_error() {
        let database = database();
        let result: Result<(), Error> = database.transaction(|tx| {
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![1])?;
            Err(Error::NoRow)
        });
        assert!(matches!(result, Err(Error::NoRow)));
        assert_eq!(count(&database), 0);
    }

    #[test]
    fn a_failed_statement_rolls_back_the_earlier_writes() {
        let database = database();
        let result = database.transaction(|tx| {
            tx.execute("INSERT INTO t (n) VALUES (?1)", &params![1])?;
            tx.execute("INSERT INTO t (n) VALUES (NULL)", &[])
        });
        assert!(matches!(result, Err(Error::Sql { .. })));
        assert_eq!(count(&database), 0);
    }
}

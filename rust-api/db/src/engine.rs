//! The one place that names the database engine. Every other module uses
//! these names, so that a change of engine changes this file and the SQL,
//! not every signature.

pub type Db = sqlx::Sqlite;
pub type DbPool = sqlx::SqlitePool;
pub type DbPoolOptions = sqlx::sqlite::SqlitePoolOptions;
pub type DbConnection = sqlx::SqliteConnection;
pub type DbRow = sqlx::sqlite::SqliteRow;
pub type DbArguments<'q> = <Db as sqlx::Database>::Arguments<'q>;

/// An executor of this engine: a pool, a connection or a transaction.
pub trait DbExecutor<'c>: sqlx::Executor<'c, Database = Db> {}

impl<'c, T: sqlx::Executor<'c, Database = Db>> DbExecutor<'c> for T {}

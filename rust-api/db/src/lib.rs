//! Database operations that more than one binary runs: the server's write
//! routes and the `ledger-cli` maintenance commands.

// Only `functions` calls the SQLite C API, and it allows unsafe code itself.
#![deny(unsafe_code)]

pub mod backup;
pub mod database;
pub mod engine;
mod functions;
pub mod job_status;
pub mod locks;
pub mod lots;
pub mod seed;
pub mod sql;
pub mod testing;

pub use database::{Open, lock_server, migrate, open};

use engine::DbPool;
use std::path::Path;

/// A pool for a command-line tool: two connections and no change hints.
/// `create` makes a missing file; apply the migrations after.
pub fn connect(path: &Path, create: bool) -> Result<DbPool, sqlx::Error> {
    open(Open {
        path,
        max_connections: 2,
        create,
    })
}

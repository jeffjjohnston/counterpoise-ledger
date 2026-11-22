//! Database operations that more than one binary runs: the server's write
//! routes and the `ledger-cli` maintenance commands.

// Only `limits` calls the SQLite C API, and it allows unsafe code itself.
#![deny(unsafe_code)]

// `#[derive(FromRow)]` names `::ledger_db`, also inside this crate.
extern crate self as ledger_db;

#[cfg(feature = "native")]
pub mod backup;
pub mod clock;
#[cfg(feature = "native")]
pub mod database;
pub mod dump;
pub mod engine;
pub mod env;
pub mod folds;
pub mod jobs;
#[cfg(feature = "native")]
mod limits;
#[cfg(all(test, feature = "native"))]
mod link_account_tests;
pub mod locks;
pub mod lots;
pub mod migrations;
pub mod seed;
pub mod sql;
#[cfg(all(test, feature = "native"))]
mod status_checks_tests;
pub mod store;
pub mod sync_floor;
#[cfg(feature = "native")]
pub mod testing;

#[cfg(feature = "native")]
pub use database::lock_server;
pub use migrations::migrate;
pub use store::{Database, Sql};

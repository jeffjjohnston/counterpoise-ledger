//! The one place that names the database engine. Every other module uses
//! these names, so that a change of engine changes this module and the SQL,
//! not every signature.
//!
//! The engine is the synchronous [`crate::store`] API. With the `native`
//! feature its backend is rusqlite on one connection ([`native`]). Without
//! it, the backend is a [`hosted::Connection`] that the host supplies: the
//! `SqlStorage` of a Cloudflare Durable Object.

#[cfg(any(not(feature = "native"), test))]
pub mod hosted;
#[cfg(feature = "native")]
mod native;

#[cfg(not(feature = "native"))]
pub use hosted::{Database, Transaction};
#[cfg(feature = "native")]
pub use native::{Database, Transaction};

//! Every lock that serializes writers, in one module.
//!
//! A write transaction is a [`crate::Database::transaction`], which opens
//! with `BEGIN IMMEDIATE`: it takes the write lock of the database file at
//! once. Two write transactions, from this process or another, cannot
//! overlap: the second waits up to the busy timeout. A row lock
//! ([`FOR_UPDATE`]) then adds nothing, so it is empty, and it marks the
//! `SELECT` that reads a row the transaction then changes.
//!
//! A run that spans several transactions, such as a Plaid sync that calls
//! the network between them, holds a lease instead (`crate::jobs`).

/// Appended to a `SELECT` that reads a row which the transaction then
/// changes. Empty: `BEGIN IMMEDIATE` already holds the write lock.
pub const FOR_UPDATE: &str = "";

/// Appended to a `SELECT` that reads rows which another writer must not
/// change or delete before the transaction ends. Empty, as [`FOR_UPDATE`].
pub const FOR_SHARE: &str = "";

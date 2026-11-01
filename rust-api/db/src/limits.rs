//! The SQLite limits of a Cloudflare Durable Object, on every native
//! connection.

#![allow(unsafe_code)]

use libsqlite3_sys as ffi;
use std::{ffi::c_int, ptr::NonNull};

/// The limits of a Cloudflare Durable Object's SQLite, set on every native
/// connection, so that a statement the object would refuse fails in every
/// test here too. Measured on the object:
/// more than 100 bound parameters, an expression deeper than 100, a statement
/// over 100 KB and a 600-term compound `SELECT` all fail there.
pub const LIMITS: [(c_int, c_int); 4] = [
    (ffi::SQLITE_LIMIT_VARIABLE_NUMBER, 100),
    (ffi::SQLITE_LIMIT_EXPR_DEPTH, 100),
    (ffi::SQLITE_LIMIT_SQL_LENGTH, 100_000),
    (ffi::SQLITE_LIMIT_COMPOUND_SELECT, 500),
];

/// Lowers the limits of the connection `handle` to [`LIMITS`].
pub(crate) fn limit(handle: NonNull<ffi::sqlite3>) {
    for (limit, value) in LIMITS {
        // SAFETY: `handle` is an open connection that its owner (rusqlite)
        // keeps open, and uses on no other thread, for this call.
        // sqlite3_limit only reads and sets an integer on it.
        unsafe { ffi::sqlite3_limit(handle.as_ptr(), limit, value) };
    }
}

/// Lowers the limits of a rusqlite connection to [`LIMITS`].
pub(crate) fn limit_native(connection: &rusqlite::Connection) {
    // SAFETY: the handle is the open connection that `connection` owns, and
    // the borrow keeps it open for this call.
    let handle = unsafe { connection.handle() };
    limit(NonNull::new(handle).expect("an open connection has a handle"));
}

#[cfg(test)]
mod tests {
    use crate::store::{Database, Sql};

    /// The library that runs is the one compiled in, not a system SQLite of
    /// another version.
    #[test]
    fn the_bundled_sqlite_runs() {
        let database = Database::open_in_memory().unwrap();
        let version: String = database.query_row("SELECT sqlite_version()", &[]).unwrap();
        let compiled = std::ffi::CStr::from_bytes_with_nul(super::ffi::SQLITE_VERSION)
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(version, compiled);
    }
}

//! The floor marker of the transaction change log, which a restore adds so
//! that a native client downloads its book again. A backup copy gets it
//! (`backup.rs`), and so does a database that a dump was loaded into.

use crate::store::{Error, Sql, params};

/// The `book_id` of a floor marker in `transaction_changes`. No book has
/// this ID. A delta cursor below the newest marker is from before a restore.
pub const SYNC_FLOOR_BOOK_ID: i32 = 0;
/// The distance from the newest `seq` of a copy to its floor marker. The live
/// database must log fewer changes than this before the copy is restored.
pub(crate) const GAP: i64 = 1 << 32;

/// Adds a floor marker to the change log that `sql` writes, [`GAP`] above
/// its newest `seq`. The next change after the restore gets a `seq` above
/// the marker, so every cursor from before it is below the marker.
pub fn insert(sql: &impl Sql) -> Result<(), Error> {
    sql.execute(
        "INSERT INTO transaction_changes (seq, book_id, transaction_id)
         SELECT coalesce(max(seq), 0) + ?1, ?2, 0 FROM transaction_changes",
        &params![GAP, SYNC_FLOOR_BOOK_ID],
    )?;
    Ok(())
}

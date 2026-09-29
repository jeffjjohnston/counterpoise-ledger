//! Database operations that more than one binary runs: the server's write
//! routes and the `ledger-cli` maintenance commands.

#![forbid(unsafe_code)]

pub mod lots;
pub mod seed;

use sqlx::{PgPool, postgres::PgPoolOptions};

/// A pool whose sessions evaluate `CURRENT_DATE` in `time_zone`. The
/// PostgreSQL image defaults to UTC, which would move a floating transaction
/// to tomorrow between local evening and UTC midnight.
pub async fn connect(database_url: &str, time_zone: &str) -> Result<PgPool, sqlx::Error> {
    let time_zone = time_zone.to_owned();
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(move |connection, _| {
            let time_zone = time_zone.clone();
            Box::pin(async move {
                sqlx::query("SELECT set_config('TimeZone', $1, false)")
                    .bind(time_zone)
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(database_url)
        .await
}

use crate::error::{ApiError, internal_error};
use ledger_db::{
    Database,
    store::{self, Transaction},
};

/// Runs `body` in one write transaction (`Database::transaction`): it commits
/// when `body` returns `Ok`, and rolls back on an error or a panic. The
/// route's own answers pass through; a failure of the transaction itself
/// (its `BEGIN` or `COMMIT`) answers 500 with `failure`.
pub(crate) fn write_transaction<R>(
    database: &Database,
    failure: &'static str,
    body: impl FnOnce(&Transaction<'_>) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    write_transaction_or(database, |cause| internal_error(cause, failure), body)
}

/// [`write_transaction`] with the route's own answer to a database error,
/// for a route whose failure is not a 500.
pub(crate) fn write_transaction_or<R>(
    database: &Database,
    failed: impl FnOnce(store::Error) -> ApiError,
    body: impl FnOnce(&Transaction<'_>) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    database
        .transaction(|tx| body(tx).map_err(Failed::Route))
        .map_err(|failure| match failure {
            Failed::Route(answer) => answer,
            Failed::Database(cause) => failed(cause),
        })
}

/// Runs `body` in one read transaction (`Database::read_transaction`), so
/// its reads see one snapshot. Errors map as in [`write_transaction`].
pub(crate) fn read_transaction<R>(
    database: &Database,
    failure: &'static str,
    body: impl FnOnce(&Transaction<'_>) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    answer(
        database.read_transaction(|tx| body(tx).map_err(Failed::Route)),
        failure,
    )
}

enum Failed {
    Route(ApiError),
    Database(store::Error),
}

impl From<store::Error> for Failed {
    fn from(cause: store::Error) -> Self {
        Self::Database(cause)
    }
}

fn answer<R>(result: Result<R, Failed>, failure: &'static str) -> Result<R, ApiError> {
    result.map_err(|failed| match failed {
        Failed::Route(answer) => answer,
        Failed::Database(cause) => internal_error(cause, failure),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use ledger_db::Sql;

    #[test]
    fn a_route_answer_rolls_back_and_passes_through() {
        let database = Database::open_in_memory().unwrap();
        database
            .exec_batch("CREATE TABLE rollback_check (value integer)")
            .unwrap();
        let answer = write_transaction(&database, "Failed", |tx| {
            tx.execute("INSERT INTO rollback_check VALUES (1)", &[])
                .map_err(|cause| internal_error(cause, "Failed"))?;
            Err::<(), _>(crate::error::error(StatusCode::CONFLICT, "Taken"))
        })
        .unwrap_err();
        assert_eq!(answer.status(), StatusCode::CONFLICT);
        let rows: i64 = database
            .query_row("SELECT COUNT(*) FROM rollback_check", &[])
            .unwrap();
        assert_eq!(rows, 0);
    }
}

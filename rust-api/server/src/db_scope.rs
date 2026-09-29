use sqlx::{Connection, PgConnection, PgPool};
use std::{future::Future, pin::Pin};

#[allow(dead_code)] // Mutation routes will use these helpers as they move.
pub(crate) type DbFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, sqlx::Error>> + Send + 'a>>;

/// A session lock must stay on one reserved connection across the callback.
/// The callback receives that connection so its transaction and queries cannot
/// silently borrow a different one from the pool.
#[allow(dead_code)]
pub(crate) async fn with_advisory_lock<T, F>(
    pool: &PgPool,
    namespace: i32,
    key: i32,
    callback: F,
) -> Result<Option<T>, sqlx::Error>
where
    F: for<'a> FnOnce(&'a mut PgConnection) -> DbFuture<'a, T>,
{
    let mut connection = pool.acquire().await?;
    // The callback may be cancelled while the session lock is held. Closing
    // the socket on drop releases the lock; returning it to the pool would
    // leave the lock attached to a connection another request can borrow.
    connection.close_on_drop();
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1, $2)")
        .bind(namespace)
        .bind(key)
        .fetch_one(&mut *connection)
        .await?;
    if !acquired {
        return Ok(None);
    }

    let result = callback(&mut connection).await;
    let unlocked: Result<bool, sqlx::Error> =
        sqlx::query_scalar("SELECT pg_advisory_unlock($1, $2)")
            .bind(namespace)
            .bind(key)
            .fetch_one(&mut *connection)
            .await;
    match unlocked {
        Ok(true) => {
            connection.close().await?;
            result.map(Some)
        }
        Ok(false) => {
            connection.close().await?;
            Err(sqlx::Error::Protocol(
                "advisory lock was not held on reserved connection".into(),
            ))
        }
        Err(cause) => {
            // A session with uncertain lock state must never return to the pool.
            let _ = connection.close().await;
            Err(cause)
        }
    }
}

/// A transaction on the caller's connection, including a lock's connection.
/// Roll back before returning an error so the connection remains usable.
#[allow(dead_code)]
pub(crate) async fn with_transaction<T, F>(
    connection: &mut PgConnection,
    callback: F,
) -> Result<T, sqlx::Error>
where
    F: for<'a> FnOnce(&'a mut PgConnection) -> DbFuture<'a, T>,
{
    let mut transaction = connection.begin().await?;
    match callback(transaction.as_mut()).await {
        Ok(value) => {
            transaction.commit().await?;
            Ok(value)
        }
        Err(cause) => {
            if let Err(rollback_error) = transaction.rollback().await {
                tracing::error!(error = %rollback_error, original_error = %cause, "Transaction rollback failed");
            }
            Err(cause)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;

    #[tokio::test]
    async fn lock_and_transaction_use_one_connection_and_rollback_after_write() {
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap();
        let namespace = 1_000_002;
        let key = std::process::id() as i32;
        let competing_pool = pool.clone();
        let first = with_advisory_lock(&pool, namespace, key, |conn| {
            Box::pin(async move {
                let inside: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1, $2)")
                    .bind(namespace)
                    .bind(key)
                    .fetch_one(&mut *conn)
                    .await?;
                assert!(inside, "same session re-acquires the lock");
                sqlx::query("SELECT pg_advisory_unlock($1, $2)")
                    .bind(namespace)
                    .bind(key)
                    .execute(&mut *conn)
                    .await?;
                let second = with_advisory_lock(&competing_pool, namespace, key, |_| {
                    Box::pin(async { Ok(()) })
                })
                .await?;
                assert!(
                    second.is_none(),
                    "another connection cannot acquire the held lock"
                );

                let rolled_back = with_transaction(conn, |conn| {
                    Box::pin(async move {
                        sqlx::query("CREATE TEMP TABLE rust_lock_rollback (value integer)")
                            .execute(&mut *conn)
                            .await?;
                        sqlx::query("INSERT INTO rust_lock_rollback VALUES (1)")
                            .execute(&mut *conn)
                            .await?;
                        Err::<(), _>(sqlx::Error::Protocol("intentional rollback".into()))
                    })
                })
                .await;
                assert!(rolled_back.is_err());
                let exists: Option<String> =
                    sqlx::query_scalar("SELECT to_regclass('rust_lock_rollback')::text")
                        .fetch_one(&mut *conn)
                        .await?;
                assert!(
                    exists.is_none(),
                    "write and DDL rolled back on the reserved connection"
                );
                Ok(())
            })
        })
        .await
        .unwrap();
        assert!(first.is_some());
        let after = with_advisory_lock(&pool, namespace, key, |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap();
        assert!(after.is_some(), "lock released after callback");
    }

    #[tokio::test]
    async fn cancelled_callback_cannot_return_a_locked_session_to_the_pool() {
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let namespace = 1_000_003;
        let key = std::process::id() as i32;
        let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
        let active_pool = pool.clone();
        let holder = tokio::spawn(async move {
            let _ = with_advisory_lock(&active_pool, namespace, key, |_| {
                Box::pin(async move {
                    acquired_tx.send(()).unwrap();
                    std::future::pending::<Result<(), sqlx::Error>>().await
                })
            })
            .await;
        });
        acquired_rx.await.unwrap();
        holder.abort();
        let _ = holder.await;
        // Probe from a different PostgreSQL session. Reacquiring on the same
        // leaked pooled session would succeed because advisory locks are
        // reentrant, and would falsely appear to prove that it was released.
        let mut competitor = PgConnection::connect(&url).await.unwrap();
        let acquisition = async {
            loop {
                let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1, $2)")
                    .bind(namespace)
                    .bind(key)
                    .fetch_one(&mut competitor)
                    .await
                    .unwrap();
                if acquired {
                    sqlx::query("SELECT pg_advisory_unlock($1, $2)")
                        .bind(namespace)
                        .bind(key)
                        .execute(&mut competitor)
                        .await
                        .unwrap();
                    break;
                }
                tokio::task::yield_now().await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), acquisition)
            .await
            .unwrap();
        let after = with_advisory_lock(&pool, namespace, key, |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap();
        assert!(after.is_some());
    }

    #[tokio::test]
    async fn rollback_failure_preserves_the_callback_error() {
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let mut connection = PgConnection::connect(&url).await.unwrap();
        let error = with_transaction(&mut connection, |conn| {
            Box::pin(async move {
                sqlx::query("CREATE TEMP TABLE rust_failed_rollback (value integer)")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("INSERT INTO rust_failed_rollback VALUES (1)")
                    .execute(&mut *conn)
                    .await?;
                // PostgreSQL closes this connection, so ROLLBACK must fail too.
                let _ = sqlx::query("SELECT pg_terminate_backend(pg_backend_pid())")
                    .execute(&mut *conn)
                    .await;
                Err::<(), _>(sqlx::Error::Protocol("callback root cause".into()))
            })
        })
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "encountered unexpected or invalid data: callback root cause"
        );
    }
}

use ledger_db::engine::DbConnection;

pub(crate) use ledger_db::locks::DbFuture;

/// A transaction on the caller's connection, including a lock's connection.
/// Roll back before returning an error so the connection remains usable.
#[allow(dead_code)]
pub(crate) async fn with_transaction<T, F>(
    connection: &mut DbConnection,
    callback: F,
) -> Result<T, sqlx::Error>
where
    F: for<'a> FnOnce(&'a mut DbConnection) -> DbFuture<'a, T>,
{
    let mut transaction = ledger_db::locks::begin(connection).await?;
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
    use ledger_db::locks::{SessionLock, with_session_lock};

    #[tokio::test]
    async fn lock_and_transaction_use_one_connection_and_rollback_after_write() {
        let database = ledger_db::testing::TempDatabase::new(2).await;
        let pool = database.pool().clone();
        let lock = SessionLock::new(1_000_002, 1);
        let competing_pool = pool.clone();
        let first = with_session_lock(&pool, lock, |conn| {
            Box::pin(async move {
                let second =
                    with_session_lock(&competing_pool, lock, |_| Box::pin(async { Ok(()) }))
                        .await?;
                assert!(
                    second.is_none(),
                    "a second caller cannot take the held lock"
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
                let exists: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'rust_lock_rollback'",
                )
                .fetch_one(&mut *conn)
                .await?;
                assert_eq!(
                    exists, 0,
                    "write and DDL rolled back on the reserved connection"
                );
                Ok(())
            })
        })
        .await
        .unwrap();
        assert!(first.is_some());
        let after = with_session_lock(&pool, lock, |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap();
        assert!(after.is_some(), "lock released after callback");
    }

    #[tokio::test]
    async fn a_cancelled_callback_releases_the_session_lock() {
        let database = ledger_db::testing::TempDatabase::new(1).await;
        let pool = database.pool().clone();
        let lock = SessionLock::new(1_000_003, 1);
        let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
        let active_pool = pool.clone();
        let holder = tokio::spawn(async move {
            let _ = with_session_lock(&active_pool, lock, |_| {
                Box::pin(async move {
                    acquired_tx.send(()).unwrap();
                    std::future::pending::<Result<(), sqlx::Error>>().await
                })
            })
            .await;
        });
        acquired_rx.await.unwrap();
        let held = with_session_lock(&pool, lock, |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap();
        assert!(held.is_none(), "the lock holds while the callback runs");
        holder.abort();
        let _ = holder.await;
        // The pool has one connection: the lock and the connection both came
        // back, or this waits for ever.
        let after = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            with_session_lock(&pool, lock, |_| Box::pin(async { Ok(()) })),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(after.is_some());
    }

    #[tokio::test]
    async fn a_write_transaction_holds_the_write_lock_from_its_start() {
        // BEGIN IMMEDIATE: a second writer waits for the first to end, and
        // cannot fail in the middle of its own transaction.
        let database = ledger_db::testing::TempDatabase::new(2).await;
        let pool = database.pool().clone();
        let mut first = ledger_db::locks::begin_pool(&pool).await.unwrap();
        let second_pool = pool.clone();
        let second = tokio::spawn(async move {
            let started = std::time::Instant::now();
            let transaction = ledger_db::locks::begin_pool(&second_pool).await.unwrap();
            transaction.commit().await.unwrap();
            started.elapsed()
        });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        sqlx::query("CREATE TABLE rust_immediate (value integer)")
            .execute(first.as_mut())
            .await
            .unwrap();
        first.commit().await.unwrap();
        let waited = second.await.unwrap();
        assert!(
            waited >= std::time::Duration::from_millis(250),
            "the second BEGIN waited for the first transaction ({waited:?})"
        );
    }
}

use crate::analytics::PostHogCapture;
use crate::api_key_cache::ApiKeyCache;
use crate::book_changes::BookChangeHub;
use crate::plaid::Plaid;
use crate::rate_limit::RateLimiter;
use crate::tiingo::Tiingo;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: PgPool,
    pub(crate) rate_limits: Arc<RateLimiter>,
    pub(crate) api_keys: Arc<ApiKeyCache>,
    pub(crate) analytics: PostHogCapture,
    pub(crate) scrypt_slots: Arc<Semaphore>,
    pub(crate) tiingo: Tiingo,
    pub(crate) plaid: Plaid,
    pub(crate) book_changes: BookChangeHub,
}

impl AppState {
    pub(crate) fn new(database_url: &str, time_zone: &str) -> Result<Self, sqlx::Error> {
        let time_zone = time_zone.to_owned();
        let pool = PgPoolOptions::new()
            .max_connections(8)
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
            .connect_lazy(database_url)?;
        Ok(Self {
            book_changes: BookChangeHub::new(pool.clone()),
            pool,
            rate_limits: Arc::new(RateLimiter::default()),
            api_keys: Arc::new(ApiKeyCache::default()),
            analytics: PostHogCapture::from_env(),
            scrypt_slots: Arc::new(Semaphore::new(8)),
            tiingo: Tiingo::from_env(),
            plaid: Plaid::from_env(),
        })
    }
}

#[cfg(test)]
pub(crate) fn test_database_url() -> Option<String> {
    match std::env::var("COUNTERPOISE_RUST_TEST_DATABASE_URL") {
        Ok(url) => Some(url),
        Err(_) if std::env::var_os("CI").is_some() => {
            panic!("CI must set COUNTERPOISE_RUST_TEST_DATABASE_URL for PostgreSQL tests")
        }
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn pool_uses_the_app_time_zone_for_dates() {
        let Some(url) = super::test_database_url() else {
            return;
        };
        let state = super::AppState::new(&url, "America/New_York").unwrap();
        let zone: String = sqlx::query_scalar("SELECT current_setting('TimeZone')")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let date: String =
            sqlx::query_scalar("SELECT (TIMESTAMPTZ '2025-01-01 02:00:00+00')::date::text")
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(zone, "America/New_York");
        assert_eq!(date, "2024-12-31");
    }
}

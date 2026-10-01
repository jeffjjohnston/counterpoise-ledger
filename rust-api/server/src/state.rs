use crate::analytics::PostHogCapture;
use crate::api_key_cache::ApiKeyCache;
use crate::book_changes::BookChangeHub;
use crate::plaid::Plaid;
use crate::rate_limit::RateLimiter;
use crate::tiingo::Tiingo;
use ledger_db::engine::DbPool;
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: DbPool,
    pub(crate) rate_limits: Arc<RateLimiter>,
    pub(crate) api_keys: Arc<ApiKeyCache>,
    pub(crate) analytics: PostHogCapture,
    pub(crate) scrypt_slots: Arc<Semaphore>,
    pub(crate) tiingo: Tiingo,
    pub(crate) plaid: Plaid,
    pub(crate) book_changes: BookChangeHub,
    pub(crate) jobs: Arc<JobLocks>,
}

/// One lock for each scheduled job, so that two runs of one job never
/// overlap: a scheduled run and a manual `/api/cron/*` call, or two calls.
#[derive(Default)]
pub(crate) struct JobLocks {
    pub(crate) recurring: tokio::sync::Mutex<()>,
    pub(crate) plaid_sync: tokio::sync::Mutex<()>,
    pub(crate) price_sync: tokio::sync::Mutex<()>,
    pub(crate) typesafe_cleanup: tokio::sync::Mutex<()>,
    /// Backup, prune and reindex: none of them runs while another does.
    pub(crate) maintenance: tokio::sync::Mutex<()>,
}

impl AppState {
    /// The state of a process on the database at `path`. The pool connects
    /// lazily and does not create a missing file: `serve` applies the
    /// migrations first.
    pub(crate) fn new(path: &Path) -> Result<Self, sqlx::Error> {
        let pool = ledger_db::open(ledger_db::Open {
            path,
            max_connections: 8,
            create: false,
        })?;
        Ok(Self::with_pool(pool.clone(), BookChangeHub::new(pool)))
    }

    /// The state around an open pool, for a test.
    pub(crate) fn with_pool(pool: DbPool, book_changes: BookChangeHub) -> Self {
        Self {
            book_changes,
            pool,
            rate_limits: Arc::new(RateLimiter::default()),
            api_keys: Arc::new(ApiKeyCache::default()),
            analytics: PostHogCapture::from_env(),
            scrypt_slots: Arc::new(Semaphore::new(8)),
            tiingo: Tiingo::from_env(),
            plaid: Plaid::from_env(),
            jobs: Arc::new(JobLocks::default()),
        }
    }
}

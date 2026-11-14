use crate::api_key_cache::ApiKeyCache;
use crate::book_changes::BookChangeHub;
use crate::oauth::Issuer;
use crate::plaid::Plaid;
use crate::rate_limit::RateLimiter;
use crate::tiingo::Tiingo;
use ledger_db::Database;
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub(crate) struct AppState {
    /// The database, on the synchronous API (`ledger_db::store`): one
    /// connection that every route, MCP tool and job shares.
    pub(crate) database: Arc<Database>,
    pub(crate) rate_limits: Arc<RateLimiter>,
    pub(crate) api_keys: Arc<ApiKeyCache>,
    pub(crate) scrypt_slots: Arc<Semaphore>,
    pub(crate) tiingo: Tiingo,
    pub(crate) plaid: Plaid,
    pub(crate) book_changes: BookChangeHub,
    /// Wakes the open book sockets when a credential is revoked.
    pub(crate) revocations: crate::revocations::Revocations,
    /// The public origin of OAuth for MCP, from `COUNTERPOISE_PUBLIC_URL`.
    /// `None` turns OAuth off. `Config::from_env` refuses a value that is
    /// not valid, so the server does not start with one.
    pub(crate) oauth: Option<Arc<Issuer>>,
    /// The GitHub client of the issue-sync job.
    pub(crate) issue_sync: crate::issue_sync::github::GitHub,
}

impl AppState {
    /// The state of a process on the database at `path`. It does not create
    /// a missing file: `serve` applies the migrations first.
    #[cfg(feature = "native")]
    pub(crate) fn new(path: &Path) -> Result<Self, ledger_db::store::Error> {
        Ok(Self::from_database(Database::open(path, false)?))
    }

    /// The state around an open database.
    pub(crate) fn from_database(database: Database) -> Self {
        let database = Arc::new(database);
        Self::with_database(database.clone(), BookChangeHub::new(database))
    }

    /// The state of a Durable Object. Its hub does not poll
    /// `change_marks`: a poll every 100 ms would keep the object awake.
    pub(crate) fn hosted(database: Database) -> Self {
        Self::with_database(Arc::new(database), BookChangeHub::detached())
    }

    /// A state on a migrated database in memory, with no change hints: for
    /// a test that needs no file.
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let database = Database::open_in_memory().expect("a database in memory");
        ledger_db::migrate(&database).expect("migrate the database in memory");
        Self::with_database(Arc::new(database), BookChangeHub::detached())
    }

    fn with_database(database: Arc<Database>, book_changes: BookChangeHub) -> Self {
        Self {
            book_changes,
            revocations: Default::default(),
            rate_limits: Arc::new(RateLimiter::new(database.clone())),
            database,
            api_keys: Arc::new(ApiKeyCache::default()),
            scrypt_slots: Arc::new(Semaphore::new(8)),
            tiingo: Tiingo::from_env(),
            plaid: Plaid::from_env(),
            oauth: Issuer::from_env().ok().flatten().map(Arc::new),
            issue_sync: crate::issue_sync::github::GitHub::from_env(),
        }
    }
}

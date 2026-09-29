use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const STAMP_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MAX_CACHE_ENTRIES: usize = 1_000;

pub(crate) type KeyDigest = [u8; 32];
type Flight = Arc<OnceCell<Option<ApiKeyPrincipal>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ApiKeyPrincipal {
    pub(crate) key_id: i32,
    pub(crate) user_id: i32,
}

#[derive(Clone, Copy)]
struct Cached {
    principal: ApiKeyPrincipal,
    verified_at: Instant,
    stamped_at: Option<Instant>,
}

#[derive(Default)]
struct CacheState {
    verified: HashMap<KeyDigest, Cached>,
    in_flight: HashMap<KeyDigest, Flight>,
}

#[derive(Default)]
pub(crate) struct ApiKeyCache {
    state: Mutex<CacheState>,
    #[cfg(test)]
    pub(crate) scrypt_runs: std::sync::atomic::AtomicUsize,
}

impl ApiKeyCache {
    pub(crate) fn flight(&self, digest: KeyDigest) -> Flight {
        self.state
            .lock()
            .expect("API key cache mutex poisoned")
            .in_flight
            .entry(digest)
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    }

    pub(crate) fn finish_flight(&self, digest: KeyDigest, flight: &Flight) {
        let mut state = self.state.lock().expect("API key cache mutex poisoned");
        if state
            .in_flight
            .get(&digest)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            state.in_flight.remove(&digest);
        }
    }

    /// A cached digest still needs a database select on every hit. Revocation
    /// must take effect on the next request, just as it does in Node.
    pub(crate) async fn verified(
        &self,
        digest: KeyDigest,
        pool: &PgPool,
    ) -> Result<Option<ApiKeyPrincipal>, sqlx::Error> {
        let cached = {
            let mut state = self.state.lock().expect("API key cache mutex poisoned");
            match state.verified.get(&digest).copied() {
                Some(entry) if entry.verified_at.elapsed() < CACHE_TTL => Some(entry),
                Some(_) => {
                    state.verified.remove(&digest);
                    None
                }
                None => None,
            }
        };
        let Some(cached) = cached else {
            return Ok(None);
        };
        let still_exists: Option<i32> = sqlx::query_scalar("SELECT id FROM api_keys WHERE id = $1")
            .bind(cached.principal.key_id)
            .fetch_optional(pool)
            .await?;
        if still_exists.is_none() {
            let mut state = self.state.lock().expect("API key cache mutex poisoned");
            if state
                .verified
                .get(&digest)
                .is_some_and(|entry| entry.principal.key_id == cached.principal.key_id)
            {
                state.verified.remove(&digest);
            }
            return Ok(None);
        }
        Ok(Some(cached.principal))
    }

    pub(crate) fn remember(&self, digest: KeyDigest, principal: ApiKeyPrincipal) {
        let mut state = self.state.lock().expect("API key cache mutex poisoned");
        if state.verified.len() >= MAX_CACHE_ENTRIES {
            state.verified.clear();
        }
        state.verified.insert(
            digest,
            Cached {
                principal,
                verified_at: Instant::now(),
                stamped_at: None,
            },
        );
    }

    /// Mark before the UPDATE so a failed informational stamp is not retried
    /// on every request. The database query runs only when this returns true.
    pub(crate) fn stamp_due(&self, digest: KeyDigest) -> bool {
        let mut state = self.state.lock().expect("API key cache mutex poisoned");
        let Some(entry) = state.verified.get_mut(&digest) else {
            return false;
        };
        if entry
            .stamped_at
            .is_some_and(|at| at.elapsed() < STAMP_INTERVAL)
        {
            return false;
        }
        entry.stamped_at = Some(Instant::now());
        true
    }
}

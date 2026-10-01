use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const WINDOW: Duration = Duration::from_secs(15 * 60);
const STEPS: [Duration; 5] = [
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(240),
    Duration::from_secs(480),
    Duration::from_secs(900),
];
const MAX_ENTRIES: usize = 10_000;
const EVICT_TO: usize = 9_000;

#[derive(Clone)]
struct Entry {
    failures: u32,
    window_started: Instant,
    locked_until: Instant,
    consecutive_lockouts: usize,
}

impl Entry {
    fn expiry(&self) -> Instant {
        (self.window_started + WINDOW).max(self.locked_until)
    }
}

#[derive(Default)]
struct Store {
    entries: HashMap<String, Entry>,
    writes_since_sweep: usize,
}

#[derive(Default)]
pub(crate) struct RateLimiter(Mutex<Store>);

pub(crate) struct RateLimitError {
    pub(crate) retry_after_seconds: u64,
}

impl IntoResponse for RateLimitError {
    fn into_response(self) -> Response {
        let seconds = self.retry_after_seconds.to_string();
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": format!("Too many attempts. Try again in {seconds}s.")})),
        )
            .into_response();
        response.headers_mut().insert(
            header::RETRY_AFTER,
            HeaderValue::from_str(&seconds).expect("numeric header"),
        );
        response
    }
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Auth and book-member routes will use the remaining scopes.
pub(crate) enum Scope {
    Login,
    Register,
    Password,
    ApiKey,
    BookMemberAdd,
}

impl Scope {
    fn name(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Register => "register",
            Self::Password => "password",
            Self::ApiKey => "apikey",
            Self::BookMemberAdd => "book-member-add",
        }
    }
}

pub(crate) struct Keys<'a> {
    pub(crate) username: Option<&'a str>,
    pub(crate) ip: Option<&'a str>,
}

impl Keys<'_> {
    fn buckets(&self, scope: Scope) -> Vec<(String, u32)> {
        let mut buckets = Vec::with_capacity(2);
        if let Some(username) = self.username.filter(|s| !s.is_empty()) {
            buckets.push((
                format!(
                    "user:{}:{}",
                    scope.name(),
                    username.to_lowercase().chars().take(64).collect::<String>()
                ),
                5,
            ));
        }
        if let Some(ip) = self.ip.filter(|s| !s.is_empty()) {
            buckets.push((
                format!(
                    "ip:{}:{}",
                    scope.name(),
                    ip.chars().take(64).collect::<String>()
                ),
                20,
            ));
        }
        buckets
    }
}

impl RateLimiter {
    /// Shared HTTP policy for login, registration, password and member-add.
    /// API keys intentionally map a lockout to the caller's 401 response.
    #[allow(dead_code)] // Auth and member routes use this as they move.
    pub(crate) fn enforce(
        &self,
        scope: Scope,
        keys: &Keys<'_>,
        now: Instant,
    ) -> Result<(), RateLimitError> {
        match self.check(scope, keys, now) {
            Some(retry_after_seconds) => Err(RateLimitError {
                retry_after_seconds,
            }),
            None => Ok(()),
        }
    }
    pub(crate) fn check(&self, scope: Scope, keys: &Keys<'_>, now: Instant) -> Option<u64> {
        let store = self.0.lock().expect("rate limit mutex poisoned");
        keys.buckets(scope).iter().find_map(|(key, _)| {
            store.entries.get(key).and_then(|entry| {
                (entry.locked_until > now).then(|| {
                    let remaining = entry.locked_until - now;
                    remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0)
                })
            })
        })
    }

    pub(crate) fn failure(&self, scope: Scope, keys: &Keys<'_>, now: Instant) {
        let mut store = self.0.lock().expect("rate limit mutex poisoned");
        for (key, limit) in keys.buckets(scope) {
            let live = store
                .entries
                .get(&key)
                .filter(|entry| entry.expiry() > now)
                .cloned();
            let mut entry = match live {
                Some(entry) if entry.window_started + WINDOW > now => entry,
                other => Entry {
                    failures: 0,
                    window_started: now,
                    locked_until: now,
                    consecutive_lockouts: other.map_or(0, |entry| entry.consecutive_lockouts),
                },
            };
            entry.failures += 1;
            if entry.failures >= limit {
                entry.locked_until = now + STEPS[entry.consecutive_lockouts.min(STEPS.len() - 1)];
                entry.consecutive_lockouts += 1;
                entry.failures = 0;
                entry.window_started = now;
            }
            store.entries.insert(key, entry);
        }
        store.writes_since_sweep += 1;
        if store.writes_since_sweep >= 512 || store.entries.len() >= MAX_ENTRIES {
            store.writes_since_sweep = 0;
            store.entries.retain(|_, entry| entry.expiry() > now);
            if store.entries.len() > MAX_ENTRIES {
                let mut by_eviction: Vec<_> = store
                    .entries
                    .iter()
                    .map(|(key, entry)| (key.clone(), entry.locked_until > now, entry.expiry()))
                    .collect();
                by_eviction.sort_by_key(|(_, locked, expiry)| (*locked, *expiry));
                let remove_count = store.entries.len() - EVICT_TO;
                for (key, _, _) in by_eviction.into_iter().take(remove_count) {
                    store.entries.remove(&key);
                }
            }
        }
    }

    #[allow(dead_code)] // Login and password routes will use this on success.
    pub(crate) fn success(&self, scope: Scope, keys: &Keys<'_>) {
        if let Some((key, _)) = keys
            .buckets(scope)
            .into_iter()
            .find(|(key, _)| key.starts_with("user:"))
        {
            self.0
                .lock()
                .expect("rate limit mutex poisoned")
                .entries
                .remove(&key);
        }
    }

    pub(crate) fn clear_ip(&self, scope: Scope, keys: &Keys<'_>) {
        if let Some((key, _)) = keys
            .buckets(scope)
            .into_iter()
            .find(|(key, _)| key.starts_with("ip:"))
        {
            self.0
                .lock()
                .expect("rate limit mutex poisoned")
                .entries
                .remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_scope_lockout_and_decay_match_node() {
        let limits = RateLimiter::default();
        let now = Instant::now();
        let keys = Keys {
            username: Some("Alice"),
            ip: None,
        };
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, now);
        }
        assert_eq!(
            limits.check(
                Scope::Login,
                &Keys {
                    username: Some("alice"),
                    ip: None
                },
                now
            ),
            Some(60)
        );
        assert_eq!(limits.check(Scope::Password, &keys, now), None);
        let later = now + Duration::from_secs(120);
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, later);
        }
        assert_eq!(limits.check(Scope::Login, &keys, later), Some(120));
        let quiet = later + Duration::from_secs(1200);
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, quiet);
        }
        assert_eq!(limits.check(Scope::Login, &keys, quiet), Some(60));
    }

    #[test]
    fn addresses_in_one_ipv6_64_share_the_ip_bucket() {
        let limits = RateLimiter::default();
        let now = Instant::now();
        let key = |address: &str| crate::client_ip::rate_limit_key(address);
        let first = key("2001:db8:1:2::1");
        let same_prefix = key("2001:db8:1:2:dead:beef:0:7");
        let other_prefix = key("2001:db8:1:3::1");
        let keys = |ip: &'_ str| -> Vec<(String, u32)> {
            Keys {
                username: None,
                ip: Some(ip),
            }
            .buckets(Scope::Login)
        };
        assert_eq!(keys(&first), keys(&same_prefix));
        assert_ne!(keys(&first), keys(&other_prefix));
        for _ in 0..20 {
            limits.failure(
                Scope::Login,
                &Keys {
                    username: None,
                    ip: Some(&first),
                },
                now,
            );
        }
        let check = |ip: &str| {
            limits.check(
                Scope::Login,
                &Keys {
                    username: None,
                    ip: Some(ip),
                },
                now,
            )
        };
        assert!(check(&same_prefix).is_some());
        assert_eq!(check(&other_prefix), None);
    }

    #[test]
    fn flooding_cannot_remove_an_active_lockout() {
        let limits = RateLimiter::default();
        let now = Instant::now();
        let victim = Keys {
            username: Some("victim"),
            ip: None,
        };
        for _ in 0..5 {
            limits.failure(Scope::Login, &victim, now);
        }
        for i in 0..25_000 {
            let username = format!("flood{i}");
            limits.failure(
                Scope::Login,
                &Keys {
                    username: Some(&username),
                    ip: None,
                },
                now,
            );
        }
        let store = limits.0.lock().unwrap();
        assert!(store.entries.len() <= MAX_ENTRIES);
        drop(store);
        assert_eq!(limits.check(Scope::Login, &victim, now), Some(60));
    }

    #[test]
    fn ip_bucket_survives_username_success_and_api_key_scope_isolated() {
        let limits = RateLimiter::default();
        let now = Instant::now();
        let keys = Keys {
            username: Some("alice"),
            ip: Some("10.0.0.1|cpk_abcd"),
        };
        for _ in 0..20 {
            limits.failure(Scope::ApiKey, &keys, now);
        }
        limits.success(Scope::ApiKey, &keys);
        assert_eq!(limits.check(Scope::ApiKey, &keys, now), Some(60));
        assert_eq!(
            limits.check(
                Scope::ApiKey,
                &Keys {
                    username: None,
                    ip: Some("10.0.0.1|cpk_ffff")
                },
                now
            ),
            None
        );
        limits.clear_ip(Scope::ApiKey, &keys);
        assert_eq!(limits.check(Scope::ApiKey, &keys, now), None);
    }
}

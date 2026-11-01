//! The failure counters and lockouts of logins, registrations, password
//! changes, API keys, member adds and OAuth. They live in the table
//! `rate_limits` (migration `0016_rate_limits.sql`), so a lockout survives a
//! restart, and a Durable Object that hibernates.
//!
//! A failure to read or write the table is logged and lets the request
//! through: the request then reads the same database, and fails on its own.

use axum::{
    Json,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, TimeDelta};
use ledger_db::{
    Database,
    store::{Error, Sql, params},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const WINDOW: TimeDelta = TimeDelta::seconds(15 * 60);
const STEPS: [TimeDelta; 5] = [
    TimeDelta::seconds(60),
    TimeDelta::seconds(120),
    TimeDelta::seconds(240),
    TimeDelta::seconds(480),
    TimeDelta::seconds(900),
];
/// Failures between two deletes of the expired rows. The daily prune job
/// deletes them too.
const PRUNE_EVERY: usize = 512;
/// The rows a prune keeps at most. A flood of distinct buckets (many
/// addresses, or many usernames) inside one window expires nothing, so past
/// this a prune deletes the unlocked rows that expire first, down to
/// `EVICT_TO`. It never deletes an active lockout, so while more than
/// `MAX_ROWS` buckets are locked the table stays above the cap. Between
/// prunes the table can pass it by at most two rows a failure.
const MAX_ROWS: i64 = 10_000;
const EVICT_TO: i64 = 9_000;

#[derive(Clone)]
struct Entry {
    failures: u32,
    window_started: NaiveDateTime,
    locked_until: NaiveDateTime,
    consecutive_lockouts: usize,
}

impl Entry {
    fn expiry(&self) -> NaiveDateTime {
        (self.window_started + WINDOW).max(self.locked_until)
    }
}

pub(crate) struct RateLimiter {
    database: Arc<Database>,
    failures_since_prune: AtomicUsize,
}

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
    /// Each Dynamic Client Registration counts (`oauth/clients.rs`).
    OAuthRegister,
    /// Each failed code or refresh token exchange counts (`oauth/token.rs`).
    OAuthToken,
}

impl Scope {
    fn name(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::Register => "register",
            Self::Password => "password",
            Self::ApiKey => "apikey",
            Self::BookMemberAdd => "book-member-add",
            Self::OAuthRegister => "oauth-register",
            Self::OAuthToken => "oauth-token",
        }
    }
}

pub(crate) struct Keys<'a> {
    pub(crate) username: Option<&'a str>,
    pub(crate) ip: Option<&'a str>,
}

impl Keys<'_> {
    /// Each bucket of the request, with its limit: the user's, then the
    /// address's.
    fn buckets(&self) -> Vec<(String, u32)> {
        let mut buckets = Vec::with_capacity(2);
        if let Some(username) = self.username.filter(|s| !s.is_empty()) {
            buckets.push((
                format!(
                    "user:{}",
                    username.to_lowercase().chars().take(64).collect::<String>()
                ),
                5,
            ));
        }
        if let Some(ip) = self.ip.filter(|s| !s.is_empty()) {
            buckets.push((
                format!("ip:{}", ip.chars().take(64).collect::<String>()),
                20,
            ));
        }
        buckets
    }

    fn bucket(&self, kind: &str) -> Option<String> {
        self.buckets()
            .into_iter()
            .map(|(bucket, _)| bucket)
            .find(|bucket| bucket.starts_with(kind))
    }
}

fn read(sql: &impl Sql, scope: Scope, bucket: &str) -> Result<Option<Entry>, Error> {
    let row: Option<(i64, NaiveDateTime, NaiveDateTime, i64)> = sql.query_optional(
        "SELECT failures, window_started, locked_until, consecutive_lockouts
         FROM rate_limits WHERE scope = ?1 AND bucket = ?2",
        &params![scope.name(), bucket],
    )?;
    Ok(row.map(
        |(failures, window_started, locked_until, consecutive_lockouts)| Entry {
            failures: u32::try_from(failures).unwrap_or(u32::MAX),
            window_started,
            locked_until,
            consecutive_lockouts: usize::try_from(consecutive_lockouts).unwrap_or(usize::MAX),
        },
    ))
}

fn write(sql: &impl Sql, scope: Scope, bucket: &str, entry: &Entry) -> Result<(), Error> {
    sql.execute(
        "INSERT INTO rate_limits
             (scope, bucket, failures, window_started, locked_until, consecutive_lockouts, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (scope, bucket) DO UPDATE SET
             failures = excluded.failures,
             window_started = excluded.window_started,
             locked_until = excluded.locked_until,
             consecutive_lockouts = excluded.consecutive_lockouts,
             expires_at = excluded.expires_at",
        &params![
            scope.name(),
            bucket,
            i64::from(entry.failures),
            entry.window_started,
            entry.locked_until,
            i64::try_from(entry.consecutive_lockouts).unwrap_or(i64::MAX),
            entry.expiry()
        ],
    )?;
    Ok(())
}

impl RateLimiter {
    pub(crate) fn new(database: Arc<Database>) -> Self {
        Self {
            database,
            failures_since_prune: AtomicUsize::new(0),
        }
    }

    /// Shared HTTP policy for login, registration, password and member-add.
    /// API keys intentionally map a lockout to the caller's 401 response.
    pub(crate) fn enforce(
        &self,
        scope: Scope,
        keys: &Keys<'_>,
        now: NaiveDateTime,
    ) -> Result<(), RateLimitError> {
        match self.check(scope, keys, now) {
            Some(retry_after_seconds) => Err(RateLimitError {
                retry_after_seconds,
            }),
            None => Ok(()),
        }
    }

    /// The seconds until the first locked bucket of the request opens.
    pub(crate) fn check(&self, scope: Scope, keys: &Keys<'_>, now: NaiveDateTime) -> Option<u64> {
        keys.buckets().iter().find_map(|(bucket, _)| {
            let entry = match read(&*self.database, scope, bucket) {
                Ok(entry) => entry?,
                Err(cause) => {
                    tracing::error!(%cause, "Error reading the rate limits");
                    return None;
                }
            };
            (entry.locked_until > now).then(|| {
                let remaining = entry.locked_until - now;
                u64::try_from(remaining.num_seconds()).unwrap_or(0)
                    + u64::from(remaining.subsec_nanos() > 0)
            })
        })
    }

    pub(crate) fn failure(&self, scope: Scope, keys: &Keys<'_>, now: NaiveDateTime) {
        let prune = self.failures_since_prune.fetch_add(1, Ordering::Relaxed) + 1 >= PRUNE_EVERY;
        if prune {
            self.failures_since_prune.store(0, Ordering::Relaxed);
        }
        let written = self.database.transaction(|tx| -> Result<(), Error> {
            for (bucket, limit) in keys.buckets() {
                let live = read(tx, scope, &bucket)?.filter(|entry| entry.expiry() > now);
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
                    entry.locked_until =
                        now + STEPS[entry.consecutive_lockouts.min(STEPS.len() - 1)];
                    entry.consecutive_lockouts += 1;
                    entry.failures = 0;
                    entry.window_started = now;
                }
                write(tx, scope, &bucket, &entry)?;
            }
            if prune {
                delete_expired(tx, now)?;
            }
            Ok(())
        });
        if let Err(cause) = written {
            tracing::error!(%cause, "Error recording a rate-limit failure");
        }
    }

    /// A success clears the user's bucket. The address's stays, so one good
    /// login does not hide a spray of guesses at other users.
    pub(crate) fn success(&self, scope: Scope, keys: &Keys<'_>) {
        if let Some(bucket) = keys.bucket("user:") {
            self.delete(scope, &bucket);
        }
    }

    /// A good API key or token clears the bucket of its address and prefix.
    /// It runs on every request with a key, so it writes only when there is
    /// a row to delete.
    pub(crate) fn clear_ip(&self, scope: Scope, keys: &Keys<'_>) {
        let Some(bucket) = keys.bucket("ip:") else {
            return;
        };
        match read(&*self.database, scope, &bucket) {
            Ok(Some(_)) => self.delete(scope, &bucket),
            Ok(None) => {}
            Err(cause) => tracing::error!(%cause, "Error reading the rate limits"),
        }
    }

    /// Deletes the rows that hold nothing at `now`, then evicts down to the
    /// cap.
    pub(crate) fn prune(&self, now: NaiveDateTime) -> Result<u64, Error> {
        delete_expired(&*self.database, now)
    }

    fn delete(&self, scope: Scope, bucket: &str) {
        if let Err(cause) = self.database.execute(
            "DELETE FROM rate_limits WHERE scope = ?1 AND bucket = ?2",
            &params![scope.name(), bucket],
        ) {
            tracing::error!(%cause, "Error clearing a rate limit");
        }
    }
}

fn delete_expired(sql: &impl Sql, now: NaiveDateTime) -> Result<u64, Error> {
    let mut deleted = sql.execute(
        "DELETE FROM rate_limits WHERE expires_at <= ?1",
        &params![now],
    )?;
    let count: i64 = sql.query_row("SELECT COUNT(*) FROM rate_limits", &[])?;
    if count > MAX_ROWS {
        deleted += sql.execute(
            "DELETE FROM rate_limits WHERE rowid IN (
                 SELECT rowid FROM rate_limits WHERE locked_until <= ?1
                 ORDER BY expires_at LIMIT ?2)",
            &params![now, count - EVICT_TO],
        )?;
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter() -> RateLimiter {
        let database = Database::open_in_memory().expect("a database in memory");
        ledger_db::migrate(&database).expect("migrate the database in memory");
        RateLimiter::new(Arc::new(database))
    }

    fn at(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%F %T%.f").unwrap()
    }

    fn rows(limits: &RateLimiter) -> i64 {
        limits
            .database
            .query_row("SELECT COUNT(*) FROM rate_limits", &[])
            .unwrap()
    }

    #[test]
    fn username_scope_lockout_and_decay_match_node() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00.250");
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
        // A part of a second counts as a whole one.
        assert_eq!(
            limits.check(Scope::Login, &keys, now + TimeDelta::milliseconds(500)),
            Some(60)
        );
        assert_eq!(limits.check(Scope::Password, &keys, now), None);
        let later = now + TimeDelta::seconds(120);
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, later);
        }
        assert_eq!(limits.check(Scope::Login, &keys, later), Some(120));
        let quiet = later + TimeDelta::seconds(1200);
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, quiet);
        }
        assert_eq!(limits.check(Scope::Login, &keys, quiet), Some(60));
    }

    #[test]
    fn addresses_in_one_ipv6_64_share_the_ip_bucket() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
        let key = |address: &str| crate::client_ip::rate_limit_key(address);
        let first = key("2001:db8:1:2::1");
        let same_prefix = key("2001:db8:1:2:dead:beef:0:7");
        let other_prefix = key("2001:db8:1:3::1");
        let keys = |ip: &'_ str| -> Vec<(String, u32)> {
            Keys {
                username: None,
                ip: Some(ip),
            }
            .buckets()
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
    fn a_lockout_survives_a_restart_on_the_same_database() {
        let path = std::env::temp_dir().join(format!(
            "counterpoise-rate-limits-{}-{}.db",
            std::process::id(),
            crate::platform::now().timestamp_subsec_nanos()
        ));
        let now = at("2026-10-22 10:00:00");
        let keys = Keys {
            username: Some("victim"),
            ip: Some("10.0.0.9"),
        };
        {
            let database = Database::open(&path, true).unwrap();
            ledger_db::migrate(&database).unwrap();
            let limits = RateLimiter::new(Arc::new(database));
            for _ in 0..5 {
                limits.failure(Scope::Login, &keys, now);
            }
        }
        let limits = RateLimiter::new(Arc::new(Database::open(&path, false).unwrap()));
        let later = now + TimeDelta::seconds(30);
        assert_eq!(limits.check(Scope::Login, &keys, later), Some(30));
        // The count of lockouts survives too: the next one is longer.
        let open = now + TimeDelta::seconds(61);
        for _ in 0..5 {
            limits.failure(Scope::Login, &keys, open);
        }
        assert_eq!(limits.check(Scope::Login, &keys, open), Some(120));
        drop(limits);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_prune_keeps_an_active_lockout() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
        let victim = Keys {
            username: Some("victim"),
            ip: None,
        };
        for _ in 0..5 {
            limits.failure(Scope::Login, &victim, now);
        }
        let flood = now + TimeDelta::seconds(30);
        for i in 0..PRUNE_EVERY + 5 {
            let username = format!("flood{i}");
            limits.failure(
                Scope::Login,
                &Keys {
                    username: Some(&username),
                    ip: None,
                },
                flood,
            );
        }
        assert_eq!(limits.check(Scope::Login, &victim, flood), Some(30));
        // A failure's window lasts 15 minutes; the lockout ended long before.
        let after = flood + WINDOW;
        assert_eq!(limits.prune(after).unwrap(), PRUNE_EVERY as u64 + 6);
        assert_eq!(rows(&limits), 0);
        assert_eq!(limits.check(Scope::Login, &victim, after), None);
    }

    #[test]
    fn a_flood_of_buckets_stays_capped_and_keeps_a_lockout() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
        let victim = Keys {
            username: Some("victim"),
            ip: None,
        };
        for _ in 0..5 {
            limits.failure(Scope::Login, &victim, now);
        }
        // Every row is live, so only the cap deletes any.
        for i in 0..MAX_ROWS + 2 * PRUNE_EVERY as i64 {
            let address = format!("10.{}.{}.{}", i >> 16, (i >> 8) & 255, i & 255);
            limits.failure(
                Scope::ApiKey,
                &Keys {
                    username: None,
                    ip: Some(&address),
                },
                now,
            );
        }
        assert!(rows(&limits) <= MAX_ROWS + PRUNE_EVERY as i64);
        limits.prune(now).unwrap();
        assert!(rows(&limits) <= MAX_ROWS);
        assert_eq!(limits.check(Scope::Login, &victim, now), Some(60));
    }

    #[test]
    fn the_cap_never_evicts_an_active_lockout() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
        let locked = Entry {
            failures: 0,
            window_started: now,
            locked_until: now + STEPS[0],
            consecutive_lockouts: 1,
        };
        limits
            .database
            .transaction(|tx| -> Result<(), Error> {
                for i in 0..MAX_ROWS + 10 {
                    write(tx, Scope::Login, &format!("user:locked{i}"), &locked)?;
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(limits.prune(now).unwrap(), 0);
        assert_eq!(rows(&limits), MAX_ROWS + 10);
    }

    #[test]
    fn the_failure_count_prunes_expired_rows() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
        for i in 0..PRUNE_EVERY - 1 {
            let username = format!("old{i}");
            limits.failure(
                Scope::Login,
                &Keys {
                    username: Some(&username),
                    ip: None,
                },
                now,
            );
        }
        let later = now + WINDOW + TimeDelta::seconds(1);
        limits.failure(
            Scope::Login,
            &Keys {
                username: Some("new"),
                ip: None,
            },
            later,
        );
        assert_eq!(rows(&limits), 1);
    }

    #[test]
    fn ip_bucket_survives_username_success_and_api_key_scope_isolated() {
        let limits = limiter();
        let now = at("2026-10-22 10:00:00");
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
        assert_eq!(rows(&limits), 0);
    }
}

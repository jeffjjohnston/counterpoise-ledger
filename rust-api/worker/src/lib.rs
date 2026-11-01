//! The Cloudflare target: a Worker in front of one Durable Object.
//!
//! The Worker runs first for every path but the hashed chunks of the client
//! build (`wrangler.toml`). It sends the API, `/health` and `/.well-known/`
//! to the object named `ledger`, WebSocket upgrades included, and runs the
//! page session gate of the native server (`security::page_gate`) before it
//! serves a page from the static assets. A page load never wakes the object.
//!
//! [`route`] holds the rules, so the native tests cover them. The Worker and
//! the object build only for wasm32.

#[cfg(target_arch = "wasm32")]
mod object;
#[cfg(target_arch = "wasm32")]
pub mod storage;
#[cfg(target_arch = "wasm32")]
mod worker_entry;

/// Where the Worker sends a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The Durable Object: the API, the health check and the OAuth metadata.
    Object,
    /// The static assets, behind the page session gate.
    Page,
}

/// The [`Route`] of a path. Every path the native server routes goes to the
/// object; the rest are pages and their files.
pub fn route(path: &str) -> Route {
    if path == "/api"
        || path.starts_with("/api/")
        || path == "/health"
        || path.starts_with("/.well-known/")
    {
        Route::Object
    } else {
        Route::Page
    }
}

/// The security headers of each response that passes through the Worker, the
/// object's included: the native server's, with HSTS when `ENABLE_HSTS` is
/// `true`. `_headers` gives the same ones to the files the Worker skips.
pub fn security_headers(hsts: bool) -> impl Iterator<Item = (&'static str, &'static str)> {
    use counterpoise_rust_api::security::{HSTS, SECURITY_HEADERS};
    SECURITY_HEADERS.into_iter().chain(hsts.then_some(HSTS))
}

/// How late the runtime can run an alarm: it can delay one by up to a
/// minute while a failover takes place.
pub const ALARM_DELAY_MS: i64 = 60_000;

/// Whether the object must set its alarm to `at` (all times in
/// milliseconds since the epoch). It must when no alarm is set, when the set
/// alarm comes after `at`, and when the set alarm is late by more than
/// [`ALARM_DELAY_MS`]. The runtime drops an alarm after its last retry, and
/// the storage can still give that alarm's time; no event comes from it, so
/// without this the jobs stop until something else sets the alarm.
pub fn needs_alarm(set: Option<i64>, at: i64, now: i64) -> bool {
    set.is_none_or(|set| set > at || set < now - ALARM_DELAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use counterpoise_rust_api::security::{PageGate, page_gate};
    use http::{HeaderMap, HeaderValue, header::COOKIE};

    #[test]
    fn sends_the_api_health_and_well_known_paths_to_the_object() {
        for path in [
            "/api",
            "/api/health",
            "/api/b/1/socket",
            "/api/mcp",
            "/health",
            "/.well-known/oauth-authorization-server",
        ] {
            assert_eq!(route(path), Route::Object, "{path}");
        }
    }

    #[test]
    fn serves_every_other_path_as_a_page() {
        for path in [
            "/",
            "/login",
            "/b/1/accounts",
            "/apix",
            "/health/x",
            "/favicon.ico",
        ] {
            assert_eq!(route(path), Route::Page, "{path}");
        }
    }

    #[test]
    fn gates_a_page_on_a_session_cookie_only() {
        let mut headers = HeaderMap::new();
        assert_eq!(page_gate("/b/1/accounts", &headers), PageGate::Login);
        assert_eq!(page_gate("/login", &headers), PageGate::Serve);
        assert_eq!(page_gate("/favicon.ico", &headers), PageGate::Serve);
        headers.insert("authorization", HeaderValue::from_static("Bearer cpk_x"));
        assert_eq!(page_gate("/b/1/accounts", &headers), PageGate::Login);
        headers.insert(COOKIE, HeaderValue::from_static("counterpoise_session=abc"));
        assert_eq!(page_gate("/b/1/accounts", &headers), PageGate::Serve);
    }

    #[test]
    fn the_headers_file_gives_the_assets_the_native_headers() {
        let rules: Vec<&str> = include_str!("../_headers")
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .collect();
        assert_eq!(rules[0], "/assets/*");
        let mut set: Vec<(String, String)> = rules[1..]
            .iter()
            .map(|line| {
                let (name, value) = line.trim().split_once(": ").expect("Name: value");
                (name.to_ascii_lowercase(), value.to_string())
            })
            .collect();
        // The chunk names change with their contents, so they are cached
        // for a year, as `static_pages.rs` does.
        let mut expected: Vec<(String, String)> = security_headers(false)
            .chain([("cache-control", "public, max-age=31536000, immutable")])
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        set.sort();
        expected.sort();
        assert_eq!(set, expected);
    }

    #[test]
    fn sets_the_alarm_when_none_is_set_or_the_set_one_is_later() {
        let now = 1_000_000_000;
        assert!(needs_alarm(None, now + 60_000, now));
        assert!(needs_alarm(Some(now + 120_000), now + 60_000, now));
        assert!(!needs_alarm(Some(now + 60_000), now + 60_000, now));
        assert!(!needs_alarm(Some(now + 30_000), now + 60_000, now));
        // An alarm that is due now, or late by less than the runtime's
        // delay, is about to run.
        assert!(!needs_alarm(Some(now - ALARM_DELAY_MS), now, now));
    }

    #[test]
    fn sets_again_an_alarm_that_is_past_and_did_not_run() {
        // The runtime drops an alarm after its last retry, and the storage
        // can still give its time: no event comes from it.
        let now = 1_000_000_000;
        let dropped = now - 65 * 60_000;
        assert!(needs_alarm(Some(dropped), now - 5 * 60_000, now));
        assert!(needs_alarm(
            Some(now - ALARM_DELAY_MS - 1),
            now + 60_000,
            now
        ));
    }

    #[test]
    fn adds_hsts_only_when_asked() {
        let names = |hsts| {
            security_headers(hsts)
                .map(|(name, _)| name)
                .collect::<Vec<_>>()
        };
        assert!(!names(false).contains(&"strict-transport-security"));
        assert!(names(true).contains(&"strict-transport-security"));
        assert!(names(false).contains(&"content-security-policy"));
    }
}

use crate::client_ip::{ProxyTrust, trust_proxy};
use std::{env, path::PathBuf};

pub(crate) struct Config {
    pub(crate) database_url: String,
    pub(crate) bind: String,
    pub(crate) time_zone: String,
    /// Send `Strict-Transport-Security` when `ENABLE_HSTS=true`.
    pub(crate) enable_hsts: bool,
    /// The client build (`vite build` writes it to `build/`). The server
    /// serves it as the pages when `COUNTERPOISE_STATIC_DIR` names it. Without
    /// it, a page request that passes the page gate gets 404.
    pub(crate) static_dir: Option<PathBuf>,
    /// Whether the client address comes from `X-Forwarded-For`, from
    /// `TRUST_PROXY`, `APP_BIND` and `RUST_BIND` (`client_ip.rs`).
    pub(crate) trust_proxy: ProxyTrust,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let bind = env::var("RUST_BIND").unwrap_or_else(|_| "127.0.0.1:4000".to_string());
        let trust_proxy = trust_proxy(
            env::var("TRUST_PROXY").ok().as_deref(),
            env::var("APP_BIND").ok().as_deref(),
            &bind,
        )?;
        Ok(Self {
            database_url: env::var("DATABASE_URL")?,
            bind,
            time_zone: match env::var("TZ") {
                Ok(zone) if !zone.is_empty() => zone,
                _ => iana_time_zone::get_timezone()?,
            },
            enable_hsts: env::var("ENABLE_HSTS").is_ok_and(|value| value == "true"),
            static_dir: env::var_os("COUNTERPOISE_STATIC_DIR")
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from),
            trust_proxy,
        })
    }
}

use crate::client_ip::{ProxyTrust, trust_proxy};
use std::{env, path::PathBuf};

/// The upgrade guide that a PostgreSQL install must follow first.
pub(crate) const UPGRADE_GUIDE: &str =
    "https://github.com/jeffjjohnston/counterpoise-ledger/blob/main/guides/upgrade-to-sqlite.md";

pub(crate) struct Config {
    /// The SQLite database file (`DATABASE_PATH`, default
    /// `data/counterpoise.db`; the image sets `/data/counterpoise.db`).
    pub(crate) database_path: PathBuf,
    pub(crate) bind: String,
    /// Send `Strict-Transport-Security` when `ENABLE_HSTS=true`.
    pub(crate) enable_hsts: bool,
    /// The client build (`vite build` writes it to `build/`). The server
    /// serves it as the pages when `COUNTERPOISE_STATIC_DIR` names it. Without
    /// it, a page request that passes the page gate gets 404.
    pub(crate) static_dir: Option<PathBuf>,
    /// Whether the client address comes from `X-Forwarded-For`, from
    /// `TRUST_PROXY`, `APP_BIND` and `RUST_BIND` (`client_ip.rs`).
    pub(crate) trust_proxy: ProxyTrust,
    /// The public origin for OAuth on `/api/mcp` (`COUNTERPOISE_PUBLIC_URL`).
    /// `None` turns OAuth off; a value that is not an origin stops the start.
    pub(crate) public_url: Option<crate::oauth::Issuer>,
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
            database_path: env::var_os("DATABASE_PATH")
                .filter(|path| !path.is_empty())
                .map_or_else(|| PathBuf::from("data/counterpoise.db"), PathBuf::from),
            bind,
            enable_hsts: env::var("ENABLE_HSTS").is_ok_and(|value| value == "true"),
            static_dir: env::var_os("COUNTERPOISE_STATIC_DIR")
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from),
            trust_proxy,
            public_url: crate::oauth::Issuer::from_env()?,
        })
    }

    /// Refuses to start an install that has not converted its PostgreSQL
    /// data. Such an install still sets `DATABASE_URL`, and it has no
    /// database file yet. Without this refusal it would start with an empty
    /// database, and the user could think that the data is lost.
    pub(crate) fn refuse_unconverted_install(&self) -> Result<(), String> {
        let postgres = env::var("DATABASE_URL").is_ok_and(|url| !url.is_empty());
        if postgres && !self.database_path.exists() {
            return Err(format!(
                "DATABASE_URL is set, and there is no database at {}. This release \
                 stores its data in SQLite. Convert the PostgreSQL data first: see {UPGRADE_GUIDE}. \
                 Remove DATABASE_URL only for a new, empty install.",
                self.database_path.display()
            ));
        }
        Ok(())
    }
}

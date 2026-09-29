mod analytics;
mod api_key_cache;
mod auth;
mod book_auth;
mod book_changes;
mod client_ip;
mod compression;
mod config;
mod cron_auth;
mod db_scope;
mod error;
#[cfg(test)]
mod http_contract_tests;
mod mcp;
mod openapi;
mod plaid;
mod posthog_query;
mod rate_limit;
mod recurring_input;
mod routes;
mod security;
mod state;
mod static_pages;
mod tiingo;
mod tracing_setup;
mod transaction_input;
mod typesafe;
mod typesafe_client;
mod typesafe_questions;
mod validation;

use crate::{
    config::Config,
    routes::{routes, system::validate_version_metadata},
    state::AppState,
};
use std::error::Error;

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("install Ctrl-C handler");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => serve().await,
        Some("mcp") => mcp_stdio().await,
        Some("openapi") => openapi::command(&args[1..]),
        Some(other) => Err(format!(
            "Unknown command: {other}. Usage: counterpoise-rust-api [mcp | openapi [--check] [--out <path>]]"
        )
        .into()),
    }
}

/// `counterpoise-rust-api mcp`: the MCP tools over stdio, for a client that
/// starts the server itself. The key comes from `COUNTERPOISE_API_KEY`.
async fn mcp_stdio() -> Result<(), Box<dyn Error>> {
    tracing_setup::init_stderr();
    validate_version_metadata();
    let config = Config::from_env()?;
    let state = AppState::new(&config.database_url, &config.time_zone)?;
    let key = std::env::var("COUNTERPOISE_API_KEY").ok();
    mcp::stdio(state, key.as_deref()).await
}

/// The server logs this warning one time at startup. This release is the last
/// release that uses PostgreSQL. The next release needs a one-time conversion
/// to SQLite. The book pages show the same text (`LastPostgresNotice.tsx`).
const LAST_POSTGRES_NOTICE: &str = "This is the last Counterpoise release that uses PostgreSQL. \
The next release moves your data to SQLite. That upgrade needs a one-time conversion. \
Read the upgrade guide (guides/upgrade-to-sqlite.md) before you upgrade.";

/// The HTTP server.
async fn serve() -> Result<(), Box<dyn Error>> {
    tracing_setup::init();
    validate_version_metadata();
    let config = Config::from_env()?;
    let state = AppState::new(&config.database_url, &config.time_zone)?;
    let book_changes = state.book_changes.clone();
    let api = routes().with_state(state);
    let app = match &config.static_dir {
        Some(dir) => {
            static_pages::check(dir)?;
            security::protect(api, static_pages::service(dir), config.enable_hsts)
        }
        None => security::protect(api, security::no_pages(), config.enable_hsts),
    };
    let app = compression::compress(app);
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(address = %config.bind, "Rust API listening");
    tracing::warn!("{LAST_POSTGRES_NOTICE}");
    tracing::info!(
        trust_proxy = config.trust_proxy.trusted,
        reason = config.trust_proxy.reason,
        "Client address for rate limits: {}",
        if config.trust_proxy.trusted {
            "X-Forwarded-For"
        } else {
            "TCP peer"
        }
    );
    axum::serve(
        listener,
        client_ip::service(app, config.trust_proxy.trusted),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        // Open event streams would otherwise hold the shutdown open.
        book_changes.close();
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod last_postgres_notice_tests {
    use super::LAST_POSTGRES_NOTICE;

    #[test]
    fn is_one_line_that_names_the_guide() {
        assert!(!LAST_POSTGRES_NOTICE.contains('\n'));
        assert!(LAST_POSTGRES_NOTICE.contains("guides/upgrade-to-sqlite.md"));
        assert!(LAST_POSTGRES_NOTICE.contains("last Counterpoise release that uses PostgreSQL"));
    }
}

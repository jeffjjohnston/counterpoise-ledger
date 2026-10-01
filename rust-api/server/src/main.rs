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
mod health_probe;
#[cfg(test)]
mod http_contract_tests;
mod mcp;
mod openapi;
mod plaid;
mod posthog_query;
mod rate_limit;
mod recurring_input;
mod routes;
mod scheduler;
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
        Some("health") => health(),
        Some(other) => Err(format!(
            "Unknown command: {other}. Usage: counterpoise-rust-api [mcp | health | openapi [--check] [--out <path>]]"
        )
        .into()),
    }
}

/// `counterpoise-rust-api health`: the container healthcheck (see
/// `health_probe`).
fn health() -> Result<(), Box<dyn Error>> {
    let config = Config::from_env()?;
    let status = health_probe::probe(health_probe::probe_address(&config.bind)?)?;
    println!("{status}");
    Ok(())
}

/// `counterpoise-rust-api mcp`: the MCP tools over stdio, for a client that
/// starts the server itself. The key comes from `COUNTERPOISE_API_KEY`.
async fn mcp_stdio() -> Result<(), Box<dyn Error>> {
    tracing_setup::init_stderr();
    validate_version_metadata();
    let config = Config::from_env()?;
    config.refuse_unconverted_install()?;
    // The server owns the file and applies the migrations. This process
    // opens it as a second writer, as `ledger-cli` does.
    if !config.database_path.exists() {
        return Err(format!(
            "no database at {}; start the server once to create it",
            config.database_path.display()
        )
        .into());
    }
    let state = AppState::new(&config.database_path)?;
    let key = std::env::var("COUNTERPOISE_API_KEY").ok();
    mcp::stdio(state, key.as_deref()).await
}

/// The HTTP server.
async fn serve() -> Result<(), Box<dyn Error>> {
    tracing_setup::init();
    validate_version_metadata();
    let config = Config::from_env()?;
    config.refuse_unconverted_install()?;
    if let Some(parent) = config
        .database_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    // Held until the process ends: a second server on this file refuses to
    // start, and its scheduler and change hints would miss this one's. The
    // HTTP tests start more than one server on a file with other settings;
    // only they set COUNTERPOISE_TEST_SHARED_DATABASE.
    let _server_lock = if std::env::var("COUNTERPOISE_TEST_SHARED_DATABASE").is_ok_and(|v| v == "1")
    {
        tracing::warn!("COUNTERPOISE_TEST_SHARED_DATABASE=1: the server lock is off (tests only)");
        None
    } else {
        Some(ledger_db::lock_server(&config.database_path)?)
    };
    let pool = ledger_db::connect(&config.database_path, true)?;
    ledger_db::migrate(&pool).await?;
    // Lots are derived state. The rebuild runs only when the file has
    // splits and no lots (a converted or restored database). A failure
    // stops the start: the server would otherwise show no cost basis.
    let lots = ledger_db::lots::backfill_lots(&pool, false).await?;
    if !lots.skipped {
        tracing::info!(
            pairs = lots.pairs_rebuilt,
            books = lots.books_processed,
            "Lots rebuilt"
        );
    }
    pool.close().await;
    let state = AppState::new(&config.database_path)?;
    let book_changes = state.book_changes.clone();
    if scheduler::enabled() {
        scheduler::start(state.clone());
    }
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

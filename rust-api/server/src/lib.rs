//! The API server as a library. The native binary (`main.rs`) runs it as a
//! process; the Worker crate (`rust-api/worker`) builds it without `native`
//! for a Durable Object.

// Without `native` the Worker crate calls only part of the server so far.
#![cfg_attr(not(feature = "native"), allow(dead_code, unused_imports))]

mod api_key_cache;
mod auth;
mod body;
mod book_auth;
mod book_changes;
mod book_scope;
mod client_ip;
mod compression;
mod config;
mod cron_auth;
mod db_scope;
mod entry_patterns;
mod error;
mod health_probe;
pub mod hosted;
#[cfg(test)]
mod http_contract_tests;
mod issue_sync;
mod leases;
mod mcp;
mod oauth;
mod openapi;
mod plaid;
mod plaid_token_keys;
mod platform;
mod rate_limit;
mod recurring_input;
mod revocations;
mod routes;
mod scheduler;
pub mod security;
mod state;
mod static_pages;
mod tiingo;
mod tracing_setup;
mod transaction_input;
mod typesafe;
mod typesafe_client;
mod typesafe_questions;
mod validation;
mod weekly_review;

use crate::{
    config::Config,
    routes::{routes, system::validate_version_metadata},
    state::AppState,
};
use std::error::Error;

#[cfg(feature = "native")]
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

/// The command line of the native binary: the arguments after its name.
#[cfg(feature = "native")]
pub async fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
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

#[cfg(feature = "native")]
/// `counterpoise-rust-api health`: the container healthcheck (see
/// `health_probe`).
fn health() -> Result<(), Box<dyn Error>> {
    let config = Config::from_env()?;
    let status = health_probe::probe(health_probe::probe_address(&config.bind)?)?;
    println!("{status}");
    Ok(())
}

#[cfg(feature = "native")]
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
    // The server encrypts the stored tokens. This process only refuses a
    // file whose tokens it could not open.
    plaid_token_keys::check(&*state.database, state.plaid.token_keys()?)?;
    let key = std::env::var("COUNTERPOISE_API_KEY").ok();
    mcp::stdio(state, key.as_deref()).await
}

#[cfg(feature = "native")]
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
    let database = ledger_db::Database::open(&config.database_path, true)?;
    ledger_db::migrate(&database)?;
    let interrupted = weekly_review::mark_interrupted(&database)?;
    if interrupted > 0 {
        tracing::warn!(
            interrupted,
            "Weekly reviews stopped by a restart were marked failed"
        );
    }
    // Lots are derived state. The rebuild runs only when the file has
    // splits and no lots (a converted or restored database). A failure
    // stops the start: the server would otherwise show no cost basis.
    let lots = ledger_db::lots::backfill_lots(&database, false)?;
    if !lots.skipped {
        tracing::info!(
            pairs = lots.pairs_rebuilt,
            books = lots.books_processed,
            "Lots rebuilt"
        );
    }
    // The folded columns are derived state: fill new ones and repair any
    // that a write outside the app left stale. The repair runs on the
    // synchronous API, before the server takes requests.
    let folds = ledger_db::folds::repair(&database)?;
    if folds > 0 {
        tracing::info!(values = folds, "Folded columns rewritten");
    }
    // The job status files of an older release become rows of `job_runs`,
    // so the status page keeps the runs from before the upgrade.
    if let Some(dir) = ledger_db::jobs::legacy_status_dir() {
        let copied = ledger_db::jobs::import_status_files(&database, &dir)?;
        if copied > 0 {
            tracing::info!(
                records = copied,
                "Job status files copied into the database"
            );
        }
    }
    // No plaintext Plaid access token stays in the file once a key is set.
    // A token under a key the environment lacks stops the start.
    let token_keys = plaid_token_keys::TokenKeys::from_env()?;
    let prepared = plaid_token_keys::prepare(&database, &token_keys)?;
    if prepared.sealed > 0 {
        tracing::info!(
            tokens = prepared.sealed,
            "Plaid access tokens encrypted with the current key"
        );
    }
    if prepared.plaintext > 0 {
        tracing::warn!(
            tokens = prepared.plaintext,
            "Plaid access tokens are stored in plaintext: set PLAID_TOKEN_KEY (openssl rand -base64 32)"
        );
    }
    let state = AppState::from_database(database);
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
    tracing::info!(zone = %ledger_db::clock::zone(), today = %platform::today(), "App time zone");
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
    match &config.public_url {
        Some(issuer) => tracing::info!(issuer = issuer.origin(), "OAuth for MCP is on"),
        None => tracing::info!("OAuth for MCP is off: COUNTERPOISE_PUBLIC_URL is not set"),
    }
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

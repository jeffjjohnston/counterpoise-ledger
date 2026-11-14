//! The server on a host that owns the database and the requests: the
//! Durable Object of the Worker crate. The host builds the database on its
//! connection, calls [`start`] when the object is constructed, passes each
//! request to the router of the [`App`] that it returns, and runs the
//! scheduled jobs from its alarm ([`App::alarm`]).
//!
//! The steps are those of `serve()` in `lib.rs` that need neither a file nor
//! a listener. Each runs at every construction, so each must be cheap when
//! there is nothing to do: the object is constructed again after each
//! hibernation. The fold repair is not cheap, as it reads every row, so the
//! start leaves it out and the host runs it once per build
//! ([`App::repair_folds`]).

use crate::{
    client_ip, plaid_token_keys,
    routes::{routes, system::validate_version_metadata},
    scheduler, security,
    state::AppState,
    weekly_review,
};
use axum::middleware;
use chrono::{DateTime, Utc};
use ledger_db::{Database, Sql};
use std::error::Error;

mod body_limit;
mod import;
pub mod restore;
mod sockets;
pub use body_limit::{BODY_BYTES, body_limit, import_authorized};
pub use import::PATH as IMPORT_PATH;
pub use sockets::{Attachment, READY, Update, book_tag};

/// The router of an [`App`].
pub type Router = axum::Router;

/// The server that [`start`] returns.
#[derive(Clone)]
pub struct App {
    router: Router,
    state: AppState,
    seen: sockets::Seen,
}

impl App {
    /// The router, which serves each request.
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    /// When the next alarm is due, from the job tables. `setAlarm` replaces
    /// the alarm that is set, so the host sets the alarm to this time and
    /// no other.
    pub fn next_wake(&self) -> DateTime<Utc> {
        scheduler::next_wake(&self.state.database)
    }

    /// Runs one step of the first due job (`crate::scheduler`) and returns
    /// when the next alarm is due.
    pub async fn alarm(&self) -> DateTime<Utc> {
        scheduler::alarm(&self.state).await
    }

    /// Rewrites the stale folds (`ledger_db::folds::repair`). The start
    /// does not: a fold goes stale only when a build changes how a fold is
    /// computed, or when rows come in from outside the write paths, and an
    /// import and a restore repair their rows themselves. So the host runs
    /// this once for each build.
    pub fn repair_folds(&self) -> Result<(), String> {
        repair_folds(&self.state.database).map_err(|cause| cause.to_string())
    }
}

/// Makes the background work that a response has promised keep the object
/// up: `hook` gets that work's promise, for `ctx.waitUntil`.
#[cfg(target_arch = "wasm32")]
pub fn keep_alive_with(hook: impl Fn(js_sys::Promise) + 'static) {
    crate::platform::keep_alive_with(hook);
}

/// Gives the scheduler's backup a bucket: `hook` takes a dump's name and
/// JSON text and returns the promise of its write.
#[cfg(target_arch = "wasm32")]
pub fn export_with(hook: impl Fn(String, Vec<u8>) -> js_sys::Promise + 'static) {
    crate::platform::export_with(hook);
}

/// The steps that read the rows, with the fold repair: they run again after
/// an import and after a restore, whose rows came in after the start.
fn prepare(database: &Database) -> Result<(), Box<dyn Error>> {
    prepare_rows(database)?;
    repair_folds(database)
}

/// The steps of the start that read the rows. Each is cheap when there is
/// nothing to do.
fn prepare_rows(database: &Database) -> Result<(), Box<dyn Error>> {
    // No task of this object runs a review that the file shows as running:
    // an eviction stopped it, or it ran on the server that the dump came
    // from.
    let interrupted = weekly_review::mark_interrupted(database)?;
    if interrupted > 0 {
        tracing::warn!(
            interrupted,
            "Weekly reviews stopped by an eviction were marked failed"
        );
    }
    // A file whose trades are all buys has lots and no allocation, so the
    // guard here is that no lot exists where a buy would open one. A rebuild
    // that the scheduler stopped part way left some lots, so the scheduler
    // also reads the record of the last rebuild.
    let absent = ledger_db::lots::lots_absent(database)?;
    if scheduler::request_lot_rebuild(database, absent)? {
        tracing::warn!(
            lots_absent = absent,
            "The database has trades and no lots, or its last lot rebuild failed: the lot rebuild will run"
        );
    }
    let token_keys = plaid_token_keys::TokenKeys::from_env()?;
    let prepared = plaid_token_keys::prepare(database, &token_keys)?;
    if prepared.plaintext > 0 {
        tracing::warn!(
            tokens = prepared.plaintext,
            "Plaid access tokens are stored in plaintext: set PLAID_TOKEN_KEY"
        );
    }
    Ok(())
}

fn repair_folds(database: &Database) -> Result<(), Box<dyn Error>> {
    let folds = ledger_db::folds::repair(database)?;
    if folds > 0 {
        tracing::info!(values = folds, "Folded columns rewritten");
    }
    Ok(())
}

/// Readies the database and returns the server.
///
/// It turns on `case_sensitive_like` for the connection, applies the
/// migrations, marks the weekly reviews that an eviction stopped, and seals
/// any plaintext Plaid token. It does not repair the folded columns, which
/// reads every row: the host calls [`App::repair_folds`] once per build. It
/// does not rebuild lots, which can outlast the object's start: a file that
/// has trades and no lots, or whose last rebuild failed, asks the scheduler
/// for the stepped lot rebuild, which the next alarm starts.
pub fn start(database: Database) -> Result<App, Box<dyn Error>> {
    #[cfg(target_arch = "wasm32")]
    crate::tracing_setup::init_console();
    validate_version_metadata();
    ledger_db::clock::resolve()?;
    // As `Config::from_env`: a public URL that is not an origin stops the
    // start, rather than turning OAuth off.
    crate::oauth::Issuer::from_env()?;
    database.exec_batch("PRAGMA case_sensitive_like = ON")?;
    ledger_db::migrate(&database)?;
    prepare_rows(&database)?;
    let hsts = ledger_db::env::var("ENABLE_HSTS").is_ok_and(|value| value == "true");
    let state = AppState::hosted(database);
    let api = routes()
        .route(import::PATH, axum::routing::post(import::import))
        .with_state(state.clone());
    // The client's address comes from `CF-Connecting-IP`, never from
    // `X-Forwarded-For`.
    let router = security::protect(api, security::no_pages(), hsts)
        .layer(middleware::from_fn_with_state(false, client_ip::record));
    Ok(App {
        router,
        state,
        seen: sockets::Seen::default(),
    })
}

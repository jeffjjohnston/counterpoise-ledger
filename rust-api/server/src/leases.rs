//! The leases that keep two runs of one job apart: two runs of a scheduled
//! job (a scheduled run and a manual `/api/cron/*` call, or two calls), or
//! two Plaid syncs of one connection. The rows are in `job_leases`
//! (`ledger_db::jobs`), so a lease holds across processes on the file: the
//! MCP stdio process syncs Plaid too.
//!
//! A [`Held`] lease is renewed every [`RENEW_EVERY`] while it lives, and
//! released when it drops, also when the run is cancelled. A process that
//! dies stops renewing: its leases lapse after [`TTL`], and the next run
//! takes them. A process that stops for longer than [`TTL`] (a suspended
//! machine) can find another run holding its lease when it wakes, so a run
//! goes through [`Held::guard`], which stops it once its lease is lost.

use crate::platform;
use ledger_db::{Database, jobs, store::Error};
use std::{future::Future, sync::Arc, time::Duration};
use tokio::sync::watch;

/// How long a lease lasts without a renewal: the most that a crash holds up
/// the next run.
pub(crate) const TTL: Duration = Duration::from_secs(60);

/// How often a held lease is renewed. A third of [`TTL`], so a renewal that
/// is late or fails once does not lose the lease.
pub(crate) const RENEW_EVERY: Duration = Duration::from_secs(20);

/// How often [`wait`] tries again.
const RETRY_EVERY: Duration = Duration::from_millis(250);

/// The lease of one scheduled job. Backup, prune and reindex share
/// `job:maintenance`, so none of them runs while another does.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Job {
    Recurring,
    PlaidSync,
    PriceSync,
    TypesafeCleanup,
    IssueSync,
    WeeklyReview,
    Maintenance,
    LotRebuild,
}

impl Job {
    pub(crate) fn lease_name(self) -> &'static str {
        match self {
            Self::Recurring => "job:recurring",
            Self::PlaidSync => "job:plaid-sync",
            Self::PriceSync => "job:price-sync",
            Self::TypesafeCleanup => "job:typesafe-cleanup",
            Self::IssueSync => "job:issue-sync",
            Self::WeeklyReview => "job:weekly-review",
            Self::Maintenance => "job:maintenance",
            Self::LotRebuild => "job:lot-rebuild",
        }
    }
}

/// The lease of one Plaid connection's sync.
pub(crate) fn plaid_sync(token_id: i32) -> String {
    format!("plaid-sync:{token_id}")
}

/// A lease that this process holds. Dropping it releases it.
pub(crate) struct Held {
    database: Arc<Database>,
    name: String,
    holder: String,
    renewal: platform::Task,
    /// Turns true when a renewal finds that the lease lapsed.
    lost: watch::Receiver<bool>,
}

/// A run stopped because its lease lapsed, and another run may hold it.
#[derive(Debug)]
pub(crate) struct Lost;

impl std::fmt::Display for Lost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the run stopped: its lease lapsed while it ran")
    }
}

impl Held {
    /// Runs `work` while this lease is held. When a renewal finds the lease
    /// lost, `work` is dropped at its next await and the result is
    /// [`Lost`]: two runs must not go on side by side.
    pub(crate) async fn guard<F: Future>(&self, work: F) -> Result<F::Output, Lost> {
        let mut lost = self.lost.clone();
        let lapsed = async move {
            // The renewal ends only once it sends `true`, or when the lease
            // drops, which cannot happen while this borrows it.
            if lost.wait_for(|lost| *lost).await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            biased;
            output = work => Ok(output),
            () = lapsed => Err(Lost),
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.renewal.abort();
        if let Err(cause) = jobs::release(&*self.database, &self.name, &self.holder) {
            // The lease lapses after TTL instead.
            tracing::warn!(lease = %self.name, error = %cause, "Could not release a lease");
        }
    }
}

/// Takes the lease `name`, or returns `None` at once when another run
/// holds it.
pub(crate) fn try_take(database: &Arc<Database>, name: &str) -> Result<Option<Held>, Error> {
    try_take_for(database, name, TTL, RENEW_EVERY)
}

fn try_take_for(
    database: &Arc<Database>,
    name: &str,
    ttl: Duration,
    renew_every: Duration,
) -> Result<Option<Held>, Error> {
    let holder = new_holder()?;
    let now = platform::timestamp();
    if !jobs::acquire(&**database, name, &holder, now, ttl)? {
        return Ok(None);
    }
    let (lose, lost) = watch::channel(false);
    let renewal = platform::spawn(renew(
        database.clone(),
        name.to_owned(),
        holder.clone(),
        ttl,
        renew_every,
        lose,
    ));
    Ok(Some(Held {
        database: database.clone(),
        name: name.to_owned(),
        holder,
        renewal,
        lost,
    }))
}

/// Takes the lease `name`, waiting while another run holds it.
pub(crate) async fn wait(database: &Arc<Database>, name: &str) -> Result<Held, Error> {
    loop {
        if let Some(held) = try_take(database, name)? {
            return Ok(held);
        }
        platform::sleep(RETRY_EVERY).await;
    }
}

async fn renew(
    database: Arc<Database>,
    name: String,
    holder: String,
    ttl: Duration,
    every: Duration,
    lose: watch::Sender<bool>,
) {
    loop {
        platform::sleep(every).await;
        let now = platform::timestamp();
        match jobs::renew(&*database, &name, &holder, now, ttl) {
            Ok(true) => {}
            Ok(false) => {
                // Only a process that stopped for longer than TTL gets here.
                tracing::error!(lease = %name, "A lease lapsed while its run was still going");
                lose.send_replace(true);
                return;
            }
            Err(cause) => tracing::warn!(lease = %name, error = %cause, "Could not renew a lease"),
        }
    }
}

/// A holder name that no other run has: the process name, for a reader of
/// the table, and 64 random bits.
fn new_holder() -> Result<String, Error> {
    let mut bytes = [0_u8; 8];
    platform::random(&mut bytes)
        .map_err(|cause| Error::Invalid(format!("no random holder name: {cause}")))?;
    Ok(format!(
        "{}-{}",
        platform::process_name(),
        u64::from_be_bytes(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Arc<Database> {
        let database = Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        Arc::new(database)
    }

    #[tokio::test]
    async fn a_held_lease_refuses_a_second_run_until_it_drops() {
        let database = database();
        let held = try_take(&database, "job:recurring").unwrap().unwrap();
        assert!(try_take(&database, "job:recurring").unwrap().is_none());
        assert!(try_take(&database, "job:maintenance").unwrap().is_some());
        drop(held);
        assert!(try_take(&database, "job:recurring").unwrap().is_some());
    }

    #[tokio::test]
    async fn a_cancelled_run_releases_its_lease() {
        let database = database();
        let (taken_tx, taken_rx) = tokio::sync::oneshot::channel();
        let holder_database = database.clone();
        let run = tokio::spawn(async move {
            let _held = try_take(&holder_database, "plaid-sync:1").unwrap().unwrap();
            taken_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        taken_rx.await.unwrap();
        assert!(try_take(&database, "plaid-sync:1").unwrap().is_none());
        run.abort();
        let _ = run.await;
        assert!(try_take(&database, "plaid-sync:1").unwrap().is_some());
    }

    /// The renewal keeps a lease past its first expiry while the run goes
    /// on.
    #[tokio::test]
    async fn a_long_run_keeps_its_lease() {
        let database = database();
        let ttl = Duration::from_millis(400);
        let _held = try_take_for(&database, "job:plaid-sync", ttl, Duration::from_millis(100))
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        let now = platform::timestamp();
        assert!(!jobs::acquire(&*database, "job:plaid-sync", "other", now, ttl).unwrap());
    }

    /// A run whose lease another run took stops at its next await.
    #[tokio::test]
    async fn a_run_that_loses_its_lease_stops() {
        let database = database();
        let ttl = Duration::from_millis(200);
        let held = try_take_for(&database, "job:recurring", ttl, Duration::from_millis(50))
            .unwrap()
            .unwrap();
        // As if the process slept past TTL: the lease lapses, and another
        // run takes it before the next renewal.
        let later = platform::timestamp() + chrono::Duration::seconds(5);
        assert!(jobs::acquire(&*database, "job:recurring", "other", later, ttl).unwrap());
        let outcome = tokio::time::timeout(
            Duration::from_secs(2),
            held.guard(std::future::pending::<()>()),
        )
        .await
        .expect("the run stops");
        assert!(matches!(outcome, Err(Lost)));
    }

    #[tokio::test]
    async fn a_run_that_keeps_its_lease_finishes() {
        let database = database();
        let held = try_take(&database, "job:recurring").unwrap().unwrap();
        assert_eq!(held.guard(async { 7 }).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn wait_takes_the_lease_once_it_is_free() {
        let database = database();
        let held = try_take(&database, "job:price-sync").unwrap().unwrap();
        let waiting_database = database.clone();
        let waiter =
            tokio::spawn(async move { wait(&waiting_database, "job:price-sync").await.map(drop) });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished());
        drop(held);
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

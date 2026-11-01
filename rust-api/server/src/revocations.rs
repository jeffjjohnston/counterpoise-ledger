//! The revocation signal: a logout, a deleted API key or a password change
//! in this process tells each open book socket to check its credential
//! again. `state.revocations` holds it, on both targets.

use std::sync::Arc;
use tokio::sync::watch;

/// A signal to every open socket that a credential was revoked in this
/// process. Each socket then checks its own credential again.
#[derive(Clone)]
pub(crate) struct Revocations(Arc<watch::Sender<u64>>);

impl Default for Revocations {
    fn default() -> Self {
        Self(Arc::new(watch::channel(0).0))
    }
}

impl Revocations {
    pub(crate) fn notify(&self) {
        self.0.send_modify(|count| *count = count.wrapping_add(1));
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }

    /// How many revocations this process has seen, for a host that checks
    /// its sockets after each event instead of waiting on [`Self::subscribe`].
    pub(crate) fn count(&self) -> u64 {
        *self.0.borrow()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_revocation_wakes_each_subscriber() {
        let revocations = Revocations::default();
        let (mut first, mut second) = (revocations.subscribe(), revocations.subscribe());
        revocations.clone().notify();
        assert!(first.changed().await.is_ok());
        assert!(second.changed().await.is_ok());
    }
}

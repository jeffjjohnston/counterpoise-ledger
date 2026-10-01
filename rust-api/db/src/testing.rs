//! A throwaway database for tests: a new file with the migrations applied,
//! removed when the value drops.

use crate::{database::sidecar, engine::DbPool};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// A migrated database in a new file under the temporary directory.
pub struct TempDatabase {
    path: PathBuf,
    pool: DbPool,
}

impl TempDatabase {
    /// Creates the file, applies the migrations, and opens a pool of
    /// `max_connections`.
    pub async fn new(max_connections: u32) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "counterpoise-test-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        remove(&path);
        let pool = crate::open(crate::Open {
            path: &path,
            max_connections,
            create: true,
        })
        .expect("open a test database");
        crate::migrate(&pool)
            .await
            .expect("migrate a test database");
        Self { path, pool }
    }

    pub fn pool(&self) -> &DbPool {
        &self.pool
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDatabase {
    fn drop(&mut self) {
        remove(&self.path);
    }
}

fn remove(path: &Path) {
    for suffix in ["", "-wal", "-shm", ".lock"] {
        let _ = std::fs::remove_file(sidecar(path, suffix));
    }
    let _ = std::fs::remove_dir_all(sidecar(path, ".locks"));
}

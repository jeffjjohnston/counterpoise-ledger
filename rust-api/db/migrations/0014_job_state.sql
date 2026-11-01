-- The state of the scheduled jobs, which lived in files beside the database
-- (ledger_db::jobs).
--
-- A lease is held by one run of a job, or by one Plaid sync, at a time. Its
-- holder renews it while the run lasts; a lease whose holder stopped without
-- releasing it (a crash) lapses at expires_at. Both timestamps are UTC text
-- that Rust binds.
CREATE TABLE job_leases (
    name TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- The last run of each job that records its status, as /api/system/status
-- reads it.
CREATE TABLE job_runs (
    job TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL,
    last_ok_at TEXT,
    verified INTEGER CHECK (verified IN (0, 1)),
    bytes INTEGER,
    detail TEXT,
    not_configured INTEGER NOT NULL CHECK (not_configured IN (0, 1))
);

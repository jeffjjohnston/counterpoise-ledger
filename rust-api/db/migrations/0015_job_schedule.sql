-- What the scheduler has run and what it still owes, so that it can find
-- the jobs due now and its next wake from the tables alone
-- (ledger_db::jobs; rust-api/server/src/scheduler/mod.rs).
--
-- A slot is the scheduled minute (UTC text that Rust binds) that a job's
-- latest run serves. A run claims its slot before it starts and finishes it
-- when it ends. A slot that is not finished and whose lease is free is a
-- run that stopped (a crash, or a Workers alarm that failed), and the
-- scheduler runs it again. A job that works in steps (the weekly review,
-- one book per step; the Plaid sync, a few connections per step) keeps in
-- cursor where its next step starts.
CREATE TABLE job_slots (
    job TEXT PRIMARY KEY,
    slot TEXT NOT NULL,
    finished INTEGER NOT NULL CHECK (finished IN (0, 1)),
    cursor TEXT
);

-- A run of a job asked for outside its schedule. The scheduler runs it at
-- its next wake, and the run removes the row when it claims its slot.
CREATE TABLE job_requests (
    job TEXT PRIMARY KEY,
    requested_at TEXT NOT NULL
);

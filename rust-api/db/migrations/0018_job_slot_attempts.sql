-- How many times the scheduler started the current step of a job's run
-- (ledger_db::jobs; rust-api/server/src/scheduler/mod.rs).
--
-- The scheduler adds one before each start of a step. A step that keeps its
-- cursor sets the count back to zero, and so does a new claim. A step that
-- stops before it returns (a Workers alarm that passed its time limit, a
-- panic, a crash) leaves the slot unfinished with its count. The scheduler
-- reads the count to stop a run that never finishes, and to run the other
-- due jobs before a run that has failed to finish.
ALTER TABLE job_slots ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

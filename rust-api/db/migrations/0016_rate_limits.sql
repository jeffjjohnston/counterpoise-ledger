-- The failure counters and lockouts of the rate limiter
-- (rust-api/server/src/rate_limit.rs), which lived in the server's memory.
-- A Durable Object loses its memory when it hibernates, and a lockout must
-- outlive that, and a restart.
--
-- One row per bucket: a scope (login, apikey, ...) and a key (user:<name>
-- or ip:<address>). expires_at is the later of the window's end and
-- locked_until; a row past it holds nothing, and the limiter deletes it.
-- The timestamps are UTC text that Rust binds.
CREATE TABLE rate_limits (
    scope TEXT NOT NULL,
    bucket TEXT NOT NULL,
    failures INTEGER NOT NULL,
    window_started TEXT NOT NULL,
    locked_until TEXT NOT NULL,
    consecutive_lockouts INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (scope, bucket)
);

CREATE INDEX rate_limits_expires_at ON rate_limits (expires_at);

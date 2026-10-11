-- Plaid Hosted Link sessions (rust-api/server/src/routes/plaid_link.rs). The
-- Sync page connects a bank, or reconnects one in update mode, through a
-- Hosted Link URL that opens in a new browser tab. Hosted Link sends no
-- callback to the page, so the server polls /link/token/get for the result.
--
-- The session is in this table, not in the memory of the server, so that a
-- restart during a session does not lose the link token. A session expires
-- four hours after it starts. The server deletes a session one day after it
-- expires.
--
-- The access token of a connection is never in this table. The exchange of
-- the public token writes it directly into plaid_tokens.
--
-- Timestamps are naive UTC text that the Rust code binds, as in 0001.
CREATE TABLE plaid_link_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- The owner who started the session.
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Update mode: the connection to reconnect. NULL for a new connection.
    token_id INTEGER REFERENCES plaid_tokens (id) ON DELETE CASCADE,
    -- The link token that /link/token/create gave. The server sends it only
    -- to Plaid; no response contains it.
    link_token TEXT NOT NULL,
    hosted_link_url TEXT NOT NULL,
    -- 'completing' is the claim of one request that exchanges the result.
    -- A second request that sees it does not exchange again.
    status TEXT NOT NULL CHECK (status IN ('pending', 'completing', 'complete', 'expired', 'failed')),
    -- The connection that the session made or reconnected.
    result_token_id INTEGER REFERENCES plaid_tokens (id) ON DELETE SET NULL,
    -- The message of a failure after the exchange. It is safe to show.
    error TEXT,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_plaid_link_sessions_book ON plaid_link_sessions (book_id);
CREATE INDEX idx_plaid_link_sessions_expires ON plaid_link_sessions (expires_at);

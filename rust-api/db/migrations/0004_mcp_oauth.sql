-- OAuth 2.1 for the MCP endpoint (rust-api/server/src/oauth/). A client such
-- as a claude.ai custom connector gets a token for /api/mcp through the
-- authorization code flow with PKCE, in place of a pasted API key.
--
-- Each secret is stored as the hex SHA-256 of its text, never as the text:
-- codes and tokens are 32 random bytes, so a fast hash is sufficient. The
-- user-chosen password does not apply here, so scrypt is not necessary.
--
-- Timestamps are naive UTC text that the Rust code binds, as in 0001.

-- A client that may ask for a grant. A client from Dynamic Client
-- Registration (RFC 7591) has a client_id that this server made. A client
-- that a Client ID Metadata Document identifies has its HTTPS URL as the
-- client_id, and fetched_at tells when the server last read the document.
-- A client has no user: any user can grant it access. A registered client
-- that has no grant is deleted after one day.
CREATE TABLE oauth_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    -- A JSON array of the exact redirect URIs.
    redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
    metadata_document INTEGER NOT NULL DEFAULT 0 CHECK (metadata_document IN (0, 1)),
    fetched_at TEXT,
    created_at TEXT NOT NULL
);

-- One approval on the consent page: a user lets a client use /api/mcp. The
-- account page lists the grants, and to revoke one deletes it with its
-- codes and tokens. resource is the canonical URI of the MCP endpoint when
-- the grant was made. A token works only while it is the current one.
CREATE TABLE oauth_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_id INTEGER NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_grants_user ON oauth_grants (user_id);
CREATE INDEX idx_oauth_grants_client ON oauth_grants (client_id);

-- An authorization code. It is good for one exchange: used_at records the
-- exchange, and a second exchange revokes the grant.
CREATE TABLE oauth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    grant_id INTEGER NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_codes_grant ON oauth_codes (grant_id);

-- An access token or a refresh token. A refresh token is good for one
-- exchange (rotation): used_at records it. A later exchange of a used
-- refresh token revokes the grant.
CREATE TABLE oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    grant_id INTEGER NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens (grant_id);

-- The access token of a Plaid connection is stored encrypted
-- (rust-api/server/src/plaid_token_keys.rs). This column names the key that
-- encrypted it: eight hex digits of a SHA-256 over the key, never the key.
-- A null means `access_token` is plaintext: a row written before this
-- migration, or a seeded demo connection. The server encrypts those rows at
-- startup when PLAID_TOKEN_KEY is set.
ALTER TABLE plaid_tokens ADD COLUMN access_token_key TEXT;

//! Encryption at rest of `plaid_tokens.access_token`.
//!
//! An access token is a live grant to a bank's data, so the database keeps
//! only its ciphertext: XChaCha20-Poly1305, a pure-Rust authenticated cipher
//! that also builds for wasm32. The key comes from `PLAID_TOKEN_KEY`
//! (32 bytes in base64; `openssl rand -base64 32`). The stored text is the
//! base64 of the 24-byte random nonce and the ciphertext with its tag.
//!
//! `plaid_tokens.access_token_key` names the key that encrypted the row: the
//! first eight hex digits of a SHA-256 over the key, never the key itself. A
//! null names no key, and the text is a plaintext token (a row from before
//! migration 0011, or a seeded demo connection). To rotate, set the new key in
//! `PLAID_TOKEN_KEY` and the old one in `PLAID_TOKEN_KEY_PREVIOUS` (a comma
//! list); the next start encrypts every row again with the new key.
//!
//! Nothing here logs a key or a token. The key type has no `Debug` of its
//! own key bytes.

use crate::error::{ApiError, error_owned};
use crate::platform;
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use ledger_db::{
    Database, Sql,
    store::{self, params},
};
use sha2::{Digest, Sha256};

pub(crate) const KEY_VARIABLE: &str = "PLAID_TOKEN_KEY";
pub(crate) const PREVIOUS_VARIABLE: &str = "PLAID_TOKEN_KEY_PREVIOUS";
/// The message of a write without a key. It names the variable, so the
/// routes answer it as a configuration fault (`is_configuration_error`).
pub(crate) const MISSING_KEY: &str = "PLAID_TOKEN_KEY environment variable not configured";

const NONCE_LEN: usize = 24;
/// Binds each ciphertext to this one use of the key.
const ASSOCIATED_DATA: &[u8] = b"counterpoise plaid_tokens.access_token v1";

struct Key {
    id: String,
    cipher: XChaCha20Poly1305,
}

impl Key {
    fn parse(variable: &str, text: &str) -> Result<Self, String> {
        let bytes = STANDARD.decode(text.trim()).map_err(|_| {
            format!("{variable} must be 32 bytes in base64 (openssl rand -base64 32)")
        })?;
        if bytes.len() != 32 {
            return Err(format!(
                "{variable} must be 32 bytes in base64 (openssl rand -base64 32); it decodes to {} bytes",
                bytes.len()
            ));
        }
        let digest = Sha256::new()
            .chain_update(b"counterpoise plaid token key\0")
            .chain_update(&bytes)
            .finalize();
        Ok(Self {
            id: hex::encode(&digest[..4]),
            cipher: XChaCha20Poly1305::new_from_slice(&bytes).expect("a 32-byte key"),
        })
    }
}

/// The ciphertext of a token and the ID of the key that sealed it: the two
/// columns `access_token` and `access_token_key`.
pub(crate) struct Sealed {
    pub(crate) text: String,
    pub(crate) key_id: String,
}

/// The current key, if one is set, and the previous keys that can still open
/// a row.
pub(crate) struct TokenKeys {
    current: Option<Key>,
    previous: Vec<Key>,
}

impl TokenKeys {
    pub(crate) fn from_env() -> Result<Self, String> {
        let read = |name: &str| {
            ledger_db::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        };
        Self::parse(
            read(KEY_VARIABLE).as_deref(),
            read(PREVIOUS_VARIABLE).as_deref(),
        )
    }

    pub(crate) fn parse(current: Option<&str>, previous: Option<&str>) -> Result<Self, String> {
        let current = current
            .map(|text| Key::parse(KEY_VARIABLE, text))
            .transpose()?;
        let previous = previous
            .into_iter()
            .flat_map(|list| list.split(','))
            .filter(|text| !text.trim().is_empty())
            .map(|text| Key::parse(PREVIOUS_VARIABLE, text))
            .collect::<Result<Vec<_>, _>>()?;
        if current.is_none() && !previous.is_empty() {
            return Err(format!("{PREVIOUS_VARIABLE} is set without {KEY_VARIABLE}"));
        }
        Ok(Self { current, previous })
    }

    /// The ID of the key that new rows get, if one is set.
    pub(crate) fn current_id(&self) -> Option<&str> {
        self.current.as_ref().map(|key| key.id.as_str())
    }

    fn find(&self, id: &str) -> Option<&Key> {
        self.current
            .iter()
            .chain(&self.previous)
            .find(|key| key.id == id)
    }

    /// Encrypts a token with the current key. Without one, the token is not
    /// stored: the caller answers [`MISSING_KEY`].
    pub(crate) fn seal(&self, token: &str) -> Result<Sealed, String> {
        let key = self.current.as_ref().ok_or(MISSING_KEY)?;
        let mut nonce = [0u8; NONCE_LEN];
        platform::random(&mut nonce).map_err(|cause| format!("no random nonce: {cause}"))?;
        let ciphertext = key
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: token.as_bytes(),
                    aad: ASSOCIATED_DATA,
                },
            )
            .map_err(|_| "Could not encrypt the Plaid access token".to_owned())?;
        let mut stored = nonce.to_vec();
        stored.extend_from_slice(&ciphertext);
        Ok(Sealed {
            text: STANDARD.encode(stored),
            key_id: key.id.clone(),
        })
    }

    /// The plaintext token of a stored row. `key_id` is the row's
    /// `access_token_key`; a null means the text is the token.
    pub(crate) fn open(&self, text: &str, key_id: Option<&str>) -> Result<String, String> {
        let Some(key_id) = key_id else {
            return Ok(text.to_owned());
        };
        let key = self.find(key_id).ok_or_else(|| unknown_key(key_id))?;
        let undecodable = || format!("A Plaid access token sealed with key {key_id} does not open");
        let bytes = STANDARD.decode(text).map_err(|_| undecodable())?;
        if bytes.len() < NONCE_LEN {
            return Err(undecodable());
        }
        let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
        let plaintext = key
            .cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: ASSOCIATED_DATA,
                },
            )
            .map_err(|_| undecodable())?;
        String::from_utf8(plaintext).map_err(|_| undecodable())
    }
}

/// The 500 of a route whose token cannot be sealed or opened. The message
/// names a variable or a key ID, never a key or a token.
pub(crate) fn key_failure(message: String) -> ApiError {
    tracing::error!(error = %message, "Plaid access token key failure");
    error_owned(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn unknown_key(key_id: &str) -> String {
    format!(
        "A Plaid access token is encrypted with key {key_id}, which neither {KEY_VARIABLE} nor \
         {PREVIOUS_VARIABLE} holds"
    )
}

/// What [`prepare`] did at startup.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Prepared {
    /// Rows encrypted again: plaintext ones, and ones under a previous key.
    pub(crate) sealed: u64,
    /// Plaintext rows of real connections left as they are, because no key
    /// is set.
    pub(crate) plaintext: u64,
}

/// Refuses a database whose rows name a key that the environment lacks:
/// such a connection could not sync, and a later write could not open it.
pub(crate) fn check(sql: &impl Sql, keys: &TokenKeys) -> Result<(), String> {
    let ids: Vec<String> = sql
        .query(
            "SELECT DISTINCT access_token_key FROM plaid_tokens WHERE access_token_key IS NOT NULL
             ORDER BY access_token_key",
            &[],
        )
        .map_err(|cause| format!("Could not read the Plaid token keys: {cause}"))?;
    match ids.iter().find(|id| keys.find(id).is_none()) {
        Some(id) => Err(format!(
            "{}. Set the key that sealed them, or the server cannot open them.",
            unknown_key(id)
        )),
        None => Ok(()),
    }
}

/// The failure of [`prepare`]: a message, from the database or from a key.
struct Failed(String);

impl From<store::Error> for Failed {
    fn from(cause: store::Error) -> Self {
        Self(format!(
            "Could not encrypt the Plaid access tokens: {cause}"
        ))
    }
}

impl From<String> for Failed {
    fn from(message: String) -> Self {
        Self(message)
    }
}

/// The startup step: [`check`], then, when a key is set, encrypt every row
/// that is plaintext or under a previous key with the current key, in one
/// transaction. Without a key it changes nothing and counts the plaintext
/// rows of real connections, for a warning.
pub(crate) fn prepare(database: &Database, keys: &TokenKeys) -> Result<Prepared, String> {
    check(database, keys)?;
    let Some(current) = keys.current_id() else {
        let plaintext: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM plaid_tokens WHERE access_token_key IS NULL AND is_demo = 0",
                &[],
            )
            .map_err(|cause| Failed::from(cause).0)?;
        return Ok(Prepared {
            sealed: 0,
            plaintext: plaintext as u64,
        });
    };
    database
        .transaction(|tx| {
            let rows: Vec<(i64, String, Option<String>)> = tx.query(
                "SELECT id, access_token, access_token_key FROM plaid_tokens
                 WHERE access_token_key IS NULL OR access_token_key <> ?1 ORDER BY id",
                &params![current],
            )?;
            for (id, text, key_id) in &rows {
                let sealed = keys.seal(&keys.open(text, key_id.as_deref())?)?;
                tx.execute(
                    "UPDATE plaid_tokens SET access_token = ?2, access_token_key = ?3 WHERE id = ?1",
                    &params![id, &sealed.text, &sealed.key_id],
                )?;
            }
            Ok::<_, Failed>(Prepared {
                sealed: rows.len() as u64,
                plaintext: 0,
            })
        })
        .map_err(|failed| failed.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const KEY_B: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

    #[test]
    fn a_sealed_token_opens_and_holds_no_plaintext() {
        let keys = TokenKeys::parse(Some(KEY_A), None).unwrap();
        let sealed = keys.seal("access-sandbox-secret").unwrap();
        assert!(!sealed.text.contains("access-sandbox-secret"));
        assert_eq!(sealed.key_id.len(), 8);
        assert_eq!(keys.current_id(), Some(sealed.key_id.as_str()));
        assert_eq!(
            keys.open(&sealed.text, Some(&sealed.key_id)).unwrap(),
            "access-sandbox-secret"
        );
        // Each seal draws a new nonce.
        assert_ne!(
            keys.seal("access-sandbox-secret").unwrap().text,
            sealed.text
        );
    }

    #[test]
    fn a_null_key_is_a_plaintext_row() {
        let keys = TokenKeys::parse(None, None).unwrap();
        assert_eq!(
            keys.open("demo_access_token", None).unwrap(),
            "demo_access_token"
        );
        assert_eq!(keys.seal("token").err().as_deref(), Some(MISSING_KEY));
    }

    #[test]
    fn a_previous_key_opens_old_rows() {
        let old = TokenKeys::parse(Some(KEY_A), None).unwrap();
        let sealed = old.seal("token").unwrap();
        let rotated = TokenKeys::parse(Some(KEY_B), Some(KEY_A)).unwrap();
        assert_ne!(rotated.current_id(), Some(sealed.key_id.as_str()));
        assert_eq!(
            rotated.open(&sealed.text, Some(&sealed.key_id)).unwrap(),
            "token"
        );
        let without = TokenKeys::parse(Some(KEY_B), None).unwrap();
        assert!(
            without
                .open(&sealed.text, Some(&sealed.key_id))
                .unwrap_err()
                .contains(&sealed.key_id)
        );
    }

    #[test]
    fn a_changed_ciphertext_does_not_open() {
        let keys = TokenKeys::parse(Some(KEY_A), None).unwrap();
        let sealed = keys.seal("token").unwrap();
        let mut bytes = STANDARD.decode(&sealed.text).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        assert!(
            keys.open(&STANDARD.encode(bytes), Some(&sealed.key_id))
                .is_err()
        );
        assert!(keys.open("not base64!", Some(&sealed.key_id)).is_err());
    }

    #[test]
    fn a_bad_key_is_refused_without_echoing_it() {
        for text in ["short", "c2hvcnQ="] {
            let message = TokenKeys::parse(Some(text), None).err().unwrap();
            assert!(
                message.contains(KEY_VARIABLE) && !message.contains(text),
                "{message}"
            );
        }
        assert!(TokenKeys::parse(None, Some(KEY_A)).is_err());
    }

    fn database() -> (Database, i32) {
        let database = Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        database
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', '2026-01-01 00:00:00')",
                &[],
            )
            .unwrap();
        let book_id: i32 = database
            .query_row(
                "INSERT INTO books (user_id, name, created_at, updated_at) VALUES (1, 'Book', '2026-01-01 00:00:00', '2026-01-01 00:00:00') RETURNING id",
                &[],
            )
            .unwrap();
        (database, book_id)
    }

    fn insert(database: &Database, book_id: i32, item: &str, token: &str, is_demo: bool) {
        database
            .execute(
                "INSERT INTO plaid_tokens (book_id, financial_institution, item_id, access_token, is_demo, created_at, updated_at)
                 VALUES (?1, 'Bank', ?2, ?3, ?4, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
                &params![book_id, item, token, is_demo],
            )
            .unwrap();
    }

    fn stored(database: &Database) -> Vec<(String, Option<String>)> {
        database
            .query(
                "SELECT access_token, access_token_key FROM plaid_tokens ORDER BY id",
                &[],
            )
            .unwrap()
    }

    #[test]
    fn startup_encrypts_plaintext_rows_and_rotates_keys() {
        let (database, book_id) = database();
        let pool = &database;
        insert(pool, book_id, "item-1", "access-live-1", false);
        insert(pool, book_id, "item-2", "demo_access_token", true);

        let none = TokenKeys::parse(None, None).unwrap();
        assert_eq!(
            prepare(pool, &none).unwrap(),
            Prepared {
                sealed: 0,
                plaintext: 1
            }
        );

        let first = TokenKeys::parse(Some(KEY_A), None).unwrap();
        assert_eq!(prepare(pool, &first).unwrap().sealed, 2);
        let rows = stored(pool);
        assert!(rows.iter().all(|(text, key)| {
            !text.contains("access") && key.as_deref() == first.current_id()
        }));
        // A second start has nothing left to do.
        assert_eq!(prepare(pool, &first).unwrap().sealed, 0);

        // Without the key that sealed them, the start is refused.
        let missing = check(pool, &none).unwrap_err();
        assert!(missing.contains(first.current_id().unwrap()), "{missing}");
        let other = TokenKeys::parse(Some(KEY_B), None).unwrap();
        assert!(prepare(pool, &other).is_err());

        let rotated = TokenKeys::parse(Some(KEY_B), Some(KEY_A)).unwrap();
        assert_eq!(prepare(pool, &rotated).unwrap().sealed, 2);
        let rows = stored(pool);
        assert!(
            rows.iter()
                .all(|(_, key)| key.as_deref() == rotated.current_id())
        );
        // The old key can go now.
        prepare(pool, &other).unwrap();
        let opened: Vec<String> = rows
            .iter()
            .map(|(text, key)| other.open(text, key.as_deref()).unwrap())
            .collect();
        assert_eq!(opened, ["access-live-1", "demo_access_token"]);
    }
}

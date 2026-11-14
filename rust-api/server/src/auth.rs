use crate::{
    api_key_cache::{ApiKeyPrincipal, KeyDigest},
    client_ip, platform,
    rate_limit::{Keys, Scope},
    state::AppState,
};
use axum::http::{HeaderMap, header};
use ledger_db::{
    Sql,
    store::{self, params},
};
use percent_encoding::percent_decode_str;
use scrypt::{Params, scrypt};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::sync::atomic::Ordering;
use subtle::ConstantTimeEq;

pub(crate) fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let mut token = None;
    for value in headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
    {
        let Some(value) = value.trim().strip_prefix("counterpoise_session=") else {
            continue;
        };
        // Next's cookie parser keeps the last valid duplicate and uses
        // decodeURIComponent, which rejects malformed percent escapes.
        if value.as_bytes().iter().enumerate().all(|(index, byte)| {
            *byte != b'%'
                || value
                    .as_bytes()
                    .get(index + 1)
                    .is_some_and(u8::is_ascii_hexdigit)
                    && value
                        .as_bytes()
                        .get(index + 2)
                        .is_some_and(u8::is_ascii_hexdigit)
        }) && let Ok(decoded) = percent_decode_str(value).decode_utf8()
        {
            token = Some(decoded.into_owned());
        }
    }
    token.filter(|value| !value.is_empty())
}

pub(crate) fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub(crate) async fn run_scrypt(
    state: &AppState,
    secret: String,
    salt: Vec<u8>,
    length: usize,
) -> Result<Vec<u8>, ()> {
    let permit = state
        .scrypt_slots
        .clone()
        .acquire_owned()
        .await
        .expect("scrypt semaphore remains open");
    platform::blocking(move || {
        let _permit = permit;
        // scrypt 0.12 takes the output length from `derived`.
        let params = Params::new(14, 8, 1).map_err(|_| ())?;
        let mut derived = vec![0; length];
        scrypt(secret.as_bytes(), &salt, &params, &mut derived).map_err(|_| ())?;
        Ok(derived)
    })
    .await
    .map_err(|cause| {
        tracing::error!(error = %cause, "Scrypt task failed");
    })?
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let authorization = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let mut words = authorization.split_whitespace();
    let scheme = words.next()?;
    let token = words.next()?;
    (scheme.eq_ignore_ascii_case("bearer") && words.next().is_none()).then_some(token)
}

pub(crate) fn valid_key_shape(key: &str) -> bool {
    key.len() == 52
        && key.starts_with("cpk_")
        && key[4..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

async fn verify_key(state: &AppState, key: &str, stored: &str) -> bool {
    let Some((salt, encoded)) = stored.split_once(':') else {
        return false;
    };
    let Ok(expected) = hex::decode(encoded) else {
        return false;
    };
    if expected.len() != 32 {
        return false;
    }
    let Ok(derived) = run_scrypt(state, key.to_owned(), salt.as_bytes().to_vec(), 32).await else {
        return false;
    };
    bool::from(derived.ct_eq(expected.as_slice()))
}

async fn stamp_if_due(state: &AppState, digest: KeyDigest, key_id: i32) {
    if !state.api_keys.stamp_due(digest) {
        return;
    }
    let now = platform::timestamp();
    if let Err(cause) = state.database.execute(
        "UPDATE api_keys SET last_used_at = ?2
         WHERE id = ?1 AND (last_used_at IS NULL OR last_used_at < ?3)",
        &params![key_id, now, now - chrono::Duration::minutes(5)],
    ) {
        tracing::error!(error = %cause, "Could not stamp API key lastUsedAt");
    }
}

async fn resolve_api_key(
    state: &AppState,
    key: &str,
    digest: KeyDigest,
) -> Result<Option<ApiKeyPrincipal>, store::Error> {
    if let Some(principal) = state.api_keys.verified(digest, &*state.database)? {
        stamp_if_due(state, digest, principal.key_id).await;
        return Ok(Some(principal));
    }
    let candidates: Vec<(i32, i32, String)> = state.database.query(
        "SELECT id, user_id, key_hash FROM api_keys WHERE key_prefix = ?1",
        &params![&key[..8]],
    )?;
    for (key_id, user_id, hash) in candidates {
        // Node's scrypt is asynchronous. Keep its Rust equivalent off Tokio's
        // request workers and bound concurrent checks for known prefixes.
        #[cfg(test)]
        state.api_keys.scrypt_runs.fetch_add(1, Ordering::SeqCst);
        let valid = verify_key(state, key, &hash).await;
        if valid {
            let principal = ApiKeyPrincipal { key_id, user_id };
            state.api_keys.remember(digest, principal);
            stamp_if_due(state, digest, key_id).await;
            return Ok(Some(principal));
        }
    }
    Ok(None)
}

/// The user of a request: the session cookie, else a bearer API key. An
/// OAuth access token counts only during a request of an MCP tool that
/// `/api/mcp` runs (see [`principal_with`]).
pub(crate) async fn principal(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<i32>, store::Error> {
    principal_with(state, headers, crate::mcp::in_oauth_tool_call()).await
}

/// [`principal`], with the choice whether an OAuth access token counts.
///
/// An access token's audience is the MCP endpoint (RFC 8707). Thus only
/// `/api/mcp` and the route requests of the tools that it runs accept one:
/// the same token sent to `/api/books` gets 401. The tool requests go
/// through the router in the same process, so they are part of the MCP
/// request, not a second use of the token.
pub(crate) async fn principal_with(
    state: &AppState,
    headers: &HeaderMap,
    accept_oauth: bool,
) -> Result<Option<i32>, store::Error> {
    if let Some(token) = cookie_token(headers) {
        let digest = token_hash(&token);
        let user_id: Option<i32> = state.database.query_optional(
            "SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
            &params![digest, platform::timestamp()],
        )?;
        if user_id.is_some() {
            return Ok(user_id);
        }
    }

    let Some(key) = bearer_token(headers) else {
        return Ok(None);
    };
    let ip = client_ip::from_headers(headers);
    let limit_id = ip.map(|ip| {
        format!(
            "{}|{}",
            ip.chars().take(64).collect::<String>(),
            key.chars().take(8).collect::<String>()
        )
    });
    let keys = Keys {
        username: None,
        ip: limit_id.as_deref(),
    };
    if state
        .rate_limits
        .check(Scope::ApiKey, &keys, platform::timestamp())
        .is_some()
    {
        return Ok(None);
    }
    if key.starts_with(crate::oauth::ACCESS_TOKEN_PREFIX) {
        let user_id = if accept_oauth {
            crate::oauth::access_token_user(state, key).await?
        } else {
            None
        };
        match user_id {
            Some(_) => state.rate_limits.clear_ip(Scope::ApiKey, &keys),
            None => state
                .rate_limits
                .failure(Scope::ApiKey, &keys, platform::timestamp()),
        }
        return Ok(user_id);
    }
    if !valid_key_shape(key) {
        state
            .rate_limits
            .failure(Scope::ApiKey, &keys, platform::timestamp());
        return Ok(None);
    }
    let digest: KeyDigest = Sha256::digest(key.as_bytes()).into();
    let flight = state.api_keys.flight(digest);
    let resolved = flight
        .get_or_try_init(|| async { resolve_api_key(state, key, digest).await })
        .await
        .copied();
    state.api_keys.finish_flight(digest, &flight);
    match resolved? {
        Some(principal) => {
            state.rate_limits.clear_ip(Scope::ApiKey, &keys);
            Ok(Some(principal.user_id))
        }
        None => {
            state
                .rate_limits
                .failure(Scope::ApiKey, &keys, platform::timestamp());
            Ok(None)
        }
    }
}

pub(crate) async fn session_user(
    state: &AppState,
    headers: &HeaderMap,
    failure: &'static str,
) -> Result<i32, crate::error::ApiError> {
    principal(state, headers)
        .await
        .map_err(|cause| crate::error::internal_error(cause, failure))?
        .ok_or_else(|| {
            crate::error::error(axum::http::StatusCode::UNAUTHORIZED, "Not authenticated")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stored password and API key hashes must still verify after a change
    /// to the scrypt crate. Node's `crypto.scryptSync` (N = 16384, r = 8,
    /// p = 1) and scrypt 0.11 give these values.
    #[test]
    fn scrypt_gives_the_known_answers() {
        let params = Params::new(14, 8, 1).unwrap();
        let mut password = [0_u8; 64];
        scrypt(b"password", b"known-answer-salt", &params, &mut password).unwrap();
        assert_eq!(
            hex::encode(password),
            "eeae34c9671de2203ed4c2cc12164acd85bd7a4d50d59a7f745a63062ebabc927e14aeaa1179548ffc1537ec4539ec9bc844d5098e7c362ac8bf9bc9230948ca"
        );
        let mut key = [0_u8; 32];
        scrypt(b"cpk_known", b"known-answer-salt", &params, &mut key).unwrap();
        assert_eq!(
            hex::encode(key),
            "7b220aa9355456b6ad11585e9c0e46e93019d4a61565eeacad163a351ed4829f"
        );
    }

    #[test]
    fn cookie_parser_uses_last_valid_decoded_value() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "counterpoise_session=stale; counterpoise_session=%41%42"
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie_token(&headers).as_deref(), Some("AB"));
        headers.insert(
            header::COOKIE,
            "counterpoise_session=valid; counterpoise_session=%ZZ"
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie_token(&headers).as_deref(), Some("valid"));
    }

    #[tokio::test]
    async fn verified_key_is_coalesced_cached_and_checked_for_revocation() {
        let state = AppState::in_memory();
        let database = &state.database;
        database
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at)
                 VALUES (7, 'cache-test', 'unused', '2026-10-21 00:00:00')",
                &[],
            )
            .unwrap();
        let key = format!("cpk_{}", "a".repeat(48));
        let salt = "cache-test-salt";
        let mut derived = [0_u8; 32];
        scrypt(
            key.as_bytes(),
            salt.as_bytes(),
            &Params::new(14, 8, 1).unwrap(),
            &mut derived,
        )
        .unwrap();
        let hash = format!("{salt}:{}", hex::encode(derived));
        database
            .execute(
                "INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
                 VALUES (11, 7, 'cache test', ?1, ?2, '2026-10-21 00:00:00')",
                &params![hash, &key[..8]],
            )
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {key}").parse().unwrap(),
        );
        headers.insert(
            client_ip::CLIENT_IP_HEADER,
            "198.51.100.77".parse().unwrap(),
        );
        let (a, b, c) = tokio::join!(
            principal(&state, &headers),
            principal(&state, &headers),
            principal(&state, &headers)
        );
        assert_eq!(a.unwrap(), Some(7));
        assert_eq!(b.unwrap(), Some(7));
        assert_eq!(c.unwrap(), Some(7));
        assert_eq!(state.api_keys.scrypt_runs.load(Ordering::SeqCst), 1);
        let first_stamp: chrono::NaiveDateTime = database
            .query_row("SELECT last_used_at FROM api_keys WHERE id = 11", &[])
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(principal(&state, &headers).await.unwrap(), Some(7));
        assert_eq!(state.api_keys.scrypt_runs.load(Ordering::SeqCst), 1);
        let cached_stamp: chrono::NaiveDateTime = database
            .query_row("SELECT last_used_at FROM api_keys WHERE id = 11", &[])
            .unwrap();
        assert_eq!(cached_stamp, first_stamp);
        database
            .execute("DELETE FROM api_keys WHERE id = 11", &[])
            .unwrap();
        assert_eq!(principal(&state, &headers).await.unwrap(), None);
    }
}

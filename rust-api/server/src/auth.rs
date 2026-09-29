use crate::{
    api_key_cache::{ApiKeyPrincipal, KeyDigest},
    client_ip,
    rate_limit::{Keys, Scope},
    state::AppState,
};
use axum::http::{HeaderMap, header};
use percent_encoding::percent_decode_str;
use scrypt::{Params, scrypt};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::time::Instant;
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
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let params = Params::new(14, 8, 1, length).map_err(|_| ())?;
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

fn valid_key_shape(key: &str) -> bool {
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
    if let Err(cause) = sqlx::query!(
        "UPDATE api_keys SET last_used_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '5 minutes')",
        key_id
    )
    .execute(&state.pool)
    .await
    {
        tracing::error!(error = %cause, "Could not stamp API key lastUsedAt");
    }
}

async fn resolve_api_key(
    state: &AppState,
    key: &str,
    digest: KeyDigest,
) -> Result<Option<ApiKeyPrincipal>, sqlx::Error> {
    if let Some(principal) = state.api_keys.verified(digest, &state.pool).await? {
        stamp_if_due(state, digest, principal.key_id).await;
        return Ok(Some(principal));
    }
    let candidates = sqlx::query!(
        "SELECT id, user_id, key_hash FROM api_keys WHERE key_prefix = $1",
        &key[..8]
    )
    .fetch_all(&state.pool)
    .await?;
    for row in candidates {
        let (key_id, user_id, hash) = (row.id, row.user_id, row.key_hash);
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

pub(crate) async fn principal(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<i32>, sqlx::Error> {
    if let Some(token) = cookie_token(headers) {
        let digest = token_hash(&token);
        let user_id = sqlx::query!(
            "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
            digest
        )
        .fetch_optional(&state.pool)
        .await?
        .map(|row| row.user_id);
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
        .check(Scope::ApiKey, &keys, Instant::now())
        .is_some()
    {
        return Ok(None);
    }
    if !valid_key_shape(key) {
        state
            .rate_limits
            .failure(Scope::ApiKey, &keys, Instant::now());
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
                .failure(Scope::ApiKey, &keys, Instant::now());
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
    use sqlx::postgres::PgPoolOptions;

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
        let Some(url) = crate::state::test_database_url() else {
            return;
        };
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("CREATE TEMP TABLE api_keys (id integer, user_id integer, key_hash text, key_prefix text, last_used_at timestamp)")
            .execute(&pool).await.unwrap();
        let key = format!("cpk_{}", "a".repeat(48));
        let salt = "cache-test-salt";
        let mut derived = [0_u8; 32];
        scrypt(
            key.as_bytes(),
            salt.as_bytes(),
            &Params::new(14, 8, 1, 32).unwrap(),
            &mut derived,
        )
        .unwrap();
        let hash = format!("{salt}:{}", hex::encode(derived));
        sqlx::query(
            "INSERT INTO api_keys (id, user_id, key_hash, key_prefix) VALUES (11, 7, $1, $2)",
        )
        .bind(hash)
        .bind(&key[..8])
        .execute(&pool)
        .await
        .unwrap();
        let mut state = AppState::new(&url, "UTC").unwrap();
        state.pool = pool.clone();
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
        let first_stamp: chrono::NaiveDateTime =
            sqlx::query_scalar("SELECT last_used_at FROM api_keys WHERE id = 11")
                .fetch_one(&pool)
                .await
                .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(principal(&state, &headers).await.unwrap(), Some(7));
        assert_eq!(state.api_keys.scrypt_runs.load(Ordering::SeqCst), 1);
        let cached_stamp: chrono::NaiveDateTime =
            sqlx::query_scalar("SELECT last_used_at FROM api_keys WHERE id = 11")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cached_stamp, first_stamp);
        sqlx::query("DELETE FROM api_keys WHERE id = 11")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(principal(&state, &headers).await.unwrap(), None);
    }
}

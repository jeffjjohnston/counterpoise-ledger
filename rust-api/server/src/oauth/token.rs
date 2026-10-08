//! The token endpoint (`POST /api/oauth/token`) and the revocation endpoint
//! (`POST /api/oauth/revoke`, RFC 7009). Both take
//! `application/x-www-form-urlencoded` bodies.
//!
//! - A code is good for one exchange, for five minutes, with the
//!   `code_verifier` whose S256 digest is the code's challenge, by the client
//!   that got it, with the same redirect URI. A second exchange of a code
//!   revokes its grant (OAuth 2.1 section 4.1.3).
//! - A refresh token is good for one exchange: each exchange gives a new
//!   access token and a new refresh token (rotation, which the specification
//!   requires for a public client). A used refresh token sent again within
//!   [`REFRESH_REUSE_GRACE_SECONDS`] gets `invalid_grant`, so a retry after
//!   a timeout costs the client nothing. Later, a second use means that a
//!   copy of the token leaked, and the grant is revoked.
//! - Failed exchanges count against a per-address limit.

use super::{
    ACCESS_TOKEN_PREFIX, ACCESS_TOKEN_SECONDS, REFRESH_REUSE_GRACE_SECONDS, REFRESH_TOKEN_DAYS,
    REFRESH_TOKEN_PREFIX, SCOPE, new_secret, no_store, not_configured, now, oauth_error, sweep,
};
use crate::{
    auth::token_hash,
    client_ip,
    rate_limit::{Keys, Scope},
    state::AppState,
};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, NaiveDateTime};
use ledger_db::locks::begin_pool;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Instant};
use subtle::ConstantTimeEq;

/// The form parameters, or `None` when one occurs twice.
fn form(body: &[u8]) -> Option<HashMap<String, String>> {
    let mut parameters = HashMap::new();
    for (name, value) in url::form_urlencoded::parse(body) {
        if parameters
            .insert(name.into_owned(), value.into_owned())
            .is_some()
        {
            return None;
        }
    }
    Some(parameters)
}

/// True when `verifier` is a PKCE verifier (RFC 7636 section 4.1) and its
/// S256 digest is `challenge`.
fn pkce_matches(verifier: &str, challenge: &str) -> bool {
    let shape = (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    shape && bool::from(digest.as_bytes().ct_eq(challenge.as_bytes()))
}

/// Why an exchange fails, with its OAuth error code.
struct Refused {
    code: &'static str,
    description: &'static str,
}

const fn refused(code: &'static str, description: &'static str) -> Refused {
    Refused { code, description }
}

const BAD_GRANT: Refused = refused(
    "invalid_grant",
    "The code or refresh token is not valid, has expired, or was revoked",
);

/// `POST /api/oauth/token`.
pub(super) async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(issuer) = state.oauth.clone() else {
        return not_configured();
    };
    let ip = client_ip::from_headers(&headers);
    let keys = Keys { username: None, ip };
    if let Err(limited) = state
        .rate_limits
        .enforce(Scope::OAuthToken, &keys, Instant::now())
    {
        return limited.into_response();
    }
    let result = match form(&body) {
        None => Err(refused(
            "invalid_request",
            "A parameter occurs more than once",
        )),
        Some(parameters) => {
            if let Some(resource) = parameters.get("resource")
                && !issuer.names_this_server(resource)
            {
                Err(refused(
                    "invalid_target",
                    "This server issues tokens only for its own MCP endpoint",
                ))
            } else {
                match parameters.get("grant_type").map(String::as_str) {
                    Some("authorization_code") => {
                        sweep(&state).await;
                        authorization_code(&state, &parameters).await
                    }
                    Some("refresh_token") => {
                        refresh_token(&state, &issuer.resource(), &parameters).await
                    }
                    Some(_) => Err(refused(
                        "unsupported_grant_type",
                        "grant_type must be authorization_code or refresh_token",
                    )),
                    None => Err(refused("invalid_request", "The request has no grant_type")),
                }
            }
        }
    };
    match result {
        Ok(response) => {
            state.rate_limits.clear_ip(Scope::OAuthToken, &keys);
            response
        }
        Err(refusal) => {
            if refusal.code == "invalid_grant" {
                state
                    .rate_limits
                    .failure(Scope::OAuthToken, &keys, Instant::now());
            }
            oauth_error(StatusCode::BAD_REQUEST, refusal.code, refusal.description)
        }
    }
}

fn required<'a>(
    parameters: &'a HashMap<String, String>,
    name: &'static str,
    description: &'static str,
) -> Result<&'a str, Refused> {
    parameters
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(refused("invalid_request", description))
}

fn database(cause: sqlx::Error) -> Refused {
    tracing::error!(error = %cause, "OAuth token request failed");
    refused("server_error", "The server could not complete the request")
}

/// Revokes a grant: its codes and tokens go with it.
async fn revoke_grant(state: &AppState, grant_id: i32, reason: &str) {
    tracing::warn!(grant_id, reason, "Revoking an OAuth grant");
    if let Err(cause) = sqlx::query("DELETE FROM oauth_grants WHERE id = $1")
        .bind(grant_id)
        .execute(&state.pool)
        .await
    {
        tracing::error!(error = %cause, "Could not revoke an OAuth grant");
    }
}

#[derive(sqlx::FromRow)]
struct CodeRow {
    id: i32,
    grant_id: i32,
    redirect_uri: String,
    code_challenge: String,
    expires_at: NaiveDateTime,
    used_at: Option<NaiveDateTime>,
    client_id: String,
}

#[derive(sqlx::FromRow)]
struct RefreshRow {
    id: i32,
    grant_id: i32,
    expires_at: NaiveDateTime,
    used_at: Option<NaiveDateTime>,
    client_id: String,
    resource: String,
}

async fn authorization_code(
    state: &AppState,
    parameters: &HashMap<String, String>,
) -> Result<Response, Refused> {
    let code = required(parameters, "code", "The request has no code")?;
    let verifier = required(
        parameters,
        "code_verifier",
        "PKCE is required: the request has no code_verifier",
    )?;
    let client_id = required(parameters, "client_id", "The request has no client_id")?;
    // OAuth 2.1 removes redirect_uri from the code exchange, because PKCE
    // binds the code to the client. An OAuth 2.0 client still sends it, and
    // then it must agree with the authorization request.
    let redirect_uri = parameters.get("redirect_uri").map(String::as_str);
    let row: Option<CodeRow> = sqlx::query_as(
        "SELECT c.id, c.grant_id, c.redirect_uri, c.code_challenge, c.expires_at, c.used_at,
                    oc.client_id
             FROM oauth_codes c
             JOIN oauth_grants g ON g.id = c.grant_id
             JOIN oauth_clients oc ON oc.id = g.client_id
             WHERE c.code_hash = $1",
    )
    .bind(token_hash(code))
    .fetch_optional(&state.pool)
    .await
    .map_err(database)?;
    let Some(CodeRow {
        id: code_id,
        grant_id,
        redirect_uri: code_redirect,
        code_challenge: challenge,
        expires_at,
        used_at,
        client_id: owner,
    }) = row
    else {
        return Err(BAD_GRANT);
    };
    if used_at.is_some() {
        revoke_grant(state, grant_id, "an authorization code was used twice").await;
        return Err(BAD_GRANT);
    }
    if expires_at <= now()
        || owner != client_id
        || redirect_uri.is_some_and(|uri| uri != code_redirect)
        || !pkce_matches(verifier, &challenge)
    {
        return Err(BAD_GRANT);
    }
    let now = now();
    let mut transaction = begin_pool(&state.pool).await.map_err(database)?;
    let marked =
        sqlx::query("UPDATE oauth_codes SET used_at = $2 WHERE id = $1 AND used_at IS NULL")
            .bind(code_id)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(database)?;
    if marked.rows_affected() != 1 {
        drop(transaction);
        revoke_grant(state, grant_id, "an authorization code was used twice").await;
        return Err(BAD_GRANT);
    }
    let response = issue(&mut transaction, grant_id, now).await?;
    transaction.commit().await.map_err(database)?;
    Ok(response)
}

async fn refresh_token(
    state: &AppState,
    resource: &str,
    parameters: &HashMap<String, String>,
) -> Result<Response, Refused> {
    let token = required(
        parameters,
        "refresh_token",
        "The request has no refresh_token",
    )?;
    let client_id = required(parameters, "client_id", "The request has no client_id")?;
    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT t.id, t.grant_id, t.expires_at, t.used_at, oc.client_id, g.resource
             FROM oauth_tokens t
             JOIN oauth_grants g ON g.id = t.grant_id
             JOIN oauth_clients oc ON oc.id = g.client_id
             WHERE t.token_hash = $1 AND t.kind = 'refresh'",
    )
    .bind(token_hash(token))
    .fetch_optional(&state.pool)
    .await
    .map_err(database)?;
    let Some(RefreshRow {
        id: token_id,
        grant_id,
        expires_at,
        used_at,
        client_id: owner,
        resource: grant_resource,
    }) = row
    else {
        return Err(BAD_GRANT);
    };
    let now = now();
    if let Some(used_at) = used_at {
        if now - used_at > Duration::seconds(REFRESH_REUSE_GRACE_SECONDS) {
            revoke_grant(state, grant_id, "a used refresh token was sent again").await;
        }
        return Err(BAD_GRANT);
    }
    if expires_at <= now || owner != client_id || grant_resource != resource {
        return Err(BAD_GRANT);
    }
    let mut transaction = begin_pool(&state.pool).await.map_err(database)?;
    let marked =
        sqlx::query("UPDATE oauth_tokens SET used_at = $2 WHERE id = $1 AND used_at IS NULL")
            .bind(token_id)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(database)?;
    if marked.rows_affected() != 1 {
        return Err(BAD_GRANT);
    }
    let response = issue(&mut transaction, grant_id, now).await?;
    transaction.commit().await.map_err(database)?;
    Ok(response)
}

/// Stores a new access token and refresh token for a grant, and gives the
/// token response (RFC 6749 section 5.1).
async fn issue(
    transaction: &mut sqlx::Transaction<'_, ledger_db::engine::Db>,
    grant_id: i32,
    now: NaiveDateTime,
) -> Result<Response, Refused> {
    let unavailable = |_| refused("server_error", "Could not make a token");
    let access = new_secret(ACCESS_TOKEN_PREFIX).map_err(unavailable)?;
    let refresh = new_secret(REFRESH_TOKEN_PREFIX).map_err(unavailable)?;
    for (secret, kind, expires_at) in [
        (
            &access,
            "access",
            now + Duration::seconds(ACCESS_TOKEN_SECONDS),
        ),
        (
            &refresh,
            "refresh",
            now + Duration::days(REFRESH_TOKEN_DAYS),
        ),
    ] {
        sqlx::query(
            "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(token_hash(secret))
        .bind(grant_id)
        .bind(kind)
        .bind(expires_at)
        .bind(now)
        .execute(&mut **transaction)
        .await
        .map_err(database)?;
    }
    Ok(no_store(
        Json(json!({
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_SECONDS,
            "refresh_token": refresh,
            "scope": SCOPE,
        }))
        .into_response(),
    ))
}

/// `POST /api/oauth/revoke` (RFC 7009). To revoke a refresh token revokes
/// its grant; to revoke an access token deletes that token only. The answer
/// is 200 for an unknown token too, as the RFC tells. When the request names
/// a `client_id`, it must be the client of the token.
pub(super) async fn revoke(State(state): State<AppState>, body: Bytes) -> Response {
    if state.oauth.is_none() {
        return not_configured();
    }
    let Some(parameters) = form(&body) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "A parameter occurs more than once",
        );
    };
    let Some(token) = parameters.get("token").filter(|token| !token.is_empty()) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The request has no token",
        );
    };
    let row: Result<Option<(i32, i32, String, String)>, _> = sqlx::query_as(
        "SELECT t.id, t.grant_id, t.kind, oc.client_id
         FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
         JOIN oauth_clients oc ON oc.id = g.client_id
         WHERE t.token_hash = $1",
    )
    .bind(token_hash(token))
    .fetch_optional(&state.pool)
    .await;
    match row {
        Ok(Some((token_id, grant_id, kind, owner))) => {
            if parameters
                .get("client_id")
                .is_some_and(|client_id| *client_id != owner)
            {
                return oauth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_client",
                    "The token belongs to another client",
                );
            }
            let deleted = if kind == "refresh" {
                sqlx::query("DELETE FROM oauth_grants WHERE id = $1")
                    .bind(grant_id)
                    .execute(&state.pool)
                    .await
            } else {
                sqlx::query("DELETE FROM oauth_tokens WHERE id = $1")
                    .bind(token_id)
                    .execute(&state.pool)
                    .await
            };
            if let Err(cause) = deleted {
                tracing::error!(error = %cause, "Could not revoke an OAuth token");
                return oauth_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "temporarily_unavailable",
                    "Could not revoke the token",
                );
            }
            StatusCode::OK.into_response()
        }
        Ok(None) => StatusCode::OK.into_response(),
        Err(cause) => {
            tracing::error!(error = %cause, "Could not read an OAuth token");
            oauth_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "temporarily_unavailable",
                "Could not revoke the token",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_uses_the_s256_digest_of_the_verifier() {
        // The example of RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(pkce_matches(verifier, challenge));
        assert!(!pkce_matches(
            verifier,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN"
        ));
        assert!(!pkce_matches("short", challenge));
        assert!(!pkce_matches(challenge, challenge));
    }

    #[test]
    fn a_form_parameter_may_occur_once() {
        assert_eq!(form(b"grant_type=refresh_token&a=%20b").unwrap()["a"], " b");
        assert!(form(b"a=1&a=2").is_none());
    }
}

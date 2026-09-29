use crate::{
    auth::{cookie_token, principal, run_scrypt, token_hash},
    client_ip,
    error::{ApiError, error, internal_error},
    rate_limit::{Keys, Scope},
    state::AppState,
    validation::parse_json_body,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{Duration, NaiveDateTime, SecondsFormat, Utc};
use getrandom::fill;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Instant;
use subtle::ConstantTimeEq;

const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
const REGISTRATION_LOCK_ID: i64 = 4_242_424_242;

fn json_response(body: Value) -> Response {
    Json(body).into_response()
}

fn fail(status: StatusCode, message: &'static str) -> Response {
    error(status, message).into_response()
}

fn db_error(cause: sqlx::Error, message: &'static str) -> ApiError {
    internal_error(cause, message)
}

async fn cookie_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<(i32, i32)>, sqlx::Error> {
    let Some(token) = cookie_token(headers) else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT id, user_id FROM sessions WHERE token_hash = $1 AND expires_at > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
        .bind(token_hash(&token))
        .fetch_optional(&state.pool)
        .await?;
    Ok(row.map(|row| (row.get("user_id"), row.get("id"))))
}

fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut value = vec![0; bytes];
    fill(&mut value)?;
    Ok(hex::encode(value))
}

async fn hash_password(
    state: &AppState,
    password: String,
    failure: &'static str,
) -> Result<String, ApiError> {
    let salt = random_hex(32).map_err(|cause| {
        tracing::error!(error = %cause, "Could not generate password salt");
        error(StatusCode::INTERNAL_SERVER_ERROR, failure)
    })?;
    let salt_bytes = hex::decode(&salt).expect("generated hex");
    let derived = run_scrypt(state, password, salt_bytes, 64)
        .await
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure))?;
    Ok(format!("{salt}:{}", hex::encode(derived)))
}

async fn verify_password(state: &AppState, password: String, stored: String) -> bool {
    let Some((salt_hex, hash_hex)) = stored.split_once(':') else {
        return false;
    };
    let (Ok(salt), Ok(expected)) = (hex::decode(salt_hex), hex::decode(hash_hex)) else {
        return false;
    };
    if expected.len() != 64 {
        return false;
    }
    let Ok(derived) = run_scrypt(state, password, salt, 64).await else {
        return false;
    };
    bool::from(derived.ct_eq(expected.as_slice()))
}

fn client_host(headers: &HeaderMap) -> &str {
    headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(value)) => !value.is_empty(),
        _ => true,
    }
}

fn credentials(body: &Value, register: bool) -> Result<(String, String), ApiError> {
    let username = body.get("username");
    let password = body.get("password");
    if !truthy(username) || !truthy(password) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Username and password are required",
        ));
    }
    if register {
        let username = username.and_then(Value::as_str).ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Username must be at least 3 characters",
            )
        })?;
        if username.encode_utf16().count() < 3 {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Username must be at least 3 characters",
            ));
        }
        let password = password.and_then(Value::as_str).ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "Password must be at least 8 characters",
            )
        })?;
        if password.encode_utf16().count() < 8 {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Password must be at least 8 characters",
            ));
        }
        Ok((username.to_owned(), password.to_owned()))
    } else {
        let (Some(username), Some(password)) = (
            username.and_then(Value::as_str),
            password.and_then(Value::as_str),
        ) else {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "Username and password must be strings",
            ));
        };
        Ok((username.to_owned(), password.to_owned()))
    }
}

async fn registration_open<'e, E>(executor: E) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    match std::env::var("REGISTRATION_ENABLED").as_deref() {
        Ok("true") => Ok(true),
        Ok("false") => Ok(false),
        _ => {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(executor)
                .await?;
            Ok(count == 0)
        }
    }
}

pub(crate) async fn registration_status(State(state): State<AppState>) -> Response {
    match registration_open(&state.pool).await {
        Ok(open) => json_response(json!({ "open": open })),
        Err(cause) => db_error(cause, "Failed to check registration").into_response(),
    }
}

async fn create_session(
    state: &AppState,
    headers: &HeaderMap,
    user_id: i32,
    failure: &'static str,
) -> Result<HeaderValue, ApiError> {
    let token = random_hex(32).map_err(|cause| {
        tracing::error!(error = %cause, "Could not generate session token");
        error(StatusCode::INTERNAL_SERVER_ERROR, failure)
    })?;
    sqlx::query("DELETE FROM sessions WHERE expires_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')")
        .execute(&state.pool)
        .await
        .map_err(|cause| db_error(cause, failure))?;
    let expires_at = (Utc::now() + Duration::seconds(SESSION_SECONDS)).naive_utc();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)")
        .bind(token_hash(&token)).bind(user_id).bind(expires_at).bind(Utc::now().naive_utc())
        .execute(&state.pool).await.map_err(|cause| db_error(cause, failure))?;
    let secure = std::env::var("NODE_ENV").as_deref() == Ok("production");
    if secure {
        let host = client_host(headers);
        let hostname = if host.starts_with('[') {
            host.find(']').map(|end| &host[..=end]).unwrap_or(host)
        } else {
            host.split(':').next().unwrap_or("")
        };
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if !host.is_empty()
            && !["localhost", "127.0.0.1", "[::1]"]
                .contains(&hostname.to_ascii_lowercase().as_str())
            && !proto
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("https")
        {
            tracing::warn!(host, "Secure session cookie may be discarded on plain HTTP");
        }
    }
    let secure_attribute = if secure { "; Secure" } else { "" };
    let expires = expires_at.and_utc().format("%a, %d %b %Y %H:%M:%S GMT");
    HeaderValue::from_str(&format!("counterpoise_session={token}; Path=/; Expires={expires}; Max-Age={SESSION_SECONDS}{secure_attribute}; HttpOnly; SameSite=lax"))
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure))
}

async fn login_inner(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&body, "Failed to log in")?;
    let (username, password) = credentials(&body, false)?;
    let keys = Keys {
        username: Some(&username),
        ip: client_ip::from_headers(&headers),
    };
    if let Err(denied) = state
        .rate_limits
        .enforce(Scope::Login, &keys, Instant::now())
    {
        return Ok(denied.into_response());
    }
    let row = sqlx::query("SELECT id, username, password_hash FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| db_error(cause, "Failed to log in"))?;
    let Some(row) = row else {
        let _ = run_scrypt(
            &state,
            password,
            b"counterpoise-no-such-account".to_vec(),
            64,
        )
        .await;
        state
            .rate_limits
            .failure(Scope::Login, &keys, Instant::now());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    };
    let id: i32 = row.get("id");
    let stored: String = row.get("password_hash");
    if !verify_password(&state, password, stored).await {
        state
            .rate_limits
            .failure(Scope::Login, &keys, Instant::now());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    }
    let cookie = create_session(&state, &headers, id, "Failed to log in").await?;
    state.rate_limits.success(Scope::Login, &keys);
    let mut response =
        json_response(json!({ "id": id, "username": row.get::<String, _>("username") }));
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

pub(crate) async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    login_inner(state, headers, body)
        .await
        .unwrap_or_else(|cause| cause.into_response())
}

pub(crate) async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    register_inner(state, headers, body)
        .await
        .unwrap_or_else(|cause| cause.into_response())
}

async fn register_inner(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&body, "Failed to register")?;
    let (username, password) = credentials(&body, true)?;
    if !registration_open(&state.pool)
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?
    {
        return Ok(fail(StatusCode::FORBIDDEN, "Registration is closed"));
    }
    let keys = Keys {
        username: Some(&username),
        ip: client_ip::from_headers(&headers),
    };
    if let Err(denied) = state
        .rate_limits
        .enforce(Scope::Register, &keys, Instant::now())
    {
        return Ok(denied.into_response());
    }
    let password_hash = hash_password(&state, password, "Failed to register").await?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(REGISTRATION_LOCK_ID)
        .execute(&mut *tx)
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?;
    let open = registration_open(&mut *tx)
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?;
    if !open {
        return Ok(fail(StatusCode::FORBIDDEN, "Registration is closed"));
    }
    let existing: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?;
    if existing.is_some() {
        state
            .rate_limits
            .failure(Scope::Register, &keys, Instant::now());
        return Ok(fail(StatusCode::CONFLICT, "Username already taken"));
    }
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&username)
    .bind(password_hash)
    .bind(Utc::now().naive_utc())
    .fetch_one(&mut *tx)
    .await
    .map_err(|cause| db_error(cause, "Failed to register"))?;
    tx.commit()
        .await
        .map_err(|cause| db_error(cause, "Failed to register"))?;
    let cookie = create_session(&state, &headers, id, "Failed to register").await?;
    let mut response = json_response(json!({ "id": id, "username": username }));
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

pub(crate) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers)
        && let Err(cause) = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash(&token))
            .execute(&state.pool)
            .await
    {
        return db_error(cause, "Failed to log out").into_response();
    }
    let mut response = json_response(json!({ "success": true }));
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "counterpoise_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0",
        ),
    );
    response
}

pub(crate) async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user_id = match principal(&state, &headers).await {
        Ok(Some(id)) => id,
        Ok(None) => return fail(StatusCode::UNAUTHORIZED, "Not authenticated"),
        Err(cause) => return db_error(cause, "Failed to fetch user").into_response(),
    };
    match sqlx::query("SELECT id, username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(row)) => json_response(
            json!({ "id": row.get::<i32, _>("id"), "username": row.get::<String, _>("username") }),
        ),
        Ok(None) => fail(StatusCode::UNAUTHORIZED, "User not found"),
        Err(cause) => db_error(cause, "Failed to fetch user").into_response(),
    }
}

fn password_payload(body: &Value) -> Result<(String, String), ApiError> {
    let current = body.get("currentPassword");
    let new = body.get("newPassword");
    if !truthy(current) || !truthy(new) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Current password and new password are required",
        ));
    }
    let (Some(current), Some(new)) = (current.and_then(Value::as_str), new.and_then(Value::as_str))
    else {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid password payload"));
    };
    if new.encode_utf16().count() < 8 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "New password must be at least 8 characters",
        ));
    }
    if current == new {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "New password must be different from current password",
        ));
    }
    Ok((current.to_owned(), new.to_owned()))
}

pub(crate) async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    change_password_inner(state, headers, body)
        .await
        .unwrap_or_else(|cause| cause.into_response())
}

async fn change_password_inner(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&body, "Failed to update password")?;
    let (current, new) = password_payload(&body)?;
    let Some((user_id, session_id)) = cookie_session(&state, &headers)
        .await
        .map_err(|cause| db_error(cause, "Failed to update password"))?
    else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "Not authenticated"));
    };
    let key = format!("uid:{user_id}");
    let keys = Keys {
        username: Some(&key),
        ip: client_ip::from_headers(&headers),
    };
    if let Err(denied) = state
        .rate_limits
        .enforce(Scope::Password, &keys, Instant::now())
    {
        return Ok(denied.into_response());
    }
    let row = sqlx::query("SELECT password_hash FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| db_error(cause, "Failed to update password"))?;
    let Some(row) = row else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "User not found"));
    };
    if !verify_password(&state, current, row.get("password_hash")).await {
        state
            .rate_limits
            .failure(Scope::Password, &keys, Instant::now());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Current password is incorrect",
        ));
    }
    state.rate_limits.success(Scope::Password, &keys);
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2")
        .bind(user_id)
        .bind(session_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| db_error(cause, "Failed to update password"))?;
    let hash = hash_password(&state, new, "Failed to update password").await?;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(hash)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| db_error(cause, "Failed to update password"))?;
    Ok(json_response(json!({ "success": true })))
}

fn iso_timestamp(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn js_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

pub(crate) async fn list_keys(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((user_id, _)) = (match cookie_session(&state, &headers).await {
        Ok(value) => value,
        Err(cause) => return db_error(cause, "Failed to fetch API keys").into_response(),
    }) else {
        return fail(StatusCode::UNAUTHORIZED, "Not authenticated");
    };
    match sqlx::query("SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC")
        .bind(user_id).fetch_all(&state.pool).await {
        Ok(rows) => json_response(Value::Array(rows.into_iter().map(|row| json!({
            "id": row.get::<i32, _>("id"),
            "name": row.get::<String, _>("name"),
            "keyPrefix": row.get::<String, _>("key_prefix"),
            "lastUsedAt": row.get::<Option<NaiveDateTime>, _>("last_used_at").map(iso_timestamp),
            "createdAt": iso_timestamp(row.get("created_at")),
        })).collect())),
        Err(cause) => db_error(cause, "Failed to fetch API keys").into_response(),
    }
}

pub(crate) async fn create_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    create_key_inner(state, headers, body)
        .await
        .unwrap_or_else(|cause| cause.into_response())
}

async fn create_key_inner(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let Some((user_id, _)) = cookie_session(&state, &headers)
        .await
        .map_err(|cause| db_error(cause, "Failed to create API key"))?
    else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "Not authenticated"));
    };
    let body = parse_json_body(&body, "Failed to create API key")?;
    let Some(name) = body.get("name").and_then(Value::as_str) else {
        return Ok(fail(StatusCode::BAD_REQUEST, "Name is required"));
    };
    let name = name.trim_matches(js_whitespace);
    if name.is_empty() {
        return Ok(fail(StatusCode::BAD_REQUEST, "Name is required"));
    }
    let key = format!(
        "cpk_{}",
        random_hex(24).map_err(|cause| {
            tracing::error!(error = %cause, "Could not generate API key");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create API key",
            )
        })?
    );
    let salt = random_hex(16).map_err(|cause| {
        tracing::error!(error = %cause, "Could not generate API key salt");
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create API key",
        )
    })?;
    let derived = run_scrypt(&state, key.clone(), salt.as_bytes().to_vec(), 32)
        .await
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create API key",
            )
        })?;
    let key_prefix = &key[..8];
    let row = sqlx::query("INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at")
        .bind(user_id).bind(name).bind(format!("{salt}:{}", hex::encode(derived))).bind(key_prefix).bind(Utc::now().naive_utc())
        .fetch_one(&state.pool).await.map_err(|cause| db_error(cause, "Failed to create API key"))?;
    Ok(json_response(
        json!({ "id": row.get::<i32, _>("id"), "name": name, "key": key,
        "keyPrefix": key_prefix, "createdAt": iso_timestamp(row.get("created_at")) }),
    ))
}

pub(crate) async fn delete_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some((user_id, _)) = (match cookie_session(&state, &headers).await {
        Ok(value) => value,
        Err(cause) => return db_error(cause, "Failed to delete API key").into_response(),
    }) else {
        return fail(StatusCode::UNAUTHORIZED, "Not authenticated");
    };
    // JavaScript's parseInt accepts leading whitespace, an optional sign,
    // then stops at the first non-digit. Preserve that path contract.
    let id = id.trim_start();
    let signed = if id.starts_with('+') || id.starts_with('-') {
        &id[1..]
    } else {
        id
    };
    let sign_len = id.len() - signed.len();
    let digits_len = signed.bytes().take_while(u8::is_ascii_digit).count();
    let parsed = &id[..sign_len + digits_len];
    if digits_len == 0 {
        return fail(StatusCode::BAD_REQUEST, "Invalid key ID");
    }
    let Ok(id) = parsed.parse::<i32>() else {
        return fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete API key",
        );
    };
    match sqlx::query("DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(_)) => json_response(json!({ "success": true })),
        Ok(None) => fail(StatusCode::NOT_FOUND, "API key not found"),
        Err(cause) => db_error(cause, "Failed to delete API key").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_host_takes_precedence_over_rust_upstream_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "rust-api:4000".parse().unwrap());
        headers.insert(
            "x-forwarded-host",
            " localhost:3000, proxy".parse().unwrap(),
        );
        assert_eq!(client_host(&headers), "localhost:3000");
    }

    #[test]
    fn api_key_name_uses_javascript_trim_whitespace() {
        assert_eq!(
            "\u{feff} Phone \u{feff}".trim_matches(js_whitespace),
            "Phone"
        );
        assert_eq!("\u{feff}".trim_matches(js_whitespace), "");
        assert_eq!("\u{0085}".trim_matches(js_whitespace), "\u{0085}");
    }
}

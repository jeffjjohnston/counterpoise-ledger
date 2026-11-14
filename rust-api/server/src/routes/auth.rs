use crate::{
    auth::{cookie_token, principal, run_scrypt, token_hash},
    client_ip,
    error::{ApiError, error, internal_error},
    platform,
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
use chrono::{Duration, NaiveDateTime, SecondsFormat};
use ledger_db::{
    Sql,
    store::{self, params},
};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;

fn json_response(body: Value) -> Response {
    Json(body).into_response()
}

fn fail(status: StatusCode, message: &'static str) -> Response {
    error(status, message).into_response()
}

fn db_error(cause: impl std::fmt::Display, message: &'static str) -> ApiError {
    internal_error(cause, message)
}

/// The user and session of the session cookie, and never of a bearer
/// header. A route that must not accept a key or a token uses this: the API
/// key routes, and the OAuth consent and grant routes.
pub(crate) async fn cookie_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<(i32, i32)>, store::Error> {
    let Some(token) = cookie_token(headers) else {
        return Ok(None);
    };
    let row = state.database.query_optional(
        "SELECT user_id, id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
        &params![token_hash(&token), platform::timestamp()],
    )?;
    Ok(row)
}

fn random_hex(bytes: usize) -> Result<String, getrandom::Error> {
    let mut value = vec![0; bytes];
    platform::random(&mut value)?;
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

fn registration_open(sql: &impl Sql) -> Result<bool, store::Error> {
    match ledger_db::env::var("REGISTRATION_ENABLED").as_deref() {
        Ok("true") => Ok(true),
        Ok("false") => Ok(false),
        _ => {
            let count: i64 = sql.query_row("SELECT COUNT(*) FROM users", &[])?;
            Ok(count == 0)
        }
    }
}

pub(crate) async fn registration_status(State(state): State<AppState>) -> Response {
    match registration_open(&state.database) {
        Ok(open) => json_response(json!({ "open": open })),
        Err(cause) => db_error(cause, "Failed to check registration").into_response(),
    }
}

/// Stores a session for a user and gives its cookie, or `None` when the
/// user's stored hash is no longer `password_hash`.
///
/// `password_hash` is the hash that the caller verified. Scrypt is slow, so
/// a password change can commit between the verification and this insert.
/// The insert thus has the hash as a condition: a login with the old
/// password gets no session after the change.
async fn create_session(
    state: &AppState,
    headers: &HeaderMap,
    user_id: i32,
    password_hash: &str,
    failure: &'static str,
) -> Result<Option<HeaderValue>, ApiError> {
    let token = random_hex(32).map_err(|cause| {
        tracing::error!(error = %cause, "Could not generate session token");
        error(StatusCode::INTERNAL_SERVER_ERROR, failure)
    })?;
    state
        .database
        .execute(
            "DELETE FROM sessions WHERE expires_at < ?1",
            &params![platform::timestamp()],
        )
        .map_err(|cause| db_error(cause, failure))?;
    let expires_at = platform::timestamp() + Duration::seconds(SESSION_SECONDS);
    let stored = state
        .database
        .execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
             SELECT ?1, ?2, ?3, ?4
             WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND password_hash = ?5)",
            &params![
                token_hash(&token),
                user_id,
                expires_at,
                platform::timestamp(),
                password_hash
            ],
        )
        .map_err(|cause| db_error(cause, failure))?;
    if stored != 1 {
        return Ok(None);
    }
    // A Worker is only ever reached through Cloudflare's HTTPS edge, so its
    // cookie is always Secure: a deployment sets no NODE_ENV, and the plain
    // HTTP request the edge redirects would otherwise carry the session.
    // Browsers keep a Secure cookie on http://localhost, so `wrangler dev`
    // still signs in. The native server serves plain HTTP in development and
    // marks the cookie Secure under NODE_ENV=production (the Docker image).
    let secure = cfg!(target_arch = "wasm32")
        || ledger_db::env::var("NODE_ENV").as_deref() == Ok("production");
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
        .map(Some)
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
        .enforce(Scope::Login, &keys, platform::timestamp())
    {
        return Ok(denied.into_response());
    }
    let row: Option<(i32, String, String)> = state
        .database
        .query_optional(
            "SELECT id, username, password_hash FROM users WHERE username = ?1",
            &params![&username],
        )
        .map_err(|cause| db_error(cause, "Failed to log in"))?;
    let Some((id, stored_username, stored)) = row else {
        let _ = run_scrypt(
            &state,
            password,
            b"counterpoise-no-such-account".to_vec(),
            64,
        )
        .await;
        state
            .rate_limits
            .failure(Scope::Login, &keys, platform::timestamp());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    };
    // `None` also when the password changed after the verification: the
    // password of this request is then the old one.
    let cookie = if verify_password(&state, password, stored.clone()).await {
        create_session(&state, &headers, id, &stored, "Failed to log in").await?
    } else {
        None
    };
    let Some(cookie) = cookie else {
        state
            .rate_limits
            .failure(Scope::Login, &keys, platform::timestamp());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password",
        ));
    };
    state.rate_limits.success(Scope::Login, &keys);
    let mut response = json_response(json!({ "id": id, "username": stored_username }));
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
    if !registration_open(&state.database).map_err(|cause| db_error(cause, "Failed to register"))? {
        return Ok(fail(StatusCode::FORBIDDEN, "Registration is closed"));
    }
    let keys = Keys {
        username: Some(&username),
        ip: client_ip::from_headers(&headers),
    };
    if let Err(denied) = state
        .rate_limits
        .enforce(Scope::Register, &keys, platform::timestamp())
    {
        return Ok(denied.into_response());
    }
    let password_hash = hash_password(&state, password, "Failed to register").await?;
    enum Registered {
        Closed,
        Taken,
        User(i32),
    }
    // The first-user check and the insert run in one write transaction, so
    // two registrations cannot both see an empty table.
    let registered = state
        .database
        .transaction(|tx| {
        if !registration_open(tx)? {
            return Ok(Registered::Closed);
        }
        let existing: Option<i32> = tx.query_optional(
            "SELECT id FROM users WHERE username = ?1",
            &params![&username],
        )?;
        if existing.is_some() {
            return Ok(Registered::Taken);
        }
        Ok(Registered::User(tx.query_row(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?1, ?2, ?3) RETURNING id",
            &params![&username, &password_hash, platform::timestamp()],
        )?))
    })
    .map_err(|cause: store::Error| db_error(cause, "Failed to register"))?;
    let id = match registered {
        Registered::Closed => return Ok(fail(StatusCode::FORBIDDEN, "Registration is closed")),
        Registered::Taken => {
            state
                .rate_limits
                .failure(Scope::Register, &keys, platform::timestamp());
            return Ok(fail(StatusCode::CONFLICT, "Username already taken"));
        }
        Registered::User(id) => id,
    };
    // `None` when the new user changed the password or was deleted before
    // this insert. The account exists, and the user can log in.
    let Some(cookie) =
        create_session(&state, &headers, id, &password_hash, "Failed to register").await?
    else {
        return Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to register",
        ));
    };
    let mut response = json_response(json!({ "id": id, "username": username }));
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}

pub(crate) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers)
        && let Err(cause) = state.database.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            &params![token_hash(&token)],
        )
    {
        return db_error(cause, "Failed to log out").into_response();
    }
    // An open book socket of this session closes.
    state.revocations.notify();
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
    match state.database.query_optional::<(i32, String)>(
        "SELECT id, username FROM users WHERE id = ?1",
        &params![user_id],
    ) {
        Ok(Some((id, username))) => json_response(json!({ "id": id, "username": username })),
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
        .enforce(Scope::Password, &keys, platform::timestamp())
    {
        return Ok(denied.into_response());
    }
    let row: Option<String> = state
        .database
        .query_optional(
            "SELECT password_hash FROM users WHERE id = ?1",
            &params![user_id],
        )
        .map_err(|cause| db_error(cause, "Failed to update password"))?;
    let Some(stored) = row else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "User not found"));
    };
    if !verify_password(&state, current, stored.clone()).await {
        state
            .rate_limits
            .failure(Scope::Password, &keys, platform::timestamp());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Current password is incorrect",
        ));
    }
    state.rate_limits.success(Scope::Password, &keys);
    // The slow hash comes first. Then one write transaction stores the hash
    // and deletes the other sessions, so no login with the old password can
    // get a session between the two steps. `create_session` refuses a login
    // that verified the old hash before this transaction and stores its
    // session after it.
    let hash = hash_password(&state, new, "Failed to update password").await?;
    let changed = state
        .database
        .transaction(|tx| {
            // The update applies only while the stored hash is the hash that
            // this request verified. `false` when another password change
            // was first: its password is now the current one.
            let updated = tx.execute(
                "UPDATE users SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3",
                &params![hash, user_id, stored],
            )?;
            if updated != 1 {
                return Ok(false);
            }
            tx.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND id <> ?2",
                &params![user_id, session_id],
            )?;
            Ok(true)
        })
        .map_err(|cause: store::Error| db_error(cause, "Failed to update password"))?;
    if !changed {
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Current password is incorrect",
        ));
    }
    // The sessions are gone from the database before the sockets check
    // their credentials again.
    state.revocations.notify();
    Ok(json_response(json!({ "success": true })))
}

fn username_payload(body: &Value) -> Result<(String, String), ApiError> {
    let username = body.get("username");
    let current = body.get("currentPassword");
    if !truthy(username) || !truthy(current) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "New username and current password are required",
        ));
    }
    let (Some(username), Some(current)) = (
        username.and_then(Value::as_str),
        current.and_then(Value::as_str),
    ) else {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid username payload"));
    };
    // The same rule as registration.
    if username.encode_utf16().count() < 3 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "Username must be at least 3 characters",
        ));
    }
    Ok((username.to_owned(), current.to_owned()))
}

pub(crate) async fn change_username(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    change_username_inner(state, headers, body)
        .await
        .unwrap_or_else(|cause| cause.into_response())
}

/// Changes the username of the signed-in user. The caller must give the
/// current password, and only the cookie session can do this, as for a
/// password change. Every other table refers to a user by id, so the rename
/// changes only this row. The sessions and the API keys stay valid.
async fn change_username_inner(
    state: AppState,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = parse_json_body(&body, "Failed to update username")?;
    let (username, current) = username_payload(&body)?;
    let Some((user_id, _)) = cookie_session(&state, &headers)
        .await
        .map_err(|cause| db_error(cause, "Failed to update username"))?
    else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "Not authenticated"));
    };
    // The password check is the same guess as on the password route, so it
    // uses the same bucket.
    let key = format!("uid:{user_id}");
    let keys = Keys {
        username: Some(&key),
        ip: client_ip::from_headers(&headers),
    };
    if let Err(denied) = state
        .rate_limits
        .enforce(Scope::Password, &keys, platform::timestamp())
    {
        return Ok(denied.into_response());
    }
    let row: Option<(String, String)> = state
        .database
        .query_optional(
            "SELECT username, password_hash FROM users WHERE id = ?1",
            &params![user_id],
        )
        .map_err(|cause| db_error(cause, "Failed to update username"))?;
    let Some((stored_username, stored)) = row else {
        return Ok(fail(StatusCode::UNAUTHORIZED, "User not found"));
    };
    if !verify_password(&state, current, stored).await {
        state
            .rate_limits
            .failure(Scope::Password, &keys, platform::timestamp());
        return Ok(fail(
            StatusCode::UNAUTHORIZED,
            "Current password is incorrect",
        ));
    }
    state.rate_limits.success(Scope::Password, &keys);
    if username == stored_username {
        return Ok(fail(
            StatusCode::BAD_REQUEST,
            "New username must be different from current username",
        ));
    }
    // The check and the update run in one write transaction, so two renames
    // cannot both take one name.
    let renamed = state
        .database
        .transaction(|tx| {
            let existing: Option<i32> = tx.query_optional(
                "SELECT id FROM users WHERE username = ?1",
                &params![&username],
            )?;
            if existing.is_some() {
                return Ok(false);
            }
            tx.execute(
                "UPDATE users SET username = ?1 WHERE id = ?2",
                &params![&username, user_id],
            )?;
            Ok(true)
        })
        .map_err(|cause: store::Error| db_error(cause, "Failed to update username"))?;
    if !renamed {
        return Ok(fail(StatusCode::CONFLICT, "Username already taken"));
    }
    Ok(json_response(
        json!({ "id": user_id, "username": username }),
    ))
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
    type KeyRow = (i32, String, String, Option<NaiveDateTime>, NaiveDateTime);
    match state.database.query::<KeyRow>("SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC", &params![user_id]) {
        Ok(rows) => json_response(Value::Array(rows.into_iter().map(|(id, name, key_prefix, last_used_at, created_at)| json!({
            "id": id,
            "name": name,
            "keyPrefix": key_prefix,
            "lastUsedAt": last_used_at.map(iso_timestamp),
            "createdAt": iso_timestamp(created_at),
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
    let (key_id, created_at): (i32, NaiveDateTime) = state.database.query_row("INSERT INTO api_keys (user_id, name, key_hash, key_prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, created_at", &params![user_id, name, format!("{salt}:{}", hex::encode(derived)), key_prefix, platform::timestamp()]).map_err(|cause| db_error(cause, "Failed to create API key"))?;
    Ok(json_response(
        json!({ "id": key_id, "name": name, "key": key,
        "keyPrefix": key_prefix, "createdAt": iso_timestamp(created_at) }),
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
    match state.database.query_optional::<i32>(
        "DELETE FROM api_keys WHERE id = ?1 AND user_id = ?2 RETURNING id",
        &params![id, user_id],
    ) {
        Ok(Some(_)) => {
            state.revocations.notify();
            json_response(json!({ "success": true }))
        }
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

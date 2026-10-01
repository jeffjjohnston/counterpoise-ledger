use crate::{
    book_auth::{AccessLevel, BookRole, authenticate_book},
    error::{ApiError, ApiResult, error, internal_error},
    rate_limit::{Keys, RateLimitError, Scope},
    state::AppState,
    validation::parse_json_body,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, SecondsFormat, Utc};
use ledger_db::engine::Db;
use ledger_db::locks::FOR_UPDATE;
use serde_json::{Value, json};
use sqlx::{FromRow, Transaction};
use std::time::Instant;

const CANNOT_ADD: &str = "Cannot add that user";
const LAST_OWNER: &str = "A book must keep at least one owner";
const NOT_MEMBER: &str = "That user is not a member of this book";

enum AddError {
    Api(ApiError),
    Limited(RateLimitError),
}

impl From<ApiError> for AddError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}

impl From<RateLimitError> for AddError {
    fn from(value: RateLimitError) -> Self {
        Self::Limited(value)
    }
}

impl IntoResponse for AddError {
    fn into_response(self) -> Response {
        match self {
            Self::Api(value) => value.into_response(),
            Self::Limited(value) => value.into_response(),
        }
    }
}

#[derive(Debug, FromRow)]
struct MemberRow {
    user_id: i32,
    username: String,
    role: String,
    created_at: NaiveDateTime,
}

#[derive(FromRow)]
struct LockedMember {
    user_id: i32,
    role: String,
}

fn member_json(row: MemberRow) -> Value {
    json!({
        "userId": row.user_id,
        "username": row.username,
        "role": row.role,
        "createdAt": row.created_at.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn role(value: Option<&Value>) -> Result<&str, ApiError> {
    value
        .and_then(Value::as_str)
        .filter(|value| ["owner", "editor", "viewer"].contains(value))
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "role must be owner, editor or viewer",
            )
        })
}

fn target_id(raw: &str) -> Result<i32, ApiError> {
    crate::validation::parse_js_number(raw)
        .filter(|value| {
            value.is_finite() && value.fract() == 0.0 && *value > 0.0 && *value <= i32::MAX as f64
        })
        .map(|value| value as i32)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid user ID"))
}

async fn get_member(
    tx: &mut Transaction<'_, Db>,
    book_id: i32,
    user_id: i32,
    failure: &'static str,
) -> Result<MemberRow, ApiError> {
    sqlx::query_as::<_, MemberRow>(
        "SELECT bm.user_id, u.username, bm.role, bm.created_at FROM book_members bm JOIN users u ON u.id = bm.user_id WHERE bm.book_id = $1 AND bm.user_id = $2"
    )
    .bind(book_id).bind(user_id).fetch_optional(tx.as_mut()).await
    .map_err(|cause| internal_error(cause, failure))?
    .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_MEMBER))
}

async fn lock_members(
    tx: &mut Transaction<'_, Db>,
    book_id: i32,
    failure: &'static str,
) -> Result<Vec<LockedMember>, ApiError> {
    sqlx::query_as::<_, LockedMember>(&format!(
        "SELECT user_id, role FROM book_members WHERE book_id = $1 ORDER BY user_id{FOR_UPDATE}"
    ))
    .bind(book_id)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|cause| internal_error(cause, failure))
}

fn require_owner(rows: &[LockedMember], actor: i32) -> Result<(), ApiError> {
    if rows
        .iter()
        .any(|row| row.user_id == actor && row.role == "owner")
    {
        Ok(())
    } else {
        Err(error(StatusCode::FORBIDDEN, "Only an owner can do this"))
    }
}

pub(crate) async fn list_members(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let auth = authenticate_book(
        &state,
        &headers,
        &book_id,
        AccessLevel::Read,
        "Failed to list members",
    )
    .await?;
    let rows = sqlx::query_as::<_, MemberRow>(
        "SELECT bm.user_id, u.username, bm.role, bm.created_at FROM book_members bm JOIN users u ON u.id = bm.user_id WHERE bm.book_id = $1 ORDER BY bm.created_at, bm.user_id"
    ).bind(auth.book_id).fetch_all(&state.pool).await
    .map_err(|cause| internal_error(cause, "Failed to list members"))?;
    Ok(Json(Value::Array(
        rows.into_iter().map(member_json).collect(),
    )))
}

pub(crate) async fn add_member(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    async fn run(
        state: &AppState,
        book_id: &str,
        headers: &HeaderMap,
        body: &Bytes,
    ) -> Result<Json<Value>, AddError> {
        let auth = authenticate_book(
            state,
            headers,
            book_id,
            AccessLevel::Owner,
            "Failed to add member",
        )
        .await?;
        let body = parse_json_body(body, "Failed to add member")?;
        let username = body
            .get("username")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "username is required"))?;
        let role = role(body.get("role"))?;
        let user_key = format!("uid:{}", auth.user_id);
        let keys = Keys {
            username: Some(&user_key),
            ip: None,
        };
        state
            .rate_limits
            .enforce(Scope::BookMemberAdd, &keys, Instant::now())?;
        let mut tx = ledger_db::locks::begin_pool(&state.pool)
            .await
            .map_err(|cause| internal_error(cause, "Failed to add member"))?;
        let rows = lock_members(&mut tx, auth.book_id, "Failed to add member").await?;
        require_owner(&rows, auth.user_id)?;
        let target: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(username)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|cause| internal_error(cause, "Failed to add member"))?;
        let Some(target) = target else {
            state
                .rate_limits
                .failure(Scope::BookMemberAdd, &keys, Instant::now());
            return Err(error(StatusCode::BAD_REQUEST, CANNOT_ADD).into());
        };
        let inserted: Option<i32> = sqlx::query_scalar(
            "INSERT INTO book_members (book_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id"
        ).bind(auth.book_id).bind(target).bind(role).bind(Utc::now().naive_utc()).fetch_optional(tx.as_mut()).await
        .map_err(|cause| internal_error(cause, "Failed to add member"))?;
        if inserted.is_none() {
            return Err(error(StatusCode::BAD_REQUEST, CANNOT_ADD).into());
        }
        let member = get_member(&mut tx, auth.book_id, target, "Failed to add member").await?;
        tx.commit()
            .await
            .map_err(|cause| internal_error(cause, "Failed to add member"))?;
        Ok(Json(member_json(member)))
    }
    run(&state, &book_id, &headers, &body).await.into_response()
}

pub(crate) async fn change_member(
    State(state): State<AppState>,
    Path((book_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let auth = authenticate_book(
        &state,
        &headers,
        &book_id,
        AccessLevel::Owner,
        "Failed to change member",
    )
    .await?;
    let target = target_id(&user_id)?;
    let body = parse_json_body(&body, "Failed to change member")?;
    let new_role = role(body.get("role"))?;
    let mut tx = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to change member"))?;
    let rows = lock_members(&mut tx, auth.book_id, "Failed to change member").await?;
    require_owner(&rows, auth.user_id)?;
    let current = rows
        .iter()
        .find(|row| row.user_id == target)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_MEMBER))?;
    if current.role == "owner"
        && new_role != "owner"
        && rows.iter().filter(|row| row.role == "owner").count() == 1
    {
        return Err(error(StatusCode::BAD_REQUEST, LAST_OWNER));
    }
    sqlx::query("UPDATE book_members SET role = $1 WHERE book_id = $2 AND user_id = $3")
        .bind(new_role)
        .bind(auth.book_id)
        .bind(target)
        .execute(tx.as_mut())
        .await
        .map_err(|cause| internal_error(cause, "Failed to change member"))?;
    let member = get_member(&mut tx, auth.book_id, target, "Failed to change member").await?;
    tx.commit()
        .await
        .map_err(|cause| internal_error(cause, "Failed to change member"))?;
    Ok(Json(member_json(member)))
}

pub(crate) async fn remove_member(
    State(state): State<AppState>,
    Path((book_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let auth = authenticate_book(
        &state,
        &headers,
        &book_id,
        AccessLevel::Read,
        "Failed to remove member",
    )
    .await?;
    let target = target_id(&user_id)?;
    if target != auth.user_id && auth.role != BookRole::Owner {
        return Err(error(StatusCode::FORBIDDEN, "Only an owner can do this"));
    }
    let mut tx = ledger_db::locks::begin_pool(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to remove member"))?;
    let rows = lock_members(&mut tx, auth.book_id, "Failed to remove member").await?;
    if target != auth.user_id {
        require_owner(&rows, auth.user_id)?;
    }
    let current = rows
        .iter()
        .find(|row| row.user_id == target)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_MEMBER))?;
    if current.role == "owner" && rows.iter().filter(|row| row.role == "owner").count() == 1 {
        return Err(error(StatusCode::BAD_REQUEST, LAST_OWNER));
    }
    sqlx::query("DELETE FROM book_members WHERE book_id = $1 AND user_id = $2")
        .bind(auth.book_id)
        .bind(target)
        .execute(tx.as_mut())
        .await
        .map_err(|cause| internal_error(cause, "Failed to remove member"))?;
    tx.commit()
        .await
        .map_err(|cause| internal_error(cause, "Failed to remove member"))?;
    Ok(Json(json!({"success": true})))
}

#[cfg(test)]
mod tests {
    use super::{NOT_MEMBER, get_member};
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};

    use serde_json::{Value, json};

    #[tokio::test]
    async fn missing_joined_user_returns_not_found() {
        let database = ledger_db::testing::TempDatabase::new(1).await;
        let pool = database.pool().clone();
        let mut tx = ledger_db::locks::begin_pool(&pool).await.unwrap();
        sqlx::query("CREATE TEMP TABLE book_members (book_id integer, user_id integer, role text, created_at timestamp)")
            .execute(tx.as_mut()).await.unwrap();
        sqlx::query("CREATE TEMP TABLE users (id integer, username text)")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO book_members VALUES (1, 7, 'viewer', $1)")
            .bind(chrono::Utc::now().naive_utc())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let response = get_member(&mut tx, 1, 7, "Failed to change member")
            .await
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body, json!({"error": NOT_MEMBER}));
    }
}

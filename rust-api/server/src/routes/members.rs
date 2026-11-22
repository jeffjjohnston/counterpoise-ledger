use crate::{
    body::{NonBlank, string_enum, typed_body},
    book_auth::{AccessLevel, BookRole, authenticate_book},
    db_scope::write_transaction,
    error::{ApiError, ApiResult, error, internal_error},
    platform,
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
use chrono::{NaiveDateTime, SecondsFormat};
use ledger_db::locks::FOR_UPDATE;
use ledger_db::store::{Sql, params};
use serde::Deserialize;
use serde_json::{Value, json};
use utoipa::ToSchema;

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

#[derive(Debug, ledger_db::store::FromRow)]
struct MemberRow {
    user_id: i32,
    username: String,
    role: String,
    created_at: NaiveDateTime,
}

#[derive(ledger_db::store::FromRow)]
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

string_enum! {
    /// What a member can do in a book.
    pub(crate) enum Role {
        Owner = "owner",
        Editor = "editor",
        Viewer = "viewer",
    }
}

// The body of `POST /api/books/{bookId}/members`, and `AddBookMemberBody` in
// the API contract: see `crate::body`.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct AddBookMemberBody {
    /// The exact username of an existing user. Case matters.
    #[schema(inline)]
    username: NonBlank,
    /// owner: everything, including members, rename, delete and bank connections. editor: read and change the ledger. viewer: read only.
    #[schema(inline)]
    role: Role,
}

// The body of `PUT /api/books/{bookId}/members/{userId}`, and
// `UpdateBookMemberBody` in the API contract.
#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct UpdateBookMemberBody {
    /// owner: everything, including members, rename, delete and bank connections. editor: read and change the ledger. viewer: read only.
    #[schema(inline)]
    role: Role,
}

fn target_id(raw: &str) -> Result<i32, ApiError> {
    crate::validation::parse_js_number(raw)
        .filter(|value| {
            value.is_finite() && value.fract() == 0.0 && *value > 0.0 && *value <= i32::MAX as f64
        })
        .map(|value| value as i32)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid user ID"))
}

fn get_member(
    tx: &impl Sql,
    book_id: i32,
    user_id: i32,
    failure: &'static str,
) -> Result<MemberRow, ApiError> {
    tx.query_optional::<MemberRow>(
        "SELECT bm.user_id, u.username, bm.role, bm.created_at
         FROM book_members bm JOIN users u ON u.id = bm.user_id
         WHERE bm.book_id = ?1 AND bm.user_id = ?2",
        &params![book_id, user_id],
    )
    .map_err(|cause| internal_error(cause, failure))?
    .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_MEMBER))
}

fn lock_members(
    tx: &impl Sql,
    book_id: i32,
    failure: &'static str,
) -> Result<Vec<LockedMember>, ApiError> {
    tx.query(
        &format!(
            "SELECT user_id, role FROM book_members WHERE book_id = ?1 ORDER BY user_id{FOR_UPDATE}"
        ),
        &params![book_id],
    )
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
    let rows = state.database.query::<MemberRow>("SELECT bm.user_id, u.username, bm.role, bm.created_at FROM book_members bm JOIN users u ON u.id = bm.user_id WHERE bm.book_id = ?1 ORDER BY bm.created_at, bm.user_id", &params![auth.book_id()])
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
        let body: AddBookMemberBody = typed_body(&parse_json_body(body, "Failed to add member")?)?;
        let (username, role) = (body.username.into_string(), body.role.as_str());
        let username = username.as_str();
        let user_key = format!("uid:{}", auth.user_id());
        let keys = Keys {
            username: Some(&user_key),
            ip: None,
        };
        state
            .rate_limits
            .enforce(Scope::BookMemberAdd, &keys, platform::timestamp())?;
        const FAILURE: &str = "Failed to add member";
        // The limiter writes on the same connection, so it records an unknown
        // username after the transaction ends: inside it, the call would wait
        // on the lock this transaction holds, and a rollback would undo it.
        let mut unknown_user = false;
        let member = write_transaction(&state.database, FAILURE, |tx| {
            let rows = lock_members(tx, auth.book_id(), FAILURE)?;
            require_owner(&rows, auth.user_id())?;
            let target: Option<i32> = tx
                .query_optional(
                    "SELECT id FROM users WHERE username = ?1",
                    &params![username],
                )
                .map_err(|cause| internal_error(cause, FAILURE))?;
            let Some(target) = target else {
                unknown_user = true;
                return Err(error(StatusCode::BAD_REQUEST, CANNOT_ADD));
            };
            let inserted: Option<i32> = tx
                .query_optional(
                    "INSERT INTO book_members (book_id, user_id, role, created_at)
                     VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING RETURNING user_id",
                    &params![auth.book_id(), target, role, platform::timestamp()],
                )
                .map_err(|cause| internal_error(cause, FAILURE))?;
            if inserted.is_none() {
                return Err(error(StatusCode::BAD_REQUEST, CANNOT_ADD));
            }
            get_member(tx, auth.book_id(), target, FAILURE)
        });
        if unknown_user {
            state
                .rate_limits
                .failure(Scope::BookMemberAdd, &keys, platform::timestamp());
        }
        Ok(Json(member_json(member?)))
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
    let body: UpdateBookMemberBody =
        typed_body(&parse_json_body(&body, "Failed to change member")?)?;
    let new_role = body.role.as_str();
    const FAILURE: &str = "Failed to change member";
    let member = write_transaction(&state.database, FAILURE, |tx| {
        let rows = lock_members(tx, auth.book_id(), FAILURE)?;
        require_owner(&rows, auth.user_id())?;
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
        tx.execute(
            "UPDATE book_members SET role = ?1 WHERE book_id = ?2 AND user_id = ?3",
            &params![new_role, auth.book_id(), target],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
        get_member(tx, auth.book_id(), target, FAILURE)
    })?;
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
    if target != auth.user_id() && auth.role() != BookRole::Owner {
        return Err(error(StatusCode::FORBIDDEN, "Only an owner can do this"));
    }
    const FAILURE: &str = "Failed to remove member";
    write_transaction(&state.database, FAILURE, |tx| {
        let rows = lock_members(tx, auth.book_id(), FAILURE)?;
        if target != auth.user_id() {
            require_owner(&rows, auth.user_id())?;
        }
        let current = rows
            .iter()
            .find(|row| row.user_id == target)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, NOT_MEMBER))?;
        if current.role == "owner" && rows.iter().filter(|row| row.role == "owner").count() == 1 {
            return Err(error(StatusCode::BAD_REQUEST, LAST_OWNER));
        }
        tx.execute(
            "DELETE FROM book_members WHERE book_id = ?1 AND user_id = ?2",
            &params![auth.book_id(), target],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
        Ok(())
    })?;
    Ok(Json(json!({"success": true})))
}

#[cfg(test)]
mod tests {
    use super::{NOT_MEMBER, get_member};
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
    use ledger_db::store::Sql;

    use serde_json::{Value, json};

    #[tokio::test]
    async fn missing_joined_user_returns_not_found() {
        let database = ledger_db::Database::open_in_memory().unwrap();
        database
            .exec_batch(
                "CREATE TABLE book_members (book_id integer, user_id integer, role text,
                   created_at timestamp);
                 CREATE TABLE users (id integer, username text);
                 INSERT INTO book_members VALUES (1, 7, 'viewer', '2026-10-21 00:00:00');",
            )
            .unwrap();
        let response = get_member(&database, 1, 7, "Failed to change member")
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body, json!({"error": NOT_MEMBER}));
    }
}

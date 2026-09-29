#[cfg(test)]
mod tests {
    use super::{AccessLevel, BookRole, denial};
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};

    #[test]
    fn roles_match_the_node_access_matrix() {
        for role in [BookRole::Owner, BookRole::Editor, BookRole::Viewer] {
            assert!(role.satisfies(AccessLevel::Read));
        }
        assert!(BookRole::Owner.satisfies(AccessLevel::Write));
        assert!(BookRole::Editor.satisfies(AccessLevel::Write));
        assert!(!BookRole::Viewer.satisfies(AccessLevel::Write));
        assert!(BookRole::Owner.satisfies(AccessLevel::Owner));
        assert!(!BookRole::Editor.satisfies(AccessLevel::Owner));
        assert!(!BookRole::Viewer.satisfies(AccessLevel::Owner));
        assert_eq!(AccessLevel::default(), AccessLevel::Write);
    }

    #[tokio::test]
    async fn denial_bodies_match_node() {
        for (role, level, status, body) in [
            (
                None,
                AccessLevel::Read,
                StatusCode::NOT_FOUND,
                r#"{"error":"Book not found"}"#,
            ),
            (
                Some(BookRole::Viewer),
                AccessLevel::Write,
                StatusCode::FORBIDDEN,
                r#"{"error":"You have read-only access to this book"}"#,
            ),
            (
                Some(BookRole::Editor),
                AccessLevel::Owner,
                StatusCode::FORBIDDEN,
                r#"{"error":"Only an owner can do this"}"#,
            ),
        ] {
            let response = denial(role, level).into_response();
            assert_eq!(response.status(), status);
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                body.as_bytes()
            );
        }
    }
}
use crate::{
    auth::session_user,
    error::{ApiError, error, internal_error},
    state::AppState,
    validation::{database_integer, parse_int_prefix},
};
use axum::http::{HeaderMap, StatusCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BookRole {
    Owner,
    Editor,
    Viewer,
}

impl BookRole {
    fn from_database(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "editor" => Some(Self::Editor),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }

    fn satisfies(self, level: AccessLevel) -> bool {
        match level {
            AccessLevel::Read => true,
            AccessLevel::Write => self != Self::Viewer,
            AccessLevel::Owner => self == Self::Owner,
        }
    }
}

// Write is the safe default, as in authenticateBookRequest. A GET route must
// explicitly ask for Read; owner-only operations explicitly ask for Owner.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[allow(dead_code)] // Owner is used by the later book and Plaid route ports.
pub(crate) enum AccessLevel {
    Read,
    #[default]
    Write,
    Owner,
}

fn denial(role: Option<BookRole>, level: AccessLevel) -> ApiError {
    match role {
        None => error(StatusCode::NOT_FOUND, "Book not found"),
        Some(_) if level == AccessLevel::Owner => {
            error(StatusCode::FORBIDDEN, "Only an owner can do this")
        }
        Some(_) => error(
            StatusCode::FORBIDDEN,
            "You have read-only access to this book",
        ),
    }
}

/// `parseInt(raw, 10)` with the NaN check of `authenticateBookRequest`. A
/// value outside the int4 range passes this check. The caller converts it
/// with `database_integer`, because in Node PostgreSQL rejects it and the
/// route returns its 500 message.
pub(crate) fn parse_book_id(raw: &str) -> Result<i64, ApiError> {
    parse_int_prefix(raw).ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid book ID"))
}

pub(crate) async fn authenticate_book(
    state: &AppState,
    headers: &HeaderMap,
    raw_book_id: &str,
    level: AccessLevel,
    failure_message: &'static str,
) -> Result<AuthenticatedBook, ApiError> {
    let user_id = session_user(state, headers, failure_message).await?;
    let book_id = database_integer(parse_book_id(raw_book_id)?, failure_message)?;
    authenticate_book_membership(state, user_id, book_id, level, failure_message).await
}

pub(crate) async fn authenticate_book_membership(
    state: &AppState,
    user_id: i32,
    book_id: i32,
    level: AccessLevel,
    failure_message: &'static str,
) -> Result<AuthenticatedBook, ApiError> {
    let membership = sqlx::query!(
        "SELECT bm.role FROM books b JOIN book_members bm ON bm.book_id = b.id WHERE b.id = $1 AND bm.user_id = $2",
        book_id,
        user_id
    )
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, failure_message))?;
    let role = match membership {
        None => None,
        Some(row) => Some(
            BookRole::from_database(&row.role)
                .ok_or_else(|| error(StatusCode::INTERNAL_SERVER_ERROR, failure_message))?,
        ),
    };
    match role {
        Some(role) if role.satisfies(level) => Ok(AuthenticatedBook {
            book_id,
            user_id,
            role,
        }),
        _ => Err(denial(role, level)),
    }
}

/// Carries the identity and role a write handler needs for auditing and
/// analytics without a second authentication query.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AuthenticatedBook {
    pub(crate) book_id: i32,
    pub(crate) user_id: i32,
    pub(crate) role: BookRole,
}

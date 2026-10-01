use crate::{
    auth::session_user,
    book_auth::{AccessLevel, authenticate_book_membership, parse_book_id},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    state::AppState,
    validation::{database_integer, from_json_bytes, parse_json_body},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{Local, NaiveDateTime, SecondsFormat, Utc};
use ledger_db::seed::{DemoDataset, SeedError, seed_book};
use serde_json::{Value, json};
use sqlx::FromRow;

#[derive(FromRow)]
struct BookRow {
    id: i32,
    user_id: i32,
    name: String,
    upcoming_days: i32,
    typesafe_reconciliation_enabled: bool,
    typesafe_revision: i32,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

fn timestamp(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn book_json(row: BookRow, role: Option<&str>) -> Value {
    let mut value = json!({
        "id": row.id,
        "userId": row.user_id,
        "name": row.name,
        "upcomingDays": row.upcoming_days,
        "typesafeReconciliationEnabled": row.typesafe_reconciliation_enabled,
        "typesafeRevision": row.typesafe_revision,
        "createdAt": timestamp(row.created_at),
        "updatedAt": timestamp(row.updated_at),
    });
    if let Some(role) = role {
        value["role"] = json!(role);
    }
    value
}

fn book_input(
    body: &Bytes,
    failure: &'static str,
    update: bool,
) -> Result<(String, Option<i32>), ApiError> {
    let body = parse_json_body(body, failure)?;
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Book name is required"))?
        .to_owned();
    let upcoming = if update {
        match body.get("upcomingDays") {
            None => None,
            Some(value) => Some(
                value
                    .as_f64()
                    .filter(|value| value.fract() == 0.0 && (1.0..=365.0).contains(value))
                    .ok_or_else(|| {
                        error(
                            StatusCode::BAD_REQUEST,
                            "upcomingDays must be an integer between 1 and 365",
                        )
                    })? as i32,
            ),
        }
    } else {
        None
    };
    Ok((name, upcoming))
}

const BOOK_COLUMNS: &str = "id, user_id, name, upcoming_days, typesafe_reconciliation_enabled, typesafe_revision, created_at, updated_at";

pub(crate) async fn list_books(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to fetch books").await?;
    let sql = format!(
        "SELECT {} , bm.role FROM book_members bm JOIN books b ON b.id = bm.book_id WHERE bm.user_id = $1 ORDER BY b.id",
        BOOK_COLUMNS
            .split(", ")
            .map(|field| format!("b.{field}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let rows: Vec<(BookRow, String)> = sqlx::query(&sql)
        .bind(user_id)
        .try_map(|row: ledger_db::engine::DbRow| {
            use sqlx::Row;
            Ok((BookRow::from_row(&row)?, row.try_get("role")?))
        })
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to fetch books"))?;
    Ok(Json(Value::Array(
        rows.into_iter()
            .map(|(book, role)| book_json(book, Some(&role)))
            .collect(),
    )))
}

pub(crate) async fn create_book(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to create book").await?;
    let (name, _) = book_input(&body, "Failed to create book", false)?;
    let sql = format!(
        "INSERT INTO books (user_id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING {BOOK_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookRow>(&sql)
        .bind(user_id)
        .bind(name)
        .bind(Utc::now().naive_utc())
        .fetch_one(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to create book"))?;
    Ok(Json(book_json(row, None)))
}

pub(crate) async fn update_book(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to update book").await?;
    let book_id = parse_book_id(&raw_book_id)?;
    let (name, upcoming) = book_input(&body, "Failed to update book", true)?;
    let book_id = database_integer(book_id, "Failed to update book")?;
    let authenticated = authenticate_book_membership(
        &state,
        user_id,
        book_id,
        AccessLevel::Owner,
        "Failed to update book",
    )
    .await?;
    let sql = format!(
        "UPDATE books SET name = $1, upcoming_days = COALESCE($2, upcoming_days), updated_at = $3 WHERE id = $4 RETURNING {BOOK_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookRow>(&sql)
        .bind(name)
        .bind(upcoming)
        .bind(Utc::now().naive_utc())
        .bind(authenticated.book_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to update book"))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Book not found"))?;
    Ok(Json(book_json(row, None)))
}

pub(crate) async fn delete_book(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to delete book").await?;
    let book_id = database_integer(parse_book_id(&raw_book_id)?, "Failed to delete book")?;
    let authenticated = authenticate_book_membership(
        &state,
        user_id,
        book_id,
        AccessLevel::Owner,
        "Failed to delete book",
    )
    .await?;
    sqlx::query("DELETE FROM books WHERE id = $1")
        .bind(authenticated.book_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to delete book"))?;
    Ok(Json(json!({ "success": true })))
}

const DEMO_FAILURE: &str = "Failed to create demo book";

/// A name that no book of this user holds: `base`, then "`base` 2", and so
/// on. At most `taken.len()` names are in use, so one of the first
/// `taken.len() + 1` candidates is free.
fn next_demo_book_name(base: &str, taken: &[String]) -> String {
    (1..=taken.len() + 1)
        .map(|n| {
            if n == 1 {
                base.to_owned()
            } else {
                format!("{base} {n}")
            }
        })
        .find(|candidate| !taken.contains(candidate))
        .expect("one of the first taken.len() + 1 names is free")
}

/// The dataset of a demo request. An empty body or no `dataset` field means
/// the household dataset, so older clients keep working. The route reads no
/// other field.
fn demo_dataset(body: &Bytes) -> Result<DemoDataset, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(DemoDataset::Household);
    }
    let value: Value =
        from_json_bytes(body).map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid JSON body"))?;
    let object = value.as_object().ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "Request body must be a JSON object",
        )
    })?;
    match object.get("dataset") {
        None | Some(Value::Null) => Ok(DemoDataset::Household),
        Some(Value::String(id)) => DemoDataset::from_id(id).ok_or_else(|| {
            let ids: Vec<&str> = DemoDataset::ALL.iter().map(|d| d.id()).collect();
            error_owned(
                StatusCode::BAD_REQUEST,
                format!("Unknown dataset \"{id}\". Use one of: {}", ids.join(", ")),
            )
        }),
        Some(_) => Err(error(StatusCode::BAD_REQUEST, "dataset must be a string")),
    }
}

/// Creates a book for `user_id` and fills it with the sample dataset.
///
/// `seed_book` deletes the rows of the book it gets before it writes, so it
/// must only get the ID of the book that this function has just created. The
/// request carries no book ID, so no caller can name one.
///
/// One transaction holds the book and the seed. A failure leaves no book
/// that holds part of a dataset.
async fn seed_demo_book(
    pool: &ledger_db::engine::DbPool,
    user_id: i32,
    dataset: DemoDataset,
) -> Result<BookRow, SeedError> {
    let mut transaction = ledger_db::locks::begin_pool(pool).await?;
    let taken: Vec<String> = sqlx::query_scalar("SELECT name FROM books WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(&mut *transaction)
        .await?;
    let sql = format!(
        "INSERT INTO books (user_id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING {BOOK_COLUMNS}"
    );
    let book = sqlx::query_as::<_, BookRow>(&sql)
        .bind(user_id)
        .bind(next_demo_book_name(dataset.book_name(), &taken))
        .bind(Utc::now().naive_utc())
        .fetch_one(&mut *transaction)
        .await?;
    let today = Local::now().date_naive();
    seed_book(&mut transaction, book.id, dataset, today, &mut |_| {}).await?;
    transaction.commit().await?;
    Ok(book)
}

/// The seed writes thousands of rows and takes seconds. It runs in its own
/// task, so it commits when the client leaves before the response. The
/// request future alone would be dropped, and the seed would roll back.
pub(crate) async fn create_demo_book(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let user_id = session_user(&state, &headers, DEMO_FAILURE).await?;
    let dataset = demo_dataset(&body)?;
    let pool = state.pool.clone();
    let seeded = tokio::spawn(async move { seed_demo_book(&pool, user_id, dataset).await })
        .await
        .map_err(|cause| cause.to_string())
        .and_then(|result| result.map_err(|cause| cause.to_string()));
    match seeded {
        Ok(book) => Ok(Json(book_json(book, None))),
        Err(cause) => {
            tracing::error!(error = %cause, "Failed to create demo book");
            Err(error(StatusCode::INTERNAL_SERVER_ERROR, DEMO_FAILURE))
        }
    }
}

/// The datasets that `POST /api/books/demo` accepts, in menu order.
pub(crate) async fn list_demo_datasets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult {
    session_user(&state, &headers, "Failed to list demo datasets").await?;
    Ok(Json(Value::Array(
        DemoDataset::ALL
            .iter()
            .map(|dataset| {
                json!({
                    "id": dataset.id(),
                    "name": dataset.name(),
                    "description": dataset.description(),
                })
            })
            .collect(),
    )))
}

#[cfg(test)]
mod tests {
    use super::{book_input, next_demo_book_name, parse_book_id};
    use axum::body::Bytes;

    #[test]
    fn book_inputs_keep_the_node_validation_order() {
        assert_eq!(parse_book_id("  +12tail").unwrap(), 12);
        assert!(parse_book_id("invalid").is_err());
        assert_eq!(
            book_input(
                &Bytes::from_static(br#"{"name":"  Ledger  ","upcomingDays":7}"#),
                "failed",
                true
            )
            .unwrap(),
            ("Ledger".into(), Some(7))
        );
        assert!(book_input(&Bytes::from_static(br#"{"name":"  "}"#), "failed", false).is_err());
    }

    #[test]
    fn demo_book_name_skips_the_names_in_use() {
        let base = "Demo Book";
        assert_eq!(next_demo_book_name(base, &[]), "Demo Book");
        assert_eq!(next_demo_book_name(base, &["Family".into()]), "Demo Book");
        assert_eq!(
            next_demo_book_name(base, &["Demo Book".into(), "Demo Book 3".into()]),
            "Demo Book 2"
        );
        assert_eq!(
            next_demo_book_name(base, &["Demo Book".into(), "Demo Book 2".into()]),
            "Demo Book 3"
        );
    }

    #[test]
    fn demo_dataset_reads_only_the_dataset_field() {
        use super::demo_dataset;
        use ledger_db::seed::DemoDataset;
        assert_eq!(demo_dataset(&Bytes::new()).unwrap(), DemoDataset::Household);
        assert_eq!(
            demo_dataset(&Bytes::from_static(b"  ")).unwrap(),
            DemoDataset::Household
        );
        assert_eq!(
            demo_dataset(&Bytes::from_static(br#"{"dataset":"single","bookId":9}"#)).unwrap(),
            DemoDataset::Single
        );
        assert_eq!(
            demo_dataset(&Bytes::from_static(br#"{"dataset":null}"#)).unwrap(),
            DemoDataset::Household
        );
        assert!(demo_dataset(&Bytes::from_static(br#"{"dataset":"nope"}"#)).is_err());
        assert!(demo_dataset(&Bytes::from_static(b"null")).is_err());
    }

    #[test]
    fn a_dataset_numbers_its_own_name() {
        let taken = vec!["Demo Book - Single".to_owned()];
        assert_eq!(
            next_demo_book_name("Demo Book - Single", &taken),
            "Demo Book - Single 2"
        );
        assert_eq!(next_demo_book_name("Demo Book", &taken), "Demo Book");
    }
}

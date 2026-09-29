use crate::{
    error::{ApiError, ApiResult, error, internal_error},
    state::AppState,
    validation::parse_json_body,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDateTime, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::FromRow;

use crate::auth::session_user;

#[derive(FromRow)]
struct ReportRow {
    id: i32,
    user_id: i32,
    description: String,
    r#type: String,
    page: String,
    status: String,
    created_at: NaiveDateTime,
}

fn report_json(row: ReportRow) -> Value {
    json!({
        "id": row.id,
        "userId": row.user_id,
        "description": row.description,
        "type": row.r#type,
        "page": row.page,
        "status": row.status,
        "createdAt": row.created_at.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

const COLUMNS: &str = "id, user_id, description, type, page, status, created_at";

fn required_text(
    body: &Value,
    key: &str,
    message: &'static str,
    trim: bool,
) -> Result<String, ApiError> {
    let text = body
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, message))?;
    let text = if trim { text.trim() } else { text };
    if text.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, message));
    }
    Ok(text.to_owned())
}

fn report_type(value: Option<&Value>, default: bool) -> Result<Option<String>, ApiError> {
    match value {
        None if default => Ok(Some("bug".to_owned())),
        None => Ok(None),
        Some(value) => value
            .as_str()
            .filter(|value| ["bug", "improvement", "other"].contains(value))
            .map(|value| Some(value.to_owned()))
            .ok_or_else(|| {
                error(
                    StatusCode::BAD_REQUEST,
                    "Invalid type. Must be one of: bug, improvement, other",
                )
            }),
    }
}

fn report_id(raw: &str) -> Result<i32, ApiError> {
    crate::validation::parse_js_number(raw)
        .filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && *value >= i32::MIN as f64
                && *value <= i32::MAX as f64
        })
        .map(|value| value as i32)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Invalid ID"))
}

pub(crate) async fn list_reports(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to fetch issue reports").await?;
    let sql = format!(
        "SELECT {COLUMNS} FROM issue_reports WHERE user_id = $1 ORDER BY created_at DESC, id DESC"
    );
    let rows = sqlx::query_as::<_, ReportRow>(&sql)
        .bind(user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to fetch issue reports"))?;
    Ok(Json(Value::Array(
        rows.into_iter().map(report_json).collect(),
    )))
}

pub(crate) async fn create_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to create issue report").await?;
    let body = parse_json_body(&body, "Failed to create issue report")?;
    let description = required_text(&body, "description", "Description is required", true)?;
    let page = required_text(&body, "page", "Page is required", false)?;
    let report_type = report_type(body.get("type"), true)?.expect("create type");
    let sql = format!(
        "INSERT INTO issue_reports (user_id, description, type, page, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING {COLUMNS}"
    );
    let row = sqlx::query_as::<_, ReportRow>(&sql)
        .bind(user_id)
        .bind(description)
        .bind(&report_type)
        .bind(&page)
        .bind(Utc::now().naive_utc())
        .fetch_one(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to create issue report"))?;
    state.analytics.capture_event(
        user_id,
        "issue_report_created",
        Some(json!({"type": report_type, "page": page})),
    );
    Ok(Json(report_json(row)))
}

pub(crate) async fn update_report(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to update issue report").await?;
    let id = report_id(&raw_id)?;
    let body = parse_json_body(&body, "Failed to update issue report")?;
    let description = if body.get("description").is_some() {
        Some(required_text(
            &body,
            "description",
            "Description cannot be empty",
            true,
        )?)
    } else {
        None
    };
    let status = match body.get("status") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|value| ["new", "resolved", "wontfix"].contains(value))
                .ok_or_else(|| {
                    error(
                        StatusCode::BAD_REQUEST,
                        "Invalid status. Must be one of: new, resolved, wontfix",
                    )
                })?
                .to_owned(),
        ),
    };
    let report_type = report_type(body.get("type"), false)?;
    if description.is_none() && status.is_none() && report_type.is_none() {
        return Err(error(StatusCode::BAD_REQUEST, "No valid fields to update"));
    }
    let sql = format!(
        "UPDATE issue_reports SET description = COALESCE($1, description), status = COALESCE($2, status), type = COALESCE($3, type) WHERE id = $4 AND user_id = $5 RETURNING {COLUMNS}"
    );
    let row = sqlx::query_as::<_, ReportRow>(&sql)
        .bind(description)
        .bind(status)
        .bind(report_type)
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to update issue report"))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Issue report not found"))?;
    Ok(Json(report_json(row)))
}

pub(crate) async fn delete_report(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    let user_id = session_user(&state, &headers, "Failed to delete issue report").await?;
    let id = report_id(&raw_id)?;
    let result = sqlx::query("DELETE FROM issue_reports WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(|cause| internal_error(cause, "Failed to delete issue report"))?;
    if result.rows_affected() == 0 {
        return Err(error(StatusCode::NOT_FOUND, "Issue report not found"));
    }
    Ok(Json(json!({ "success": true })))
}

//! The user's grants, for the "Connected apps" list of the account page:
//! `GET /api/oauth/grants` and `DELETE /api/oauth/grants/{id}`. To delete a
//! grant deletes its codes and tokens, so the client's next call gets 401.
//! These routes accept only the session cookie, as the API key routes do.

use super::{cookie_user, no_store, sweep};
use crate::{error::error, state::AppState};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, SecondsFormat};
use serde_json::{Value, json};

fn iso(value: NaiveDateTime) -> String {
    value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
}

#[derive(sqlx::FromRow)]
struct GrantRow {
    id: i32,
    client_name: String,
    client_id: String,
    metadata_document: bool,
    redirect_uri: String,
    created_at: NaiveDateTime,
    last_used_at: Option<NaiveDateTime>,
}

/// `GET /api/oauth/grants`: the grants that have a token, newest first. A
/// grant with only an unused code is not yet a connection.
pub(super) async fn list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user_id = match cookie_user(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(cause) => return cause.into_response(),
    };
    // The list works while OAuth is off, so that a user can still revoke
    // the grants from before.
    sweep(&state).await;
    let rows: Result<Vec<GrantRow>, _> = sqlx::query_as(
        "SELECT g.id, oc.client_name, oc.client_id, oc.metadata_document, g.redirect_uri,
                g.created_at, g.last_used_at
         FROM oauth_grants g JOIN oauth_clients oc ON oc.id = g.client_id
         WHERE g.user_id = $1
           AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id)
         ORDER BY g.created_at DESC, g.id DESC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await;
    match rows {
        Ok(rows) => no_store(
            Json(Value::Array(
                rows.into_iter()
                    .map(|row| {
                        json!({
                            "id": row.id,
                            "clientName": row.client_name,
                            "clientHost": row
                                .metadata_document
                                .then(|| host_of(&row.client_id))
                                .flatten(),
                            "redirectHost": host_of(&row.redirect_uri),
                            "createdAt": iso(row.created_at),
                            "lastUsedAt": row.last_used_at.map(iso),
                        })
                    })
                    .collect(),
            ))
            .into_response(),
        ),
        Err(cause) => {
            tracing::error!(error = %cause, "Could not list OAuth grants");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to fetch connected apps",
            )
            .into_response()
        }
    }
}

/// `DELETE /api/oauth/grants/{id}`: revokes one of the user's grants.
pub(super) async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let user_id = match cookie_user(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(cause) => return cause.into_response(),
    };
    let Ok(id) = id.parse::<i32>() else {
        return error(StatusCode::BAD_REQUEST, "Invalid connection ID").into_response();
    };
    match sqlx::query_scalar::<_, i32>(
        "DELETE FROM oauth_grants WHERE id = $1 AND user_id = $2 RETURNING id",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(_)) => Json(json!({ "success": true })).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "Connection not found").into_response(),
        Err(cause) => {
            tracing::error!(error = %cause, "Could not revoke an OAuth grant");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to revoke the connection",
            )
            .into_response()
        }
    }
}

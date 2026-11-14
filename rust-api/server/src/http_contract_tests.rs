//! HTTP adapters used only by tests while the dependent route ports are
//! blocked on this shared layer. They exercise the same helpers those routes
//! will call, through Axum and a real SQLite database (migrated, in memory).

use crate::{
    book_auth::{AccessLevel, authenticate_book},
    cron_auth::require_cron_secret,
    error::{ApiError, error, internal_error},
    platform,
    rate_limit::{Keys, RateLimiter, Scope},
    state::AppState,
    validation::{parse_json_body, require_account_parent, validate_account_create},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use ledger_db::{Sql, store::params};
use serde_json::{Value, json};
use std::sync::Arc;

async fn read_book(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth = authenticate_book(
        &state,
        &headers,
        &raw_id,
        AccessLevel::Read,
        "Failed to fetch accounts",
    )
    .await?;
    Ok(Json(
        json!({"bookId": auth.book_id(), "userId": auth.user_id()}),
    ))
}

async fn write_account(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let auth = authenticate_book(
        &state,
        &headers,
        &raw_id,
        AccessLevel::Write,
        "Failed to create account",
    )
    .await?;
    let body = parse_json_body(&body, "Failed to create account")?;
    let input = validate_account_create(&body)?;
    require_account_parent(
        &state.database,
        auth.book_id(),
        input.parent_id,
        "Failed to create account",
    )?;
    let id: i32 = state
        .database
        .query_row(
            "INSERT INTO accounts (book_id, name, type, created_at, updated_at)
             VALUES (?1, ?2, ?3, '2026-10-21 00:00:00', '2026-10-21 00:00:00') RETURNING id",
            &params![auth.book_id(), &input.name, &input.account_type],
        )
        .map_err(|cause| internal_error(cause, "Failed to create account"))?;
    Ok(Json(
        json!({"id": id, "bookId": auth.book_id(), "name": input.name}),
    ))
}

async fn owner_book(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    authenticate_book(
        &state,
        &headers,
        &raw_id,
        AccessLevel::Owner,
        "Failed to update book",
    )
    .await?;
    Ok(StatusCode::OK)
}

async fn cron(headers: HeaderMap) -> Result<StatusCode, ApiError> {
    require_cron_secret(&headers, Some("test-cron-secret"))?;
    Ok(StatusCode::OK)
}

async fn limited_login(State(limiter): State<Arc<RateLimiter>>) -> axum::response::Response {
    let keys = Keys {
        username: Some("alice"),
        ip: Some("10.0.0.1"),
    };
    let now = platform::timestamp();
    if let Err(denied) = limiter.enforce(Scope::Login, &keys, now) {
        return axum::response::IntoResponse::into_response(denied);
    }
    limiter.failure(Scope::Login, &keys, now);
    axum::response::IntoResponse::into_response((
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"Invalid username or password"})),
    ))
}

async fn lock_probe(
    State(database): State<Arc<ledger_db::Database>>,
) -> Result<StatusCode, ApiError> {
    let held = crate::leases::try_take(&database, &crate::leases::plaid_sync(4))
        .map_err(|cause| internal_error(cause, "Failed to sync token"))?;
    if held.is_some() {
        Ok(StatusCode::OK)
    } else {
        Err(error(
            StatusCode::CONFLICT,
            "A sync is already running for this connection",
        ))
    }
}

async fn spawn(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, server)
}

#[tokio::test]
async fn book_and_body_denials_match_node_http_contract() {
    let state = AppState::in_memory();
    let database = state.database.clone();
    // The trigger makes each book's creator its owner.
    database
        .exec_batch(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES
           (1, 'owner', 'unused', '2026-10-21 00:00:00'),
           (2, 'editor', 'unused', '2026-10-21 00:00:00'),
           (3, 'viewer', 'unused', '2026-10-21 00:00:00'),
           (4, 'other', 'unused', '2026-10-21 00:00:00');
         INSERT INTO books (id, user_id, name, created_at, updated_at) VALUES
           (7, 1, 'Shared', '2026-10-21 00:00:00', '2026-10-21 00:00:00'),
           (8, 4, 'Other', '2026-10-21 00:00:00', '2026-10-21 00:00:00');
         INSERT INTO book_members (book_id, user_id, role, created_at) VALUES
           (7, 2, 'editor', '2026-10-21 00:00:00'), (7, 3, 'viewer', '2026-10-21 00:00:00');
         INSERT INTO accounts (book_id, name, type, created_at, updated_at)
           VALUES (8, 'Other Parent', 'asset', '2026-10-21 00:00:00', '2026-10-21 00:00:00');",
        )
        .unwrap();
    for (token, user_id) in [("owner", 1), ("editor", 2), ("viewer", 3)] {
        use sha2::{Digest, Sha256};
        database
            .execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
                 VALUES (?1, ?2, ?3, '2026-10-21 00:00:00')",
                &params![
                    hex::encode(Sha256::digest(token.as_bytes())),
                    user_id,
                    (chrono::Utc::now() + chrono::Duration::hours(1)).naive_utc()
                ],
            )
            .unwrap();
    }
    let other_parent: i32 = database
        .query_row("SELECT id FROM accounts WHERE book_id = 8", &[])
        .unwrap();
    let app = Router::new()
        .route("/book/{id}/read", get(read_book))
        .route("/book/{id}/write", post(write_account))
        .route("/book/{id}/owner", post(owner_book))
        .with_state(state);
    let (base, server) = spawn(app).await;
    let client = reqwest::Client::new();
    let request = |path: &str, token: &str| {
        client
            .post(format!("{base}{path}"))
            .header("cookie", format!("counterpoise_session={token}"))
    };

    let viewer = request("/book/7/write", "viewer")
        .json(&json!({"name":"Child","type":"asset"}))
        .send()
        .await
        .unwrap();
    assert_eq!(viewer.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        viewer.json::<Value>().await.unwrap(),
        json!({"error":"You have read-only access to this book"})
    );
    let unauthenticated = client
        .get(format!("{base}/book/7/read"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        unauthenticated.json::<Value>().await.unwrap(),
        json!({"error":"Not authenticated"})
    );
    let editor = request("/book/7/owner", "editor").send().await.unwrap();
    assert_eq!(editor.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        editor.json::<Value>().await.unwrap(),
        json!({"error":"Only an owner can do this"})
    );
    let missing = client
        .get(format!("{base}/book/8/read"))
        .header("cookie", "counterpoise_session=viewer")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        missing.json::<Value>().await.unwrap(),
        json!({"error":"Book not found"})
    );
    let invalid = request("/book/7/write", "owner")
        .json(&json!({"name":"Child","type":"banana"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid.json::<Value>().await.unwrap(),
        json!({"error":"Invalid account type"})
    );
    let missing_name = request("/book/7/write", "owner")
        .json(&json!({"type":"asset"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_name.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        missing_name.json::<Value>().await.unwrap(),
        json!({"error":"Name and type are required"})
    );
    let malformed = request("/book/7/write", "owner")
        .header("content-type", "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        malformed.json::<Value>().await.unwrap(),
        json!({"error":"Failed to create account"})
    );
    let foreign_parent = request("/book/7/write", "owner")
        .json(&json!({"name":"Child","type":"asset","parentId":other_parent}))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_parent.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        foreign_parent.json::<Value>().await.unwrap(),
        json!({"error":"Invalid parentId"})
    );
    let protected = request("/book/7/write", "owner")
        .json(&json!({"name":"Safe","type":"asset","bookId":8,"id":999}))
        .send()
        .await
        .unwrap();
    assert_eq!(protected.status(), StatusCode::OK);
    let created: Value = protected.json().await.unwrap();
    assert_eq!(created["bookId"], 7);
    assert_ne!(created["id"], 999);
    let stored_book: i32 = database
        .query_row(
            "SELECT book_id FROM accounts WHERE id = ?1",
            &params![created["id"].as_i64().unwrap() as i32],
        )
        .unwrap();
    assert_eq!(stored_book, 7);
    server.abort();
}

#[tokio::test]
async fn cron_and_rate_limit_denials_match_node_http_contract() {
    let (base, server) = spawn(Router::new().route("/cron", get(cron))).await;
    let client = reqwest::Client::new();
    for header in [None, Some("Bearer wrong"), Some("bearer test-cron-secret")] {
        let mut request = client.get(format!("{base}/cron"));
        if let Some(value) = header {
            request = request.header("authorization", value);
        }
        let denied = request.send().await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            denied.json::<Value>().await.unwrap(),
            json!({"error":"Unauthorized"})
        );
    }
    let allowed = client
        .get(format!("{base}/cron"))
        .header("authorization", "Bearer test-cron-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status(), StatusCode::OK);
    server.abort();

    let database = ledger_db::Database::open_in_memory().unwrap();
    ledger_db::migrate(&database).unwrap();
    let limiter = Arc::new(RateLimiter::new(Arc::new(database)));
    let app = Router::new()
        .route("/login", post(limited_login))
        .with_state(limiter);
    let (base, server) = spawn(app).await;
    for _ in 0..5 {
        let denied = client.post(format!("{base}/login")).send().await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            denied.json::<Value>().await.unwrap(),
            json!({"error":"Invalid username or password"})
        );
    }
    let limited = client.post(format!("{base}/login")).send().await.unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.headers()["retry-after"], "60");
    assert_eq!(
        limited.json::<Value>().await.unwrap(),
        json!({"error":"Too many attempts. Try again in 60s."})
    );
    server.abort();
}

#[tokio::test]
async fn advisory_lock_busy_maps_to_the_node_conflict_body() {
    let database = Arc::new(ledger_db::Database::open_in_memory().unwrap());
    ledger_db::migrate(&database).unwrap();
    let held = crate::leases::try_take(&database, &crate::leases::plaid_sync(4))
        .unwrap()
        .unwrap();
    let (base, server) = spawn(
        Router::new()
            .route("/sync", post(lock_probe))
            .with_state(database),
    )
    .await;
    let response = reqwest::Client::new()
        .post(format!("{base}/sync"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error":"A sync is already running for this connection"})
    );
    drop(held);
    let response = reqwest::Client::new()
        .post(format!("{base}/sync"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    server.abort();
}

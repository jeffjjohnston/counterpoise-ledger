//! HTTP adapters used only by tests while the dependent route ports are
//! blocked on this shared layer. They exercise the same helpers those routes
//! will call, through Axum and a real SQLite database file (`TempDatabase`).

use crate::{
    analytics::PostHogCapture,
    book_auth::{AccessLevel, authenticate_book},
    cron_auth::require_cron_secret,
    error::{ApiError, error, internal_error},
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
use ledger_db::engine::DbPool;
use ledger_db::locks::{SessionLock, with_session_lock};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};

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
        json!({"bookId": auth.book_id, "userId": auth.user_id}),
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
        &state.pool,
        auth.book_id,
        input.parent_id,
        "Failed to create account",
    )
    .await?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO accounts (book_id, name, type) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(auth.book_id)
    .bind(&input.name)
    .bind(&input.account_type)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| internal_error(cause, "Failed to create account"))?;
    Ok(Json(
        json!({"id": id, "bookId": auth.book_id, "name": input.name}),
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
    let now = Instant::now();
    if let Err(denied) = limiter.enforce(Scope::Login, &keys, now) {
        return axum::response::IntoResponse::into_response(denied);
    }
    limiter.failure(Scope::Login, &keys, now);
    axum::response::IntoResponse::into_response((
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"Invalid username or password"})),
    ))
}

async fn lock_probe(State(pool): State<DbPool>) -> Result<StatusCode, ApiError> {
    let result = with_session_lock(
        &pool,
        SessionLock::new(1_000_004, std::process::id() as i32),
        |_| Box::pin(async { Ok(()) }),
    )
    .await
    .map_err(|cause| internal_error(cause, "Failed to sync token"))?;
    if result.is_some() {
        Ok(StatusCode::OK)
    } else {
        Err(error(
            StatusCode::CONFLICT,
            "A sync is already running for this connection",
        ))
    }
}

async fn analytics_probe(State(capture): State<PostHogCapture>) -> StatusCode {
    capture.capture_event(
        42,
        "account_created",
        Some(json!({"bookId":7,"type":"asset"})),
    );
    StatusCode::OK
}

async fn spawn(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, server)
}

#[tokio::test]
async fn book_and_body_denials_match_node_http_contract() {
    let database = ledger_db::testing::TempDatabase::new(1).await;
    let pool = database.pool().clone();
    sqlx::query(
        "CREATE TEMP TABLE sessions (token_hash text, user_id integer, expires_at timestamp)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("CREATE TEMP TABLE books (id integer)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TEMP TABLE book_members (book_id integer, user_id integer, role text)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("CREATE TEMP TABLE accounts (id INTEGER PRIMARY KEY, book_id integer, name text, type text)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO books VALUES (7), (8)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO book_members VALUES (7, 1, 'owner'), (7, 2, 'editor'), (7, 3, 'viewer')",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (token, user_id) in [("owner", 1), ("editor", 2), ("viewer", 3)] {
        use sha2::{Digest, Sha256};
        sqlx::query("INSERT INTO sessions VALUES ($1, $2, $3)")
            .bind(hex::encode(Sha256::digest(token.as_bytes())))
            .bind(user_id)
            .bind((chrono::Utc::now() + chrono::Duration::hours(1)).naive_utc())
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO accounts (book_id, name, type) VALUES (8, 'Other Parent', 'asset')")
        .execute(&pool)
        .await
        .unwrap();
    let other_parent: i32 = sqlx::query_scalar("SELECT id FROM accounts WHERE book_id = 8")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut state = AppState::with_pool(
        pool.clone(),
        crate::book_changes::BookChangeHub::new(pool.clone()),
    );
    state.pool = pool.clone();
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
    let stored_book: i32 = sqlx::query_scalar("SELECT book_id FROM accounts WHERE id = $1")
        .bind(created["id"].as_i64().unwrap() as i32)
        .fetch_one(&pool)
        .await
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

    let limiter = Arc::new(RateLimiter::default());
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
    let database = ledger_db::testing::TempDatabase::new(2).await;
    let pool = database.pool().clone();
    let (held_tx, held_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let holder_pool = pool.clone();
    let holder = tokio::spawn(async move {
        with_session_lock(
            &holder_pool,
            SessionLock::new(1_000_004, std::process::id() as i32),
            |_| {
                Box::pin(async move {
                    held_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(())
                })
            },
        )
        .await
        .unwrap()
    });
    held_rx.await.unwrap();
    let (base, server) = spawn(
        Router::new()
            .route("/sync", post(lock_probe))
            .with_state(pool),
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
    release_tx.send(()).unwrap();
    assert!(holder.await.unwrap().is_some());
    server.abort();
}

#[tokio::test]
async fn analytics_backend_error_does_not_change_http_success() {
    let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel(1);
    let receiver = Router::new().route(
        "/batch/",
        post(move |Json(body): Json<Value>| {
            let seen_tx = seen_tx.clone();
            async move {
                seen_tx.send(body).await.unwrap();
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }),
    );
    let (host, receiver_server) = spawn(receiver).await;
    let capture = PostHogCapture::new(Some("project-key".into()), Some(host));
    let (base, app_server) = spawn(
        Router::new()
            .route("/account", post(analytics_probe))
            .with_state(capture),
    )
    .await;
    let response = reqwest::Client::new()
        .post(format!("{base}/account"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), seen_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        event["batch"][0],
        json!({"distinct_id":"42","event":"account_created","properties":{"bookId":7,"type":"asset"}})
    );
    app_server.abort();
    receiver_server.abort();
}

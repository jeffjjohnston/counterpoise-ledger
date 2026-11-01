//! How many bytes of a request body the Worker reads before it forwards the
//! request to the object. The Worker reads the body into one buffer first
//! (`worker_entry.rs` in the Worker crate says why), and that read comes
//! before any check of the object's: before authentication, and before the
//! route's own limit. Each limit here is therefore the route's own, so that
//! the Worker never holds more than the route would take.

use crate::{cron_auth::verify_cron_secret, mcp};
use axum::http::HeaderMap;

/// The limit of every route that reads its body with an axum extractor
/// (`Json`, `Form`, `Bytes`): axum's `DefaultBodyLimit`, which the router
/// keeps. A test below holds the two together.
pub const BODY_BYTES: usize = 2 * 1024 * 1024;

/// The most bytes of a request body to `path` that the Worker reads.
/// `import_authorized` says that the request carries the import secret
/// ([`import_authorized`]): only then does the admin import get its larger
/// limit, so that a caller without the secret cannot make the Worker hold
/// a 64 MiB body.
pub fn body_limit(path: &str, import_authorized: bool) -> usize {
    if path == super::import::PATH && import_authorized {
        super::import::MOST_BYTES
    } else if path == mcp::PATH {
        mcp::MAX_BODY_BYTES
    } else {
        BODY_BYTES
    }
}

/// Whether `headers` carry `Authorization: Bearer <secret>`, the import's
/// own check. No secret is never authorized.
pub fn import_authorized(headers: &HeaderMap, secret: Option<&str>) -> bool {
    verify_cron_secret(headers, secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::{HeaderValue, Request, StatusCode, header::AUTHORIZATION},
        routing::post,
    };
    use tower::ServiceExt;

    #[test]
    fn each_route_gets_its_own_limit() {
        assert_eq!(body_limit("/api/b/1/transactions", false), BODY_BYTES);
        assert_eq!(body_limit("/api/oauth/token", false), BODY_BYTES);
        assert_eq!(body_limit("/api/mcp", false), 4 * 1024 * 1024);
        assert_eq!(body_limit("/api/mcp/", false), BODY_BYTES);
        assert_eq!(body_limit("/api/admin/import", true), 64 * 1024 * 1024);
        assert_eq!(body_limit("/api/admin/import", false), BODY_BYTES);
        assert_eq!(body_limit("/api/admin/restore", true), BODY_BYTES);
    }

    #[test]
    fn the_import_limit_needs_the_secret() {
        let mut headers = HeaderMap::new();
        assert!(!import_authorized(&headers, Some("s3cret")));
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer s3cret"));
        assert!(import_authorized(&headers, Some("s3cret")));
        assert!(!import_authorized(&headers, Some("other")));
        assert!(!import_authorized(&headers, None));
        assert!(!import_authorized(&headers, Some("")));
    }

    /// `BODY_BYTES` is axum's default limit: a body of that size is read,
    /// one byte more is refused.
    #[tokio::test]
    async fn body_bytes_is_the_extractor_limit() {
        let app = Router::new().route(
            "/",
            post(|body: Bytes| async move { body.len().to_string() }),
        );
        for (size, status) in [
            (BODY_BYTES, StatusCode::OK),
            (BODY_BYTES + 1, StatusCode::PAYLOAD_TOO_LARGE),
        ] {
            let request = Request::post("/")
                .body(Body::from(vec![b'a'; size]))
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), status, "{size} bytes");
        }
    }
}

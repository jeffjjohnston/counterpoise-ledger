//! The client build, served as the page service of [`crate::security::protect`].
//!
//! `vite build` writes a static site: `index.html`, the files of `public/`,
//! and the hashed chunks in `assets/`. The client routes in the browser, so
//! each page path that is not a file gets `index.html`. The page gate in
//! `security.rs` runs first: this service gets only a public path or a
//! request that has a session.

use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::Response,
};
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};

/// The folder of the build that holds the hashed chunks. A new build gives
/// each changed file a new name, so the browser can keep these for a year.
pub(crate) const ASSETS_PREFIX: &str = "/assets/";

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// `index.html` names the chunks of one build, so the browser must ask again
/// each time. It gets a 304 when the file did not change.
const REVALIDATE: &str = "no-cache";

/// Refuses to start with a folder that is not a client build, so that a
/// wrong `COUNTERPOISE_STATIC_DIR` does not give 404 for every page.
pub(crate) fn check(dir: &Path) -> Result<(), String> {
    let index = dir.join("index.html");
    if index.is_file() {
        Ok(())
    } else {
        Err(format!(
            "COUNTERPOISE_STATIC_DIR names {}, which has no index.html",
            dir.display()
        ))
    }
}

pub(crate) fn service(dir: &Path) -> Router {
    Router::new()
        // A chunk that is not there gets 404, not index.html: a browser that
        // asks for a script must not get a page.
        .nest_service("/assets", ServeDir::new(dir.join("assets")))
        .fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html"))))
        .layer(middleware::from_fn(cache_control))
}

async fn cache_control(request: Request, next: Next) -> Response {
    let asset = request.uri().path().starts_with(ASSETS_PREFIX);
    let mut response = next.run(request).await;
    // A 304 must have the headers of the 200 that it replaces, because the
    // browser puts them on the copy that it keeps. With `no-cache` here, a
    // 304 for a chunk would make the browser ask for that chunk each time.
    let found = response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED;
    let value = if asset && found {
        IMMUTABLE
    } else {
        REVALIDATE
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    // The compression layer (compression.rs) adds this header only to a body
    // that it compresses. A 304 has no body, but it must name the same
    // header as the 200 (RFC 9110, section 15.4.5). The layer does not add
    // the header again when it is there.
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::protect;
    use axum::body::{Body, to_bytes};
    use std::path::PathBuf;
    use tower::ServiceExt;

    /// A small client build in a new temporary folder.
    fn build() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "counterpoise-static-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><div id=root>").unwrap();
        std::fs::write(dir.join("assets/index-abc123.js"), "console.log(1)").unwrap();
        std::fs::write(dir.join("favicon.ico"), "icon").unwrap();
        dir
    }

    async fn get(dir: &Path, path: &str, session: bool) -> (StatusCode, Option<String>, String) {
        let app = protect(Router::new(), service(dir), false);
        let mut request = Request::builder().uri(path).header("host", "localhost");
        if session {
            request = request.header("cookie", "counterpoise_session=token");
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let cache = response
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|value| value.to_str().unwrap().to_owned());
        let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        (status, cache, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn sends_index_html_for_each_page_path() {
        let dir = build();
        for path in [
            "/",
            "/b/5/transactions",
            "/b/5/securities/2.json",
            "/account",
        ] {
            let (status, cache, body) = get(&dir, path, true).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(cache.as_deref(), Some(REVALIDATE), "{path}");
            assert!(body.contains("id=root"), "{path}");
        }
        // The public pages load without a session.
        for path in ["/login", "/register"] {
            let (status, _, body) = get(&dir, path, false).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert!(body.contains("id=root"), "{path}");
        }
    }

    #[tokio::test]
    async fn keeps_the_page_gate_in_front() {
        let dir = build();
        let (status, _, body) = get(&dir, "/b/5/transactions", false).await;
        assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(body, "");
    }

    #[tokio::test]
    async fn serves_the_chunks_without_a_session_and_caches_them() {
        let dir = build();
        let (status, cache, body) = get(&dir, "/assets/index-abc123.js", false).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache.as_deref(), Some(IMMUTABLE));
        assert_eq!(body, "console.log(1)");

        let (status, cache, _) = get(&dir, "/favicon.ico", false).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache.as_deref(), Some(REVALIDATE));
    }

    #[tokio::test]
    async fn gives_404_for_a_missing_chunk() {
        let dir = build();
        let (status, cache, body) = get(&dir, "/assets/gone-000000.js", false).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(cache.as_deref(), Some(REVALIDATE));
        assert!(!body.contains("id=root"));
    }

    #[test]
    fn refuses_a_folder_without_index_html() {
        let dir = build();
        assert!(check(&dir).is_ok());
        assert!(check(&dir.join("assets")).is_err());
    }
}

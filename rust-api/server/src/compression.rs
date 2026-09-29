//! Response compression for the whole server: the API, the MCP endpoint and
//! the client build.
//!
//! The Next server compressed its responses, and this server must do the same.
//! The largest file of the client build is the chunk that holds the WASM core
//! as base64 (about 1.9 MB). Without compression it goes out at full size,
//! unless a reverse proxy compresses it.
//!
//! The server compresses each response when it sends it. It does not keep
//! compressed copies of the build (`.gz` and `.br` files beside each chunk)
//! for these reasons:
//!
//! - The API and the MCP endpoint send JSON, which only compression at send
//!   time can make smaller. Thus the layer is necessary for them in any case.
//! - The browser keeps each hashed chunk for a year (`static_pages.rs`), so a
//!   browser gets the large chunk again only after a release changes it.
//! - Compressed copies need a new build step and a new stage in the image,
//!   and a copy that does not agree with its source is a new type of defect.
//!   A copy at brotli quality 11 makes the WASM chunk about 90 KB smaller
//!   than [`LEVEL`] does, one time for each release. That is not sufficient
//!   reason for the new step.
//!
//! [`LEVEL`] is 5 for gzip and brotli. The default of tower-http is gzip 6
//! and brotli 4. On the base64 text of the WASM chunk, brotli 4 is worse
//! than gzip. Measured on the 1,940 KB chunk: gzip 6 gives 691 KB, gzip 5
//! gives 699 KB, brotli 4 gives 696 KB and brotli 5 gives 624 KB, for about
//! the same time. Brotli 11 (536 KB) takes more than 2 s, which is too slow
//! for compression at send time.
//!
//! The layer does not compress these responses:
//!
//! - Server-sent events (`text/event-stream`): the book change stream. Each
//!   hint must go out at once, as the route writes it. A compressor, or a
//!   proxy that reads a compressed stream, can hold bytes back until it has
//!   more of them. The default predicate of tower-http refuses this content
//!   type. A test below holds this rule.
//! - Images (but not SVG) and gRPC: the default predicate refuses them.
//! - WOFF and WOFF2 fonts: these formats are compressed already.
//! - A body of 32 bytes or less: the default predicate refuses it.
//! - A response that has a `Content-Encoding` or a `Content-Range`.
//!
//! When the layer compresses a response, it adds `Vary: Accept-Encoding` and
//! removes `Content-Length` and `Accept-Ranges`. Hyper then sends the body in
//! chunks.
//!
//! Only the gzip and br features of tower-http are on, so the layer ignores
//! deflate and zstd in `Accept-Encoding`. For Chrome (`gzip, deflate, br,
//! zstd`) it selects br.

use axum::Router;
use tower_http::{
    CompressionLevel,
    compression::{
        CompressionLayer, DefaultPredicate, Predicate,
        predicate::{And, NotForContentType},
    },
};

/// The gzip level and the brotli quality. See the module documentation.
const LEVEL: i32 = 5;

/// `font/woff` is also the start of `font/woff2`, so this refuses the two.
const FONTS: NotForContentType = NotForContentType::const_new("font/woff");

type Rules = And<DefaultPredicate, NotForContentType>;

fn layer() -> CompressionLayer<Rules> {
    CompressionLayer::new()
        .quality(CompressionLevel::Precise(LEVEL))
        .compress_when(DefaultPredicate::new().and(FONTS))
}

/// Puts the compression layer around `app`. `serve()` calls this last, so
/// that the layer compresses each response that the server sends.
pub(crate) fn compress(app: Router) -> Router {
    app.layer(layer())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{security::protect, static_pages};
    use axum::{
        Json,
        body::{Body, to_bytes},
        extract::Request,
        http::{HeaderMap, HeaderValue, StatusCode, header},
        response::{IntoResponse, Response},
        routing::get,
    };
    use futures_util::StreamExt;
    use serde_json::{Value, json};
    use std::{
        convert::Infallible,
        io::Read,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use tokio::sync::Notify;
    use tower::ServiceExt;

    const FIRST_FRAME: &str = "event: ready\ndata: {}\n\n";
    const SECOND_FRAME: &str = "event: change\ndata: {\"tables\":[\"payees\"]}\n\n";
    const IMMUTABLE: &str = "public, max-age=31536000, immutable";

    /// A JSON body of more than 10 KB, as a register page gives.
    fn big_json() -> Value {
        let rows: Vec<Value> = (0..200)
            .map(|id| json!({ "id": id, "payee": "Grocer", "memo": "Weekly shop", "amountCents": -4200 }))
            .collect();
        json!({ "transactions": rows })
    }

    /// An event stream like the book change stream (`routes/events.rs`). It
    /// sends the second frame only after `release` is notified. Thus the test
    /// can read the first frame while the stream is open.
    fn event_stream(release: Arc<Notify>) -> Response {
        let frames = futures_util::stream::unfold(0, move |sent| {
            let release = release.clone();
            async move {
                match sent {
                    0 => Some((Ok::<_, Infallible>(FIRST_FRAME), 1)),
                    1 => {
                        release.notified().await;
                        Some((Ok(SECOND_FRAME), 2))
                    }
                    _ => None,
                }
            }
        });
        let mut response = Body::from_stream(frames).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        response
    }

    fn chunk() -> String {
        "export const value = 1;\n".repeat(1000)
    }

    /// A client build with a large chunk, a font, an image and `index.html`.
    fn build() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "counterpoise-compression-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::create_dir_all(dir.join("fonts")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><div id=root>").unwrap();
        std::fs::write(dir.join("assets/index-abc123.js"), chunk()).unwrap();
        std::fs::write(dir.join("fonts/Sans.woff2"), [7u8; 4096]).unwrap();
        std::fs::write(dir.join("icon.png"), [7u8; 4096]).unwrap();
        dir
    }

    /// The layers of `serve()`: the security layers, the API routes, the
    /// client build, and the compression layer around them.
    fn app(dir: &Path, release: Arc<Notify>) -> Router {
        let api = Router::new()
            .route("/api/big", get(|| async { Json(big_json()) }))
            .route("/api/tiny", get(|| async { Json(json!({ "ok": true })) }))
            .route(
                "/api/stream",
                get(move || {
                    let release = release.clone();
                    async move { event_stream(release) }
                }),
            );
        compress(protect(api, static_pages::service(dir), false))
    }

    async fn send(dir: &Path, path: &str, headers: &[(&str, &str)]) -> Response {
        send_to(app(dir, Arc::default()), path, headers).await
    }

    async fn send_to(app: Router, path: &str, headers: &[(&str, &str)]) -> Response {
        let mut request = Request::builder()
            .uri(path)
            .header("host", "localhost")
            .header("cookie", "counterpoise_session=token");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        app.oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        headers.get(name).map(|value| value.to_str().unwrap())
    }

    /// The body as the client reads it after it removes the encoding.
    async fn decoded(response: Response) -> Vec<u8> {
        let encoding = text(response.headers(), "content-encoding").map(str::to_owned);
        let body = to_bytes(response.into_body(), 1 << 24).await.unwrap();
        let mut plain = Vec::new();
        match encoding.as_deref() {
            None => plain.extend_from_slice(&body),
            Some("gzip") => {
                flate2::read::GzDecoder::new(&body[..])
                    .read_to_end(&mut plain)
                    .unwrap();
            }
            Some("br") => {
                brotli_decompressor::Decompressor::new(&body[..], 4096)
                    .read_to_end(&mut plain)
                    .unwrap();
            }
            Some(other) => panic!("unexpected encoding {other}"),
        }
        plain
    }

    fn assert_compressed(response: &Response, encoding: &str) {
        let headers = response.headers();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(text(headers, "content-encoding"), Some(encoding));
        assert_eq!(text(headers, "vary"), Some("accept-encoding"));
        // Hyper sends a body with no length in chunks. The length of the
        // uncompressed body would not agree with the bytes that go out.
        assert_eq!(headers.get(header::CONTENT_LENGTH), None);
        // The security headers stay on a compressed response.
        assert_eq!(text(headers, "x-content-type-options"), Some("nosniff"));
    }

    fn assert_not_compressed(response: &Response) {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(header::CONTENT_ENCODING), None);
    }

    #[tokio::test]
    async fn compresses_a_large_json_response_only_when_the_client_accepts_it() {
        let dir = build();
        let expected = serde_json::to_vec(&big_json()).unwrap();
        assert!(expected.len() > 10_000);

        for (accept, encoding) in [
            ("gzip", "gzip"),
            ("br", "br"),
            ("gzip, deflate, br", "br"),
            ("br;q=0.5, gzip", "gzip"),
        ] {
            let response = send(&dir, "/api/big", &[("accept-encoding", accept)]).await;
            assert_compressed(&response, encoding);
            assert_eq!(decoded(response).await, expected, "{accept}");
        }

        for headers in [
            &[][..],
            &[("accept-encoding", "identity")][..],
            &[("accept-encoding", "deflate")][..],
        ] {
            let response = send(&dir, "/api/big", headers).await;
            assert_not_compressed(&response);
            assert_eq!(decoded(response).await, expected, "{headers:?}");
        }
    }

    /// Chrome and Firefox name zstd, which this server cannot send. The
    /// server must then send br, not an uncompressed body.
    #[tokio::test]
    async fn selects_br_when_the_browser_also_names_zstd() {
        let dir = build();
        let response = send(
            &dir,
            "/api/big",
            &[("accept-encoding", "gzip, deflate, br, zstd")],
        )
        .await;
        assert_compressed(&response, "br");

        let response = send(&dir, "/api/big", &[("accept-encoding", "zstd")]).await;
        assert_not_compressed(&response);
    }

    #[tokio::test]
    async fn does_not_compress_a_tiny_body() {
        let dir = build();
        let response = send(&dir, "/api/tiny", &[("accept-encoding", "gzip")]).await;
        assert_not_compressed(&response);
        assert_eq!(decoded(response).await, br#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn compresses_a_chunk_of_the_client_build_and_keeps_its_cache_headers() {
        let dir = build();
        let path = "/assets/index-abc123.js";

        let response = send(&dir, path, &[("accept-encoding", "gzip")]).await;
        assert_compressed(&response, "gzip");
        let headers = response.headers();
        assert_eq!(text(headers, "cache-control"), Some(IMMUTABLE));
        assert_eq!(headers.get(header::ACCEPT_RANGES), None);
        let last_modified = text(headers, "last-modified").unwrap().to_owned();
        assert_eq!(decoded(response).await, chunk().as_bytes());

        let response = send(&dir, path, &[]).await;
        assert_not_compressed(&response);
        let headers = response.headers();
        let length = chunk().len().to_string();
        assert_eq!(text(headers, "content-length"), Some(length.as_str()));
        assert_eq!(text(headers, "vary"), Some("accept-encoding"));
        assert_eq!(text(headers, "cache-control"), Some(IMMUTABLE));
        assert_eq!(decoded(response).await, chunk().as_bytes());

        // A 304 has the cache headers of the 200 that it replaces.
        let response = send(
            &dir,
            path,
            &[
                ("accept-encoding", "gzip"),
                ("if-modified-since", &last_modified),
            ],
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        let headers = response.headers();
        assert_eq!(headers.get(header::CONTENT_ENCODING), None);
        assert_eq!(text(headers, "vary"), Some("accept-encoding"));
        assert_eq!(text(headers, "cache-control"), Some(IMMUTABLE));
    }

    #[tokio::test]
    async fn does_not_compress_fonts_or_images() {
        let dir = build();
        for path in ["/fonts/Sans.woff2", "/icon.png"] {
            let response = send(&dir, path, &[("accept-encoding", "gzip, br")]).await;
            assert_not_compressed(&response);
            assert_eq!(
                text(response.headers(), "content-length"),
                Some("4096"),
                "{path}"
            );
            assert_eq!(decoded(response).await, [7u8; 4096], "{path}");
        }
    }

    /// Each frame must go out as the route writes it: with no encoding, and
    /// while the stream is open, before the route writes the next frame.
    #[tokio::test]
    async fn never_compresses_an_event_stream_and_sends_each_frame_at_once() {
        let dir = build();
        let release = Arc::new(Notify::new());
        let response = send_to(
            app(&dir, release.clone()),
            "/api/stream",
            &[("accept-encoding", "gzip, deflate, br, zstd")],
        )
        .await;
        assert_not_compressed(&response);
        assert_eq!(
            text(response.headers(), "content-type"),
            Some("text/event-stream")
        );

        let mut body = response.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the first frame arrives while the stream is open")
            .unwrap()
            .unwrap();
        assert_eq!(first, FIRST_FRAME.as_bytes());

        release.notify_one();
        let second = tokio::time::timeout(Duration::from_secs(5), body.next())
            .await
            .expect("the second frame arrives after its release")
            .unwrap()
            .unwrap();
        assert_eq!(second, SECOND_FRAME.as_bytes());
        assert!(body.next().await.is_none());
    }
}

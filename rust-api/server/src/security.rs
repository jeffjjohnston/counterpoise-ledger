//! The security layers around the HTTP server: the cross-origin write check,
//! the response security headers, the API gate, and the session gate for
//! pages. They came from `proxy.ts` and `next.config.js` of the Next server,
//! with the same rules and the same responses. This server is now the only
//! layer in front of the routes and the pages. The unit tests below and
//! `tests/http/security-layers.test.ts` hold the cases.
//!
//! [`protect`] sets the order. From the outside in:
//!
//! 1. The security headers. They go on every response, the refusals below
//!    included.
//! 2. The cross-origin write check. It runs before every route, so it runs
//!    before any authentication and before the public login route.
//! 3. The API gate. An `/api/` path that is not public gets 401 when it has
//!    no session cookie and no bearer header. It runs before
//!    the router, so a wrong method on a known route, or a path that no route
//!    has, gives the same 401 as a known route. Thus a person without
//!    credentials cannot find which routes and methods exist.
//! 4. The router. A route authenticates its own requests: the API gate only
//!    stops the requests that have no credentials at all.
//! 5. The gate for a request that no route matched. An `/api/` path gets 404.
//!    Any other path is a page: without a session it goes to `/login`, and
//!    with one it goes to the page service.

use crate::{auth::cookie_token, static_pages::ASSETS_PREFIX};
use axum::{
    Json, Router,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{MethodRouter, any},
};
use regex::bytes::Regex;
use serde_json::json;
use std::{convert::Infallible, sync::LazyLock};
use tower::{Layer, Service};

/// The security headers of every response, `/api/` included, with the values
/// that the Next server sent.
///
/// The Content-Security-Policy is for pages, but it is correct on JSON too: it
/// has no `script-src` or `style-src`, and `frame-ancestors 'none'` stops a
/// page on another site from framing a response. It has no `script-src`
/// because the theme script in `index.html` is inline.
const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("x-frame-options", "DENY"),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "same-origin"),
    (
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
    ),
    (
        "content-security-policy",
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    ),
];

/// Sent only when `ENABLE_HSTS=true`.
const HSTS: (&str, &str) = (
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
);

/// Pages that a person without a session must reach.
const PUBLIC_PAGES: [&str; 2] = ["/login", "/register"];

/// The public API paths. The API gate lets a request to these paths through
/// with no credentials, and the route does its own authentication.
const PUBLIC_API_ROUTES: [&str; 2] = ["/api/health", "/api/version"];
const PUBLIC_API_PREFIXES: [&str; 2] = ["/api/auth/", "/api/cron/"];

/// API routes that the API gate lets through with no credentials, because
/// the route refuses each request without a key itself and its refusal is
/// part of its contract. `/api/mcp` answers 401 with `WWW-Authenticate:
/// Bearer` (guides/mcp-server.md), which the plain 401 of the gate does not
/// have. It accepts every method, so no 405 can tell anything about it.
const SELF_AUTHENTICATING_API_ROUTES: [&str; 1] = ["/api/mcp"];

/// The shape of a file of `public/`, as bytes and with ASCII case folding
/// (`STATIC_ASSET_RE` of the old `proxy.ts`).
///
/// It matches the SHAPE of an asset path, not only its suffix. Each file in
/// `public/` is at the root or in `public/fonts/`, and nothing static is
/// deeper. A test of the suffix alone lets route paths through, because a
/// dynamic segment matches dotted text: `/b/1/securities/2.json` is a page.
/// The leading anchor closes that class. No `/api/` path has this shape. The
/// test `serves_every_file_in_public` fails when a new asset directory comes
/// without a change to this pattern.
static STATIC_ASSET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)^/(?:fonts/)?[^/]+\.(?:css|js|mjs|map|json|txt|xml|webmanifest|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot)$",
    )
    .expect("valid static asset pattern")
});

/// A bearer header. The route verifies the key: the API gate only lets a
/// request with this shape of header through.
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^Bearer\s+\S+$").expect("valid bearer pattern"));

/// Puts the security layers around `api` and makes `pages` its fallback, in
/// the order that the module documentation gives.
///
/// `pages` gets only a non-`/api/` request that no route matched and that
/// has a session or a public path. `serve()` gives the client build
/// (`static_pages.rs`), or [`no_pages`] when `COUNTERPOISE_STATIC_DIR` is not
/// set.
pub(crate) fn protect<P>(api: Router, pages: P, hsts: bool) -> Router
where
    P: Service<Request, Error = Infallible> + Clone + Send + Sync + 'static,
    P::Response: IntoResponse,
    P::Future: Send + 'static,
{
    api.fallback_service(middleware::from_fn(gate_unrouted).layer(pages))
        .layer(middleware::from_fn(require_api_credentials))
        .layer(middleware::from_fn(reject_cross_origin_write))
        .layer(middleware::map_response(
            move |response: Response| async move { with_security_headers(response, hsts) },
        ))
}

/// The page service when the server has no client build to serve. It answers
/// 404, as the router did for an unknown path before the gate.
pub(crate) fn no_pages() -> MethodRouter {
    any(|| async { StatusCode::NOT_FOUND })
}

fn with_security_headers(mut response: Response, hsts: bool) -> Response {
    let headers = response.headers_mut();
    let hsts = hsts.then_some(HSTS);
    for (name, value) in SECURITY_HEADERS.into_iter().chain(hsts) {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn reject_cross_origin_write(request: Request, next: Next) -> Response {
    if is_cross_origin_write(request.method(), request.uri(), request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Cross-origin request rejected" })),
        )
            .into_response();
    }
    next.run(request).await
}

/// A write to `/api/` that another site sent. The order of the tests is part of
/// the rule.
fn is_cross_origin_write(method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return false;
    }
    if !uri.path().starts_with("/api/") {
        return false;
    }

    // "same-site" (for example a sibling subdomain) gets the same refusal as
    // "cross-site". This is deliberate: nothing correct posts to this app from
    // a sibling subdomain, and to trust same-site would make the hole that
    // this check closes wider. An empty value counts as absent, as in
    // JavaScript.
    if let Some(site) = header_text(headers, "sec-fetch-site").filter(|site| !site.is_empty()) {
        return site != "same-origin";
    }

    let Some(origin) = header_text(headers, header::ORIGIN.as_str()) else {
        return false;
    };
    let Some(host) = public_host(headers, uri) else {
        return true;
    };
    match url::Url::parse(&origin) {
        Ok(origin) => origin_host(&origin) != host,
        Err(_) => true,
    }
}

/// The host that the browser used, which the `Origin` must name.
///
/// Use `X-Forwarded-Host` first. A reverse proxy that replaces `Host` with the
/// upstream address can put the browser's host there. The header gets here
/// only when the server trusts a proxy (`TRUST_PROXY`): else
/// `client_ip::record` removes it. To trust this header is
/// safe: a page on another site cannot set it. A custom header makes the
/// browser send a CORS preflight first, and this server approves no
/// preflight. A client that is not a browser can set any header, but it has
/// no cookie of a victim to use. Also, the `Sec-Fetch-Site` test above comes
/// first, and each current browser sends that header.
///
/// Then use `Host`, then the authority of the request URI (HTTP/2 sends the
/// host there).
///
/// Requirement on self-hosters: the reverse proxy in front of this app must
/// keep the original `Host` header, or send it in `X-Forwarded-Host`.
/// Tailscale Serve and Caddy keep `Host` by
/// default. nginx does NOT: its default `proxy_set_header Host $proxy_host`
/// replaces it with the upstream address. Then each write that gets to this
/// comparison, that is a write with an `Origin` but no `Sec-Fetch-Site`, gets
/// the 403 "Cross-origin request rejected", which does not tell why. See the
/// section "Security notes for self-hosting" in the README.
fn public_host(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    let forwarded = header_text(headers, "x-forwarded-host")
        .and_then(|value| value.split(',').next().map(|host| host.trim().to_owned()))
        .filter(|host| !host.is_empty());
    forwarded
        .or_else(|| header_text(headers, header::HOST.as_str()))
        .or_else(|| {
            uri.authority()
                .map(|authority| authority.as_str().to_owned())
        })
}

/// `URL.host` in JavaScript: the host name, and the port when it is not the
/// default port of the scheme.
fn origin_host(origin: &url::Url) -> String {
    let name = origin.host_str().unwrap_or("");
    match origin.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_owned(),
    }
}

/// A header as `Headers.get` in JavaScript gives it: all of its values,
/// joined by ", ", or `None` when the request does not have it.
fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The session and bearer test for `/api/` paths, before the router. A request
/// without credentials to a path that is not public gets 401, whether a route
/// has the path and method or not.
async fn require_api_credentials(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if !path.starts_with("/api/")
        || is_public_api(path)
        || SELF_AUTHENTICATING_API_ROUTES.contains(&path)
    {
        return next.run(request).await;
    }
    let headers = request.headers();
    let bearer = header_text(headers, header::AUTHORIZATION.as_str())
        .is_some_and(|value| BEARER.is_match(value.as_bytes()));
    if cookie_token(headers).is_some() || bearer {
        return next.run(request).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

fn is_public_api(path: &str) -> bool {
    PUBLIC_API_ROUTES.contains(&path)
        || PUBLIC_API_PREFIXES
            .iter()
            .any(|prefix| path.starts_with(prefix))
}

async fn gate_unrouted(request: Request, next: Next) -> Response {
    let path = request.uri().path();
    let session = cookie_token(request.headers()).is_some();

    if path.starts_with("/api/") {
        // No API route matched, and the API gate let the request through, so
        // it is public or has credentials. The page service must never see
        // an API path.
        return StatusCode::NOT_FOUND.into_response();
    }

    // Pages carry no authentication of their own, so for them this gate is
    // the only authentication. A page never accepts a key: a bearer header
    // does not open it.
    if is_public_page(path) || session {
        return next.run(request).await;
    }
    // A relative `Location`, as the Next server sent. This server cannot know
    // the scheme that the browser used behind a proxy that terminates TLS,
    // and an absolute `http:` URL would send the browser away from HTTPS.
    (
        StatusCode::TEMPORARY_REDIRECT,
        [(header::LOCATION, "/login")],
    )
        .into_response()
}

/// The static assets, the hashed chunks of the client build, and the public
/// pages.
fn is_public_page(path: &str) -> bool {
    path.starts_with(ASSETS_PREFIX)
        || path.starts_with("/favicon")
        || STATIC_ASSET.is_match(path.as_bytes())
        || PUBLIC_PAGES.contains(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{routes::routes, state::AppState};
    use axum::{body::Body, body::to_bytes, routing::get};
    use tower::ServiceExt;

    /// Stand-ins for the routes. Each answers 200, so 200 means that the
    /// layers let the request through.
    fn app(hsts: bool) -> Router {
        let ok = || async { StatusCode::OK };
        let api = Router::new()
            .route("/api/health", get(ok))
            .route("/api/version", get(ok))
            .route("/api/auth/login", axum::routing::post(ok))
            .route("/api/cron/recurring", get(ok).post(ok))
            .route("/api/b/{book_id}/transactions", get(ok).post(ok))
            .route("/api/b/{book_id}/transactions/{id}", get(ok));
        protect(api, any(ok), hsts)
    }

    struct Call<'a> {
        method: Method,
        path: &'a str,
        headers: Vec<(&'a str, &'a str)>,
    }

    fn call(path: &str) -> Call<'_> {
        Call {
            method: Method::GET,
            path,
            headers: vec![("host", "localhost")],
        }
    }

    impl<'a> Call<'a> {
        fn method(mut self, method: Method) -> Self {
            self.method = method;
            self
        }

        fn header(mut self, name: &'a str, value: &'a str) -> Self {
            self.headers.retain(|(existing, _)| *existing != name);
            self.headers.push((name, value));
            self
        }

        fn session(self) -> Self {
            self.header("cookie", "counterpoise_session=token")
        }

        async fn send_to(self, app: Router) -> Response {
            let mut request = Request::builder().method(self.method).uri(self.path);
            for (name, value) in self.headers {
                request = request.header(name, value);
            }
            app.oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
        }

        async fn send(self) -> Response {
            self.send_to(app(false)).await
        }

        async fn status(self) -> StatusCode {
            self.send().await.status()
        }
    }

    async fn body(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    // The auth gate.

    #[tokio::test]
    async fn redirects_a_page_without_a_session_to_login() {
        let response = call("/b/1").send().await;
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(response.headers()[header::LOCATION], "/login");
        assert_eq!(body(response).await, "");
    }

    #[tokio::test]
    async fn lets_a_page_through_with_a_session() {
        for path in ["/", "/b/1", "/b/1/transactions", "/account"] {
            assert_eq!(
                call(path).session().status().await,
                StatusCode::OK,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn treats_an_empty_or_malformed_session_cookie_as_absent() {
        for cookie in [
            "counterpoise_session=",
            "counterpoise_session=%ZZ",
            "other=1",
        ] {
            let status = call("/b/1").header("cookie", cookie).status().await;
            assert_eq!(status, StatusCode::TEMPORARY_REDIRECT, "{cookie}");
        }
    }

    #[tokio::test]
    async fn still_redirects_a_page_request_that_carries_only_a_bearer_header() {
        let status = call("/b/1")
            .header("authorization", "Bearer cpk_x")
            .status()
            .await;
        assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
    }

    #[tokio::test]
    async fn keeps_login_register_and_the_client_chunks_public() {
        for path in [
            "/login",
            "/register",
            "/assets/index-abc123.js",
            "/assets/index-abc123.css",
            "/favicon.ico",
            "/favicon-dark.ico",
        ] {
            assert_eq!(call(path).status().await, StatusCode::OK, "{path}");
        }
        // Exact paths, not prefixes.
        for path in ["/login/x", "/registered", "/api"] {
            assert_eq!(
                call(path).status().await,
                StatusCode::TEMPORARY_REDIRECT,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn lets_the_container_healthcheck_reach_api_health_without_a_session() {
        assert_eq!(call("/api/health").status().await, StatusCode::OK);
        assert_eq!(call("/api/version").status().await, StatusCode::OK);
    }

    #[tokio::test]
    async fn refuses_an_unrouted_api_path_without_a_session_or_a_key() {
        for path in [
            "/api/healthcheck-internal",
            "/api/versions",
            "/api/b/1/accounts.json",
        ] {
            let response = call(path).send().await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            assert_eq!(body(response).await, r#"{"error":"Unauthorized"}"#);
        }
    }

    #[tokio::test]
    async fn answers_404_to_an_unrouted_api_path_with_credentials() {
        let calls = [
            call("/api/versions").session(),
            call("/api/versions").header("authorization", "Bearer cpk_x"),
            call("/api/versions").header("authorization", "bearer  cpk_x"),
            call("/api/auth/unknown"),
            call("/api/cron/unknown"),
        ];
        for request in calls {
            let path = request.path;
            assert_eq!(request.status().await, StatusCode::NOT_FOUND, "{path}");
        }
        // Not a bearer credential, so the API gate refuses it.
        for value in ["Bearer", "Bearer ", "Basic abc", "Bearer a b"] {
            let status = call("/api/versions")
                .header("authorization", value)
                .status()
                .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{value}");
        }
    }

    #[tokio::test]
    async fn never_sends_an_api_path_to_the_page_service() {
        // With a session, an unrouted API path must not get the page (200).
        let status = call("/api/b/1/accounts.json").session().status().await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn refuses_a_request_without_credentials_before_routing() {
        // A known route with its method, a known route with a wrong method,
        // and a preflight all get the same 401. Thus the response does not
        // tell which routes and methods exist.
        let calls = [
            call("/api/b/1/transactions"),
            call("/api/b/1/transactions").method(Method::PATCH),
            call("/api/b/1/transactions/5").method(Method::DELETE),
            call("/api/b/1/transactions").method(Method::OPTIONS),
        ];
        for request in calls {
            let label = format!("{} {}", request.method, request.path);
            let response = request.send().await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{label}");
            assert_eq!(
                body(response).await,
                r#"{"error":"Unauthorized"}"#,
                "{label}"
            );
        }
    }

    #[tokio::test]
    async fn gives_method_not_allowed_only_with_credentials() {
        let calls = [
            call("/api/b/1/transactions")
                .method(Method::PATCH)
                .session(),
            call("/api/b/1/transactions")
                .method(Method::PATCH)
                .header("authorization", "Bearer cpk_x"),
        ];
        for request in calls {
            assert_eq!(request.status().await, StatusCode::METHOD_NOT_ALLOWED);
        }
    }

    #[tokio::test]
    async fn keeps_method_not_allowed_on_a_matched_route() {
        let response = call("/api/version").method(Method::POST).send().await;
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(response.headers()["x-frame-options"], "DENY");
    }

    // The cross-origin write check.

    #[tokio::test]
    async fn rejects_a_post_from_another_origin() {
        let response = call("/api/b/1/transactions")
            .method(Method::POST)
            .session()
            .header("origin", "https://evil.example")
            .send()
            .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            body(response).await,
            r#"{"error":"Cross-origin request rejected"}"#
        );
    }

    #[tokio::test]
    async fn rejects_when_sec_fetch_site_is_not_same_origin() {
        for site in [
            "cross-site",
            "same-site",
            "none",
            "same-origin, same-origin",
        ] {
            let status = call("/api/b/1/transactions")
                .method(Method::POST)
                .session()
                .header("sec-fetch-site", site)
                .status()
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{site}");
        }
    }

    #[tokio::test]
    async fn sec_fetch_site_comes_before_origin() {
        // A same-origin label passes, whatever the Origin says.
        let status = call("/api/b/1/transactions")
            .method(Method::POST)
            .session()
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://evil.example")
            .status()
            .await;
        assert_eq!(status, StatusCode::OK);
        // An empty label counts as absent, so the Origin decides.
        let status = call("/api/b/1/transactions")
            .method(Method::POST)
            .session()
            .header("sec-fetch-site", "")
            .header("origin", "https://evil.example")
            .status()
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn allows_a_same_origin_post() {
        let status = call("/api/b/1/transactions")
            .method(Method::POST)
            .session()
            .header("origin", "http://localhost")
            .header("sec-fetch-site", "same-origin")
            .status()
            .await;
        assert_eq!(status, StatusCode::OK);
        // The Origin alone, on the host that it names.
        for (host, origin) in [
            ("localhost", "http://localhost"),
            ("localhost", "http://localhost:80"),
            ("localhost:3000", "http://localhost:3000"),
            ("books.example", "https://books.example"),
            ("[::1]:3000", "http://[::1]:3000"),
        ] {
            let status = call("/api/b/1/transactions")
                .method(Method::POST)
                .session()
                .header("host", host)
                .header("origin", origin)
                .status()
                .await;
            assert_eq!(status, StatusCode::OK, "{host} {origin}");
        }
    }

    #[tokio::test]
    async fn rejects_an_origin_that_names_another_host_or_cannot_be_parsed() {
        for origin in [
            "http://localhost:3000",
            "https://localhost.evil.example",
            "null",
            "not a url",
            "file:///etc/passwd",
        ] {
            let status = call("/api/b/1/transactions")
                .method(Method::POST)
                .session()
                .header("origin", origin)
                .status()
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        }
    }

    #[tokio::test]
    async fn uses_the_browser_host_that_a_reverse_proxy_forwards() {
        let proxied = |origin| {
            call("/api/b/1/transactions")
                .method(Method::POST)
                .session()
                .header("host", "127.0.0.1:4000")
                .header("x-forwarded-host", "books.example")
                .header("origin", origin)
        };
        assert_eq!(
            proxied("https://books.example").status().await,
            StatusCode::OK
        );
        assert_eq!(
            proxied("https://evil.example").status().await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            proxied("http://127.0.0.1:4000").status().await,
            StatusCode::FORBIDDEN
        );
        // The first host of a list is the one that the browser used.
        let status = call("/api/b/1/transactions")
            .method(Method::POST)
            .session()
            .header("x-forwarded-host", "books.example, inner.proxy")
            .header("origin", "https://books.example")
            .status()
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn allows_a_cross_origin_safe_method() {
        for method in [Method::GET, Method::HEAD, Method::OPTIONS] {
            let status = call("/api/b/1/transactions")
                .method(method.clone())
                .session()
                .header("origin", "https://evil.example")
                .header("sec-fetch-site", "cross-site")
                .status()
                .await;
            assert_ne!(status, StatusCode::FORBIDDEN, "{method}");
        }
    }

    #[tokio::test]
    async fn allows_a_post_carrying_neither_origin_nor_sec_fetch_site() {
        // The cron calls of the scheduler. Browsers always send Origin on a
        // cross-origin write, so a request without it comes from a client
        // that is not a browser, which has no cookie for an attacker to use.
        let status = call("/api/cron/recurring")
            .method(Method::POST)
            .status()
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_a_cross_origin_post_to_the_login_endpoint() {
        // The order matters: /api/auth/ is public, and login is where a
        // cross-site request forgery goes. A check after the route would not
        // protect it.
        let response = call("/api/auth/login")
            .method(Method::POST)
            .header("origin", "https://evil.example")
            .send()
            .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn does_not_check_the_origin_of_a_page_write() {
        let status = call("/b/1")
            .method(Method::POST)
            .session()
            .header("sec-fetch-site", "cross-site")
            .status()
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    // The static asset detection.

    #[tokio::test]
    async fn auth_gates_a_page_path_that_merely_contains_a_dot() {
        for path in [
            "/b/1.0/transactions",
            "/b/1/securities/2.json",
            "/b/1/transactions/5.txt",
            "/b/1.json",
            "/.css",
            "/fonts/a/b.woff2",
        ] {
            assert_eq!(
                call(path).status().await,
                StatusCode::TEMPORARY_REDIRECT,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn lets_real_assets_through_without_a_session() {
        for path in [
            "/logo.svg",
            "/styles.css",
            "/app.js",
            "/font.woff2",
            "/site.webmanifest",
            "/fonts/GeneralSans-Bold.woff2",
            "/FONTS/X.WOFF2",
            "/image.JPEG",
        ] {
            assert_eq!(call(path).status().await, StatusCode::OK, "{path}");
        }
    }

    #[tokio::test]
    async fn serves_every_file_in_public() {
        // Read from the real directory, not from a list. The asset pattern
        // follows the shape of the public/ tree of today, so a new asset
        // directory would otherwise send its files to /login in silence.
        // This test fails instead, and points at STATIC_ASSET.
        fn walk(dir: &std::path::Path, prefix: &str, paths: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().into_string().unwrap();
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), &format!("{prefix}{name}/"), paths);
                } else {
                    paths.push(format!("/{prefix}{name}"));
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public");
        let mut paths = Vec::new();
        walk(&root, "", &mut paths);
        assert!(!paths.is_empty());
        for path in paths {
            assert_eq!(call(&path).status().await, StatusCode::OK, "{path}");
        }
    }

    #[tokio::test]
    async fn never_treats_an_api_path_as_a_static_asset() {
        for path in [
            "/api/b/1/transactions/5.json",
            "/api/b/1/securities/2.txt",
            "/api/b/1/accounts.json",
        ] {
            assert!(!is_public_page(path), "{path}");
            // The API gate is total for `/api/`.
            assert_eq!(
                call(path).status().await,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        // With a session, the router still matches a dotted id to its route.
        assert_eq!(
            call("/api/b/1/transactions/5.json")
                .session()
                .status()
                .await,
            StatusCode::OK
        );
    }

    // The security headers.

    fn assert_security_headers(response: &Response, hsts: bool) {
        let headers = response.headers();
        assert_eq!(headers["x-frame-options"], "DENY");
        assert_eq!(headers["x-content-type-options"], "nosniff");
        assert_eq!(headers["referrer-policy"], "same-origin");
        assert_eq!(
            headers["permissions-policy"],
            "camera=(), microphone=(), geolocation=()"
        );
        assert_eq!(
            headers["content-security-policy"],
            "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
        );
        match hsts {
            true => assert_eq!(
                headers["strict-transport-security"],
                "max-age=31536000; includeSubDomains"
            ),
            false => assert!(!headers.contains_key("strict-transport-security")),
        }
        for (name, _) in SECURITY_HEADERS {
            assert_eq!(headers.get_all(name).iter().count(), 1, "{name}");
        }
    }

    fn every_kind_of_response() -> Vec<Call<'static>> {
        vec![
            call("/api/health"),
            call("/b/1"),
            call("/b/1").session(),
            call("/login"),
            call("/api/versions"),
            call("/api/versions").session(),
            call("/api/version").method(Method::POST),
            call("/api/auth/login")
                .method(Method::POST)
                .header("origin", "https://evil.example"),
        ]
    }

    #[tokio::test]
    async fn sends_the_security_headers_on_every_response() {
        for request in every_kind_of_response() {
            assert_security_headers(&request.send_to(app(false)).await, false);
        }
    }

    #[tokio::test]
    async fn sends_hsts_only_when_enabled() {
        for request in every_kind_of_response() {
            assert_security_headers(&request.send_to(app(true)).await, true);
        }
    }

    #[tokio::test]
    async fn replaces_a_header_that_a_route_already_set() {
        let api = Router::new().route(
            "/api/version",
            get(|| async { ([("x-frame-options", "SAMEORIGIN")], "") }),
        );
        let response = call("/api/version")
            .send_to(protect(api, no_pages(), false))
            .await;
        assert_security_headers(&response, false);
    }

    // The real router, with a pool that never connects. Each case here is
    // decided before a route reads the database.

    fn real_app() -> Router {
        let state =
            AppState::new(std::path::Path::new("/nonexistent/counterpoise.db")).expect("lazy pool");
        protect(routes().with_state(state), no_pages(), false)
    }

    #[tokio::test]
    async fn guards_the_real_router() {
        let login = call("/api/auth/login")
            .method(Method::POST)
            .header("origin", "https://evil.example")
            .send_to(real_app())
            .await;
        assert_eq!(login.status(), StatusCode::FORBIDDEN);
        assert_security_headers(&login, false);

        let mcp = call("/api/mcp")
            .method(Method::POST)
            .header("authorization", "Bearer cpk_x")
            .header("sec-fetch-site", "cross-site")
            .send_to(real_app())
            .await;
        assert_eq!(mcp.status(), StatusCode::FORBIDDEN);

        let page = call("/b/1").send_to(real_app()).await;
        assert_eq!(page.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_security_headers(&page, false);

        // Rust serves no pages yet.
        let page = call("/b/1").session().send_to(real_app()).await;
        assert_eq!(page.status(), StatusCode::NOT_FOUND);

        let unrouted = call("/api/versions").send_to(real_app()).await;
        assert_eq!(unrouted.status(), StatusCode::UNAUTHORIZED);

        let wrong_method = call("/api/version")
            .method(Method::POST)
            .send_to(real_app())
            .await;
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);

        // A wrong method on a protected route, without credentials. The
        // router alone answers 405, which tells that the route exists.
        let protected = call("/api/b/1/accounts")
            .method(Method::PATCH)
            .send_to(real_app())
            .await;
        assert_eq!(protected.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body(protected).await, r#"{"error":"Unauthorized"}"#);

        // MCP gives its own refusal, with the Bearer challenge.
        let mcp = call("/api/mcp")
            .method(Method::POST)
            .send_to(real_app())
            .await;
        assert_eq!(mcp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(mcp.headers()[header::WWW_AUTHENTICATE], "Bearer");
    }
}

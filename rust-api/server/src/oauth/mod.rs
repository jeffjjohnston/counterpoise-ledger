//! OAuth 2.1 for the MCP endpoint, as the MCP authorization specification
//! (revision 2026-07-28) tells. This server is the authorization server and
//! the resource server. A client such as a claude.ai custom connector gets an
//! access token for `/api/mcp` with the authorization code flow and PKCE, in
//! place of a pasted API key. `guides/mcp-server.md` gives the flow.
//!
//! The feature is on only when `COUNTERPOISE_PUBLIC_URL` gives the public
//! origin, such as `https://books.example.com`. The issuer, the endpoint
//! URLs and the token audience come from it. Behind a proxy that terminates
//! TLS, the server cannot know its public scheme, so it does not guess.
//!
//! - Discovery: the protected resource metadata (RFC 9728) and the
//!   authorization server metadata (RFC 8414), under `/.well-known/`.
//! - Clients: Client ID Metadata Documents and Dynamic Client Registration
//!   (RFC 7591), public clients only ([`clients`], [`cimd`]).
//! - Authorization: `/api/oauth/authorize` sends the browser to the consent
//!   page (`app/oauth/consent`), which uses the session cookie
//!   ([`authorize`]).
//! - Tokens: the code exchange with S256 PKCE, refresh token rotation and
//!   revocation (RFC 7009) ([`token`]).
//! - The account page lists the grants and revokes them ([`grants`]).
//!
//! An access token is good only for `/api/mcp` and the route requests of its
//! tools: `auth::principal_with` accepts it only there. Every secret is
//! stored as its SHA-256 digest.

mod authorize;
mod cimd;
mod clients;
mod grants;
mod token;

use crate::{auth::token_hash, error::error, state::AppState};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use chrono::{Duration, NaiveDateTime, Utc};
use serde_json::{Value, json};

/// The prefix of an access token. `auth.rs` sends a bearer value with this
/// prefix to [`access_token_user`].
pub(crate) const ACCESS_TOKEN_PREFIX: &str = "cpo_";
const REFRESH_TOKEN_PREFIX: &str = "cpr_";
/// The prefix of a client ID that Dynamic Client Registration gives.
const CLIENT_ID_PREFIX: &str = "cpc_";

/// The one scope. A grant gives the user's full MCP access, as an API key
/// does; the book roles still apply to each tool.
const SCOPE: &str = "mcp";

const ACCESS_TOKEN_SECONDS: i64 = 60 * 60;
const REFRESH_TOKEN_DAYS: i64 = 30;
const CODE_SECONDS: i64 = 5 * 60;
/// A refresh token sent again within this time after its exchange gets
/// `invalid_grant` only. Later, the second use revokes the grant. A client
/// that retries a refresh after a timeout must not lose its connection.
const REFRESH_REUSE_GRACE_SECONDS: i64 = 60;
/// How seldom a grant's `last_used_at` changes, so that each tool request
/// does not write.
const STAMP_SECONDS: i64 = 5 * 60;

/// The public origin of the server, from `COUNTERPOISE_PUBLIC_URL`. It is the
/// issuer, and the endpoints and the token audience are under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Issuer {
    /// The ASCII serialization of the origin: a lowercase scheme and host,
    /// no default port and no trailing slash.
    origin: String,
}

impl Issuer {
    /// The issuer from the environment. `None` turns the feature off. A
    /// value that is not an acceptable origin is an error, and the server
    /// refuses to start (`config.rs`).
    pub(crate) fn from_env() -> Result<Option<Self>, String> {
        match std::env::var("COUNTERPOISE_PUBLIC_URL") {
            Ok(value) if !value.trim().is_empty() => Self::parse(value.trim()).map(Some),
            _ => Ok(None),
        }
    }

    /// An `https` origin, or an `http` origin on a loopback host (for local
    /// tests). The value has no path, query, fragment or user information.
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        let invalid = |reason: &str| {
            Err(format!(
                "COUNTERPOISE_PUBLIC_URL must be the public origin of the server, such as \
                 https://books.example.com: {reason}"
            ))
        };
        let Ok(url) = url::Url::parse(raw) else {
            return invalid("it is not a URL");
        };
        let Some(host) = url.host() else {
            return invalid("it has no host");
        };
        match url.scheme() {
            "https" => {}
            "http" if clients::is_loopback(&host) => {}
            _ => return invalid("it must use https"),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return invalid("it must not have user information");
        }
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return invalid("it must not have a path, a query or a fragment");
        }
        Ok(Self {
            origin: url.origin().ascii_serialization(),
        })
    }

    pub(crate) fn origin(&self) -> &str {
        &self.origin
    }

    /// The canonical URI of the MCP server (RFC 8707): the audience of each
    /// token.
    pub(crate) fn resource(&self) -> String {
        format!("{}/api/mcp", self.origin)
    }

    /// The protected resource metadata URL that a 401 from `/api/mcp` gives.
    pub(crate) fn resource_metadata_url(&self) -> String {
        format!(
            "{}/.well-known/oauth-protected-resource/api/mcp",
            self.origin
        )
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.origin)
    }

    /// True when a `resource` parameter names this MCP server: its canonical
    /// URI or the bare origin. Case of the scheme and host, a default port and
    /// a trailing slash do not matter.
    fn names_this_server(&self, requested: &str) -> bool {
        let Ok(url) = url::Url::parse(requested) else {
            return false;
        };
        if url.fragment().is_some() || url.query().is_some() {
            return false;
        }
        let normalized = format!(
            "{}{}",
            url.origin().ascii_serialization(),
            url.path().trim_end_matches('/')
        );
        normalized == self.resource() || normalized == self.origin
    }
}

/// The OAuth routes, which `routes::routes` merges into the router. The paths
/// under `/api/oauth/` are public to the API gate (`security.rs`): each route
/// authenticates its own requests.
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/api/mcp",
            get(protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(authorization_server),
        )
        .route("/api/oauth/register", post(clients::register))
        .route("/api/oauth/authorize", get(authorize::start))
        .route(
            "/api/oauth/consent",
            get(authorize::details).post(authorize::decide),
        )
        .route("/api/oauth/token", post(token::exchange))
        .route("/api/oauth/revoke", post(token::revoke))
        .route("/api/oauth/grants", get(grants::list))
        .route("/api/oauth/grants/{id}", delete(grants::remove))
}

/// The answer of each OAuth route while `COUNTERPOISE_PUBLIC_URL` is not set.
fn not_configured() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "OAuth is off: set COUNTERPOISE_PUBLIC_URL to turn it on",
    )
    .into_response()
}

/// A metadata document. Any origin may read it, so a client in a browser can
/// find the endpoints.
fn metadata(body: Value) -> Response {
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

/// `GET /.well-known/oauth-protected-resource[/api/mcp]` (RFC 9728).
async fn protected_resource(State(state): State<AppState>) -> Response {
    let Some(issuer) = &state.oauth else {
        return not_configured();
    };
    metadata(json!({
        "resource": issuer.resource(),
        "authorization_servers": [issuer.origin()],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": "Counterpoise",
    }))
}

/// `GET /.well-known/oauth-authorization-server` (RFC 8414).
async fn authorization_server(State(state): State<AppState>) -> Response {
    let Some(issuer) = &state.oauth else {
        return not_configured();
    };
    metadata(json!({
        "issuer": issuer.origin(),
        "authorization_endpoint": issuer.endpoint("/api/oauth/authorize"),
        "token_endpoint": issuer.endpoint("/api/oauth/token"),
        "registration_endpoint": issuer.endpoint("/api/oauth/register"),
        "revocation_endpoint": issuer.endpoint("/api/oauth/revoke"),
        "scopes_supported": [SCOPE],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "code_challenge_methods_supported": ["S256"],
        "authorization_response_iss_parameter_supported": true,
        "client_id_metadata_document_supported": true,
    }))
}

/// The user of the session cookie. The consent and grant routes accept the
/// cookie only: a key or a token must not approve a client or revoke one.
async fn cookie_user(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Result<i32, crate::error::ApiError> {
    match crate::routes::auth::cookie_session(state, headers).await {
        Ok(Some((user_id, _))) => Ok(user_id),
        Ok(None) => Err(error(StatusCode::UNAUTHORIZED, "Not authenticated")),
        Err(cause) => Err(crate::error::internal_error(cause, "Internal error")),
    }
}

/// An OAuth error response (RFC 6749 section 5.2), which no cache keeps.
fn oauth_error(status: StatusCode, code: &'static str, description: &str) -> Response {
    no_store(
        (
            status,
            Json(json!({ "error": code, "error_description": description })),
        )
            .into_response(),
    )
}

/// A response that holds a secret: no cache may keep it.
fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response
}

fn now() -> NaiveDateTime {
    Utc::now().naive_utc()
}

/// A new secret: `prefix` and 32 random bytes as lowercase hex.
fn new_secret(prefix: &str) -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(format!("{prefix}{}", hex::encode(bytes)))
}

/// True when `value` has the shape that [`new_secret`] gives for `prefix`.
fn secret_shape(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 64
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The user of an access token for `/api/mcp`, or `None` when the token is
/// unknown, expired, revoked, or for another audience. The audience changes
/// when `COUNTERPOISE_PUBLIC_URL` changes, and the old tokens then stop.
pub(crate) async fn access_token_user(
    state: &AppState,
    token: &str,
) -> Result<Option<i32>, sqlx::Error> {
    let Some(issuer) = &state.oauth else {
        return Ok(None);
    };
    if !secret_shape(token, ACCESS_TOKEN_PREFIX) {
        return Ok(None);
    }
    let now = now();
    let row: Option<(i32, i32, String, Option<NaiveDateTime>)> = sqlx::query_as(
        "SELECT g.id, g.user_id, g.resource, g.last_used_at
         FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > $2",
    )
    .bind(token_hash(token))
    .bind(now)
    .fetch_optional(&state.pool)
    .await?;
    let Some((grant_id, user_id, resource, last_used_at)) = row else {
        return Ok(None);
    };
    if resource != issuer.resource() {
        return Ok(None);
    }
    let stale = now - Duration::seconds(STAMP_SECONDS);
    if last_used_at.is_none_or(|at| at < stale)
        && let Err(cause) = sqlx::query(
            "UPDATE oauth_grants SET last_used_at = $2
             WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)",
        )
        .bind(grant_id)
        .bind(now)
        .bind(stale)
        .execute(&state.pool)
        .await
    {
        tracing::error!(error = %cause, "Could not stamp OAuth grant lastUsedAt");
    }
    Ok(Some(user_id))
}

/// Deletes what can no longer be used: expired codes and tokens, grants with
/// neither, and clients that no grant uses. A used refresh token stays while
/// its grant is active, for the detection of replay. A registered client gets one day
/// to get a grant. The OAuth routes run this from time to time; the work is
/// small.
async fn sweep(state: &AppState) {
    let now = now();
    let result = async {
        sqlx::query("DELETE FROM oauth_codes WHERE expires_at <= $1")
            .bind(now)
            .execute(&state.pool)
            .await?;
        // A used refresh token stays while its grant has a token that is not
        // expired. If the token comes back, the server can then find its
        // grant and revoke it (RFC 9700 section 4.14.2).
        sqlx::query(
            "DELETE FROM oauth_tokens
             WHERE expires_at <= $1
               AND NOT (kind = 'refresh' AND used_at IS NOT NULL
                        AND EXISTS (SELECT 1 FROM oauth_tokens live
                                    WHERE live.grant_id = oauth_tokens.grant_id
                                      AND live.expires_at > $1))",
        )
        .bind(now)
        .execute(&state.pool)
        .await?;
        sqlx::query(
            "DELETE FROM oauth_grants
             WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id)
               AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.grant_id = oauth_grants.id)",
        )
        .execute(&state.pool)
        .await?;
        sqlx::query(
            "DELETE FROM oauth_clients
             WHERE created_at <= $1
               AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)",
        )
        .bind(now - Duration::days(1))
        .execute(&state.pool)
        .await?;
        Ok::<_, sqlx::Error>(())
    }
    .await;
    if let Err(cause) = result {
        tracing::error!(error = %cause, "Could not delete expired OAuth rows");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_url_must_be_an_https_origin() {
        let issuer = Issuer::parse("HTTPS://Books.Example.com:443/").unwrap();
        assert_eq!(issuer.origin(), "https://books.example.com");
        assert_eq!(issuer.resource(), "https://books.example.com/api/mcp");
        assert_eq!(
            issuer.resource_metadata_url(),
            "https://books.example.com/.well-known/oauth-protected-resource/api/mcp"
        );
        assert_eq!(
            Issuer::parse("https://books.example.com:8443")
                .unwrap()
                .origin(),
            "https://books.example.com:8443"
        );
        assert!(Issuer::parse("http://127.0.0.1:3000").is_ok());
        assert!(Issuer::parse("http://localhost:3000").is_ok());
        assert!(Issuer::parse("http://books.example.com").is_err());
        assert!(Issuer::parse("https://books.example.com/app").is_err());
        assert!(Issuer::parse("https://books.example.com/?a=1").is_err());
        assert!(Issuer::parse("https://user@books.example.com").is_err());
        assert!(Issuer::parse("books.example.com").is_err());
    }

    #[test]
    fn a_resource_names_this_server_in_its_canonical_forms() {
        let issuer = Issuer::parse("https://books.example.com").unwrap();
        assert!(issuer.names_this_server("https://books.example.com/api/mcp"));
        assert!(issuer.names_this_server("https://BOOKS.example.com/api/mcp/"));
        assert!(issuer.names_this_server("https://books.example.com:443/api/mcp"));
        assert!(issuer.names_this_server("https://books.example.com"));
        assert!(issuer.names_this_server("https://books.example.com/"));
        assert!(!issuer.names_this_server("https://books.example.com/api/other"));
        assert!(!issuer.names_this_server("https://evil.example/api/mcp"));
        assert!(!issuer.names_this_server("http://books.example.com/api/mcp"));
        assert!(!issuer.names_this_server("https://books.example.com/api/mcp#x"));
        assert!(!issuer.names_this_server("not a url"));
    }

    #[test]
    fn secrets_have_a_prefix_and_64_hex_digits() {
        let secret = new_secret(ACCESS_TOKEN_PREFIX).unwrap();
        assert!(secret_shape(&secret, ACCESS_TOKEN_PREFIX));
        assert!(!secret_shape(&secret, REFRESH_TOKEN_PREFIX));
        assert!(!secret_shape(&secret.to_uppercase(), ACCESS_TOKEN_PREFIX));
        assert!(!secret_shape(&secret[..60], ACCESS_TOKEN_PREFIX));
        assert_ne!(secret, new_secret(ACCESS_TOKEN_PREFIX).unwrap());
    }
}

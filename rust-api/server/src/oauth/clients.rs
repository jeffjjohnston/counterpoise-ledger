//! The OAuth clients: Dynamic Client Registration (RFC 7591) at
//! `POST /api/oauth/register`, the lookup of a client ID, and the redirect
//! URI rules.
//!
//! Every client is public (`token_endpoint_auth_method` `none`): it has no
//! secret, and PKCE protects its codes. The MCP specification marks Dynamic
//! Client Registration as deprecated in favor of Client ID Metadata
//! Documents ([`super::cimd`]), but clients still use it when a server
//! supports it, so this server supports both.

use super::{
    CLIENT_ID_PREFIX, cimd, new_secret, no_store, not_configured, now, oauth_error, sweep,
};
use crate::{
    client_ip,
    rate_limit::{Keys, Scope},
    state::AppState,
};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Instant;
use url::Host;

const MAX_REDIRECT_URIS: usize = 10;
const MAX_REDIRECT_URI_LENGTH: usize = 2000;
const MAX_CLIENT_NAME_CHARS: usize = 100;

/// A client that may ask for a grant.
#[derive(Clone, Debug)]
pub(super) struct Client {
    pub(super) id: i32,
    pub(super) client_id: String,
    pub(super) name: String,
    pub(super) redirect_uris: Vec<String>,
    /// True when a Client ID Metadata Document gives the client: its
    /// `client_id` is the HTTPS URL of that document, so its host is known.
    pub(super) metadata_document: bool,
}

/// Why a client ID does not give a client.
pub(super) enum Lookup {
    Unknown,
    /// The metadata document could not be read or is not valid.
    Invalid(String),
}

/// The client that `client_id` names. An HTTPS URL is a Client ID Metadata
/// Document; any other value must be an ID that registration gave.
pub(super) async fn find(state: &AppState, client_id: &str) -> Result<Client, Lookup> {
    if client_id.starts_with("https://") {
        return cimd::client(state, client_id).await;
    }
    let row: Option<(i32, String, String)> = sqlx::query_as(
        "SELECT id, client_name, redirect_uris FROM oauth_clients
         WHERE client_id = $1 AND metadata_document = 0",
    )
    .bind(client_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| {
        tracing::error!(error = %cause, "Could not read an OAuth client");
        Lookup::Invalid("The server could not read the client".to_owned())
    })?;
    let Some((id, name, redirect_uris)) = row else {
        return Err(Lookup::Unknown);
    };
    Ok(Client {
        id,
        client_id: client_id.to_owned(),
        name,
        redirect_uris: serde_json::from_str(&redirect_uris).unwrap_or_default(),
        metadata_document: false,
    })
}

/// True for `localhost` and the loopback addresses.
pub(super) fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

/// A redirect URI that a client may register: an absolute `https` URI, or
/// an `http` URI on a loopback host for a native client (RFC 8252). It has
/// no fragment and no user information (OAuth 2.1 section 2.3.1).
pub(super) fn acceptable_redirect_uri(raw: &str) -> bool {
    if raw.len() > MAX_REDIRECT_URI_LENGTH {
        return false;
    }
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host()) {
        ("https", Some(_)) => true,
        ("http", Some(host)) => is_loopback(&host),
        _ => false,
    }
}

/// True when a redirect URI in an authorization request matches one that
/// the client registered. The match is exact, except that the port of a
/// loopback `http` URI does not count: a native client listens on a port that
/// it gets when it starts (RFC 8252 section 7.3). Claude Code registers
/// `http://localhost/callback` and sends `http://localhost:<port>/callback`.
pub(super) fn redirect_matches(registered: &str, requested: &str) -> bool {
    if registered == requested {
        return true;
    }
    let (Ok(registered), Ok(requested)) = (url::Url::parse(registered), url::Url::parse(requested))
    else {
        return false;
    };
    let loopback =
        |url: &url::Url| url.scheme() == "http" && url.host().is_some_and(|h| is_loopback(&h));
    loopback(&registered)
        && loopback(&requested)
        && registered.host_str() == requested.host_str()
        && registered.path() == requested.path()
        && registered.query() == requested.query()
        && registered.fragment().is_none()
        && requested.fragment().is_none()
        && requested.username().is_empty()
        && requested.password().is_none()
}

/// Client metadata that this server refuses: an error code of RFC 7591
/// section 3.2.2 and a description.
#[derive(Debug)]
pub(super) struct Refusal {
    pub(super) code: &'static str,
    pub(super) description: String,
}

fn refuse(code: &'static str, description: &str) -> Refusal {
    Refusal {
        code,
        description: description.to_owned(),
    }
}

impl Refusal {
    fn response(self) -> Response {
        oauth_error(StatusCode::BAD_REQUEST, self.code, &self.description)
    }
}

/// The text of a string member, or an error when it is present and not a
/// string.
fn optional_text<'a>(body: &'a Value, name: &str) -> Result<Option<&'a str>, Refusal> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(refuse(
            "invalid_client_metadata",
            &format!("{name} must be a string"),
        )),
    }
}

/// The strings of an array member, or an error when it is present and not
/// an array of strings.
fn optional_list<'a>(body: &'a Value, name: &str) -> Result<Option<Vec<&'a str>>, Refusal> {
    match body.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => items
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .map(Some)
            .ok_or_else(|| {
                refuse(
                    "invalid_client_metadata",
                    &format!("{name} must be an array of strings"),
                )
            }),
        Some(_) => Err(refuse(
            "invalid_client_metadata",
            &format!("{name} must be an array of strings"),
        )),
    }
}

/// The metadata that a client document or a registration gives, after the
/// checks that both share.
pub(super) struct Metadata {
    pub(super) name: Option<String>,
    pub(super) redirect_uris: Vec<String>,
}

/// Checks the members of client metadata that this server uses. Members
/// that it does not use (`client_uri`, `logo_uri`, `scope`,
/// `application_type`, and others) are ignored.
pub(super) fn read_metadata(body: &Value) -> Result<Metadata, Refusal> {
    if !body.is_object() {
        return Err(refuse(
            "invalid_client_metadata",
            "The client metadata must be a JSON object",
        ));
    }
    let redirect_uris = optional_list(body, "redirect_uris")?.unwrap_or_default();
    if redirect_uris.is_empty() || redirect_uris.len() > MAX_REDIRECT_URIS {
        return Err(refuse(
            "invalid_redirect_uri",
            &format!("redirect_uris must give 1 to {MAX_REDIRECT_URIS} URIs"),
        ));
    }
    if let Some(bad) = redirect_uris
        .iter()
        .find(|uri| !acceptable_redirect_uri(uri))
    {
        return Err(refuse(
            "invalid_redirect_uri",
            &format!("{bad} is not an https URI or an http URI on a loopback host"),
        ));
    }
    match optional_text(body, "token_endpoint_auth_method")? {
        None | Some("none") => {}
        Some(_) => {
            return Err(refuse(
                "invalid_client_metadata",
                "Only public clients are supported: token_endpoint_auth_method must be \"none\"",
            ));
        }
    }
    // A client can declare grant types that this server does not support.
    // The claude.ai document declares the JWT bearer grant, for example. The
    // token endpoint refuses those grants, so only the authorization code
    // grant is necessary here.
    if let Some(grants) = optional_list(body, "grant_types")?
        && !grants.contains(&"authorization_code")
    {
        return Err(refuse(
            "invalid_client_metadata",
            "grant_types must include authorization_code",
        ));
    }
    if let Some(types) = optional_list(body, "response_types")?
        && types.iter().any(|kind| *kind != "code")
    {
        return Err(refuse(
            "invalid_client_metadata",
            "response_types may include code only",
        ));
    }
    let name = optional_text(body, "client_name")?
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if name.is_some_and(|name| name.chars().count() > MAX_CLIENT_NAME_CHARS) {
        return Err(refuse(
            "invalid_client_metadata",
            &format!("client_name must have at most {MAX_CLIENT_NAME_CHARS} characters"),
        ));
    }
    Ok(Metadata {
        name: name.map(str::to_owned),
        redirect_uris: redirect_uris.into_iter().map(str::to_owned).collect(),
    })
}

/// `POST /api/oauth/register`: Dynamic Client Registration. Each request
/// counts against a per-address limit, and a client that gets no grant in
/// one day is deleted.
pub(super) async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if state.oauth.is_none() {
        return not_configured();
    }
    let ip = client_ip::from_headers(&headers);
    let keys = Keys { username: None, ip };
    if let Err(limited) = state
        .rate_limits
        .enforce(Scope::OAuthRegister, &keys, Instant::now())
    {
        return limited.into_response();
    }
    state
        .rate_limits
        .failure(Scope::OAuthRegister, &keys, Instant::now());
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return refuse(
            "invalid_client_metadata",
            "The request body must be JSON client metadata",
        )
        .response();
    };
    let metadata = match read_metadata(&body) {
        Ok(metadata) => metadata,
        Err(refused) => return refused.response(),
    };
    sweep(&state).await;
    let Ok(client_id) =
        new_secret(CLIENT_ID_PREFIX).map(|id| id[..CLIENT_ID_PREFIX.len() + 32].to_owned())
    else {
        return oauth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Could not make a client ID",
        );
    };
    let name = metadata
        .name
        .unwrap_or_else(|| "Unnamed MCP client".to_owned());
    let issued_at = now();
    let inserted = sqlx::query(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(&client_id)
    .bind(&name)
    .bind(json!(metadata.redirect_uris).to_string())
    .bind(issued_at)
    .execute(&state.pool)
    .await;
    if let Err(cause) = inserted {
        tracing::error!(error = %cause, "Could not register an OAuth client");
        return oauth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "Could not register the client",
        );
    }
    no_store(
        (
            StatusCode::CREATED,
            Json(json!({
                "client_id": client_id,
                "client_id_issued_at": issued_at.and_utc().timestamp(),
                "client_name": name,
                "redirect_uris": metadata.redirect_uris,
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            })),
        )
            .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_redirect_uri_is_https_or_loopback_http() {
        assert!(acceptable_redirect_uri(
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(acceptable_redirect_uri("http://localhost/callback"));
        assert!(acceptable_redirect_uri("http://127.0.0.1:3118/callback"));
        assert!(acceptable_redirect_uri("http://[::1]/callback"));
        assert!(!acceptable_redirect_uri("http://claude.ai/callback"));
        assert!(!acceptable_redirect_uri("https://claude.ai/callback#x"));
        assert!(!acceptable_redirect_uri("https://user@claude.ai/callback"));
        assert!(!acceptable_redirect_uri("javascript:alert(1)"));
        assert!(!acceptable_redirect_uri("/relative"));
        assert!(!acceptable_redirect_uri(&format!(
            "https://claude.ai/{}",
            "a".repeat(2000)
        )));
    }

    #[test]
    fn only_a_loopback_redirect_may_change_its_port() {
        let claude = "https://claude.ai/api/mcp/auth_callback";
        assert!(redirect_matches(claude, claude));
        assert!(!redirect_matches(
            claude,
            "https://claude.ai/api/mcp/auth_callback/"
        ));
        assert!(!redirect_matches(
            claude,
            "https://claude.ai:8443/api/mcp/auth_callback"
        ));
        assert!(!redirect_matches(
            claude,
            "https://CLAUDE.ai/api/mcp/auth_callback?x=1"
        ));
        assert!(redirect_matches(
            "http://localhost/callback",
            "http://localhost:3118/callback"
        ));
        assert!(redirect_matches(
            "http://127.0.0.1/callback",
            "http://127.0.0.1:50000/callback"
        ));
        assert!(!redirect_matches(
            "http://localhost/callback",
            "http://127.0.0.1:3118/callback"
        ));
        assert!(!redirect_matches(
            "http://localhost/callback",
            "http://localhost:3118/other"
        ));
        assert!(!redirect_matches(
            "http://localhost/callback",
            "http://evil@localhost:3118/callback"
        ));
    }

    #[test]
    fn registration_metadata_is_checked() {
        let good = json!({
            "client_name": "Claude",
            "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": "claudeai",
        });
        let metadata = read_metadata(&good).ok().unwrap();
        assert_eq!(metadata.name.as_deref(), Some("Claude"));
        assert_eq!(metadata.redirect_uris.len(), 1);
        let with = |key: &str, value: Value| {
            let mut body = good.clone();
            body[key] = value;
            read_metadata(&body).is_ok()
        };
        assert!(!with("redirect_uris", json!([])));
        assert!(!with("redirect_uris", json!(["http://claude.ai/cb"])));
        assert!(!with("redirect_uris", json!("https://claude.ai/cb")));
        assert!(!with(
            "token_endpoint_auth_method",
            json!("client_secret_post")
        ));
        assert!(!with("grant_types", json!(["refresh_token"])));
        assert!(with(
            "grant_types",
            json!([
                "authorization_code",
                "refresh_token",
                "urn:ietf:params:oauth:grant-type:jwt-bearer"
            ])
        ));
        assert!(!with("response_types", json!(["token"])));
        assert!(!with("client_name", json!("x".repeat(101))));
        assert!(with("client_name", json!("  ")));
        assert!(read_metadata(&json!([])).is_err());
    }
}

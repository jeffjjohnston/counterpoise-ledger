//! The authorization request: `GET /api/oauth/authorize`, and the consent
//! page's two calls, `GET` and `POST /api/oauth/consent`.
//!
//! The authorization endpoint does not check the request itself. It sends the
//! browser to the consent page with the same query, or to the login page
//! first when the browser has no session. The consent page sends the query
//! to `GET /api/oauth/consent`, which checks it and gives what the page shows.
//! The user's decision goes to `POST /api/oauth/consent` with the query
//! again, and the server checks it again. Thus one function holds every
//! check.
//!
//! The page finishes the redirect to the client in JavaScript. The
//! Content-Security-Policy has `form-action 'self'`, and a browser applies it
//! to the redirect that follows a form post, so a form could not reach the
//! client's redirect URI.
//!
//! The consent routes accept only the session cookie (`cookie_session`): a
//! key or a token must not approve a client.

use super::{
    CODE_SECONDS, Issuer, SCOPE,
    clients::{self, Client, Lookup},
    cookie_user, new_secret, no_store, not_configured, now,
};
use crate::{
    auth::token_hash, error::error, routes::auth::cookie_session, state::AppState,
    validation::parse_json_body,
};
use axum::{
    Json,
    body::Bytes,
    extract::{RawQuery, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Duration;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use std::collections::HashMap;

/// The longest query that the authorization endpoint accepts.
const MAX_QUERY_LENGTH: usize = 8 * 1024;

/// An authorization request that passed every check.
struct Approved {
    client: Client,
    redirect_uri: String,
    state: Option<String>,
    code_challenge: String,
}

/// Why an authorization request fails.
enum Invalid {
    /// The client or the redirect URI is not known, so the server must not
    /// redirect: the page shows the message.
    Page(String),
    /// The redirect URI is good: the client gets the error at that URI, but
    /// only when the user clicks. Every client registers itself, so the URI
    /// proves nothing about where it goes; an automatic redirect would make
    /// this server an open redirector (RFC 9700 section 4.11.2). The page
    /// shows the description and the host of `location`.
    Redirect {
        location: String,
        description: String,
    },
}

/// The parameters of a query. A parameter that occurs twice is an error
/// (OAuth 2.1 section 3.1).
fn parameters(query: &str) -> Result<HashMap<String, String>, Invalid> {
    let mut parameters = HashMap::new();
    for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if parameters
            .insert(name.clone().into_owned(), value.into_owned())
            .is_some()
        {
            return Err(Invalid::Page(format!(
                "The request has the parameter {name} more than once"
            )));
        }
    }
    Ok(parameters)
}

/// The redirect URI with response parameters added, and `iss` (RFC 9207).
fn redirect_to(
    redirect_uri: &str,
    pairs: &[(&str, &str)],
    state: Option<&str>,
    issuer: &Issuer,
) -> String {
    let mut url = url::Url::parse(redirect_uri).expect("a registered redirect URI parses");
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in pairs {
            query.append_pair(name, value);
        }
        if let Some(state) = state {
            query.append_pair("state", state);
        }
        query.append_pair("iss", issuer.origin());
    }
    url.into()
}

/// A PKCE code challenge: 43 to 128 characters of the unreserved set
/// (RFC 7636 section 4.2). An S256 challenge has 43.
fn valid_challenge(challenge: &str) -> bool {
    (43..=128).contains(&challenge.len())
        && challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// Checks an authorization request. The order matters: until the client and
/// the redirect URI are known good, no error may go to the redirect URI.
async fn check(state: &AppState, issuer: &Issuer, query: &str) -> Result<Approved, Invalid> {
    let parameters = parameters(query)?;
    let get = |name: &str| {
        parameters
            .get(name)
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    };
    let Some(client_id) = get("client_id") else {
        return Err(Invalid::Page("The request has no client_id".to_owned()));
    };
    let client = match clients::find(state, client_id).await {
        Ok(client) => client,
        Err(Lookup::Unknown) => {
            return Err(Invalid::Page(
                "The client is not registered. Connect it again from the app.".to_owned(),
            ));
        }
        Err(Lookup::Invalid(reason)) => return Err(Invalid::Page(reason)),
    };
    let redirect_uri = match get("redirect_uri") {
        Some(requested) => {
            if !client
                .redirect_uris
                .iter()
                .any(|registered| clients::redirect_matches(registered, requested))
            {
                return Err(Invalid::Page(
                    "The redirect_uri is not one that the client registered".to_owned(),
                ));
            }
            requested.to_owned()
        }
        None => match client.redirect_uris.as_slice() {
            [only] => only.clone(),
            _ => {
                return Err(Invalid::Page(
                    "The request has no redirect_uri, and the client registered more than one"
                        .to_owned(),
                ));
            }
        },
    };
    let request_state = get("state").map(str::to_owned);
    let fail = |code: &str, description: &str| Invalid::Redirect {
        location: redirect_to(
            &redirect_uri,
            &[("error", code), ("error_description", description)],
            request_state.as_deref(),
            issuer,
        ),
        description: description.to_owned(),
    };
    if get("response_type") != Some("code") {
        return Err(fail(
            "unsupported_response_type",
            "response_type must be code",
        ));
    }
    if get("code_challenge_method") != Some("S256") {
        return Err(fail(
            "invalid_request",
            "PKCE is required: code_challenge_method must be S256",
        ));
    }
    let Some(code_challenge) = get("code_challenge").filter(|c| valid_challenge(c)) else {
        return Err(fail(
            "invalid_request",
            "PKCE is required: the code_challenge is missing or not valid",
        ));
    };
    if let Some(resource) = get("resource")
        && !issuer.names_this_server(resource)
    {
        return Err(fail(
            "invalid_target",
            "This server issues tokens only for its own MCP endpoint",
        ));
    }
    // The scope is not checked: a client may ask for scopes that this server
    // does not have (Claude registers "claudeai"). Every grant gets the one
    // scope, and the token response says so.
    Ok(Approved {
        code_challenge: code_challenge.to_owned(),
        client,
        redirect_uri,
        state: request_state,
    })
}

/// `GET /api/oauth/authorize`: sends the browser to the consent page, through
/// the login page when it has no session. The login page goes on to `next`.
/// A relative `Location`, as the page gate gives (`security.rs`).
pub(super) async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if state.oauth.is_none() {
        return not_configured();
    }
    let query = query.unwrap_or_default();
    if query.len() > MAX_QUERY_LENGTH {
        return error(
            StatusCode::BAD_REQUEST,
            "The authorization request is too long",
        )
        .into_response();
    }
    let consent = format!("/oauth/consent?{query}");
    let signed_in = matches!(cookie_session(&state, &headers).await, Ok(Some(_)));
    let location = if signed_in {
        consent
    } else {
        format!(
            "/login?next={}",
            utf8_percent_encode(&consent, NON_ALPHANUMERIC)
        )
    };
    (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
}

fn invalid_response(invalid: Invalid) -> Response {
    match invalid {
        Invalid::Page(message) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
        }
        // `returnTo`, not `redirectTo`: the page must not treat it as a
        // decision and leave at once. It shows the error and `returnHost`,
        // and goes to `returnTo` when the user clicks.
        Invalid::Redirect {
            location,
            description,
        } => no_store(
            Json(json!({
                "error": format!(
                    "The app sent a request that this server cannot accept: {description}"
                ),
                "returnHost": host_of(&location),
                "returnTo": location,
            }))
            .into_response(),
        ),
    }
}

/// The host of a URL, for the consent page.
fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default()
}

/// `GET /api/oauth/consent?<the authorization query>`: what the consent page
/// shows. The MCP specification requires the page to show the host of the
/// redirect URI, and recommends a warning when every registered redirect URI
/// is on a loopback host: any program on the computer can listen there.
pub(super) async fn details(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(issuer) = state.oauth.clone() else {
        return not_configured();
    };
    let user_id = match cookie_user(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(cause) => return cause.into_response(),
    };
    let approved = match check(&state, &issuer, &query.unwrap_or_default()).await {
        Ok(approved) => approved,
        Err(invalid) => return invalid_response(invalid),
    };
    let username: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or_default();
    let loopback_only = approved.client.redirect_uris.iter().all(|uri| {
        url::Url::parse(uri)
            .ok()
            .and_then(|url| url.host().map(|host| clients::is_loopback(&host)))
            .unwrap_or(false)
    });
    no_store(
        Json(json!({
            "client": {
                "name": approved.client.name,
                "clientId": approved.client.client_id,
                "metadataDocument": approved.client.metadata_document,
                "host": approved.client.metadata_document.then(|| host_of(&approved.client.client_id)),
            },
            "redirectUri": approved.redirect_uri,
            "redirectHost": host_of(&approved.redirect_uri),
            "loopbackOnly": loopback_only,
            "username": username,
            "server": issuer.origin(),
        }))
        .into_response(),
    )
}

/// `POST /api/oauth/consent` with `{ "query": "<the authorization query>",
/// "approve": true | false }`. It checks the query again, and gives the URL
/// that the page goes to: the redirect URI with a code, or with
/// `access_denied`.
pub(super) async fn decide(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(issuer) = state.oauth.clone() else {
        return not_configured();
    };
    let user_id = match cookie_user(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(cause) => return cause.into_response(),
    };
    let body: Value = match parse_json_body(&body, "Could not read the decision") {
        Ok(body) => body,
        Err(cause) => return cause.into_response(),
    };
    let (Some(query), Some(approve)) = (
        body.get("query").and_then(Value::as_str),
        body.get("approve").and_then(Value::as_bool),
    ) else {
        return error(
            StatusCode::BAD_REQUEST,
            "The decision needs query (a string) and approve (a boolean)",
        )
        .into_response();
    };
    let approved = match check(&state, &issuer, query).await {
        Ok(approved) => approved,
        Err(invalid) => return invalid_response(invalid),
    };
    if !approve {
        return no_store(
            Json(json!({
                "redirectTo": redirect_to(
                    &approved.redirect_uri,
                    &[("error", "access_denied"), ("error_description", "The user denied access")],
                    approved.state.as_deref(),
                    &issuer,
                ),
            }))
            .into_response(),
        );
    }
    let Ok(code) = new_secret("") else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Could not make a code").into_response();
    };
    let now = now();
    let stored = async {
        let mut transaction = ledger_db::locks::begin_pool(&state.pool).await?;
        let grant_id: i32 = sqlx::query_scalar(
            "INSERT INTO oauth_grants (user_id, client_id, scope, resource, redirect_uri, created_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        )
        .bind(user_id)
        .bind(approved.client.id)
        .bind(SCOPE)
        .bind(issuer.resource())
        .bind(&approved.redirect_uri)
        .bind(now)
        .fetch_one(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO oauth_codes
                 (code_hash, grant_id, redirect_uri, code_challenge, expires_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(token_hash(&code))
        .bind(grant_id)
        .bind(&approved.redirect_uri)
        .bind(&approved.code_challenge)
        .bind(now + Duration::seconds(CODE_SECONDS))
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await
    }
    .await;
    if let Err(cause) = stored {
        tracing::error!(error = %cause, "Could not store an OAuth grant");
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not store the grant",
        )
        .into_response();
    }
    no_store(
        Json(json!({
            "redirectTo": redirect_to(
                &approved.redirect_uri,
                &[("code", &code)],
                approved.state.as_deref(),
                &issuer,
            ),
        }))
        .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_parameter_may_occur_once() {
        assert!(parameters("a=1&b=2").is_ok());
        assert!(matches!(parameters("a=1&a=2"), Err(Invalid::Page(_))));
    }

    #[test]
    fn a_challenge_has_the_pkce_shape() {
        assert!(valid_challenge(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        ));
        assert!(!valid_challenge("short"));
        assert!(!valid_challenge(&"a".repeat(129)));
        assert!(!valid_challenge(&format!("{}+", "a".repeat(43))));
    }

    #[test]
    fn the_redirect_keeps_its_query_and_adds_the_issuer() {
        let issuer = Issuer::parse("https://books.example.com").unwrap();
        assert_eq!(
            redirect_to(
                "https://claude.ai/cb?x=1",
                &[("code", "abc")],
                Some("s t"),
                &issuer
            ),
            "https://claude.ai/cb?x=1&code=abc&state=s+t&iss=https%3A%2F%2Fbooks.example.com"
        );
    }
}

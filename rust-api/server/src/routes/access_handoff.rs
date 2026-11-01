//! `GET /api/auth/access-handoff`: gives a native client its Cloudflare Access
//! token.
//!
//! A native client opens this route in the system browser's sign-in sheet.
//! Access signs the user in before the request arrives, and forwards its
//! application token in `Cf-Access-Jwt-Assertion`. The route sends the browser
//! on to `counterpoise://access` with that token and the client's `state`. The
//! client then sends the token in the `cf-access-token` header, which Access
//! accepts in place of its cookie, until the Access session ends.
//!
//! Only a server behind Access gets the header. The native server, and a
//! Worker request without the header, answer 404 as an unknown API path does.
//! The route never checks the token: it only hands back what Access forwarded,
//! to the one callback scheme, and Access checks the token on every later
//! request.

use axum::{
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::collections::HashMap;

/// The client's callback. A fixed scheme: the route never redirects to a
/// target that the request names.
const CALLBACK: &str = "counterpoise://access";
/// The header in which Access forwards its application token.
const ASSERTION: &str = "cf-access-jwt-assertion";
/// An Access token is a few kilobytes at most.
const MAX_TOKEN: usize = 8192;

pub(crate) async fn access_handoff(
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if cfg!(feature = "native") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let assertion = headers.get(ASSERTION).and_then(|value| value.to_str().ok());
    match location(assertion, query.get("state").map(String::as_str)) {
        Ok(location) => {
            let mut response = StatusCode::SEE_OTHER.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::LOCATION,
                HeaderValue::from_str(&location).expect("a checked location"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            // The security layer's `same-origin` Referrer-Policy keeps this
            // URL out of the Referer of any later request.
            response
        }
        Err(Refusal::NoAccess) => StatusCode::NOT_FOUND.into_response(),
        Err(Refusal::State) => {
            crate::error::error(StatusCode::BAD_REQUEST, "Invalid state").into_response()
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Refusal {
    /// No Access token: the request did not come through Access.
    NoAccess,
    /// The client's `state` is missing or malformed.
    State,
}

/// The callback URL for this token and state. Both are checked to hold only
/// URL-safe characters, so neither needs encoding.
fn location(assertion: Option<&str>, state: Option<&str>) -> Result<String, Refusal> {
    let token = assertion
        .filter(|token| is_jwt(token))
        .ok_or(Refusal::NoAccess)?;
    let state = state
        .filter(|state| (16..=128).contains(&state.len()) && state.bytes().all(is_base64url))
        .ok_or(Refusal::State)?;
    Ok(format!("{CALLBACK}?token={token}&state={state}"))
}

/// Three non-empty base64url segments, as a JWT has.
fn is_jwt(token: &str) -> bool {
    token.len() <= MAX_TOKEN
        && token.split('.').count() == 3
        && token
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(is_base64url))
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "header.payload.signature";
    const STATE: &str = "aB3-_xYz0123456789";

    #[test]
    fn hands_the_token_and_state_to_the_callback() {
        assert_eq!(
            location(Some(TOKEN), Some(STATE)),
            Ok(format!("counterpoise://access?token={TOKEN}&state={STATE}"))
        );
    }

    #[test]
    fn needs_a_token_shaped_like_a_jwt() {
        for token in [
            None,
            Some(""),
            Some("a.b"),
            Some("a..c"),
            Some("a.b.c d"),
            Some("a.b.c&x=y"),
        ] {
            assert_eq!(
                location(token, Some(STATE)),
                Err(Refusal::NoAccess),
                "{token:?}"
            );
        }
        let long = format!("{}.b.c", "a".repeat(MAX_TOKEN));
        assert_eq!(location(Some(&long), Some(STATE)), Err(Refusal::NoAccess));
    }

    #[test]
    fn needs_a_url_safe_state_of_16_to_128_characters() {
        let long = "a".repeat(129);
        for state in [
            None,
            Some("short"),
            Some(long.as_str()),
            Some("0123456789abcdef&evil=1"),
        ] {
            assert_eq!(
                location(Some(TOKEN), state),
                Err(Refusal::State),
                "{state:?}"
            );
        }
        assert!(location(Some(TOKEN), Some(&"a".repeat(128))).is_ok());
    }
}

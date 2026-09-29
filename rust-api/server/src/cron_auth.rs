use crate::error::{ApiError, error};
use axum::http::StatusCode;
use axum::http::{HeaderMap, header};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// The Node helper compares fixed-width digests of the entire header value.
/// This preserves its case and whitespace rules while accepting any secret length.
pub(crate) fn verify_cron_secret(headers: &HeaderMap, secret: Option<&str>) -> bool {
    let Some(secret) = secret.filter(|secret| !secret.is_empty()) else {
        return false;
    };
    let Some(actual) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let expected = format!("Bearer {secret}");
    bool::from(Sha256::digest(actual.as_bytes()).ct_eq(&Sha256::digest(expected.as_bytes())))
}

pub(crate) fn require_cron_secret(
    headers: &HeaderMap,
    secret: Option<&str>,
) -> Result<(), ApiError> {
    if verify_cron_secret(headers, secret) {
        Ok(())
    } else {
        Err(error(StatusCode::UNAUTHORIZED, "Unauthorized"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cron_bearer_matches_node_denials() {
        let mut headers = HeaderMap::new();
        assert!(!verify_cron_secret(&headers, Some("s3cret")));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer s3cret"),
        );
        assert!(verify_cron_secret(&headers, Some("s3cret")));
        assert!(!verify_cron_secret(&headers, None));
        assert!(!verify_cron_secret(&headers, Some("")));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer much-much-longer-value"),
        );
        assert!(!verify_cron_secret(&headers, Some("s3cret")));
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("bearer s3cret"),
        );
        assert!(!verify_cron_secret(&headers, Some("s3cret")));
    }
}

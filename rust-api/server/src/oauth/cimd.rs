//! Client ID Metadata Documents
//! (draft-ietf-oauth-client-id-metadata-document): a client whose
//! `client_id` is an HTTPS URL. The server reads the JSON document at that
//! URL, and the document gives the client's name and redirect URIs. Claude
//! uses one when the server metadata advertises
//! `client_id_metadata_document_supported` and the `none` token endpoint
//! auth method.
//!
//! The server makes the request, so a user who controls a `client_id` can
//! point it at any address. The fetch therefore refuses an address that is
//! not public (loopback, private, link-local and others), connects only to
//! the addresses that it checked, follows no redirect, stops after
//! [`TIMEOUT`], and reads at most [`MAX_DOCUMENT_BYTES`].
//!
//! A document is kept in `oauth_clients` and read again after
//! [`FRESH_SECONDS`]. When a read fails, a copy younger than
//! [`STALE_SECONDS`] is used.

use super::{
    clients::{Client, Lookup, read_metadata},
    now,
};
use crate::state::AppState;
use chrono::NaiveDateTime;
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

const FRESH_SECONDS: i64 = 60 * 60;
const STALE_SECONDS: i64 = 24 * 60 * 60;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_DOCUMENT_BYTES: usize = 64 * 1024;

/// What the fetch accepts. Only the unit tests relax it, to read a document
/// from a local test server.
#[derive(Clone, Copy)]
struct Policy {
    require_https: bool,
    allow_private: bool,
}

const POLICY: Policy = Policy {
    require_https: true,
    allow_private: false,
};

/// The client that the document at `client_id` gives.
pub(super) async fn client(state: &AppState, client_id: &str) -> Result<Client, Lookup> {
    let url =
        valid_client_id(client_id, POLICY).map_err(|reason| Lookup::Invalid(reason.to_owned()))?;
    let cached: Option<(i32, String, String, Option<NaiveDateTime>)> = sqlx::query_as(
        "SELECT id, client_name, redirect_uris, fetched_at FROM oauth_clients
         WHERE client_id = $1 AND metadata_document = 1",
    )
    .bind(client_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|cause| {
        tracing::error!(error = %cause, "Could not read an OAuth client");
        Lookup::Invalid("The server could not read the client".to_owned())
    })?;
    let now = now();
    let age = |fetched_at: Option<NaiveDateTime>| {
        fetched_at.map_or(i64::MAX, |at| (now - at).num_seconds())
    };
    if let Some((id, name, uris, fetched_at)) = &cached
        && age(*fetched_at) < FRESH_SECONDS
    {
        return Ok(stored(*id, client_id, name, uris));
    }
    let document = match fetch(&url, POLICY).await {
        Ok(document) => document,
        Err(reason) => {
            tracing::warn!(
                client_id,
                reason,
                "Could not read a client metadata document"
            );
            return match cached {
                Some((id, name, uris, fetched_at)) if age(fetched_at) < STALE_SECONDS => {
                    Ok(stored(id, client_id, &name, &uris))
                }
                _ => Err(Lookup::Invalid(format!(
                    "The client metadata document could not be read: {reason}"
                ))),
            };
        }
    };
    let (name, redirect_uris) =
        check_document(&document, client_id, &url).map_err(Lookup::Invalid)?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO oauth_clients
             (client_id, client_name, redirect_uris, metadata_document, fetched_at, created_at)
         VALUES ($1, $2, $3, 1, $4, $4)
         ON CONFLICT (client_id) DO UPDATE SET
             client_name = excluded.client_name,
             redirect_uris = excluded.redirect_uris,
             fetched_at = excluded.fetched_at
         RETURNING id",
    )
    .bind(client_id)
    .bind(&name)
    .bind(json!(redirect_uris).to_string())
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .map_err(|cause| {
        tracing::error!(error = %cause, "Could not keep a client metadata document");
        Lookup::Invalid("The server could not keep the client".to_owned())
    })?;
    Ok(Client {
        id,
        client_id: client_id.to_owned(),
        name,
        redirect_uris,
        metadata_document: true,
    })
}

fn stored(id: i32, client_id: &str, name: &str, redirect_uris: &str) -> Client {
    Client {
        id,
        client_id: client_id.to_owned(),
        name: name.to_owned(),
        redirect_uris: serde_json::from_str(redirect_uris).unwrap_or_default(),
        metadata_document: true,
    }
}

/// A `client_id` that can be a document URL: `https`, a host, a path other
/// than `/`, no fragment and no user information. The URL must be in its
/// normal form, because the document must give the same text as its
/// `client_id`.
fn valid_client_id(raw: &str, policy: Policy) -> Result<url::Url, &'static str> {
    let url = url::Url::parse(raw).map_err(|_| "The client_id is not a URL")?;
    if url.as_str() != raw {
        return Err("The client_id URL is not in its normal form");
    }
    if policy.require_https && url.scheme() != "https" {
        return Err("The client_id URL must use https");
    }
    if url.host().is_none() || url.path() == "/" {
        return Err("The client_id URL must have a host and a path");
    }
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("The client_id URL must not have a fragment or user information");
    }
    Ok(url)
}

/// The name and redirect URIs of a document, after the checks of the draft
/// and of [`read_metadata`].
fn check_document(
    document: &Value,
    client_id: &str,
    url: &url::Url,
) -> Result<(String, Vec<String>), String> {
    if document.get("client_id").and_then(Value::as_str) != Some(client_id) {
        return Err("The document's client_id is not the URL of the document".to_owned());
    }
    let metadata = read_metadata(document).map_err(|refusal| refusal.description)?;
    let name = metadata
        .name
        .unwrap_or_else(|| url.host_str().unwrap_or("Unnamed MCP client").to_owned());
    Ok((name, metadata.redirect_uris))
}

/// True for an address on the public internet. The rest are loopback,
/// private, link-local, shared, documentation, benchmark, multicast,
/// reserved and unspecified ranges, and IPv6 forms that hold one of those
/// IPv4 addresses.
fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => {
            if let Some(v4) = address.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let segments = address.segments();
            // NAT64 (64:ff9b::/96) holds an IPv4 address in its last 32 bits.
            if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                let octets = address.octets();
                return is_public_v4(Ipv4Addr::new(
                    octets[12], octets[13], octets[14], octets[15],
                ));
            }
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..=19).contains(&b))
        || a >= 240)
}

/// Reads the JSON document at `url`. Each address of the host must pass
/// [`is_public`], and the connection goes only to those addresses, so a
/// second DNS answer cannot change the target.
async fn fetch(url: &url::Url, policy: Policy) -> Result<Value, String> {
    let host = url.host_str().ok_or("no host")?.to_owned();
    let port = url.port_or_known_default().ok_or("no port")?;
    let lookup_host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        TIMEOUT,
        tokio::net::lookup_host((lookup_host.as_str(), port)),
    )
    .await
    .map_err(|_| "the DNS lookup timed out".to_owned())?
    .map_err(|cause| format!("the DNS lookup failed: {cause}"))?
    .collect();
    if addresses.is_empty() {
        return Err("the host has no address".to_owned());
    }
    if !policy.allow_private && addresses.iter().any(|address| !is_public(address.ip())) {
        return Err("the host has an address that is not public".to_owned());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .https_only(policy.require_https)
        .resolve_to_addrs(&lookup_host, &addresses)
        // A proxy resolves the host again, so it could connect to an
        // address that is not public. The client connects directly.
        .no_proxy()
        .user_agent(concat!("Counterpoise/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|cause| format!("the HTTP client failed: {cause}"))?;
    let mut response = client
        .get(url.as_str())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|cause| format!("the request failed: {cause}"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "the server answered {}",
            response.status().as_u16()
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|cause| format!("the response failed: {cause}"))?
    {
        if body.len() + chunk.len() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "the document is larger than {MAX_DOCUMENT_BYTES} bytes"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "the document is not JSON".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::get};

    #[test]
    fn only_public_addresses_pass() {
        for public in ["93.184.216.34", "2606:4700::1111", "160.79.104.10"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "192.0.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        assert!(is_public("64:ff9b::5db8:d822".parse().unwrap()));
    }

    #[test]
    fn a_client_id_must_be_an_https_url_with_a_path() {
        let ok = |raw: &str| valid_client_id(raw, POLICY).is_ok();
        assert!(ok("https://claude.ai/oauth/claude-code-client-metadata"));
        assert!(ok("https://app.example.com/client.json?v=1"));
        assert!(!ok("https://app.example.com/"));
        assert!(!ok("https://app.example.com"));
        assert!(!ok("http://app.example.com/client.json"));
        assert!(!ok("https://app.example.com/client.json#x"));
        assert!(!ok("https://user@app.example.com/client.json"));
        assert!(!ok("https://APP.example.com/client.json"));
        assert!(!ok("https://app.example.com/a/../client.json"));
    }

    #[test]
    fn a_document_must_name_itself_and_be_valid_metadata() {
        let id = "https://app.example.com/client.json";
        let url = url::Url::parse(id).unwrap();
        let document = json!({
            "client_id": id,
            "client_name": "Example",
            "redirect_uris": ["http://localhost/callback"],
            "token_endpoint_auth_method": "none",
        });
        assert_eq!(
            check_document(&document, id, &url).unwrap(),
            (
                "Example".to_owned(),
                vec!["http://localhost/callback".to_owned()]
            )
        );
        let mut other = document.clone();
        other["client_id"] = json!("https://evil.example/client.json");
        assert!(check_document(&other, id, &url).is_err());
        let mut secret = document.clone();
        secret["token_endpoint_auth_method"] = json!("private_key_jwt");
        assert!(check_document(&secret, id, &url).is_err());
        let mut unnamed = document.clone();
        unnamed.as_object_mut().unwrap().remove("client_name");
        assert_eq!(
            check_document(&unnamed, id, &url).unwrap().0,
            "app.example.com"
        );
    }

    async fn serve(app: Router) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        address
    }

    #[tokio::test]
    async fn the_fetch_refuses_private_hosts_redirects_and_large_documents() {
        let address = serve(
            Router::new()
                .route(
                    "/client.json",
                    get(|| async { Json(json!({ "client_id": "x" })) }),
                )
                .route(
                    "/moved",
                    get(|| async {
                        (
                            axum::http::StatusCode::FOUND,
                            [(axum::http::header::LOCATION, "/client.json")],
                        )
                    }),
                )
                .route(
                    "/large",
                    get(|| async { "x".repeat(MAX_DOCUMENT_BYTES + 1) }),
                ),
        )
        .await;
        let local = Policy {
            require_https: false,
            allow_private: true,
        };
        let at = |path: &str| url::Url::parse(&format!("http://{address}{path}")).unwrap();
        assert_eq!(
            fetch(&at("/client.json"), local).await.unwrap(),
            json!({ "client_id": "x" })
        );
        let refused = fetch(
            &at("/client.json"),
            Policy {
                require_https: false,
                allow_private: false,
            },
        )
        .await
        .unwrap_err();
        assert!(refused.contains("not public"), "{refused}");
        assert!(
            fetch(&at("/moved"), local)
                .await
                .unwrap_err()
                .contains("302")
        );
        assert!(
            fetch(&at("/large"), local)
                .await
                .unwrap_err()
                .contains("larger")
        );
        assert!(fetch(&at("/client.json"), POLICY).await.is_err());
    }
}

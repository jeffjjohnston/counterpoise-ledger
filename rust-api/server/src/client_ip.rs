//! The client address that the rate limiter keys on.
//!
//! A client can send any `X-Forwarded-For` value. The server uses that header
//! only when a reverse proxy is the only way in, because then the proxy writes
//! the rightmost entry. In all other cases the server uses the address of the
//! TCP peer.
//!
//! [`record`] runs before every route. It removes any [`CLIENT_IP_HEADER`]
//! that the request has, and then writes the address that it found. The routes
//! read the address with [`from_headers`]. They do not read
//! `X-Forwarded-For`.
//!
//! The address is a rate-limit key: [`rate_limit_key`] maps an IPv6 address to
//! its /64 prefix and an IPv4-mapped address to its IPv4 address.
//!
//! The same rule applies to [`PROXY_HEADERS`], `X-Forwarded-Host` and
//! `X-Forwarded-Proto`. They give the host that the cross-origin checks
//! compare with `Origin`, and the scheme of the Secure-cookie warning. When
//! the server does not trust a proxy, [`record`] removes them, so that a
//! client that connects directly cannot choose the host of the origin check.
//!
//! `TRUST_PROXY` sets the rule (see [`trust_proxy`]):
//!
//! | `TRUST_PROXY` | Rule |
//! | --- | --- |
//! | `true` | Use `X-Forwarded-For`. Use the peer when the header is missing |
//! | `false` | Use the peer. Ignore `X-Forwarded-For` |
//! | not set | `true` when the published address is loopback, else `false` |
//!
//! The published address is `APP_BIND` when it is set, which is the host
//! address where Compose publishes the port. Else it is the host of
//! `RUST_BIND`. When the port is on loopback, only a process on the same host
//! can connect, and that is the reverse proxy.

use axum::{
    Router,
    extract::{ConnectInfo, Request, State, connect_info::IntoMakeServiceWithConnectInfo},
    http::{HeaderMap, HeaderValue},
    middleware::{self, Next},
    response::Response,
};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};

/// The header that [`record`] writes. Its value is the rate-limit key of the
/// client, not the client's address. An IPv6 address is cut to its /64 prefix.
/// An IPv4-mapped IPv6 address becomes an IPv4 address. It is not a public
/// contract: the server removes the value that a client sends.
pub(crate) const CLIENT_IP_HEADER: &str = "x-counterpoise-client-ip";

/// The proxy headers other than `X-Forwarded-For` that the server reads.
/// [`record`] removes them when the server does not trust a proxy.
const PROXY_HEADERS: [&str; 2] = ["x-forwarded-host", "x-forwarded-proto"];

/// The result of [`trust_proxy`], with the reason for the log line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProxyTrust {
    pub(crate) trusted: bool,
    pub(crate) reason: &'static str,
}

/// Decides whether to use `X-Forwarded-For`. `explicit` is `TRUST_PROXY`,
/// `app_bind` is `APP_BIND`, and `rust_bind` is the address that the server
/// listens on. An empty value is the same as no value. A `TRUST_PROXY` value
/// that is not `true` or `false` is an error, so that a typing error does not
/// change the rule without a message.
pub(crate) fn trust_proxy(
    explicit: Option<&str>,
    app_bind: Option<&str>,
    rust_bind: &str,
) -> Result<ProxyTrust, String> {
    let (trusted, reason) = match explicit.map(str::trim).filter(|value| !value.is_empty()) {
        Some("true") => (true, "TRUST_PROXY=true"),
        Some("false") => (false, "TRUST_PROXY=false"),
        Some(other) => {
            return Err(format!(
                "TRUST_PROXY must be true or false, not {other:?}. Leave it unset to trust X-Forwarded-For only when the published address is loopback"
            ));
        }
        None => match app_bind.map(str::trim).filter(|value| !value.is_empty()) {
            Some(host) if is_loopback(host) => (true, "APP_BIND is loopback"),
            Some(_) => (false, "APP_BIND is not loopback"),
            None if is_loopback(bind_host(rust_bind)) => (true, "RUST_BIND is loopback"),
            None => (false, "RUST_BIND is not loopback"),
        },
    };
    Ok(ProxyTrust { trusted, reason })
}

/// The host part of a `host:port` listen address, without IPv6 brackets.
fn bind_host(bind: &str) -> &str {
    let bind = bind.trim();
    match bind.rsplit_once(':') {
        // `::1` without a port has more than one colon and no brackets.
        Some((host, _)) if host.starts_with('[') || !host.contains(':') => host,
        _ => bind,
    }
}

fn is_loopback(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// The rightmost non-empty entry of `X-Forwarded-For`. A proxy adds the
/// address of its own client at the end, so this is the entry that the
/// nearest proxy wrote. A request can have more than one header line; the
/// entries of the last line come last.
fn rightmost_forwarded(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .rev()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            value
                .split(',')
                .rev()
                .map(str::trim)
                .find(|part| !part.is_empty())
        })
}

/// The rate-limit key for a client address.
///
/// An IPv4 address is its own key. An IPv4-mapped IPv6 address
/// (`::ffff:a.b.c.d`) gives the embedded IPv4 address, so it shares the IPv4
/// bucket. Any other IPv6 address gives its /64 prefix, because one client
/// usually holds a whole /64 and can use a new address for each attempt. Text
/// that is not an IP address stays as it is.
pub(crate) fn rate_limit_key(address: &str) -> String {
    match address.parse::<IpAddr>() {
        Ok(ip) => match ip.to_canonical() {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => {
                let mut segments = v6.segments();
                segments[4..].fill(0);
                Ipv6Addr::from(segments).to_string()
            }
        },
        Err(_) => address.to_string(),
    }
}

/// The client key for a request: the rightmost `X-Forwarded-For` entry when
/// `trusted` and the header has one, else the peer address. Both go through
/// [`rate_limit_key`].
pub(crate) fn resolve(trusted: bool, headers: &HeaderMap, peer: Option<IpAddr>) -> Option<String> {
    if trusted && let Some(forwarded) = rightmost_forwarded(headers) {
        return Some(rate_limit_key(forwarded));
    }
    peer.map(|ip| rate_limit_key(&ip.to_string()))
}

/// The middleware that writes [`CLIENT_IP_HEADER`], and that removes
/// [`PROXY_HEADERS`] when the server does not trust a proxy. `State` is the
/// result of [`trust_proxy`].
pub(crate) async fn record(
    State(trusted): State<bool>,
    mut request: Request,
    next: Next,
) -> Response {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip());
    let client = resolve(trusted, request.headers(), peer);
    let headers = request.headers_mut();
    headers.remove(CLIENT_IP_HEADER);
    if !trusted {
        for name in PROXY_HEADERS {
            headers.remove(name);
        }
    }
    if let Some(value) = client.and_then(|client| HeaderValue::from_str(&client).ok()) {
        headers.insert(CLIENT_IP_HEADER, value);
    }
    next.run(request).await
}

/// The rate-limit key that [`record`] wrote, or `None` when it found none.
/// This is not the client's address. An IPv6 address is cut to its /64 prefix.
/// An IPv4-mapped IPv6 address is an IPv4 address. Do not log it. Do not store
/// it as the address of the client.
pub(crate) fn from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(CLIENT_IP_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

/// The server's service: `app` behind [`record`], with the peer address in
/// each request. `serve()` gives this to `axum::serve`.
pub(crate) fn service(
    app: Router,
    trusted: bool,
) -> IntoMakeServiceWithConnectInfo<Router, SocketAddr> {
    app.layer(middleware::from_fn_with_state(trusted, record))
        .into_make_service_with_connect_info::<SocketAddr>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    fn forwarded(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append("x-forwarded-for", value.parse().unwrap());
        }
        headers
    }

    const PEER: Option<IpAddr> = Some(IpAddr::V4(std::net::Ipv4Addr::new(172, 18, 0, 1)));

    #[test]
    fn trusted_header_gives_the_rightmost_entry() {
        let headers = forwarded(&["198.51.100.7"]);
        assert_eq!(
            resolve(true, &headers, PEER).as_deref(),
            Some("198.51.100.7")
        );
        // The proxy adds the real client at the end. The entries before it
        // are what the client sent.
        let headers = forwarded(&["203.0.113.66, 198.51.100.7"]);
        assert_eq!(
            resolve(true, &headers, PEER).as_deref(),
            Some("198.51.100.7")
        );
        let headers = forwarded(&["203.0.113.66", "198.51.100.7, "]);
        assert_eq!(
            resolve(true, &headers, PEER).as_deref(),
            Some("198.51.100.7")
        );
    }

    #[test]
    fn ipv6_clients_share_a_key_per_64_prefix() {
        let key = rate_limit_key;
        assert_eq!(
            key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
            key("2001:db8:1:2::1")
        );
        assert_eq!(key("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::");
        assert_ne!(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"));
        assert_ne!(key("2001:db8:1:2::1"), key("2001:db8:2:2::1"));
    }

    #[test]
    fn mapped_ipv6_shares_the_ipv4_key_and_ipv4_is_unchanged() {
        assert_eq!(
            rate_limit_key("::ffff:192.0.2.1"),
            rate_limit_key("192.0.2.1")
        );
        assert_eq!(rate_limit_key("192.0.2.1"), "192.0.2.1");
        assert_eq!(rate_limit_key("172.18.0.1"), "172.18.0.1");
        assert_eq!(rate_limit_key("not an address"), "not an address");
    }

    #[test]
    fn resolve_gives_the_64_key_for_peer_and_forwarded_entry() {
        let peer: IpAddr = "2001:db8:1:2::9".parse().unwrap();
        let headers = HeaderMap::new();
        assert_eq!(
            resolve(false, &headers, Some(peer)).as_deref(),
            Some("2001:db8:1:2::")
        );
        let headers = forwarded(&["2001:db8:1:2:f::1"]);
        assert_eq!(
            resolve(true, &headers, PEER).as_deref(),
            Some("2001:db8:1:2::")
        );
    }

    #[test]
    fn untrusted_header_is_ignored_for_the_peer() {
        let headers = forwarded(&["198.51.100.7"]);
        assert_eq!(
            resolve(false, &headers, PEER).as_deref(),
            Some("172.18.0.1")
        );
    }

    #[test]
    fn missing_header_gives_the_peer_in_both_modes() {
        let headers = HeaderMap::new();
        assert_eq!(resolve(true, &headers, PEER).as_deref(), Some("172.18.0.1"));
        assert_eq!(
            resolve(false, &headers, PEER).as_deref(),
            Some("172.18.0.1")
        );
        assert_eq!(
            resolve(true, &forwarded(&[" , "]), PEER).as_deref(),
            Some("172.18.0.1")
        );
        assert_eq!(resolve(false, &headers, None), None);
        let mapped: IpAddr = "::ffff:203.0.113.9".parse().unwrap();
        assert_eq!(
            resolve(false, &headers, Some(mapped)).as_deref(),
            Some("203.0.113.9")
        );
    }

    #[test]
    fn spoofed_header_cannot_change_the_untrusted_key() {
        for spoof in ["10.0.0.1", "10.0.0.2", "1.1.1.1, 10.0.0.3"] {
            let headers = forwarded(&[spoof]);
            assert_eq!(
                resolve(false, &headers, PEER).as_deref(),
                Some("172.18.0.1")
            );
        }
        // With trust, a spoofed entry before the proxy's entry is not used.
        let headers = forwarded(&["10.0.0.1, 198.51.100.7"]);
        assert_eq!(
            resolve(true, &headers, PEER).as_deref(),
            Some("198.51.100.7")
        );
    }

    #[test]
    fn setting_and_published_address_decide_the_trust() {
        let trusted = |explicit, app_bind, rust_bind| {
            trust_proxy(explicit, app_bind, rust_bind).unwrap().trusted
        };
        assert!(trusted(Some("true"), Some("0.0.0.0"), "0.0.0.0:4000"));
        assert!(!trusted(Some("false"), Some("127.0.0.1"), "127.0.0.1:4000"));
        // The Compose default and the owner's production.
        assert!(trusted(None, Some("127.0.0.1"), "0.0.0.0:4000"));
        assert!(trusted(Some(""), Some("::1"), "0.0.0.0:4000"));
        assert!(trusted(None, Some("[::1]"), "0.0.0.0:4000"));
        assert!(trusted(None, Some("localhost"), "0.0.0.0:4000"));
        // A port that the network can reach.
        assert!(!trusted(None, Some("0.0.0.0"), "0.0.0.0:4000"));
        assert!(!trusted(None, Some("192.168.1.10"), "0.0.0.0:4000"));
        // No APP_BIND: `docker run -p` or a server outside Docker.
        assert!(!trusted(None, None, "0.0.0.0:4000"));
        assert!(!trusted(None, Some(" "), "[::]:4000"));
        assert!(trusted(None, None, "127.0.0.1:4000"));
        assert!(trusted(None, None, "[::1]:4000"));
        assert!(trusted(None, None, "localhost:4000"));
        assert!(trust_proxy(Some("yes"), None, "127.0.0.1:4000").is_err());
        assert!(trust_proxy(Some("TRUE"), None, "127.0.0.1:4000").is_err());
    }

    /// The real listener, so the peer address comes from the socket.
    async fn echo_client_ip(trusted: bool, headers: &[(&str, &str)]) -> String {
        let app = Router::new().route(
            "/",
            get(|headers: HeaderMap| async move {
                from_headers(&headers).unwrap_or("none").to_string()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(
                async move { axum::serve(listener, service(app, trusted)).await.unwrap() },
            );
        let mut request = reqwest::Client::new().get(&base);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let body = request.send().await.unwrap().text().await.unwrap();
        server.abort();
        body
    }

    #[tokio::test]
    async fn service_keys_on_the_socket_peer_unless_trusted() {
        let spoofed = [
            ("x-forwarded-for", "203.0.113.5"),
            (CLIENT_IP_HEADER, "203.0.113.6"),
        ];
        assert_eq!(echo_client_ip(false, &spoofed).await, "127.0.0.1");
        assert_eq!(echo_client_ip(true, &spoofed).await, "203.0.113.5");
        assert_eq!(
            echo_client_ip(true, &[(CLIENT_IP_HEADER, "203.0.113.6")]).await,
            "127.0.0.1"
        );
    }

    /// Sends one request through [`service`] on a real listener.
    async fn send(
        app: Router,
        trusted: bool,
        method: reqwest::Method,
        headers: &[(&str, &str)],
    ) -> (u16, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server =
            tokio::spawn(
                async move { axum::serve(listener, service(app, trusted)).await.unwrap() },
            );
        let mut request = reqwest::Client::new().request(method, format!("{base}/api/write"));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let body = response.text().await.unwrap();
        server.abort();
        (status, body)
    }

    #[tokio::test]
    async fn untrusted_service_removes_the_forwarded_host_and_proto() {
        let echo = Router::new().route(
            "/api/write",
            get(|headers: HeaderMap| async move {
                let value = |name| {
                    headers
                        .get(name)
                        .and_then(|value: &HeaderValue| value.to_str().ok())
                        .unwrap_or("none")
                        .to_string()
                };
                format!(
                    "{} {}",
                    value("x-forwarded-host"),
                    value("x-forwarded-proto")
                )
            }),
        );
        let forwarded = [
            ("x-forwarded-host", "books.example"),
            ("x-forwarded-proto", "https"),
        ];
        let get = reqwest::Method::GET;
        assert_eq!(
            send(echo.clone(), false, get.clone(), &forwarded).await.1,
            "none none"
        );
        assert_eq!(
            send(echo, true, get, &forwarded).await.1,
            "books.example https"
        );
    }

    /// A client that connects directly must not choose the host that the
    /// cross-origin write check compares with `Origin`.
    #[tokio::test]
    async fn untrusted_forwarded_host_cannot_pass_the_origin_check() {
        let app = || {
            let api = Router::new().route("/api/write", axum::routing::post(|| async { "ok" }));
            crate::security::protect(api, crate::security::no_pages(), false)
        };
        let post = reqwest::Method::POST;
        let forged = [
            ("origin", "https://attacker.example"),
            ("x-forwarded-host", "attacker.example"),
            ("authorization", "Bearer cpk_test"),
        ];
        assert_eq!(send(app(), false, post.clone(), &forged).await.0, 403);
        // Behind a trusted proxy, the proxy writes the header.
        assert_eq!(send(app(), true, post, &forged).await.0, 200);
    }
}

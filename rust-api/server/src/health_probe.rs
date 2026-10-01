//! `counterpoise-rust-api health`: the container healthcheck. It sends
//! `GET /health` to the server in this container and exits 0 only on a 200.
//! `/health` runs a query, so a broken database also fails the check. The
//! image has no `wget` or `curl`; this probe replaces them.

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(5);

/// The address to probe for a bind address. A server that binds every
/// interface (`0.0.0.0` or `::`) is probed on the loopback address.
pub(crate) fn probe_address(bind: &str) -> Result<SocketAddr, String> {
    let mut address = bind
        .to_socket_addrs()
        .map_err(|cause| format!("RUST_BIND {bind:?} is not an address: {cause}"))?
        .next()
        .ok_or_else(|| format!("RUST_BIND {bind:?} has no address"))?;
    if address.ip().is_unspecified() {
        address.set_ip(if address.is_ipv4() {
            [127, 0, 0, 1].into()
        } else {
            std::net::Ipv6Addr::LOCALHOST.into()
        });
    }
    Ok(address)
}

/// Sends `GET /health` to `address`. Returns the status line on a 200, and
/// an error that names the failure otherwise.
pub(crate) fn probe(address: SocketAddr) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(&address, TIMEOUT)
        .map_err(|cause| format!("cannot connect to {address}: {cause}"))?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(TIMEOUT)))
        .map_err(|cause| cause.to_string())?;
    stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|cause| format!("cannot send to {address}: {cause}"))?;
    let mut response = Vec::new();
    stream
        .take(4096)
        .read_to_end(&mut response)
        .map_err(|cause| format!("no response from {address}: {cause}"))?;
    let text = String::from_utf8_lossy(&response);
    let status = text.lines().next().unwrap_or_default().to_owned();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(status),
        _ => Err(format!("{address} answered {status:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn answer_once(response: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        address
    }

    #[test]
    fn a_200_passes() {
        let address = answer_once("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
        assert_eq!(probe(address).unwrap(), "HTTP/1.1 200 OK");
    }

    #[test]
    fn a_503_fails() {
        let address = answer_once("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
        assert!(probe(address).unwrap_err().contains("503"));
    }

    #[test]
    fn no_server_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        assert!(probe(address).unwrap_err().contains("cannot connect"));
    }

    #[test]
    fn an_unspecified_bind_is_probed_on_loopback() {
        assert_eq!(
            probe_address("0.0.0.0:4000").unwrap(),
            "127.0.0.1:4000".parse().unwrap()
        );
        assert_eq!(
            probe_address("[::]:4000").unwrap(),
            "[::1]:4000".parse().unwrap()
        );
        assert_eq!(
            probe_address("127.0.0.1:4100").unwrap(),
            "127.0.0.1:4100".parse().unwrap()
        );
        assert!(probe_address("not an address").is_err());
    }
}

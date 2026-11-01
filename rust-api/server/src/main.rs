//! The native server process. Everything is in the library (`lib.rs`).

/// Without `native` there is no listener and no command line: the Worker
/// runs the router.
#[cfg(not(feature = "native"))]
fn main() {}

#[cfg(feature = "native")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    counterpoise_rust_api::run(std::env::args().skip(1).collect()).await
}

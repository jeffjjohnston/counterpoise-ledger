/// Logs to stdout, for the HTTP server.
pub(crate) fn init() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
}

/// Logs to stderr, for the stdio MCP server: stdout carries only the protocol.
/// `rmcp` logs each message at info, so it logs warnings only by default.
pub(crate) fn init_stderr() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,rmcp=warn".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
}

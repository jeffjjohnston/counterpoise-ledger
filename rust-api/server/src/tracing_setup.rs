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

/// Logs to the isolate's console, for a Durable Object: Workers keeps what
/// `console.log` prints. No time stamp, which would read the system clock,
/// and the console stamps each line anyway. An object is constructed again
/// after each hibernation, so a second call does nothing.
#[cfg(target_arch = "wasm32")]
pub(crate) fn init_console() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(
                ledger_db::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
            )
            .unwrap_or_else(|_| "info".into()),
        )
        .without_time()
        .with_ansi(false)
        .with_writer(ConsoleLine::default)
        .try_init();
}

/// One log line, printed with `console.log` when it is dropped.
#[cfg(target_arch = "wasm32")]
#[derive(Default)]
pub(crate) struct ConsoleLine(Vec<u8>);

#[cfg(target_arch = "wasm32")]
impl std::io::Write for ConsoleLine {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for ConsoleLine {
    fn drop(&mut self) {
        use wasm_bindgen::{JsCast, JsValue};
        let line = String::from_utf8_lossy(&self.0);
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        let global = js_sys::global();
        let log = js_sys::Reflect::get(&global, &JsValue::from_str("console"))
            .and_then(|console| js_sys::Reflect::get(&console, &JsValue::from_str("log")))
            .ok()
            .and_then(|log| log.dyn_into::<js_sys::Function>().ok());
        if let Some(log) = log {
            let _ = log.call1(&global, &JsValue::from_str(line));
        }
    }
}

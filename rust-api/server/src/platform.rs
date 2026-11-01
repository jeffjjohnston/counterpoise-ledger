//! What the server takes from the runtime under it: the time, background
//! work, blocking work, sleeps, randomness and the client's peer address.
//!
//! Server code calls these, not `Utc::now`, `Instant::now`, `tokio::spawn`,
//! `spawn_blocking`, `tokio::time`, `getrandom` or `ConnectInfo`. The server
//! runs natively on tokio today. The Workers build (wasm32) has no threads,
//! no tokio timer, no system clock and no socket peer, and
//! `std::time::Instant::now()` panics there, so each of these needs a second
//! implementation. This module is the one place that will have it.
//!
//! The functions are free functions rather than methods of a value in
//! `AppState`, because many callers hold no state (the lease renewal, the
//! change hub, the PostHog capture) and none of them needs one: on Workers
//! the clock, the timer and `waitUntil` belong to the isolate, not to a
//! request.
//!
//! Code that only the native server runs keeps its own tokio calls: the
//! listener and signals in `main.rs`, the CIMD DNS pinning, and the native
//! WebSocket route (`routes/socket.rs`).

use axum::extract::Request;
#[cfg(feature = "native")]
use axum::{
    Router,
    extract::{ConnectInfo, connect_info::IntoMakeServiceWithConnectInfo},
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use ledger_db::clock::Tz;
#[cfg(feature = "native")]
use std::net::SocketAddr;
use std::{future::Future, net::IpAddr, time::Duration};

/// A monotonic instant. On Workers it reads `performance.now()`.
pub(crate) use web_time::Instant;

/// Now, in UTC. On wasm32 chrono reads `Date.now()` (its `wasmbind`
/// feature).
pub(crate) fn now() -> DateTime<Utc> {
    Utc::now()
}

/// Now as UTC wall-clock time, the form a timestamp column holds.
pub(crate) fn timestamp() -> NaiveDateTime {
    now().naive_utc()
}

/// Now, in the app's zone (`APP_TZ`, else `TZ`).
pub(crate) fn local_now() -> DateTime<Tz> {
    now().with_timezone(&ledger_db::clock::zone())
}

/// Today's date in the app's zone.
pub(crate) fn today() -> NaiveDate {
    local_now().date_naive()
}

/// The monotonic clock, for intervals: the API key cache.
pub(crate) fn instant() -> Instant {
    Instant::now()
}

/// Fills `bytes` from the system's secure random source.
pub(crate) fn random(bytes: &mut [u8]) -> Result<(), getrandom::Error> {
    getrandom::fill(bytes)
}

/// The name of this process, for a reader of a table that records who did
/// something: its id. An isolate has no process id, so there it is
/// `object`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn process_name() -> String {
    std::process::id().to_string()
}

/// The name of this process: see the native version.
#[cfg(target_arch = "wasm32")]
pub(crate) fn process_name() -> String {
    "object".to_owned()
}

/// Background work that a caller may stop.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) struct Task(tokio::task::JoinHandle<()>);

/// Background work that a caller may stop.
#[cfg(target_arch = "wasm32")]
pub(crate) struct Task(futures_util::future::AbortHandle);

impl Task {
    /// Stops the work at its next await. Dropping a task does not stop it.
    pub(crate) fn abort(&self) {
        self.0.abort();
    }
}

/// Runs `work` in the background, as a tokio task.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn spawn(work: impl Future<Output = ()> + Send + 'static) -> Task {
    Task(tokio::spawn(work))
}

/// Runs `work` in the background, on the isolate's event loop. It runs
/// while the object lives, and does not keep it up: work that must finish
/// goes to [`spawn_to_finish`] or to the alarm.
#[cfg(target_arch = "wasm32")]
pub(crate) fn spawn(work: impl Future<Output = ()> + Send + 'static) -> Task {
    let (work, handle) = futures_util::future::abortable(work);
    wasm_bindgen_futures::spawn_local(async move {
        let _ = work.await;
    });
    Task(handle)
}

/// Runs `work` in the background, and keeps the runtime up until it ends:
/// work that a response has promised, such as the review that a 202 has
/// started. Natively any task runs to its end.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn spawn_to_finish(work: impl Future<Output = ()> + Send + 'static) {
    tokio::spawn(work);
}

/// What keeps the runtime up for a promise.
#[cfg(target_arch = "wasm32")]
type KeepAlive = Box<dyn Fn(js_sys::Promise)>;

#[cfg(target_arch = "wasm32")]
thread_local! {
    /// What [`keep_alive_with`] installed.
    static KEEP_ALIVE: std::cell::RefCell<Option<KeepAlive>> =
        const { std::cell::RefCell::new(None) };
}

/// Installs the hook that keeps the runtime up for a promise: the object
/// passes it to `ctx.waitUntil`, which holds the object until the promise
/// settles, for at most 15 minutes.
#[cfg(target_arch = "wasm32")]
pub(crate) fn keep_alive_with(hook: impl Fn(js_sys::Promise) + 'static) {
    KEEP_ALIVE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

/// See the other [`spawn_to_finish`]. The work runs on the isolate's event
/// loop, and its promise goes to the hook of [`keep_alive_with`].
#[cfg(target_arch = "wasm32")]
pub(crate) fn spawn_to_finish(work: impl Future<Output = ()> + Send + 'static) {
    let promise = wasm_bindgen_futures::future_to_promise(async move {
        work.await;
        Ok(wasm_bindgen::JsValue::UNDEFINED)
    });
    KEEP_ALIVE.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(promise);
        }
    });
}

/// What stores a dump: it takes the name and the text, and its promise
/// settles when the bucket has the object.
#[cfg(target_arch = "wasm32")]
type Export = Box<dyn Fn(String, Vec<u8>) -> js_sys::Promise>;

#[cfg(target_arch = "wasm32")]
thread_local! {
    /// What [`export_with`] installed.
    static EXPORT: std::cell::RefCell<Option<Export>> = const { std::cell::RefCell::new(None) };
}

/// Installs the hook that writes a dump into the object's export bucket.
#[cfg(target_arch = "wasm32")]
pub(crate) fn export_with(hook: impl Fn(String, Vec<u8>) -> js_sys::Promise + 'static) {
    EXPORT.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

/// Writes the dump `text` as `name` into the export bucket of
/// [`export_with`].
#[cfg(target_arch = "wasm32")]
pub(crate) async fn put_export(name: String, text: Vec<u8>) -> Result<(), String> {
    let promise = EXPORT
        .with(|slot| slot.borrow().as_ref().map(|hook| hook(name, text)))
        .ok_or("the object has no export bucket")?;
    send_wrapper::SendWrapper::new(wasm_bindgen_futures::JsFuture::from(promise))
        .await
        .map(drop)
        .map_err(|cause| cause.as_string().unwrap_or_else(|| format!("{cause:?}")))
}

/// See the other [`put_export`]: a host with no bucket.
#[cfg(all(not(target_arch = "wasm32"), not(feature = "native")))]
pub(crate) async fn put_export(_name: String, _text: Vec<u8>) -> Result<(), String> {
    Err("this host has no export bucket".to_owned())
}

/// A blocking step that panicked or was cancelled.
#[derive(Debug)]
pub(crate) struct Stopped(String);

impl std::fmt::Display for Stopped {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Runs `step`, which takes CPU time or waits on the disk (scrypt, a
/// `VACUUM`, the demo seed), without holding up other requests. Natively it
/// runs on a blocking thread.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn blocking<T: Send + 'static>(
    step: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Stopped> {
    tokio::task::spawn_blocking(step)
        .await
        .map_err(|cause| Stopped(cause.to_string()))
}

/// Runs `step` in place: the isolate has no other thread. A panic aborts
/// the module, so there is no [`Stopped`] here.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn blocking<T: Send + 'static>(
    step: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Stopped> {
    Ok(step())
}

/// Waits for `duration`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

/// Waits for `duration`, on the isolate's `setTimeout`.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn sleep(duration: Duration) {
    use wasm_bindgen::{JsCast, JsValue};
    let millis = duration.as_millis().min(i32::MAX as u128) as f64;
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        let set_timeout = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .ok()
            .and_then(|function| function.dyn_into::<js_sys::Function>().ok());
        match set_timeout {
            Some(set_timeout) => {
                let _ = set_timeout.call2(&global, &resolve, &JsValue::from_f64(millis));
            }
            None => {
                let _ = resolve.call0(&JsValue::NULL);
            }
        }
    });
    send_wrapper::SendWrapper::new(wasm_bindgen_futures::JsFuture::from(promise))
        .await
        .ok();
}

/// `work`, or `None` when it takes longer than `limit`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn timeout<T>(limit: Duration, work: impl Future<Output = T>) -> Option<T> {
    tokio::time::timeout(limit, work).await.ok()
}

/// `work`, or `None` when it takes longer than `limit`.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn timeout<T>(limit: Duration, work: impl Future<Output = T>) -> Option<T> {
    use futures_util::future::{Either, select};
    let work = std::pin::pin!(work);
    let limit = std::pin::pin!(sleep(limit));
    match select(work, limit).await {
        Either::Left((value, _)) => Some(value),
        Either::Right(_) => None,
    }
}

/// A client for outbound HTTP. It sets no timeout: each request sets its own
/// with `.timeout()`, because on Workers reqwest calls `fetch`, where a
/// client-level timeout does not apply.
pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .build()
        .expect("the HTTP client builds")
}

/// The answer to [`post_without_redirects`]: the status and the body.
pub(crate) struct Answer {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
}

/// POSTs `body` to `url` with `headers`, and never follows a redirect: a
/// caller that sends a key gets the 3xx itself. The error is a failure to
/// reach the server or to read its answer.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn post_without_redirects(
    url: &str,
    headers: &[(&str, &str)],
    body: String,
) -> Result<Answer, ()> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client builds")
    });
    let mut request = client.post(url).body(body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|_| ())?;
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(|_| ())?.to_vec();
    Ok(Answer { status, body })
}

/// POSTs `body` to `url` with `headers`, and never follows a redirect: see
/// the native version. reqwest's `fetch` cannot set `redirect`, so this
/// calls `fetch` itself with `redirect: "manual"`.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn post_without_redirects(
    url: &str,
    headers: &[(&str, &str)],
    body: String,
) -> Result<Answer, ()> {
    use wasm_bindgen::JsValue;
    let exchange = async {
        let response = fetch_without_redirects("POST", url, headers, Some(&body), None).await?;
        let status = js_number(&response, "status")? as u16;
        let buffer = js_call(&response, "arrayBuffer").await?;
        Ok::<_, JsValue>(Answer {
            status,
            body: js_sys::Uint8Array::new(&buffer).to_vec(),
        })
    };
    send_wrapper::SendWrapper::new(exchange)
        .await
        .map_err(|_| ())
}

/// Why [`get_without_redirects`] has no answer.
#[cfg(target_arch = "wasm32")]
pub(crate) enum GetFailure {
    /// The server could not be reached, or the deadline passed.
    Failed,
    /// The body is longer than the limit.
    TooLarge,
}

/// GETs `url` with `headers`, never follows a redirect, and gives up after
/// `timeout`, the body's read included. Only a 200's body is read, as a
/// stream that stops once it passes `max_bytes`: a large answer is never
/// held whole. Any other status comes back with an empty body.
#[cfg(target_arch = "wasm32")]
pub(crate) async fn get_without_redirects(
    url: &str,
    headers: &[(&str, &str)],
    timeout: std::time::Duration,
    max_bytes: usize,
) -> Result<Answer, GetFailure> {
    use wasm_bindgen::{JsCast, JsValue};
    let exchange = async {
        let response = fetch_without_redirects("GET", url, headers, None, Some(timeout))
            .await
            .map_err(|_| GetFailure::Failed)?;
        let status = js_number(&response, "status").map_err(|_| GetFailure::Failed)? as u16;
        let stream = js_sys::Reflect::get(&response, &JsValue::from_str("body"))
            .map_err(|_| GetFailure::Failed)?;
        if status != 200 {
            if !stream.is_null() && !stream.is_undefined() {
                let _ = js_call(&stream.unchecked_into(), "cancel").await;
            }
            return Ok(Answer {
                status,
                body: Vec::new(),
            });
        }
        let mut body = Vec::new();
        if stream.is_null() || stream.is_undefined() {
            return Ok(Answer { status, body });
        }
        let reader: js_sys::Object = js_call_value(&stream.unchecked_into(), "getReader")
            .map_err(|_| GetFailure::Failed)?
            .unchecked_into();
        loop {
            let chunk: js_sys::Object = js_call(&reader, "read")
                .await
                .map_err(|_| GetFailure::Failed)?
                .unchecked_into();
            let done = js_sys::Reflect::get(&chunk, &JsValue::from_str("done"))
                .map_err(|_| GetFailure::Failed)?;
            if done.is_truthy() {
                return Ok(Answer { status, body });
            }
            let value = js_sys::Reflect::get(&chunk, &JsValue::from_str("value"))
                .map_err(|_| GetFailure::Failed)?;
            let bytes = js_sys::Uint8Array::new(&value);
            if body.len() + bytes.length() as usize > max_bytes {
                let _ = js_call(&reader, "cancel").await;
                return Err(GetFailure::TooLarge);
            }
            body.extend(bytes.to_vec());
        }
    };
    send_wrapper::SendWrapper::new(exchange).await
}

/// Starts one `fetch` with `redirect: "manual"`, so a redirect comes back
/// as its own answer, never followed. `timeout` aborts the request and the
/// read of its body.
#[cfg(target_arch = "wasm32")]
async fn fetch_without_redirects(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
    timeout: Option<std::time::Duration>,
) -> Result<js_sys::Object, wasm_bindgen::JsValue> {
    use wasm_bindgen::{JsCast, JsValue};
    let set = |target: &js_sys::Object, name: &str, value: &JsValue| {
        js_sys::Reflect::set(target, &JsValue::from_str(name), value).map(|_| ())
    };
    let fields = js_sys::Object::new();
    for (name, value) in headers {
        set(&fields, name, &JsValue::from_str(value))?;
    }
    let init = js_sys::Object::new();
    set(&init, "method", &JsValue::from_str(method))?;
    set(&init, "headers", &fields)?;
    if let Some(body) = body {
        set(&init, "body", &JsValue::from_str(body))?;
    }
    set(&init, "redirect", &JsValue::from_str("manual"))?;
    let global = js_sys::global();
    if let Some(timeout) = timeout {
        let signals: js_sys::Object =
            js_sys::Reflect::get(&global, &JsValue::from_str("AbortSignal"))?.dyn_into()?;
        let make: js_sys::Function =
            js_sys::Reflect::get(&signals, &JsValue::from_str("timeout"))?.dyn_into()?;
        let signal = make.call1(&signals, &JsValue::from_f64(timeout.as_millis() as f64))?;
        set(&init, "signal", &signal)?;
    }
    let fetch: js_sys::Function =
        js_sys::Reflect::get(&global, &JsValue::from_str("fetch"))?.dyn_into()?;
    let promise: js_sys::Promise = fetch
        .call2(&global, &JsValue::from_str(url), &init)?
        .dyn_into()?;
    wasm_bindgen_futures::JsFuture::from(promise)
        .await?
        .dyn_into()
}

/// The number `target[name]`.
#[cfg(target_arch = "wasm32")]
fn js_number(target: &js_sys::Object, name: &str) -> Result<f64, wasm_bindgen::JsValue> {
    Ok(
        js_sys::Reflect::get(target, &wasm_bindgen::JsValue::from_str(name))?
            .as_f64()
            .unwrap_or(0.0),
    )
}

/// Calls the method `name` of `target` with no arguments.
#[cfg(target_arch = "wasm32")]
fn js_call_value(
    target: &js_sys::Object,
    name: &str,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast;
    let method: js_sys::Function =
        js_sys::Reflect::get(target, &wasm_bindgen::JsValue::from_str(name))?.dyn_into()?;
    method.call0(target)
}

/// Calls the method `name` of `target` with no arguments, and awaits the
/// promise it returns.
#[cfg(target_arch = "wasm32")]
async fn js_call(
    target: &js_sys::Object,
    name: &str,
) -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast;
    let promise: js_sys::Promise = js_call_value(target, name)?.dyn_into()?;
    wasm_bindgen_futures::JsFuture::from(promise).await
}

/// Runs `work`, an outbound HTTP exchange, as a `Send` future. On wasm32 a
/// `fetch` future and its response are not `Send`, and the server's
/// handlers must be; the isolate has one thread, so a wrapper that asserts
/// it is enough. Wrap the exchange up to the data it returns, so that no
/// response is held across an await outside it.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn outbound<F: Future + Send>(work: F) -> impl Future<Output = F::Output> + Send {
    work
}

/// Runs `work`, an outbound HTTP exchange, as a `Send` future: see the
/// native version.
#[cfg(target_arch = "wasm32")]
pub(crate) fn outbound<F: Future>(work: F) -> impl Future<Output = F::Output> + Send {
    send_wrapper::SendWrapper::new(work)
}

/// The address of the TCP peer of `request`, which [`with_peer`] records.
/// Workers has no socket: there the client address comes from
/// `CF-Connecting-IP`.
#[cfg(feature = "native")]
pub(crate) fn peer(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(address)| address.ip())
}

/// The client's address, from the `CF-Connecting-IP` header that Cloudflare
/// sets and the Worker passes on. The object is reachable only through the
/// Worker, so no client sets it.
#[cfg(not(feature = "native"))]
pub(crate) fn peer(request: &Request) -> Option<IpAddr> {
    request
        .headers()
        .get("cf-connecting-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

/// The listener's service: a router that records each request's peer.
#[cfg(feature = "native")]
pub(crate) type PeerService = IntoMakeServiceWithConnectInfo<Router, SocketAddr>;

/// `app` as the listener's service, with the peer address in each request.
#[cfg(feature = "native")]
pub(crate) fn with_peer(app: Router) -> PeerService {
    app.into_make_service_with_connect_info::<SocketAddr>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_is_the_date_in_the_app_zone() {
        assert_eq!(today(), ledger_db::clock::today());
        assert_eq!(
            local_now().timezone(),
            ledger_db::clock::zone(),
            "local_now is in the app's zone"
        );
    }

    #[test]
    fn the_monotonic_clock_moves_forward() {
        let start = instant();
        assert!(instant() >= start);
    }

    #[tokio::test]
    async fn a_blocking_step_returns_its_value_or_reports_a_panic() {
        assert_eq!(blocking(|| 7).await.unwrap(), 7);
        let stopped = blocking(|| -> () { panic!("boom") }).await.unwrap_err();
        assert!(stopped.to_string().contains("panic"), "{stopped}");
    }

    #[tokio::test]
    async fn an_aborted_task_does_not_run() {
        let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
        let task = spawn(async move {
            sleep(Duration::from_secs(60)).await;
            let _ = sender.send(());
        });
        task.abort();
        assert!(receiver.await.is_err(), "the task dropped its sender");
    }

    /// Holds the line this module draws: outside it, and outside the
    /// native-only files, server code reaches the runtime only through it.
    /// Test modules may use tokio as they like.
    #[test]
    fn server_code_reaches_the_runtime_only_through_this_module() {
        const FORBIDDEN: [&str; 11] = [
            "Utc::now(",
            "SystemTime::now(",
            "Instant::now(",
            "tokio::spawn(",
            "spawn_blocking(",
            "tokio::time::",
            "getrandom::fill(",
            "ConnectInfo<",
            "clock::today(",
            "Client::builder(",
            "process::id(",
        ];
        // Native-only: the listener and signals, the CIMD DNS pinning, the
        // native WebSocket route (a Durable Object serves its own sockets),
        // and the files that are tests.
        const NATIVE: [&str; 6] = [
            "platform.rs",
            "main.rs",
            "oauth/cimd.rs",
            "routes/socket.rs",
            "http_contract_tests.rs",
            "issue_sync/fake_github.rs",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = vec![root.clone()];
        let mut found = Vec::new();
        while let Some(path) = files.pop() {
            if path.is_dir() {
                files.extend(std::fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            let name = path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !name.ends_with(".rs") || NATIVE.contains(&name.as_str()) {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let code = text.split("#[cfg(test)]\nmod tests").next().unwrap();
            for (number, line) in code.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                for pattern in FORBIDDEN {
                    if line.contains(pattern) {
                        found.push(format!("{name}:{}: {pattern}", number + 1));
                    }
                }
            }
        }
        assert!(found.is_empty(), "use crate::platform instead: {found:#?}");
    }

    /// Serves one HTTPS answer on 127.0.0.1 with a self-signed certificate
    /// for `localhost`, and returns the port and the certificate.
    #[cfg(feature = "native")]
    async fn untrusted_https_server() -> (u16, reqwest::Certificate) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let signed = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let pem = signed.cert.pem();
        let config = rustls::ServerConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![signed.cert.der().clone()],
            rustls::pki_types::PrivateKeyDer::Pkcs8(signed.signing_key.serialize_der().into()),
        )
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut tls) = acceptor.accept(socket).await else {
                        return;
                    };
                    let mut request = [0u8; 4096];
                    let _ = tls.read(&mut request).await;
                    let _ = tls
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .await;
                    let _ = tls.shutdown().await;
                });
            }
        });
        (
            port,
            reqwest::Certificate::from_pem(pem.as_bytes()).unwrap(),
        )
    }

    /// The outbound clients keep certificate validation: each refuses a
    /// server whose certificate no trusted root signed. The same server
    /// answers a client that trusts its certificate, so the refusal is the
    /// certificate and not the connection.
    #[cfg(feature = "native")]
    #[tokio::test]
    async fn outbound_https_refuses_a_certificate_it_does_not_trust() {
        let (port, certificate) = untrusted_https_server().await;
        let url = format!("https://localhost:{port}/");

        let refused = http_client().get(&url).send().await.unwrap_err();
        assert!(refused.is_connect(), "{refused:?}");
        assert!(
            post_without_redirects(&url, &[], String::new())
                .await
                .is_err(),
            "post_without_redirects refuses the certificate"
        );

        let trusting = reqwest::Client::builder()
            .add_root_certificate(certificate)
            .build()
            .unwrap();
        let answer = trusting.get(&url).send().await.unwrap();
        assert_eq!(answer.status(), 200);
        assert_eq!(answer.text().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn timeout_gives_none_after_the_limit() {
        assert_eq!(timeout(Duration::from_secs(1), async { 3 }).await, Some(3));
        let slow = sleep(Duration::from_secs(60));
        assert_eq!(timeout(Duration::from_millis(10), slow).await, None);
    }
}

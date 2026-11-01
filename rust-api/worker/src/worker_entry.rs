//! The Worker's fetch handler.

use crate::{Route, route, security_headers};
use counterpoise_rust_api::{
    hosted::{self, restore},
    security::{PageGate, page_gate},
};
use js_sys::{Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{
    Context, Env, Headers, Method, Request, RequestInit, RequestRedirect, Response, Result, event,
};

/// The name of the one Durable Object that holds the database.
const OBJECT_NAME: &str = "ledger";

/// The header of `/health` that names the deployed commit, from the
/// variable `BUILD_COMMIT` that a deploy sets. The deploy's probe reads it,
/// so it can tell the new version from the one before it.
const BUILD_HEADER: &str = "x-build-commit";

#[event(fetch)]
async fn fetch(request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let hsts = env
        .var("ENABLE_HSTS")
        .is_ok_and(|value| value.to_string() == "true");
    match route(&request.path()) {
        Route::Object => {
            let health = request.path() == "/health";
            let restore = (request.method() == Method::Post && request.path() == restore::PATH)
                .then(request_id);
            let response = match forward(request, &env, restore.as_deref()).await {
                Ok(response) => response,
                // The object resets once it has scheduled a restore, which
                // fails the request that asked for it.
                Err(cause) => match &restore {
                    Some(id) => match restore_outcome(&env, id).await? {
                        Some(outcome) => worker::response_to_wasm(outcome)?.into(),
                        None => return Err(cause),
                    },
                    None => return Err(cause),
                },
            };
            let mut response = with_security_headers(response, hsts)?;
            if health && let Ok(build) = env.var("BUILD_COMMIT") {
                response
                    .headers_mut()
                    .set(BUILD_HEADER, &build.to_string())?;
            }
            Ok(response)
        }
        Route::Page => {
            let response = match page_gate(&request.path(), &cookie_headers(&request)?) {
                PageGate::Serve => {
                    let file = env.assets("ASSETS")?.fetch_request(request).await?;
                    worker::response_to_wasm(file)?.into()
                }
                PageGate::Login => login_redirect()?,
            };
            with_security_headers(response, hsts)
        }
    }
}

/// Sends `request` to the object, with the client's address in
/// `CF-Connecting-IP`. An incoming request's headers cannot change, so this
/// builds a new request with the same method, headers and body.
///
/// The body goes as one buffer, read in full first. Passed as the client's
/// stream, it is piped to the object while the object answers; a route that
/// answers without reading it (a refused token, say) left the pipe reading
/// the client's stream after the response, which workerd reports as an
/// uncaught error and at times answers with a 500. The buffer is a runtime
/// `Uint8Array`, the only copy: read into Rust, a 64 MiB dump would be held
/// twice and grow the WebAssembly memory, which never shrinks, against the
/// isolate's 128 MB.
///
/// The read is bounded ([`read_body`]): this read comes before the object
/// checks a credential, so the bound is the route's own limit
/// (`hosted::body_limit`), and a larger body is refused here with 413 before
/// it is held.
///
/// `restore` names a restore request (`restore::REQUEST_HEADER`); a copy of
/// that header from the client never reaches the object.
async fn forward(request: Request, env: &Env, restore: Option<&str>) -> Result<Response> {
    let headers = Headers::new();
    for (name, value) in request.headers().entries() {
        headers.set(&name, &value)?;
    }
    headers.delete(restore::REQUEST_HEADER)?;
    if let Some(id) = restore {
        headers.set(restore::REQUEST_HEADER, id)?;
    }
    // Cloudflare sets it on each request that reaches the Worker. Under
    // `wrangler dev` it can be missing.
    if !headers.has("CF-Connecting-IP")? {
        headers.set("CF-Connecting-IP", "127.0.0.1")?;
    }
    let path = request.path();
    let import = path == hosted::IMPORT_PATH
        && hosted::import_authorized(
            &authorization_headers(&request)?,
            env.secret("IMPORT_SECRET")
                .ok()
                .map(|secret| secret.to_string())
                .as_deref(),
        );
    let limit = hosted::body_limit(&path, import);
    // The import's limit is too large to collect in pieces and then join:
    // that holds the body twice. Its length must be known up front.
    let body = match read_body(&request, limit, import).await? {
        Ok(body) => body,
        Err(refusal) => return refusal.response(limit),
    };
    let mut init = RequestInit::new();
    // A new request follows redirects by default: the browser must get the
    // object's 3xx itself.
    init.with_method(request.method())
        .with_redirect(RequestRedirect::Manual)
        .with_headers(headers)
        .with_body(body);
    let forwarded = Request::new_with_init(request.url()?.as_str(), &init)?;
    let stub = env.durable_object("LEDGER")?.get_by_name(OBJECT_NAME)?;
    stub.fetch_with_request(forwarded).await
}

/// Why [`read_body`] refused a body.
enum Refusal {
    /// It is longer than the route's limit.
    TooLarge,
    /// It has no `Content-Length`, which the route needs.
    LengthRequired,
    /// It is not the length that it declared, or the client stopped
    /// sending it.
    Unreadable,
}

impl Refusal {
    fn response(self, limit: usize) -> Result<Response> {
        let (status, message) = match self {
            Refusal::TooLarge => (
                413,
                format!("Payload Too Large: request body exceeds {limit} bytes"),
            ),
            Refusal::LengthRequired => (411, "Content-Length is required".to_string()),
            Refusal::Unreadable => (400, "The request body could not be read".to_string()),
        };
        Ok(Response::from_json(&serde_json::json!({ "error": message }))?.with_status(status))
    }
}

/// The request's body as one `Uint8Array`, read up to `limit` bytes.
///
/// A `Content-Length` past the limit is refused before a byte is read. A
/// declared length is read into a buffer of that length, the only copy. A
/// body without one (chunked) is read in pieces, joined at the end, and
/// refused once the pieces pass the limit; `need_length` refuses such a body
/// outright.
///
/// A refusal before the read leaves the body unread, and the runtime drops
/// it with the request. A refusal during the read reads the rest and drops
/// each piece, so that it holds no more than one piece: a reader left
/// half-way failed the next request in `wrangler dev` ("Network connection
/// lost"). Neither cancels the stream, which fails the request itself while
/// the runtime is still delivering the body (500). Cloudflare's edge bounds
/// what is left to read: it refuses a body past the plan's limit (100 MB).
async fn read_body(
    request: &Request,
    limit: usize,
    need_length: bool,
) -> Result<std::result::Result<Option<JsValue>, Refusal>> {
    let Some(stream) = request.inner().body() else {
        return Ok(Ok(None));
    };
    let declared = request
        .headers()
        .get("content-length")?
        .and_then(|length| length.trim().parse::<usize>().ok());
    let refusal = match declared {
        Some(length) if length > limit => Some(Refusal::TooLarge),
        None if need_length => Some(Refusal::LengthRequired),
        _ => None,
    };
    if let Some(refusal) = refusal {
        return Ok(Err(refusal));
    }
    let reader: JsValue = call(&stream, "getReader")?;
    let mut buffer = declared.map(|length| Uint8Array::new_with_length(length as u32));
    let mut pieces = Vec::new();
    let mut read = 0usize;
    loop {
        let Ok(step) = JsFuture::from(Promise::from(call(&reader, "read")?)).await else {
            return Ok(Err(Refusal::Unreadable));
        };
        if Reflect::get(&step, &"done".into())?.is_truthy() {
            break;
        }
        let piece = Uint8Array::from(Reflect::get(&step, &"value".into())?);
        let size = piece.length() as usize;
        let refusal = match declared {
            Some(length) if size > length - read => Some(Refusal::Unreadable),
            None if size > limit - read => Some(Refusal::TooLarge),
            _ => None,
        };
        if let Some(refusal) = refusal {
            discard(&reader).await?;
            return Ok(Err(refusal));
        }
        match &buffer {
            Some(buffer) => buffer.set(&piece, read as u32),
            None => pieces.push(piece),
        }
        read += size;
    }
    if let Some(length) = declared
        && read != length
    {
        return Ok(Err(Refusal::Unreadable));
    }
    let body = buffer.take().unwrap_or_else(|| {
        let joined = Uint8Array::new_with_length(read as u32);
        let mut at = 0;
        for piece in &pieces {
            joined.set(piece, at);
            at += piece.length();
        }
        joined
    });
    Ok(Ok(Some(body.into())))
}

/// Reads the rest of a body and drops it. A client that stops sending ends
/// the read.
async fn discard(reader: &JsValue) -> Result<()> {
    loop {
        let Ok(step) = JsFuture::from(Promise::from(call(reader, "read")?)).await else {
            return Ok(());
        };
        if Reflect::get(&step, &"done".into())?.is_truthy() {
            return Ok(());
        }
    }
}

/// Calls the method `name` of `target` with no arguments.
fn call(target: &JsValue, name: &str) -> Result<JsValue> {
    let method: Function = Reflect::get(target, &name.into())?.dyn_into()?;
    Ok(method.call0(target)?)
}

/// The request's `Authorization`, as `hosted::import_authorized` reads it.
fn authorization_headers(request: &Request) -> Result<http::HeaderMap> {
    let mut headers = http::HeaderMap::new();
    if let Some(value) = request.headers().get("authorization")?
        && let Ok(value) = http::HeaderValue::from_str(&value)
    {
        headers.insert(http::header::AUTHORIZATION, value);
    }
    Ok(headers)
}

/// A name for a restore request that no other request shares.
fn request_id() -> String {
    let random = (js_sys::Math::random() * 2f64.powi(53)) as u64;
    format!("{:x}-{random:x}", js_sys::Date::now() as u64)
}

/// The answer to restore request `id` whose object failed it
/// (`restore::outcome`), read from the export bucket.
async fn restore_outcome(env: &Env, id: &str) -> Result<Option<restore::Response>> {
    let bucket = env.bucket("EXPORTS")?;
    let record = read_text(&bucket, restore::LAST).await?;
    let marker = read_text(&bucket, restore::MARKER).await?;
    Ok(restore::outcome(id, record.as_deref(), marker.as_deref()))
}

/// The text of `key` in `bucket`, if it is there.
async fn read_text(bucket: &worker::Bucket, key: &str) -> Result<Option<String>> {
    match bucket.get(key).execute().await? {
        Some(object) => match object.body() {
            Some(body) => Ok(Some(body.text().await?)),
            None => Ok(None),
        },
        None => Ok(None),
    }
}

/// The request's cookies, as the gate reads them.
fn cookie_headers(request: &Request) -> Result<http::HeaderMap> {
    let mut headers = http::HeaderMap::new();
    if let Some(cookie) = request.headers().get("cookie")?
        && let Ok(value) = http::HeaderValue::from_str(&cookie)
    {
        headers.insert(http::header::COOKIE, value);
    }
    Ok(headers)
}

/// `security::login_redirect`, as a Worker response: a 307 with a relative
/// `Location`.
fn login_redirect() -> Result<Response> {
    let headers = Headers::new();
    headers.set("location", "/login")?;
    Ok(Response::empty()?.with_status(307).with_headers(headers))
}

/// The response with the security headers. A fetched response's headers
/// cannot change, so this copies them into new ones.
fn with_security_headers(response: Response, hsts: bool) -> Result<Response> {
    // A socket's 101 goes back as the object made it: the headers of a page
    // mean nothing to it.
    if response.status_code() == 101 {
        return Ok(response);
    }
    let headers = Headers::new();
    for (name, value) in response.headers().entries() {
        headers.append(&name, &value)?;
    }
    for (name, value) in security_headers(hsts) {
        headers.set(name, value)?;
    }
    Ok(response.with_headers(headers))
}

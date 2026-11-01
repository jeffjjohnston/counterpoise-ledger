//! `LedgerObject`, the Durable Object that holds the database and serves
//! the router.

use crate::storage::{
    ObjectContext, ObjectDatabase, ObjectStorage, object_context, object_storage, reset,
};
use counterpoise_rust_api::hosted::{self, restore};
use http::StatusCode;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
use tower_service::Service;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{
    Bucket, DurableObject, Env, HttpRequest, Method, Request, Response, Result, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair, durable_object,
};

#[durable_object]
pub struct LedgerObject {
    state: State,
    /// The server, or why the start failed. A failed start is tried again
    /// on the next event.
    app: RefCell<std::result::Result<hosted::App, String>>,
    /// Whether this instance has set the alarm from the job tables. Each
    /// instance does it once, at its first request, so that an alarm lost
    /// with an old deployment, or a job asked for at the start, still runs.
    alarm_set: Cell<bool>,
    /// The export bucket, which holds the marker of a restore.
    exports: Option<Bucket>,
    /// Whether this instance has looked for the marker of a restore. It does
    /// that once, before its first event is served.
    restore_checked: Rc<Cell<bool>>,
    /// Whether this instance has made sure that the folds were repaired for
    /// this build ([`LedgerObject::finish_folds`]).
    folds_checked: Rc<Cell<bool>>,
}

/// The key, in the object's storage, of the build that last repaired the
/// folds.
const FOLDS_KEY: &str = "folds-repaired-for";

impl DurableObject for LedgerObject {
    fn new(state: State, env: Env) -> Self {
        reset_on_panic(object_context(&state));
        ledger_db::env::set(settings(&env));
        keep_alive(&state);
        export_to(&env);
        let exports = env.bucket("EXPORTS").ok();
        // The start has no await, so no other event reaches the object
        // while it runs: it needs no `blockConcurrencyWhile`.
        let app = start(&state);
        Self {
            state,
            app: RefCell::new(app),
            alarm_set: Cell::new(false),
            exports,
            restore_checked: Rc::new(Cell::new(false)),
            folds_checked: Rc::new(Cell::new(false)),
        }
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        // The restore needs no server, so that it can take back a database
        // that the server fails to start on.
        if request.path() == restore::PATH {
            match request.method() {
                Method::Post => return self.restore(request).await,
                Method::Get => return self.last_restore(&request).await,
                _ => {}
            }
        }
        let app = match self.app() {
            Ok(app) => app,
            Err(message) => {
                return unavailable(format!("The server could not start: {message}"));
            }
        };
        self.finish_restore(&app).await?;
        self.finish_folds(&app).await?;
        if !self.alarm_set.get() {
            // Marked only once it is set, so that a storage error leaves the
            // next request to try again.
            self.set_alarm_by(app.next_wake()).await?;
            self.alarm_set.set(true);
        }
        let request: HttpRequest = request.try_into()?;
        let sockets = self.sockets();
        app.watch_books(&books(&sockets));
        let import = request.uri().path() == hosted::IMPORT_PATH;
        let response = if let Some(book) = socket_book(&request) {
            self.open_socket(&app, &request, &book).await?
        } else {
            let response = match app.router().call(request).await {
                Ok(response) => response,
                Err(never) => match never {},
            };
            // The imported job tables replace those that set the alarm
            // above, and can hold work that is due now. The import has
            // committed, so a storage error here leaves the next request to
            // set the alarm rather than fail this one.
            if import
                && response.status().is_success()
                && let Err(cause) = self.set_alarm_by(app.next_wake()).await
            {
                worker::console_error!("The alarm was not set after the import: {cause}");
                self.alarm_set.set(false);
            }
            worker::response_to_wasm(response)?.into()
        };
        self.update_sockets(&app, false).await;
        Ok(response)
    }

    /// Runs one step of a due job, then sets the next alarm. An alarm that
    /// returns an error is retried by the runtime with a backoff, so a
    /// failed start sets the next alarm itself, a minute later.
    async fn alarm(&self) -> Result<Response> {
        let next = match self.app() {
            Ok(app) => {
                self.finish_restore(&app).await?;
                self.finish_folds(&app).await?;
                app.watch_books(&books(&self.sockets()));
                let next = app.alarm().await;
                // The alarm also checks every credential, so that an
                // expired session loses its socket without a timer.
                self.update_sockets(&app, true).await;
                next
            }
            Err(message) => {
                worker::console_error!("The alarm found no server: {message}");
                chrono::Utc::now() + chrono::TimeDelta::minutes(1)
            }
        };
        self.alarm_set.set(true);
        self.state.storage().set_alarm(next).await?;
        Response::empty()
    }

    /// A client sends nothing that the server reads.
    async fn websocket_message(&self, _: WebSocket, _: WebSocketIncomingMessage) -> Result<()> {
        Ok(())
    }

    /// Answers the client's close, so that the client sees a clean end.
    async fn websocket_close(
        &self,
        ws: WebSocket,
        code: usize,
        reason: String,
        _: bool,
    ) -> Result<()> {
        // The codes that mean no close frame came cannot be sent.
        let code = match u16::try_from(code) {
            Ok(1005 | 1006 | 1015) | Err(_) => 1000,
            Ok(code) => code,
        };
        let _ = ws.close(Some(code), Some(reason));
        Ok(())
    }

    async fn websocket_error(&self, _: WebSocket, error: worker::Error) -> Result<()> {
        worker::console_warn!("A book socket failed: {error}");
        Ok(())
    }
}

impl LedgerObject {
    /// The server, started again when its last start failed.
    fn app(&self) -> std::result::Result<hosted::App, String> {
        let started = self.app.borrow().is_ok();
        if !started {
            let app = start(&self.state);
            *self.app.borrow_mut() = app;
        }
        self.app.borrow().clone()
    }

    /// Finishes a restore that the export bucket shows, before any other
    /// event (`hosted::App::after_restore`), and then removes the marker.
    /// Each instance looks once. A step that fails resets the object, so
    /// that nothing is served before the floor marker is in: the next event
    /// constructs the object and looks again.
    async fn finish_restore(&self, app: &hosted::App) -> Result<()> {
        if self.restore_checked.get() {
            return Ok(());
        }
        let Some(bucket) = self.exports.clone() else {
            self.restore_checked.set(true);
            return Ok(());
        };
        let app = app.clone();
        let checked = self.restore_checked.clone();
        self.state
            .block_concurrency_while(async move {
                if checked.get() {
                    return Ok(());
                }
                // The HEAD goes out inside the callback. The callback holds
                // back every event that it did not start itself, and that
                // includes the answer to a HEAD sent before it: the callback
                // then waits for that answer until the runtime resets the
                // object, at each start.
                if bucket.head(restore::MARKER).await?.is_some() {
                    app.after_restore().map_err(worker::Error::RustError)?;
                    bucket.delete(restore::MARKER).await?;
                    worker::console_warn!("A restore finished: the change log has a floor marker");
                }
                checked.set(true);
                Ok(())
            })
            .await
    }

    /// Repairs the folds once for each build, before the first event of the
    /// build is served (`hosted::App::repair_folds`). The object's storage
    /// keeps the build that last repaired them; a restore takes that value
    /// back together with the rows that it was true of. Without
    /// `BUILD_COMMIT`, as in a local run, each instance repairs them.
    async fn finish_folds(&self, app: &hosted::App) -> Result<()> {
        if self.folds_checked.get() {
            return Ok(());
        }
        let build = ledger_db::env::var("BUILD_COMMIT")
            .ok()
            .filter(|build| !build.is_empty());
        let app = app.clone();
        let checked = self.folds_checked.clone();
        let storage = self.state.storage();
        self.state
            .block_concurrency_while(async move {
                if checked.get() {
                    return Ok(());
                }
                let repaired_for = match &build {
                    Some(_) => storage.get::<String>(FOLDS_KEY).await?,
                    None => None,
                };
                if build.is_none() || repaired_for != build {
                    app.repair_folds().map_err(worker::Error::RustError)?;
                    if let Some(build) = &build {
                        storage.put(FOLDS_KEY, build).await?;
                    }
                }
                checked.set(true);
                Ok(())
            })
            .await
    }

    /// `POST /api/admin/restore` (`hosted::restore`): schedules the restore,
    /// records its bookmarks in the export bucket, and resets the object, so
    /// that the next event starts on the restored database. The reset fails
    /// this request too; the Worker answers it (`worker_entry`), and
    /// [`Self::last_restore`] gives the bookmarks.
    async fn restore(&self, mut request: Request) -> Result<Response> {
        let headers: http::HeaderMap = request.headers().into();
        if let Err(refusal) = restore::authorize(&headers) {
            return wasm_response(*refusal);
        }
        let body = request.bytes().await?;
        let target = match restore::target(&body, chrono::Utc::now()) {
            Ok(target) => target,
            Err(refusal) => return wasm_response(*refusal),
        };
        let Some(bucket) = self.exports.clone() else {
            return wasm_response(*restore::refusal(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The export bucket is not bound, so a restore cannot be marked".to_owned(),
            ));
        };
        let id = headers
            .get(restore::REQUEST_HEADER)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let storage = object_storage(&self.state);
        let context = object_context(&self.state).clone();
        // No other event runs from the marker to the reset: one that did
        // could find the marker, add the floor to the database before the
        // restore, and remove the marker that the restored start needs.
        let refused = self
            .state
            .block_concurrency_while(async move {
                let (bookmark, undo) = match schedule_restore(&storage, &bucket, &id, target).await
                {
                    Ok(bookmarks) => bookmarks,
                    Err(refusal) => return Ok(Some(refusal)),
                };
                worker::console_warn!("A restore to {bookmark} was scheduled; its undo is {undo}");
                let record = restore::record(&id, &bookmark, &undo, chrono::Utc::now());
                if let Err(cause) = bucket.put(restore::LAST, record).execute().await {
                    worker::console_error!(
                        "The bookmarks of the restore were not recorded: {cause}. Bookmark \
                         {bookmark}, undo {undo}"
                    );
                }
                // As Cloudflare's recovery does it: the storage restores at
                // the next start, and the reset starts it now. A storage
                // that waits for its restore serves nothing in the meantime.
                // The wait holds other events until the reset fails this
                // one; it ends only if the reset never came.
                reset(&context, "A restore was scheduled");
                worker::Delay::from(std::time::Duration::from_secs(10)).await;
                Ok(None)
            })
            .await?;
        wasm_response(*refused.unwrap_or_else(|| {
            restore::refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "The restore was scheduled, and the object did not reset".to_owned(),
            )
        }))
    }

    /// `GET /api/admin/restore`: the bookmarks of the last restore.
    async fn last_restore(&self, request: &Request) -> Result<Response> {
        let headers: http::HeaderMap = request.headers().into();
        if let Err(refusal) = restore::authorize(&headers) {
            return wasm_response(*refusal);
        }
        let recorded = match &self.exports {
            Some(bucket) => match bucket.get(restore::LAST).execute().await? {
                Some(object) => match object.body() {
                    Some(body) => Some(body.text().await?),
                    None => None,
                },
                None => None,
            },
            None => None,
        };
        wasm_response(restore::recorded(recorded.as_deref()))
    }

    /// Accepts the socket of `book` with hibernation (`hosted::App::admit_socket`
    /// decides), or returns the refusal.
    async fn open_socket(
        &self,
        app: &hosted::App,
        request: &HttpRequest,
        book: &str,
    ) -> Result<Response> {
        let socket = match app
            .admit_socket(request.uri(), request.headers(), book)
            .await
        {
            Ok(socket) => socket,
            Err(refusal) => return Ok(worker::response_to_wasm(*refusal)?.into()),
        };
        let WebSocketPair { client, server } = WebSocketPair::new()?;
        self.state
            .accept_websocket_with_tags(&server, &[&hosted::book_tag(socket.book_id())]);
        server.serialize_attachment(&socket)?;
        server.send_with_str(hosted::READY)?;
        Response::from_websocket(client)
    }

    /// The open sockets, with what each keeps.
    fn sockets(&self) -> Vec<(WebSocket, hosted::Attachment)> {
        self.state
            .get_websockets()
            .into_iter()
            .filter_map(|ws| {
                let attachment = ws.deserialize_attachment().ok().flatten()?;
                Some((ws, attachment))
            })
            .collect()
    }

    /// Sends the hints of the event that just ran, and closes the sockets
    /// whose credential no longer reads the book. A socket that is gone
    /// fails its send, which changes nothing.
    async fn update_sockets(&self, app: &hosted::App, check_all: bool) {
        let sockets = self.sockets();
        if sockets.is_empty() {
            return;
        }
        let attachments: Vec<hosted::Attachment> =
            sockets.iter().map(|(_, socket)| socket.clone()).collect();
        for (index, update) in app.socket_updates(&attachments, check_all).await {
            let ws = &sockets[index].0;
            let _ = match update {
                hosted::Update::Send(text) => ws.send_with_str(text),
                hosted::Update::Close(code, reason) => ws.close(Some(code), Some(reason)),
            };
        }
    }

    /// Sets the alarm to `at`, unless one is set that comes sooner and is
    /// not past ([`crate::needs_alarm`]). An alarm that comes too soon only
    /// plans again.
    async fn set_alarm_by(&self, at: chrono::DateTime<chrono::Utc>) -> Result<()> {
        let storage = self.state.storage();
        let set = storage.get_alarm().await?;
        let now = chrono::Utc::now().timestamp_millis();
        if crate::needs_alarm(set, at.timestamp_millis(), now) {
            if let Some(set) = set.filter(|&set| set < now - crate::ALARM_DELAY_MS) {
                worker::console_warn!(
                    "The alarm set for {set} is past and did not run; it is set again"
                );
            }
            storage.set_alarm(at).await?;
        }
        Ok(())
    }
}

/// Leaves the marker and tells the storage to restore at the next start.
/// The bookmark and the bookmark that undoes the restore.
async fn schedule_restore(
    storage: &ObjectStorage,
    bucket: &Bucket,
    id: &str,
    target: restore::Target,
) -> std::result::Result<(String, String), Box<restore::Response>> {
    let bookmark = match target {
        restore::Target::Bookmark(bookmark) => bookmark,
        restore::Target::Time(at) => {
            let found = match storage.get_bookmark_for_time(at.timestamp_millis() as f64) {
                Ok(promise) => settled_text(promise).await,
                Err(cause) => Err(js_message(cause)),
            };
            found.map_err(|cause| {
                restore::refusal(
                    StatusCode::BAD_REQUEST,
                    format!("The storage has no bookmark for {at}: {cause}"),
                )
            })?
        }
    };
    // A marker can be here already: a restore whose start has not come
    // yet. A refusal below leaves that one.
    let pending = match bucket.head(restore::MARKER).await {
        Ok(marker) => marker.is_some(),
        Err(cause) => {
            return Err(restore::refusal(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("The export bucket could not be read: {cause}"),
            ));
        }
    };
    let marker = restore::marker(id, &bookmark);
    if let Err(cause) = bucket.put(restore::MARKER, marker).execute().await {
        return Err(restore::refusal(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The restore was not marked, so it did not start: {cause}"),
        ));
    }
    let undo = match storage.on_next_session_restore_bookmark(&bookmark) {
        Ok(promise) => settled_text(promise).await,
        Err(cause) => Err(js_message(cause)),
    };
    match undo {
        Ok(undo) => Ok((bookmark, undo)),
        Err(cause) => {
            // No restore follows, so no start should add a floor marker
            // for this one.
            if !pending && let Err(cause) = bucket.delete(restore::MARKER).await {
                worker::console_error!("The marker of a refused restore stays: {cause}");
            }
            Err(restore::refusal(
                StatusCode::BAD_REQUEST,
                format!("The storage refused the bookmark {bookmark}: {cause}"),
            ))
        }
    }
}

/// A 503 with `message`, which no cache keeps.
fn unavailable(message: String) -> Result<Response> {
    let mut response =
        Response::from_json(&serde_json::json!({ "error": message }))?.with_status(503);
    response.headers_mut().set("cache-control", "no-store")?;
    Ok(response)
}

fn wasm_response(response: restore::Response) -> Result<Response> {
    Ok(worker::response_to_wasm(response)?.into())
}

/// The text that `promise` resolves to, or the message of its rejection.
async fn settled_text(promise: js_sys::Promise) -> std::result::Result<String, String> {
    let value = JsFuture::from(promise).await.map_err(js_message)?;
    value
        .as_string()
        .ok_or_else(|| "the storage answered with no text".to_owned())
}

fn js_message(cause: JsValue) -> String {
    cause
        .dyn_ref::<js_sys::Error>()
        .map(|error| String::from(error.message()))
        .or_else(|| cause.as_string())
        .unwrap_or_else(|| format!("{cause:?}"))
}

/// The book of a `GET /api/b/{bookId}/socket` request.
fn socket_book(request: &HttpRequest) -> Option<String> {
    if request.method() != http::Method::GET {
        return None;
    }
    let book = request
        .uri()
        .path()
        .strip_prefix("/api/b/")?
        .strip_suffix("/socket")?;
    (!book.is_empty() && !book.contains('/')).then(|| book.to_owned())
}

/// The books that `sockets` listen to.
fn books(sockets: &[(WebSocket, hosted::Attachment)]) -> Vec<i32> {
    sockets.iter().map(|(_, socket)| socket.book_id()).collect()
}

thread_local! {
    /// `ctx` of the object that this isolate runs.
    static CONTEXT: RefCell<Option<ObjectContext>> = const { RefCell::new(None) };
}

/// Makes a panic reset the object. A panic aborts the Wasm instance, and
/// workers-rs starts a new one for the next event, but the object would
/// keep its handle into the old one: its requests would fail or never
/// answer until the runtime evicted it. [`reset`] ends the object, fails
/// the requests in flight, and lets the next request construct it again.
fn reset_on_panic(context: &ObjectContext) {
    CONTEXT.with(|slot| *slot.borrow_mut() = Some(context.clone()));
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let earlier = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            earlier(info);
            CONTEXT.with(|slot| {
                if let Some(context) = slot.borrow().as_ref() {
                    reset(context, "The server panicked");
                }
            });
        }));
    });
}

/// Hands the background work that a response promised to `ctx.waitUntil`.
fn keep_alive(state: &State) {
    let context = object_context(state).clone();
    hosted::keep_alive_with(move |promise| context.wait_until(&promise));
}

/// Gives the scheduler's backup the export bucket. Without the binding the
/// backup fails and says so.
fn export_to(env: &Env) {
    let bucket = match env.bucket("EXPORTS") {
        Ok(bucket) => bucket,
        Err(cause) => {
            worker::console_error!("The export bucket is not bound: {cause}");
            return;
        }
    };
    hosted::export_with(move |name, text| {
        let bucket = bucket.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            bucket
                .put(name, text)
                .http_metadata(worker::HttpMetadata {
                    content_type: Some("application/json".to_owned()),
                    ..Default::default()
                })
                .execute()
                .await
                .map(|_| wasm_bindgen::JsValue::UNDEFINED)
                .map_err(|cause| wasm_bindgen::JsValue::from_str(&cause.to_string()))
        })
    });
}

fn start(state: &State) -> std::result::Result<hosted::App, String> {
    hosted::start(ledger_db::Database::new(Box::new(ObjectDatabase::new(
        state,
    ))))
    .map_err(|cause| cause.to_string())
}

/// The Worker's variables and secrets: every binding whose value is a
/// string. The other bindings (the object namespace, the bucket, the
/// assets) are objects.
fn settings(env: &Env) -> HashMap<String, String> {
    let object: &js_sys::Object = env.unchecked_ref();
    js_sys::Object::entries(object)
        .iter()
        .filter_map(|entry| {
            let pair: js_sys::Array = entry.unchecked_into();
            Some((pair.get(0).as_string()?, pair.get(1).as_string()?))
        })
        .collect()
}

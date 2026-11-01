//! The object's database: `ctx.storage.sql` as the hosted connection of
//! `ledger-db`, and the storage methods that workers-rs 0.8.7 does not bind.

use ledger_db::{
    engine::hosted::Connection,
    store::{Error, Row, Value},
};
use std::{cell::Cell, ops::ControlFlow, sync::Arc};
use wasm_bindgen::{JsCast, JsValue, prelude::*};
use worker::{SqlStorage, SqlStorageValue, State};

#[wasm_bindgen]
extern "C" {
    /// `ctx.storage`, for the methods that workers-rs does not bind.
    #[wasm_bindgen(extends = js_sys::Object)]
    pub type ObjectStorage;

    /// Runs `closure` in one transaction: it commits when the closure
    /// returns and rolls back when it throws.
    #[wasm_bindgen(method, catch, js_name = transactionSync)]
    pub fn transaction_sync(
        this: &ObjectStorage,
        closure: &js_sys::Function,
    ) -> Result<JsValue, JsValue>;

    /// The point-in-time recovery bookmark of `time`, in milliseconds since
    /// the epoch.
    #[wasm_bindgen(method, catch, js_name = getBookmarkForTime)]
    pub fn get_bookmark_for_time(
        this: &ObjectStorage,
        time: f64,
    ) -> Result<js_sys::Promise, JsValue>;

    /// Restores the database to `bookmark` the next time the object starts.
    #[wasm_bindgen(method, catch, js_name = onNextSessionRestoreBookmark)]
    pub fn on_next_session_restore_bookmark(
        this: &ObjectStorage,
        bookmark: &str,
    ) -> Result<js_sys::Promise, JsValue>;

    /// `ctx`, for `abort` and `waitUntil`.
    #[wasm_bindgen(extends = js_sys::Object)]
    #[derive(Clone)]
    pub type ObjectContext;

    /// `ctx.abort`, which [`reset`] calls.
    #[wasm_bindgen(method, getter, js_name = abort)]
    fn abort_function(this: &ObjectContext) -> js_sys::Function;

    /// Keeps the object up until `promise` settles, for at most 15 minutes.
    #[wasm_bindgen(method, js_name = waitUntil)]
    pub fn wait_until(this: &ObjectContext, promise: &js_sys::Promise);

    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(handler: &JsValue, delay: i32) -> JsValue;
}

/// Resets the object as soon as the current event yields: the next event
/// constructs it again. `ctx.abort` throws, and a throw that unwinds through
/// Wasm frames breaks the Wasm instance, which the isolate keeps: the
/// future executor's closure stays marked as running, so no future of any
/// later event, in the object or the Worker, ever completes again, until a
/// deploy replaces the isolate. A timer calls `abort`, bound to `ctx`,
/// itself, so that no Rust frame is on the stack when it throws.
pub fn reset(context: &ObjectContext, reason: &str) {
    let abort = context
        .abort_function()
        .bind1(context, &JsValue::from_str(reason));
    set_timeout(abort.as_ref(), 0);
}

/// `ctx.storage` of `state`.
pub fn object_storage(state: &State) -> ObjectStorage {
    state
        .as_raw()
        .storage()
        .expect("a Durable Object has storage")
        .unchecked_into()
}

/// `ctx` of `state`.
pub fn object_context(state: &State) -> &ObjectContext {
    state.as_raw().unchecked_ref()
}

/// The object's SQLite database, as `ledger-db` uses it.
pub struct ObjectDatabase {
    sql: SqlStorage,
    storage: ObjectStorage,
}

// The isolate has one thread; `Connection` is `Send + Sync` because the
// server's state is.
unsafe impl Send for ObjectDatabase {}
unsafe impl Sync for ObjectDatabase {}

impl ObjectDatabase {
    pub fn new(state: &State) -> Self {
        Self {
            sql: state.storage().sql(),
            storage: object_storage(state),
        }
    }

    fn exec(&self, sql: &str, params: &[Value]) -> Result<worker::SqlCursor, Error> {
        let mut bindings = Vec::with_capacity(params.len());
        for value in params {
            bindings.push(to_js(value.clone().checked()?));
        }
        self.sql.exec_raw(sql, bindings).map_err(sql_error)
    }
}

impl Connection for ObjectDatabase {
    fn for_each_row(
        &self,
        sql: &str,
        params: &[Value],
        each: &mut dyn FnMut(Row) -> Result<ControlFlow<()>, Error>,
    ) -> Result<(), Error> {
        let cursor = self.exec(sql, params)?;
        let columns: Arc<[String]> = cursor.column_names().into();
        for row in cursor.raw() {
            let mut values = Vec::with_capacity(columns.len());
            for value in row.map_err(sql_error)? {
                values.push(from_sql(value).checked()?);
            }
            if each(Row::new(columns.clone(), values))?.is_break() {
                break;
            }
        }
        Ok(())
    }

    fn execute(&self, sql: &str, params: &[Value]) -> Result<u64, Error> {
        drain(&self.exec(sql, params)?)?;
        // `rowsWritten` counts index and trigger writes too; `changes()`
        // counts the rows the statement changed, as rusqlite does.
        let changed = self.exec("SELECT changes()", &[])?;
        match changed.raw().next() {
            Some(Ok(row)) => match row.first() {
                Some(SqlStorageValue::Integer(n)) => Ok(*n as u64),
                _ => Ok(0),
            },
            Some(Err(cause)) => Err(sql_error(cause)),
            None => Ok(0),
        }
    }

    fn exec_batch(&self, sql: &str) -> Result<(), Error> {
        drain(&self.sql.exec_raw(sql, None).map_err(sql_error)?)
    }

    fn transaction(&self, body: &mut dyn FnMut() -> bool) -> Result<(), Error> {
        // `transactionSync` calls the closure before it returns, so the
        // borrow of `body` outlives every call. The closure is `'static` only
        // in name.
        let body: &mut (dyn FnMut() -> bool + 'static) = unsafe { std::mem::transmute(body) };
        let rolled_back = std::rc::Rc::new(Cell::new(false));
        let flag = rolled_back.clone();
        let closure = Closure::<dyn FnMut() -> Result<(), JsValue>>::new(move || {
            if body() {
                Ok(())
            } else {
                flag.set(true);
                Err(JsValue::from_str("rolled back"))
            }
        });
        let result = self
            .storage
            .transaction_sync(closure.as_ref().unchecked_ref());
        drop(closure);
        match result {
            Ok(_) => Ok(()),
            Err(_) if rolled_back.get() => Ok(()),
            Err(cause) => Err(js_error(cause)),
        }
    }
}

/// Reads every row, so that a write statement runs to its end.
fn drain(cursor: &worker::SqlCursor) -> Result<(), Error> {
    for row in cursor.raw() {
        row.map_err(sql_error)?;
    }
    Ok(())
}

fn to_js(value: Value) -> JsValue {
    match value {
        Value::Null => JsValue::NULL,
        Value::Integer(n) => JsValue::from_f64(n as f64),
        Value::Real(n) => JsValue::from_f64(n),
        Value::Text(text) => JsValue::from_str(&text),
        Value::Blob(bytes) => js_sys::Uint8Array::from(bytes.as_slice()).buffer().into(),
    }
}

/// workers-rs reads a number as an integer when it is a safe one. A whole
/// number beyond 2^53 is an integer that the object rounded: it becomes an
/// integer here, which `Value::checked` refuses, rather than a real.
fn from_sql(value: SqlStorageValue) -> Value {
    match value {
        SqlStorageValue::Null => Value::Null,
        SqlStorageValue::Boolean(flag) => Value::Integer(flag.into()),
        SqlStorageValue::Integer(n) => Value::Integer(n),
        SqlStorageValue::Float(n) if n.fract() == 0.0 && n.abs() < 9.2e18 => {
            Value::Integer(n as i64)
        }
        SqlStorageValue::Float(n) => Value::Real(n),
        SqlStorageValue::String(text) => Value::Text(text),
        SqlStorageValue::Blob(bytes) => Value::Blob(bytes),
    }
}

fn sql_error(cause: worker::Error) -> Error {
    Error::Sql {
        message: cause.to_string(),
    }
}

fn js_error(cause: JsValue) -> Error {
    let message = cause
        .dyn_ref::<js_sys::Error>()
        .map(|error| String::from(error.message()))
        .or_else(|| cause.as_string())
        .unwrap_or_else(|| format!("{cause:?}"));
    Error::Sql { message }
}

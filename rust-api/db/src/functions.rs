//! The SQL functions that each connection registers, so that SQLite keeps
//! the text rules of the PostgreSQL database that it replaces:
//!
//! - `lower(x)` folds Unicode case, as PostgreSQL did. The built-in folds
//!   ASCII only.
//! - `x LIKE p` (the `like(p, x)` and `like(p, x, e)` functions) is
//!   case-sensitive and takes `\` as its escape character when the SQL names
//!   none, as PostgreSQL did. The built-in folds ASCII case and has no
//!   escape character.
//! - `cp_today()` is today's date in the local time zone (`TZ`), as
//!   `YYYY-MM-DD`. It replaces `CURRENT_DATE`, which SQLite gives in UTC.
//! - `cp_merchant_key(merchant_name, name)` is `ledger_core::names::merchant_key`.
//!
//! A tool that opens the file without these functions (the sqlite3 shell)
//! still reads and writes it: no table, trigger or index refers to them.

#![allow(unsafe_code)]

use chrono::Local;
use libsqlite3_sys as ffi;
use std::{
    ffi::{CString, c_int},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr::NonNull,
};

type Function =
    unsafe extern "C" fn(*mut ffi::sqlite3_context, c_int, *mut *mut ffi::sqlite3_value);

/// Registers every function on the connection `handle`.
pub(crate) fn register(handle: NonNull<ffi::sqlite3>) -> Result<(), sqlx::Error> {
    let deterministic = ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC;
    for (name, arguments, flags, function) in [
        ("lower", 1, deterministic, lower as Function),
        ("like", 2, deterministic, like as Function),
        ("like", 3, deterministic, like as Function),
        ("cp_today", 0, ffi::SQLITE_UTF8, today as Function),
        (
            "cp_merchant_key",
            2,
            deterministic,
            merchant_key as Function,
        ),
    ] {
        let name = CString::new(name).expect("a function name without NUL");
        // SAFETY: `handle` is an open connection that sqlx holds locked for
        // this call. The function pointers live for the whole program.
        let code = unsafe {
            ffi::sqlite3_create_function_v2(
                handle.as_ptr(),
                name.as_ptr(),
                arguments,
                flags,
                std::ptr::null_mut(),
                Some(function),
                None,
                None,
                None,
            )
        };
        if code != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "could not register the SQL function {name:?} (code {code})"
            )));
        }
    }
    Ok(())
}

/// The text of argument `index`, or `None` for NULL. A number reads as its
/// text, as in SQLite.
///
/// # Safety
/// `argv` must hold at least `index + 1` values of the current call.
unsafe fn text<'a>(argv: *mut *mut ffi::sqlite3_value, index: usize) -> Option<&'a str> {
    // SAFETY: the caller keeps `index` inside the argument count. SQLite
    // keeps the value and its text alive until the function returns.
    unsafe {
        let value = *argv.add(index);
        if ffi::sqlite3_value_type(value) == ffi::SQLITE_NULL {
            return None;
        }
        let bytes = ffi::sqlite3_value_text(value);
        let length = ffi::sqlite3_value_bytes(value);
        if bytes.is_null() {
            return Some("");
        }
        let slice = std::slice::from_raw_parts(bytes, length as usize);
        // The connection encoding is UTF-8, so SQLite gives valid UTF-8.
        std::str::from_utf8(slice).ok()
    }
}

/// The result of one call.
enum Output {
    Text(String),
    Integer(i64),
    Null,
}

impl From<Option<String>> for Output {
    fn from(value: Option<String>) -> Self {
        value.map_or(Self::Null, Self::Text)
    }
}

/// Sets the result of the call: a value or an error.
///
/// # Safety
/// `context` must be the context of the current call.
unsafe fn result(context: *mut ffi::sqlite3_context, value: Result<Output, &str>) {
    // SAFETY: SQLITE_TRANSIENT makes SQLite copy the bytes before this
    // function returns, so the Rust strings may drop.
    unsafe {
        match value {
            Ok(Output::Text(text)) => ffi::sqlite3_result_text(
                context,
                text.as_ptr().cast(),
                text.len() as c_int,
                ffi::SQLITE_TRANSIENT(),
            ),
            Ok(Output::Integer(number)) => ffi::sqlite3_result_int64(context, number),
            Ok(Output::Null) => ffi::sqlite3_result_null(context),
            Err(message) => {
                ffi::sqlite3_result_error(context, message.as_ptr().cast(), message.len() as c_int)
            }
        }
    }
}

/// Runs `body` and sets its result. A panic becomes an SQL error, because a
/// panic must not unwind into C.
///
/// # Safety
/// `context` must be the context of the current call.
unsafe fn call(
    context: *mut ffi::sqlite3_context,
    body: impl FnOnce() -> Result<Output, &'static str>,
) {
    let value = catch_unwind(AssertUnwindSafe(body)).unwrap_or(Err("SQL function panicked"));
    // SAFETY: the caller passes the context of the current call.
    unsafe { result(context, value) }
}

unsafe extern "C" fn lower(
    context: *mut ffi::sqlite3_context,
    _argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: registered with one argument.
    unsafe {
        let input = text(argv, 0);
        call(context, || Ok(input.map(str::to_lowercase).into()));
    }
}

unsafe extern "C" fn like(
    context: *mut ffi::sqlite3_context,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: registered with two and with three arguments; `argc` says
    // which.
    unsafe {
        let pattern = text(argv, 0);
        let input = text(argv, 1);
        let escape = if argc == 3 { text(argv, 2) } else { Some("\\") };
        call(context, || {
            let (Some(pattern), Some(input), Some(escape)) = (pattern, input, escape) else {
                return Ok(Output::Null);
            };
            let mut characters = escape.chars();
            let escape = match (characters.next(), characters.next()) {
                (None, _) => None,
                (Some(character), None) => Some(character),
                _ => return Err("ESCAPE expression must be a single character"),
            };
            Ok(Output::Integer(like_matches(pattern, input, escape).into()))
        });
    }
}

unsafe extern "C" fn today(
    context: *mut ffi::sqlite3_context,
    _argc: c_int,
    _argv: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: the context of this call.
    unsafe {
        call(context, || {
            Ok(Output::Text(Local::now().format("%Y-%m-%d").to_string()))
        })
    }
}

unsafe extern "C" fn merchant_key(
    context: *mut ffi::sqlite3_context,
    _argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: registered with two arguments.
    unsafe {
        let merchant = text(argv, 0);
        let name = text(argv, 1);
        call(context, || {
            // `coalesce(merchant_name, name)`: a NULL name gives NULL.
            Ok(match (merchant, name) {
                (Some(merchant), _) => Some(ledger_core::names::merchant_key(Some(merchant), "")),
                (None, Some(name)) => Some(ledger_core::names::merchant_key(None, name)),
                (None, None) => None,
            }
            .into())
        });
    }
}

/// PostgreSQL `LIKE`: `%` matches any run of characters, `_` one character,
/// and the escape character makes the next character literal. Case counts.
pub(crate) fn like_matches(pattern: &str, input: &str, escape: Option<char>) -> bool {
    // The search patterns are `%text%`. The function runs for each row, so
    // find such text without the general matcher, which allocates. UTF-8 is
    // self-synchronizing: a byte match of valid text is a character match.
    // When `%` is the escape character, the outer `%` are not wildcards, so
    // the shortcut does not apply.
    if escape != Some('%')
        && let Some(text) = pattern
            .strip_prefix('%')
            .and_then(|rest| rest.strip_suffix('%'))
        && !text.contains(|character| matches!(character, '%' | '_') || Some(character) == escape)
    {
        return input.contains(text);
    }
    like_matches_general(pattern, input, escape)
}

/// [`like_matches`] without the shortcut. It matches each pattern.
fn like_matches_general(pattern: &str, input: &str, escape: Option<char>) -> bool {
    #[derive(Clone, Copy, PartialEq)]
    enum Token {
        Any,
        One,
        Literal(char),
    }
    let mut tokens = Vec::new();
    let mut characters = pattern.chars();
    while let Some(character) = characters.next() {
        tokens.push(if Some(character) == escape {
            // A trailing escape character matches itself, as in PostgreSQL.
            Token::Literal(characters.next().unwrap_or(character))
        } else if character == '%' {
            Token::Any
        } else if character == '_' {
            Token::One
        } else {
            Token::Literal(character)
        });
    }
    let input: Vec<char> = input.chars().collect();
    // Greedy match with one backtrack point: the last `%` seen.
    let (mut token, mut position) = (0, 0);
    let mut resume: Option<(usize, usize)> = None;
    while position < input.len() {
        match tokens.get(token) {
            Some(Token::Any) => {
                resume = Some((token, position));
                token += 1;
            }
            Some(Token::One) => {
                token += 1;
                position += 1;
            }
            Some(Token::Literal(literal)) if *literal == input[position] => {
                token += 1;
                position += 1;
            }
            _ => match resume {
                Some((any, start)) => {
                    token = any + 1;
                    position = start + 1;
                    resume = Some((any, start + 1));
                }
                None => return false,
            },
        }
    }
    tokens[token..]
        .iter()
        .all(|remaining| *remaining == Token::Any)
}

#[cfg(test)]
mod tests {
    use super::like_matches;

    #[test]
    fn like_follows_postgresql() {
        let yes = |pattern, input| like_matches(pattern, input, Some('\\'));
        assert!(yes("%cafe%", "blue cafe"));
        assert!(yes("caf_", "café"));
        assert!(!yes("caf_", "caf"));
        assert!(!yes("Cafe", "cafe"), "case counts");
        assert!(yes("%", ""));
        assert!(yes("a%b%c", "aXXbYYc"));
        assert!(!yes("a%b%c", "aXXbYY"));
        assert!(yes("50\\%%", "50% off"));
        assert!(!yes("50\\%%", "500 off"));
        assert!(yes("a\\_b", "a_b"));
        assert!(!yes("a\\_b", "acb"));
        assert!(yes("%x\\y%", "xylo"));
        assert!(!yes("%x\\y%", "x\\ylo"));
        assert!(yes("%%a", "bba"));
        assert!(yes("é%", "éclair"));
        assert!(like_matches("a\\b", "a\\b", None), "no escape character");
        // 'abc' LIKE '%%' ESCAPE '%': the pattern is one literal `%`.
        assert!(!like_matches("%%", "abc", Some('%')));
        assert!(like_matches("%%", "%", Some('%')));
    }

    /// The `%text%` shortcut gives the answer of the general matcher, also
    /// when the text holds a wildcard or the escape character.
    #[test]
    fn the_contains_shortcut_agrees_with_the_general_matcher() {
        let patterns = [
            "%", "%%", "%%%", "%a%", "%A%", "%é%", "%caf%", "%cafe%", "%fé%", "%a_%", "%_%",
            "%a%b%", "%\\%", "%\\%%", "%a\\%", "%\\_%", "%x\\y%", "%50\\%%", "%%a%%", "a%", "%a",
            "a", "",
        ];
        let inputs = [
            "",
            "a",
            "A",
            "blue cafe",
            "café",
            "CAFÉ",
            "a_b",
            "a%b",
            "50% off",
            "x\\ylo",
            "xylo",
            "\\",
            "%",
            "_",
            "aa",
            "ab%",
            "abc",
        ];
        for pattern in patterns {
            for input in inputs {
                for escape in [Some('\\'), None, Some('a'), Some('%'), Some('_')] {
                    assert_eq!(
                        like_matches(pattern, input, escape),
                        super::like_matches_general(pattern, input, escape),
                        "{pattern:?} LIKE {input:?} ESCAPE {escape:?}"
                    );
                }
            }
        }
    }
}

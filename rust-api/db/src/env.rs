//! The settings that the server and the jobs read by name. A process reads
//! them from its environment. A host with no process environment (a Durable
//! Object) hands its own values to [`set`] before it serves.

use std::{
    collections::HashMap,
    env::VarError,
    sync::{PoisonError, RwLock},
};

static HOST: RwLock<Option<HashMap<String, String>>> = RwLock::new(None);

/// Puts `values` in place of the process environment, for a host that has
/// none. A later call replaces them.
pub fn set(values: HashMap<String, String>) {
    *HOST.write().unwrap_or_else(PoisonError::into_inner) = Some(values);
}

/// The value of the setting `name`, as [`std::env::var`] gives it: from the
/// host's values once [`set`] has run, else from the process environment.
pub fn var(name: &str) -> Result<String, VarError> {
    match &*HOST.read().unwrap_or_else(PoisonError::into_inner) {
        Some(values) => values.get(name).cloned().ok_or(VarError::NotPresent),
        None => std::env::var(name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_values_replace_the_process_environment() {
        // The only test that calls `set`, so no other test sees its values.
        let path = var("PATH");
        assert!(path.is_ok(), "the process environment has PATH");
        set(HashMap::from([(
            "APP_TZ".to_owned(),
            "Europe/Paris".to_owned(),
        )]));
        let seen = (var("APP_TZ"), var("PATH"));
        *HOST.write().unwrap() = None;
        assert_eq!(
            seen,
            (Ok("Europe/Paris".to_owned()), Err(VarError::NotPresent))
        );
        assert_eq!(var("PATH"), path);
    }
}

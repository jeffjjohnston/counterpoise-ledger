//! The app's time zone and today's date in it.
//!
//! The zone is `APP_TZ`, else `TZ`, else the zone of the system, else
//! `America/New_York`. Workers has no `TZ` and no system zone, so a
//! deployment there sets `APP_TZ`. The SQL never reads a clock: the code
//! computes today here and puts it into the statement
//! ([`crate::sql::EFFECTIVE_DATE`], [`crate::sql::today_literal`]).

use chrono::{DateTime, NaiveDate, Utc};
pub use chrono_tz::Tz;
use std::sync::OnceLock;

/// The zone when nothing names one.
pub const DEFAULT_ZONE: Tz = chrono_tz::America::New_York;

/// The zone from the environment, or why a named zone is not one.
pub fn resolve() -> Result<Tz, String> {
    let read = |name: &str| crate::env::var(name).ok();
    resolve_from(read("APP_TZ").as_deref(), read("TZ").as_deref())
}

/// [`resolve`] for the values of `APP_TZ` and `TZ`. A leading `:` (the
/// POSIX form `TZ=:America/New_York`) is dropped; an empty value is unset.
pub fn resolve_from(app_tz: Option<&str>, tz: Option<&str>) -> Result<Tz, String> {
    let clean = |value: Option<&str>| {
        value
            .map(|value| value.trim().trim_start_matches(':').to_owned())
            .filter(|value| !value.is_empty())
    };
    if let Some(name) = clean(app_tz) {
        return name.parse().map_err(|_| {
            format!("APP_TZ={name} is not an IANA time zone (for example America/New_York)")
        });
    }
    if let Some(name) = clean(tz) {
        return name.parse().map_err(|_| {
            format!(
                "TZ={name} is not an IANA time zone; set APP_TZ to one (for example America/New_York)"
            )
        });
    }
    Ok(iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| name.parse().ok())
        .unwrap_or(DEFAULT_ZONE))
}

/// The app's zone, resolved once per process. A start calls [`resolve`]
/// first to refuse a zone that is not one; here such a zone falls back to
/// [`DEFAULT_ZONE`].
pub fn zone() -> Tz {
    static ZONE: OnceLock<Tz> = OnceLock::new();
    *ZONE.get_or_init(|| resolve().unwrap_or(DEFAULT_ZONE))
}

/// Now, in the app's zone.
pub fn now() -> DateTime<Tz> {
    Utc::now().with_timezone(&zone())
}

/// Today's date in the app's zone.
pub fn today() -> NaiveDate {
    now().date_naive()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_tz_wins_over_tz() {
        assert_eq!(
            resolve_from(Some("Pacific/Auckland"), Some("America/Los_Angeles")),
            Ok(chrono_tz::Pacific::Auckland)
        );
        assert_eq!(
            resolve_from(None, Some(":America/Los_Angeles")),
            Ok(chrono_tz::America::Los_Angeles)
        );
        assert_eq!(
            resolve_from(Some(" "), Some("Europe/Berlin")),
            Ok(chrono_tz::Europe::Berlin)
        );
    }

    #[test]
    fn a_name_that_is_not_a_zone_is_refused() {
        assert!(
            resolve_from(Some("Mars/Olympus"), None)
                .unwrap_err()
                .contains("APP_TZ")
        );
        assert!(
            resolve_from(None, Some("EST+5"))
                .unwrap_err()
                .contains("set APP_TZ")
        );
    }

    #[test]
    fn today_is_the_date_in_the_zone() {
        use chrono::TimeZone;
        // 03:30 UTC on 2026-10-21 is still 2026-10-20 in New York.
        let instant = Utc.with_ymd_and_hms(2026, 10, 21, 3, 30, 0).unwrap();
        assert_eq!(
            instant
                .with_timezone(&DEFAULT_ZONE)
                .date_naive()
                .to_string(),
            "2026-10-20"
        );
        assert_eq!(
            crate::sql::EFFECTIVE_DATE.on(chrono::NaiveDate::from_ymd_opt(2026, 10, 20).unwrap()),
            "(CASE WHEN t.is_floating THEN '2026-10-20' ELSE t.date END)"
        );
    }
}

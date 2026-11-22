//! The app's time zone and today's date in it.
//!
//! The zone is `APP_TZ`, else `TZ`, else the zone of the system, else
//! `America/New_York`. Workers has no `TZ` and no system zone, so a
//! deployment there sets `APP_TZ`. The SQL never reads a clock: the code
//! computes today here and puts it into the statement
//! ([`crate::sql::EFFECTIVE_DATE`], [`crate::sql::today_literal`]).
//!
//! The zone rules come from jiff, with its time zone database compiled in
//! (`tzdb-bundle-always`), so each target reads the same rules and none
//! needs zone files. [`Tz`] gives those rules to chrono, which the rest of
//! the workspace uses for dates and times.

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Timelike,
    Utc,
};
use jiff::tz::{AmbiguousOffset, TimeZone};
use std::{
    fmt,
    str::FromStr,
    sync::{Mutex, OnceLock, PoisonError},
};

/// The name of the zone when nothing names one.
const DEFAULT_ZONE_NAME: &str = "America/New_York";

static UTC: TimeZone = TimeZone::UTC;

/// An IANA time zone, as a chrono [`chrono::TimeZone`].
///
/// A value is a reference to the zone's rules, so it is `Copy`. A process
/// keeps the rules of each zone that it names until it exits. A process
/// names few zones: the app's zone, and the zones of its tests.
#[derive(Clone, Copy)]
pub struct Tz(&'static TimeZone);

impl Tz {
    /// The IANA name, for example `America/New_York`.
    pub fn name(&self) -> &'static str {
        self.0.iana_name().unwrap_or("UTC")
    }
}

impl FromStr for Tz {
    type Err = String;

    /// The zone with this IANA name. A POSIX rule such as `EST+5` is not a
    /// name.
    fn from_str(name: &str) -> Result<Self, Self::Err> {
        static ZONES: Mutex<Vec<&'static TimeZone>> = Mutex::new(Vec::new());
        let mut zones = ZONES.lock().unwrap_or_else(PoisonError::into_inner);
        let known = |zone: &&&'static TimeZone| {
            zone.iana_name()
                .is_some_and(|known| known.eq_ignore_ascii_case(name))
        };
        if let Some(zone) = zones.iter().find(known) {
            return Ok(Tz(zone));
        }
        let zone = TimeZone::get(name).map_err(|error| error.to_string())?;
        if zone.iana_name().is_none() {
            return Err(format!("{name} is not an IANA time zone"));
        }
        let zone: &'static TimeZone = Box::leak(Box::new(zone));
        zones.push(zone);
        Ok(Tz(zone))
    }
}

impl PartialEq for Tz {
    fn eq(&self, other: &Self) -> bool {
        self.name() == other.name()
    }
}

impl Eq for Tz {}

impl fmt::Display for Tz {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

impl fmt::Debug for Tz {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.name())
    }
}

/// The offset of a [`Tz`] from UTC at one time.
#[derive(Clone, Copy, Debug)]
pub struct TzOffset {
    zone: Tz,
    fixed: FixedOffset,
}

impl TzOffset {
    fn new(zone: Tz, offset: jiff::tz::Offset) -> Self {
        // An IANA offset is much less than a day, which is chrono's limit.
        let fixed =
            FixedOffset::east_opt(offset.seconds()).unwrap_or_else(|| chrono::Offset::fix(&Utc));
        Self { zone, fixed }
    }
}

impl chrono::Offset for TzOffset {
    fn fix(&self) -> FixedOffset {
        self.fixed
    }
}

impl fmt::Display for TzOffset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.fixed.fmt(formatter)
    }
}

impl chrono::TimeZone for Tz {
    type Offset = TzOffset;

    fn from_offset(offset: &TzOffset) -> Self {
        offset.zone
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<TzOffset> {
        self.offset_from_local_datetime(&local.and_time(NaiveTime::MIN))
    }

    /// A local time that a clock change skips has no offset. A local time
    /// that a clock change repeats has two: the earlier time first.
    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<TzOffset> {
        let civil = i16::try_from(local.year()).ok().and_then(|year| {
            jiff::civil::DateTime::new(
                year,
                local.month() as i8,
                local.day() as i8,
                local.hour() as i8,
                local.minute() as i8,
                local.second() as i8,
                // chrono holds a leap second as a nanosecond count above 1e9.
                local.nanosecond().min(999_999_999) as i32,
            )
            .ok()
        });
        let Some(civil) = civil else {
            return LocalResult::None;
        };
        match self.0.to_ambiguous_timestamp(civil).offset() {
            AmbiguousOffset::Unambiguous { offset } => {
                LocalResult::Single(TzOffset::new(*self, offset))
            }
            AmbiguousOffset::Gap { .. } => LocalResult::None,
            AmbiguousOffset::Fold { before, after } => {
                LocalResult::Ambiguous(TzOffset::new(*self, before), TzOffset::new(*self, after))
            }
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> TzOffset {
        self.offset_from_utc_datetime(&utc.and_time(NaiveTime::MIN))
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> TzOffset {
        let seconds = utc.and_utc().timestamp();
        // chrono has more years than jiff. A time outside jiff's years gets
        // the offset at jiff's limit on that side.
        let timestamp = jiff::Timestamp::from_second(seconds).unwrap_or(if seconds < 0 {
            jiff::Timestamp::MIN
        } else {
            jiff::Timestamp::MAX
        });
        TzOffset::new(*self, self.0.to_offset(timestamp))
    }
}

/// The zone when nothing names one.
pub fn default_zone() -> Tz {
    DEFAULT_ZONE_NAME.parse().unwrap_or(Tz(&UTC))
}

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
        .unwrap_or_else(default_zone))
}

/// The app's zone, resolved once per process. A start calls [`resolve`]
/// first to refuse a zone that is not one; here such a zone falls back to
/// [`default_zone`].
pub fn zone() -> Tz {
    static ZONE: OnceLock<Tz> = OnceLock::new();
    *ZONE.get_or_init(|| resolve().unwrap_or_else(|_| default_zone()))
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
            "Pacific/Auckland".parse()
        );
        assert_eq!(
            resolve_from(None, Some(":America/Los_Angeles")),
            "America/Los_Angeles".parse()
        );
        assert_eq!(
            resolve_from(Some(" "), Some("Europe/Berlin")),
            "Europe/Berlin".parse()
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

    fn zone(name: &str) -> Tz {
        name.parse().unwrap()
    }

    #[test]
    fn a_zone_has_its_iana_name() {
        assert_eq!(zone("Europe/Berlin").to_string(), "Europe/Berlin");
        assert_eq!(default_zone().name(), "America/New_York");
        // The letter case of a name does not make a different zone.
        assert_eq!(zone("europe/berlin"), zone("Europe/Berlin"));
        assert_ne!(zone("Europe/Berlin"), zone("Europe/Paris"));
        assert_eq!(zone("UTC").name(), "UTC");
    }

    #[test]
    fn the_offset_follows_daylight_saving_time() {
        use chrono::{Offset, TimeZone};
        let new_york = default_zone();
        let offset_at = |month| {
            Utc.with_ymd_and_hms(2026, month, 15, 12, 0, 0)
                .unwrap()
                .with_timezone(&new_york)
                .offset()
                .fix()
                .local_minus_utc()
        };
        assert_eq!(offset_at(1), -5 * 3600);
        assert_eq!(offset_at(7), -4 * 3600);
        // A zone east of UTC, with a half hour.
        let kolkata = Utc
            .with_ymd_and_hms(2026, 1, 15, 12, 0, 0)
            .unwrap()
            .with_timezone(&zone("Asia/Kolkata"));
        assert_eq!(kolkata.to_rfc3339(), "2026-01-15T17:30:00+05:30");
    }

    #[test]
    fn a_local_time_in_a_clock_change_is_none_or_two() {
        use chrono::TimeZone;
        let new_york = default_zone();
        let local = |month, day, hour, minute| {
            new_york.from_local_datetime(
                &NaiveDate::from_ymd_opt(2026, month, day)
                    .unwrap()
                    .and_hms_opt(hour, minute, 0)
                    .unwrap(),
            )
        };
        // 2026-03-08: the clocks go from 02:00 to 03:00.
        assert_eq!(local(3, 8, 2, 30), LocalResult::None);
        assert_eq!(
            local(3, 8, 3, 30).single().unwrap().to_rfc3339(),
            "2026-03-08T03:30:00-04:00"
        );
        // 2026-11-01: the clocks go from 02:00 back to 01:00.
        let LocalResult::Ambiguous(first, second) = local(11, 1, 1, 30) else {
            panic!("01:30 occurs two times on 2026-11-01");
        };
        assert_eq!(first.to_rfc3339(), "2026-11-01T01:30:00-04:00");
        assert_eq!(second.to_rfc3339(), "2026-11-01T01:30:00-05:00");
        assert!(first < second);
        // The date keeps its zone through arithmetic across the change.
        let before = local(10, 31, 12, 0).single().unwrap();
        let after = before + chrono::TimeDelta::hours(24);
        assert_eq!(after.to_rfc3339(), "2026-11-01T11:00:00-05:00");
        assert_eq!(after.timezone(), new_york);
    }

    #[test]
    fn a_year_outside_the_zone_rules_does_not_panic() {
        use chrono::TimeZone;
        let far = NaiveDate::from_ymd_opt(200_000, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        assert_eq!(default_zone().from_local_datetime(&far), LocalResult::None);
        let _ = default_zone().from_utc_datetime(&far);
    }

    #[test]
    fn today_is_the_date_in_the_zone() {
        use chrono::TimeZone;
        // 03:30 UTC on 2026-10-21 is still 2026-10-20 in New York.
        let instant = Utc.with_ymd_and_hms(2026, 10, 21, 3, 30, 0).unwrap();
        assert_eq!(
            instant
                .with_timezone(&default_zone())
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

//! Recurrence math shared by the browser and server. Callers supply today's local date.

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::formatters::{parse_date, to_date_string};
use crate::js::parse_int;

pub const MAX_AUTO_CREATE_DAYS_BEFORE: i64 = 30;
pub const MAX_DAILY_INTERVAL_DAYS: i64 = 1461;
pub const MAX_WEEKLY_INTERVAL_WEEKS: i64 = 260;
pub const MAX_MONTHLY_INTERVAL_MONTHS: i64 = 120;
pub const MAX_YEARLY_INTERVAL_YEARS: i64 = 20;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceConfig {
    pub frequency: String,
    pub interval: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_of_week: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week_of_month: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_of_month: Option<Vec<i64>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRule {
    pub frequency: String,
    pub interval: Option<i64>,
    pub days_of_week: Option<String>,
    pub week_of_month: Option<String>,
    pub days_of_month: Option<String>,
}

pub fn build_rule_recurrence_config(rule: &StoredRule) -> RecurrenceConfig {
    let parse_days = |value: &Option<String>| {
        value.as_deref().and_then(|text| {
            let parsed: serde_json::Value = serde_json::from_str(text).ok()?;
            serde_json::from_value(parsed).ok()
        })
    };
    RecurrenceConfig {
        frequency: rule.frequency.clone(),
        interval: rule.interval.unwrap_or(1).max(1),
        days_of_week: parse_days(&rule.days_of_week),
        week_of_month: rule.week_of_month.clone().filter(|value| !value.is_empty()),
        days_of_month: parse_days(&rule.days_of_month),
    }
}

pub fn max_interval_for(frequency: &str) -> Option<i64> {
    match frequency {
        "daily" => Some(MAX_DAILY_INTERVAL_DAYS),
        "weekly" => Some(MAX_WEEKLY_INTERVAL_WEEKS),
        "monthly" => Some(MAX_MONTHLY_INTERVAL_MONTHS),
        "yearly" => Some(MAX_YEARLY_INTERVAL_YEARS),
        _ => None,
    }
}

pub fn is_valid_auto_create_days_before(value: i64) -> bool {
    (0..=MAX_AUTO_CREATE_DAYS_BEFORE).contains(&value)
}

pub fn parse_auto_create_days_before(value: Option<i64>, fallback: i64) -> Option<i64> {
    match value {
        None => Some(fallback),
        Some(days) if is_valid_auto_create_days_before(days) => Some(days),
        _ => None,
    }
}

pub fn is_valid_auto_create_days_before_value(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite()
            && number.fract() == 0.0
            && (0.0..=MAX_AUTO_CREATE_DAYS_BEFORE as f64).contains(&number)
    })
}

pub fn parse_auto_create_days_before_value(value: Option<&Value>, fallback: i64) -> Option<i64> {
    match value {
        None => Some(fallback),
        Some(value) if is_valid_auto_create_days_before_value(value) => {
            parse_auto_create_days_before(value.as_f64().map(|number| number as i64), fallback)
        }
        Some(_) => None,
    }
}

fn date(value: &str) -> Result<NaiveDate, String> {
    parse_date(value).ok_or_else(|| format!("Invalid date: {value}"))
}

fn business_date(value: &str) -> Result<NaiveDate, String> {
    if !crate::accounting::is_valid_date_string(value) {
        return Err(format!("Invalid date: {value}"));
    }
    date(value)
}

fn shifted(base: NaiveDate, days: i64) -> Result<NaiveDate, String> {
    base.checked_add_signed(Duration::days(days))
        .ok_or_else(|| "Date out of range".into())
}

fn weekday(date: NaiveDate) -> i64 {
    date.weekday().num_days_from_sunday().into()
}

fn normalized_date(year: i32, month0: i64, day: i64) -> Option<NaiveDate> {
    let total = i64::from(year) * 12 + month0;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month = u32::try_from(total.rem_euclid(12) + 1).ok()?;
    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_signed(Duration::try_days(day - 1)?)
}

fn last_day(year: i32, month0: i64) -> Option<i64> {
    let first_next = normalized_date(year, month0 + 1, 1)?;
    Some(i64::from((first_next - Duration::days(1)).day()))
}

fn nth_weekday(year: i32, month0: i64, wanted: i64, nth: i64) -> Option<NaiveDate> {
    let first = normalized_date(year, month0, 1)?;
    // Saturating: `nth` comes from `parseInt` of stored text.
    let day = (wanted - weekday(first))
        .rem_euclid(7)
        .saturating_add(nth.saturating_sub(1).saturating_mul(7))
        .saturating_add(1);
    (day <= last_day(year, month0)?)
        .then(|| normalized_date(year, month0, day))
        .flatten()
}

fn last_weekday(year: i32, month0: i64, wanted: i64) -> Option<NaiveDate> {
    let last = last_day(year, month0)?;
    let last_date = normalized_date(year, month0, last)?;
    normalized_date(
        year,
        month0,
        last - (weekday(last_date) - wanted).rem_euclid(7),
    )
}

pub fn add_days_to_date_string(value: &str, days: i64) -> Result<String, String> {
    Ok(to_date_string(shifted(date(value)?, days)?))
}

pub fn is_business_day(value: &str) -> Result<bool, String> {
    Ok(!matches!(
        business_date(value)?.weekday(),
        Weekday::Sat | Weekday::Sun
    ))
}

pub fn get_next_business_day(value: &str) -> Result<String, String> {
    let mut next = shifted(business_date(value)?, 1)?;
    while matches!(next.weekday(), Weekday::Sat | Weekday::Sun) {
        next = shifted(next, 1)?;
    }
    Ok(to_date_string(next))
}

pub fn advance_to_business_day(value: &str) -> Result<String, String> {
    if is_business_day(value)? {
        Ok(value.to_owned())
    } else {
        get_next_business_day(value)
    }
}

pub fn occurrence_date(scheduled: &str, business_days_only: bool) -> Result<String, String> {
    if business_days_only {
        advance_to_business_day(scheduled)
    } else {
        Ok(scheduled.to_owned())
    }
}

pub fn is_recurring_rule_due(
    next_date: &str,
    today: &str,
    lead_days: i64,
    business_days_only: bool,
) -> Result<bool, String> {
    Ok(occurrence_date(next_date, business_days_only)?
        <= add_days_to_date_string(today, lead_days)?)
}

fn normalized_initial(start: NaiveDate, config: &RecurrenceConfig) -> RecurrenceConfig {
    let mut result = config.clone();
    result.interval = result.interval.max(1);
    if result.frequency == "weekly" {
        if result.days_of_week.as_ref().is_none_or(Vec::is_empty) {
            result.days_of_week = Some(vec![weekday(start)]);
        }
        if result.week_of_month.as_ref().is_none_or(String::is_empty) {
            result.week_of_month = Some("every".into());
        }
    }
    if result.frequency == "monthly" && result.days_of_month.as_ref().is_none_or(Vec::is_empty) {
        result.days_of_month = Some(vec![i64::from(start.day())]);
    }
    result
}

fn resolve_monthly_day(day: i64, year: i32, month0: i64) -> Option<i64> {
    let last = last_day(year, month0)?;
    Some(if day == -1 { last } else { day.min(last) })
}

fn matches_recurrence_date(
    candidate: NaiveDate,
    start: NaiveDate,
    config: &RecurrenceConfig,
) -> bool {
    if candidate < start {
        return false;
    }
    let interval = config.interval.max(1);
    match config.frequency.as_str() {
        "daily" => (candidate - start).num_days() % interval == 0,
        "weekly" => {
            let days = config
                .days_of_week
                .as_deref()
                .filter(|days| !days.is_empty());
            if !days
                .unwrap_or(&[weekday(start)])
                .contains(&weekday(candidate))
            {
                return false;
            }
            let wom = config
                .week_of_month
                .as_deref()
                .filter(|w| !w.is_empty())
                .unwrap_or("every");
            if wom == "last" {
                return i64::from(candidate.day()) + 7
                    > last_day(candidate.year(), i64::from(candidate.month0())).unwrap_or(31);
            }
            if wom != "every" {
                // `Number.parseInt(weekOfMonth, 10)`.
                let Some(index) = parse_int(wom, false) else {
                    return false;
                };
                return index >= 1 && (i64::from(candidate.day()) - 1) / 7 + 1 == index;
            }
            let start_week = start - Duration::days(weekday(start));
            let candidate_week = candidate - Duration::days(weekday(candidate));
            (candidate_week - start_week).num_days() / 7 % interval == 0
        }
        "monthly" => {
            let month_diff = i64::from(candidate.year() - start.year()) * 12
                + i64::from(candidate.month())
                - i64::from(start.month());
            if month_diff < 0 || month_diff % interval != 0 {
                return false;
            }
            let fallback = [i64::from(start.day())];
            let days = config
                .days_of_month
                .as_deref()
                .filter(|days| !days.is_empty())
                .unwrap_or(&fallback);
            days.iter().any(|day| {
                resolve_monthly_day(*day, candidate.year(), i64::from(candidate.month0()))
                    == Some(i64::from(candidate.day()))
            })
        }
        "yearly" => {
            (candidate.year() - start.year()) as i64 % interval == 0
                && candidate.month() == start.month()
                && candidate.day() == start.day()
        }
        _ => false,
    }
}

pub fn initial_next_date(start_date: &str, config: &RecurrenceConfig) -> Result<String, String> {
    let start = date(start_date)?;
    let normalized = normalized_initial(start, config);
    if matches_recurrence_date(start, start, &normalized) {
        Ok(start_date.into())
    } else {
        next_date(start_date, &normalized)
    }
}

pub fn next_date(current_date: &str, config: &RecurrenceConfig) -> Result<String, String> {
    let current = date(current_date)?;
    let (year, month0, day) = (
        current.year(),
        i64::from(current.month0()),
        i64::from(current.day()),
    );
    let interval = config.interval;
    let next = match config.frequency.as_str() {
        "daily" => normalized_date(year, month0, day + interval),
        "weekly" => {
            let mut days = config
                .days_of_week
                .clone()
                .filter(|days| !days.is_empty())
                .unwrap_or_else(|| vec![weekday(current)]);
            days.sort_unstable();
            let wom = config
                .week_of_month
                .as_deref()
                .filter(|w| !w.is_empty())
                .unwrap_or("every");
            if wom == "every" {
                let mut found = None;
                for step in 1..=7 * interval.max(0) {
                    let candidate =
                        normalized_date(year, month0, day + step).ok_or("Date out of range")?;
                    if !days.contains(&weekday(candidate)) {
                        continue;
                    }
                    if interval == 1 {
                        found = Some(candidate);
                        break;
                    }
                    let week_num = (step + 6) / 7;
                    if week_num <= 1 && days.iter().any(|d| *d > weekday(current)) {
                        if weekday(candidate) > weekday(current) {
                            found = Some(candidate);
                            break;
                        }
                    } else if week_num == interval {
                        found = Some(candidate);
                        break;
                    }
                }
                found.or_else(|| normalized_date(year, month0, day + 7 * interval))
            } else {
                let find_in_month = |y: i32, m: i64, after: Option<NaiveDate>| {
                    let mut candidates: Vec<NaiveDate> = days
                        .iter()
                        .filter_map(|wanted| {
                            let date = if wom == "last" {
                                last_weekday(y, m, *wanted)
                            } else {
                                // `parseInt(wom)`, with no radix.
                                nth_weekday(y, m, *wanted, parse_int(wom, true)?)
                            };
                            date.filter(|date| after.is_none_or(|after| *date > after))
                        })
                        .collect();
                    candidates.sort_unstable();
                    candidates.into_iter().next()
                };
                let mut found = find_in_month(year, month0, Some(current));
                if found.is_none() {
                    for offset in 1..=13 {
                        let target =
                            normalized_date(year, month0 + offset, 1).ok_or("Date out of range")?;
                        found = find_in_month(target.year(), i64::from(target.month0()), None);
                        if found.is_some() {
                            break;
                        }
                    }
                }
                found.or_else(|| normalized_date(year, month0 + 1, day))
            }
        }
        "monthly" => {
            let mut days = config
                .days_of_month
                .clone()
                .filter(|days| !days.is_empty())
                .unwrap_or_else(|| vec![day]);
            days.sort_by_key(|day| if *day == -1 { i64::MAX } else { *day });
            let in_month = days
                .iter()
                .filter_map(|wanted| resolve_monthly_day(*wanted, year, month0))
                .find(|candidate| *candidate > day);
            if let Some(next_day) = in_month {
                normalized_date(year, month0, next_day)
            } else {
                let target =
                    normalized_date(year, month0 + interval, 1).ok_or("Date out of range")?;
                let next_day =
                    resolve_monthly_day(days[0], target.year(), i64::from(target.month0()))
                        .ok_or("Date out of range")?;
                normalized_date(target.year(), i64::from(target.month0()), next_day)
            }
        }
        "yearly" => normalized_date(
            year + i32::try_from(interval).map_err(|_| "Date out of range")?,
            month0,
            day,
        ),
        _ => return Err(format!("Invalid frequency: {}", config.frequency)),
    }
    .ok_or("Date out of range")?;
    Ok(to_date_string(next))
}

pub fn advance_next_date_to_future(
    next_date_value: &str,
    config: &RecurrenceConfig,
    today: &str,
    business_days_only: bool,
) -> Result<String, String> {
    let mut current = next_date_value.to_owned();
    for _ in 0..10_000 {
        if occurrence_date(&current, business_days_only)?.as_str() >= today {
            break;
        }
        let next = next_date(&current, config)?;
        if next <= current {
            break;
        }
        current = next;
    }
    Ok(current)
}

pub fn schedule_key(config: &RecurrenceConfig) -> String {
    let days = |value: &Option<Vec<i64>>| {
        let mut items = value.clone().unwrap_or_default();
        items.sort_unstable();
        items
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    };
    let weekly = config.frequency == "weekly";
    let wom = if weekly {
        config
            .week_of_month
            .as_deref()
            .filter(|w| !w.is_empty())
            .unwrap_or("every")
    } else {
        "every"
    };
    format!(
        "{{\"frequency\":{},\"interval\":{},\"daysOfWeek\":{},\"weekOfMonth\":{},\"daysOfMonth\":{}}}",
        serde_json::to_string(&config.frequency).unwrap(),
        if (weekly && wom != "every") || config.interval == 0 {
            1
        } else {
            config.interval
        },
        serde_json::to_string(&if weekly {
            days(&config.days_of_week)
        } else {
            String::new()
        })
        .unwrap(),
        serde_json::to_string(wom).unwrap(),
        serde_json::to_string(&if config.frequency == "monthly" {
            days(&config.days_of_month)
        } else {
            String::new()
        })
        .unwrap()
    )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInput {
    pub config: RecurrenceConfig,
    pub start_date: String,
    #[serde(default)]
    pub business_days_only: bool,
    pub seed: Option<String>,
    pub count: Option<usize>,
    pub today: String,
}

pub fn preview_occurrences(input: &PreviewInput) -> Result<Vec<String>, String> {
    let mut current = if let Some(seed) = &input.seed {
        seed.clone()
    } else {
        advance_next_date_to_future(
            &initial_next_date(&input.start_date, &input.config)?,
            &input.config,
            &input.today,
            input.business_days_only,
        )?
    };
    let mut dates = Vec::new();
    for _ in 0..input.count.unwrap_or(3).min(200) {
        dates.push(occurrence_date(&current, input.business_days_only)?);
        let next = next_date(&current, &input.config)?;
        if next <= current {
            break;
        }
        current = next;
    }
    Ok(dates)
}

fn ordinal(value: i64) -> String {
    let suffix = if (11..=13).contains(&(value % 100)) {
        "th"
    } else {
        match value % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    format!("{value}{suffix}")
}

pub fn describe_recurrence(config: &RecurrenceConfig) -> String {
    let interval = if config.interval == 0 {
        1
    } else {
        config.interval
    };
    match config.frequency.as_str() {
        "daily" => {
            if interval == 1 {
                "Daily".into()
            } else {
                format!("Every {interval} days")
            }
        }
        "weekly" => {
            let days = config.days_of_week.as_deref().unwrap_or(&[]);
            let names = [
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ];
            let day_list = days
                .iter()
                .map(|day| {
                    usize::try_from(*day)
                        .ok()
                        .and_then(|index| names.get(index))
                        .copied()
                        .unwrap_or("")
                })
                .collect::<Vec<_>>()
                .join(" and ");
            let wom = config
                .week_of_month
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("every");
            let prefix = if wom == "every" {
                if interval == 1 {
                    "Every".into()
                } else {
                    format!("Every {}", ordinal(interval))
                }
            } else if wom == "last" {
                "Last".into()
            } else {
                // `ordinal(parseInt(wom))`: NaN is written "NaNth".
                parse_int(wom, true).map_or_else(|| "NaNth".into(), ordinal)
            };
            if days.is_empty() {
                if wom == "every" {
                    if interval == 1 {
                        "Weekly".into()
                    } else {
                        format!("Every {interval} weeks")
                    }
                } else {
                    format!("{prefix} week of each month")
                }
            } else if wom == "every" && interval == 1 {
                format!("Every {day_list}")
            } else if wom == "every" {
                format!("Every {} week on {day_list}", ordinal(interval))
            } else {
                format!("{prefix} {day_list} of each month")
            }
        }
        "monthly" => {
            let prefix = if interval == 1 {
                "Monthly".into()
            } else if interval == 2 {
                "Every other month".into()
            } else {
                format!("Every {} month", ordinal(interval))
            };
            let days = config.days_of_month.as_deref().unwrap_or(&[]);
            if days.is_empty() {
                prefix
            } else {
                format!(
                    "{prefix} on the {}",
                    days.iter()
                        .map(|day| if *day == -1 {
                            "last day".into()
                        } else {
                            ordinal(*day)
                        })
                        .collect::<Vec<_>>()
                        .join(" and ")
                )
            }
        }
        "yearly" => "Yearly".into(),
        other => other.into(),
    }
}

pub fn effective_date(stored: &str, is_floating: bool, today: &str) -> String {
    if is_floating {
        today.to_owned()
    } else {
        stored.to_owned()
    }
}

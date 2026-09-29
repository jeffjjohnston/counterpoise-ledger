//! Locale-specific display helpers and numeric input parsing.

use crate::expression::evaluate_expression;
use chrono::{Datelike, Duration, NaiveDate};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub fn format_currency(cents: i64) -> String {
    let magnitude = i128::from(cents).abs();
    let digits = (magnitude / 100).to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().rev().enumerate() {
        if index != 0 && index % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    let dollars: String = grouped.chars().rev().collect();
    format!(
        "{}${dollars}.{:02}",
        if cents < 0 { "−" } else { "" },
        magnitude % 100
    )
}

pub fn parse_date(value: &str) -> Option<NaiveDate> {
    if value.len() != 10
        || !value.as_bytes().iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

pub fn is_valid_date_string(value: &str) -> bool {
    parse_date(value).is_some_and(|date| date.year() >= 1000)
}

pub fn format_date(value: &str) -> Option<String> {
    let date = parse_display_date(value)?;
    Some(format!(
        "{} {}, {}",
        MONTHS[date.month0() as usize],
        date.day(),
        date.year()
    ))
}

pub fn format_date_short(value: &str) -> Option<String> {
    let date = parse_display_date(value)?;
    Some(format!("{} {}", MONTHS[date.month0() as usize], date.day()))
}

// Date(string + "T00:00:00") accepts days 29..31 that overflow a short month.
// Keep that display behavior separate from strict input validation.
fn parse_display_date(value: &str) -> Option<NaiveDate> {
    if let Some(date) = parse_date(value) {
        return Some(date);
    }
    if value.len() != 10 || !value.is_ascii() {
        return None;
    }
    let year = value.get(..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..)?.parse::<u32>().ok()?;
    if value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || !(1..=31).contains(&day)
    {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, 1)?.checked_add_signed(Duration::days(i64::from(day - 1)))
}

pub fn to_date_string(date: NaiveDate) -> String {
    format!("{}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn float_prefix(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    let mut end = 0;
    if bytes
        .first()
        .is_some_and(|byte| *byte == b'+' || *byte == b'-')
    {
        end += 1;
    }
    let mut digit = false;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
        digit = true;
    }
    if bytes.get(end) == Some(&b'.') {
        end += 1;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
            digit = true;
        }
    }
    if !digit {
        return None;
    }
    value[..end].parse().ok()
}

pub fn parse_currency(value: &str) -> i64 {
    let cleaned: String = value
        .chars()
        .filter_map(|c| match c {
            '−' => Some('-'),
            '0'..='9' | '.' | '-' => Some(c),
            _ => None,
        })
        .collect();
    float_prefix(&cleaned).map_or(0, |amount| crate::accounting::round_js(amount * 100.0))
}

pub fn parse_strict_currency(value: &str) -> Option<i64> {
    let cleaned: String = value
        .chars()
        .filter_map(|c| match c {
            '−' => Some('-'),
            '$' | ',' => None,
            _ => Some(c),
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unsigned = trimmed.strip_prefix(['-', '+']).unwrap_or(trimmed);
    if unsigned.is_empty()
        || !unsigned
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return None;
    }
    if unsigned.bytes().filter(|byte| *byte == b'.').count() > 1
        || !unsigned.bytes().any(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let value: f64 = trimmed.parse().ok()?;
    value
        .is_finite()
        .then(|| crate::accounting::round_js(value * 100.0))
}

pub fn resolve_amount_on_blur(value: &str) -> String {
    if let Some(result) = evaluate_expression(value) {
        return to_fixed_2_js(result);
    }
    let trimmed = value.trim();
    if !trimmed.is_empty()
        && parse_strict_currency(trimmed).is_some()
        && !trimmed.contains(['$', ',', '−'])
        && let Ok(parsed) = trimmed.parse::<f64>()
    {
        return to_fixed_2_js(parsed);
    }
    value.to_owned()
}

/// `Number.toFixed(2)` rounds exact binary ties away from zero, unlike Rust formatting.
pub fn to_fixed_2_js(value: f64) -> String {
    if value == 0.0 {
        return "0.00".into();
    }
    let eighths = value.abs() * 8.0;
    if eighths < 9_007_199_254_740_992.0 && eighths.fract() == 0.0 && (eighths as i64) % 2 == 1 {
        let cents = (25 * i128::from(eighths as i64) + 1) / 2;
        return format!(
            "{}{}.{:02}",
            if value < 0.0 { "-" } else { "" },
            cents / 100,
            cents % 100
        );
    }
    format!("{value:.2}")
}

pub fn account_short_name(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, short)| short)
}

pub fn format_relative_age(ms: f64) -> String {
    if !ms.is_finite() {
        return "—".into();
    }
    if ms < 60_000.0 {
        return "just now".into();
    }
    if ms < 3_600_000.0 {
        return format!("{} min ago", (ms / 60_000.0).floor() as i64);
    }
    if ms < 86_400_000.0 {
        return format!("{} hr ago", (ms / 3_600_000.0).floor() as i64);
    }
    let days = (ms / 86_400_000.0).floor() as i64;
    format!("{days} day{} ago", if days == 1 { "" } else { "s" })
}

pub fn format_price_micros_input(price_micros: i64) -> String {
    let magnitude = i128::from(price_micros).abs();
    let mut fraction = format!("{:06}", magnitude % 1_000_000);
    while fraction.len() > 2 && fraction.ends_with('0') {
        fraction.pop();
    }
    format!(
        "{}{}.{fraction}",
        if price_micros < 0 { "-" } else { "" },
        magnitude / 1_000_000
    )
}

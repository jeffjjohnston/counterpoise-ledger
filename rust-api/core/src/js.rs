//! JavaScript string conversions that the shared logic repeats.

/// JavaScript `String.prototype.trim()` and `\s` whitespace. Rust's
/// `char::is_whitespace` also accepts U+0085 and rejects U+FEFF.
pub fn is_js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
}

/// JavaScript `parseInt`: skip leading JavaScript whitespace, read a sign,
/// then read the longest digit prefix. With `auto_radix`, a `0x` or `0X` after
/// the sign selects base 16, as `parseInt(raw)` does without a radix. `None`
/// is NaN. A value outside `i64` saturates.
pub fn parse_int(raw: &str, auto_radix: bool) -> Option<i64> {
    let raw = raw.trim_start_matches(is_js_whitespace);
    let (negative, rest) = if let Some(rest) = raw.strip_prefix('-') {
        (true, rest)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let (radix, rest) = match rest.get(..2) {
        Some("0x" | "0X") if auto_radix => (16, &rest[2..]),
        _ => (10, rest),
    };
    let digits: Vec<u32> = rest
        .chars()
        .map_while(|digit| digit.to_digit(radix))
        .collect();
    if digits.is_empty() {
        return None;
    }
    let magnitude = digits.iter().fold(0_i64, |value, digit| {
        value
            .saturating_mul(i64::from(radix))
            .saturating_add(i64::from(*digit))
    });
    Some(if negative { -magnitude } else { magnitude })
}

/// JavaScript `parseFloat`: skip leading JavaScript whitespace, then read the
/// longest prefix that is a decimal literal or `Infinity`, with an optional
/// sign. An exponent counts only when a digit follows it. `None` is NaN.
pub fn parse_float(raw: &str) -> Option<f64> {
    let raw = raw.trim_start_matches(is_js_whitespace);
    let bytes = raw.as_bytes();
    let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    if raw[end..].starts_with("Infinity") {
        return Some(if bytes[0] == b'-' {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    let digits_from = |mut index: usize| {
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        index
    };
    let integer_end = digits_from(end);
    let mut digit = integer_end > end;
    end = integer_end;
    if bytes.get(end) == Some(&b'.') {
        let fraction_end = digits_from(end + 1);
        digit |= fraction_end > end + 1;
        end = fraction_end;
    }
    if !digit {
        return None;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent_end = digits_from(end + 1 + sign);
        if exponent_end > end + 1 + sign {
            end = exponent_end;
        }
    }
    // Rust rejects a bare trailing point ("5.") that JavaScript accepts.
    raw[..end].trim_end_matches('.').parse().ok()
}

/// JavaScript `Math.round` on a double: a half rounds toward positive
/// infinity. NaN and the infinities come back unchanged.
pub fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_float_reads_the_longest_decimal_prefix() {
        assert_eq!(parse_float("0.02"), Some(0.02));
        assert_eq!(parse_float("  2e-2xyz"), Some(0.02));
        assert_eq!(parse_float("-.5"), Some(-0.5));
        assert_eq!(parse_float("5."), Some(5.0));
        assert_eq!(parse_float("7e"), Some(7.0));
        assert_eq!(parse_float("7e+"), Some(7.0));
        assert_eq!(parse_float("1.5.3"), Some(1.5));
        assert_eq!(parse_float("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(parse_float("Infinityx"), Some(f64::INFINITY));
        assert_eq!(parse_float("."), None);
        assert_eq!(parse_float("abc"), None);
        assert_eq!(parse_float(""), None);
        assert_eq!(parse_float("-"), None);
    }

    #[test]
    fn round_takes_a_half_toward_positive_infinity() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-2.6), -3.0);
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
    }
}

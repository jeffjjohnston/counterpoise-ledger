//! Payee names, as the server, the importer and the database compare them.

use crate::js::is_js_whitespace;

/// `normalizePayeeName()`: trim, collapse whitespace runs, and straighten
/// quote characters. It does not change case: "IKEA" and "Ikea" are two
/// payees.
pub fn normalize_payee_name(input: &str) -> String {
    input
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .map(|character| match character {
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' | '\u{2032}' | '`' | '\u{00b4}' => {
                '\''
            }
            other => other,
        })
        .collect()
}

/// `normalizePayeeName(merchant ?? name).toLowerCase()`: the key of the
/// learned payee map of a staged Plaid row.
pub fn merchant_key(merchant_name: Option<&str>, name: &str) -> String {
    normalize_payee_name(merchant_name.unwrap_or(name)).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_whitespace_and_quotes_but_not_case() {
        assert_eq!(
            normalize_payee_name("  Blue\u{2019}s \t CAFE \u{feff}"),
            "Blue's CAFE"
        );
        assert_eq!(normalize_payee_name("IKEA"), "IKEA");
        assert_eq!(
            merchant_key(Some("  Blue\u{2019}s   CAFE "), "x"),
            "blue's cafe"
        );
        assert_eq!(merchant_key(None, "ÉCLAIR"), "éclair");
    }
}

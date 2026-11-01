use crate::{
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiResult, internal_error},
    state::AppState,
    validation::{first_query_values, local_today, query_date_param},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State},
    http::HeaderMap,
};
use ledger_db::store::{self, Builder, Row, Sql, params};
use serde_json::{Value, json};
use std::collections::HashMap;

fn float_prefix(value: &str) -> Option<f64> {
    let value = value.trim_start_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
    let bytes = value.as_bytes();
    let mut end = 0;
    if bytes
        .get(end)
        .is_some_and(|byte| matches!(byte, b'+' | b'-'))
    {
        end += 1;
    }
    let mut digits = 0;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
        digits += 1;
    }
    if bytes.get(end) == Some(&b'.') {
        end += 1;
        while bytes.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if bytes
        .get(end)
        .is_some_and(|byte| matches!(byte, b'e' | b'E'))
    {
        let mut exponent_end = end + 1;
        if bytes
            .get(exponent_end)
            .is_some_and(|byte| matches!(byte, b'+' | b'-'))
        {
            exponent_end += 1;
        }
        let first_exponent_digit = exponent_end;
        while bytes.get(exponent_end).is_some_and(u8::is_ascii_digit) {
            exponent_end += 1;
        }
        if exponent_end > first_exponent_digit {
            end = exponent_end;
        }
    }
    value[..end]
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn amount_cents(query: &str) -> Option<i64> {
    let cleaned = query.replace(['$', ','], "");
    let value = float_prefix(&cleaned)?;
    let cents = (value * 100.0 + 0.5).floor();
    (cents.is_finite() && cents > i64::MIN as f64 && cents < i64::MAX as f64)
        .then_some(cents as i64)
}

fn empty_bucket() -> Value {
    json!({ "items": [], "total": 0, "truncated": false })
}
fn bucket(items: Vec<Value>, total: i32) -> Value {
    json!({ "items": items, "total": total, "truncated": total > 25 })
}

fn transaction_results(
    pool: &impl Sql,
    book_id: i32,
    query: &str,
    pattern: &str,
    start: Option<&str>,
    end: Option<&str>,
    today: &str,
) -> Result<Vec<Value>, store::Error> {
    let mut ids_query =
        Builder::new("WITH matches AS (SELECT DISTINCT t.id, CASE WHEN t.is_floating THEN ");
    ids_query
        .push_bind(today)
        .push(
            " ELSE t.date END AS date
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
         LEFT JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE t.book_id = ",
        )
        .push_bind(book_id)
        .push(" AND (t.description_fold LIKE ")
        .push_bind(pattern)
        .push(" ESCAPE '\\' OR t.notes_fold LIKE ")
        .push_bind(pattern)
        .push(" ESCAPE '\\' OR p.name_fold LIKE ")
        .push_bind(pattern)
        .push(" ESCAPE '\\' OR t.check_number_fold LIKE ")
        .push_bind(pattern)
        .push(" ESCAPE '\\'");
    if let Some(amount) = amount_cents(query) {
        ids_query
            .push(" OR s.amount = ")
            .push_bind(amount)
            .push(" OR s.amount = ")
            .push_bind(-amount);
    }
    ids_query.push(")) SELECT id, date FROM matches WHERE TRUE");
    if let Some(start) = start {
        ids_query.push(" AND date >= ").push_bind(start);
    }
    if let Some(end) = end {
        ids_query.push(" AND date <= ").push_bind(end);
    }
    ids_query.push(" ORDER BY date DESC, id DESC LIMIT 25");
    let ids: Vec<i32> = ids_query
        .query::<(i32, String)>(pool)?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut details = Builder::new("SELECT t.id, CASE WHEN t.is_floating THEN ");
    details
        .push_bind(today)
        .push(
            " ELSE t.date END AS date,
           t.description, t.notes, t.check_number, p.id AS payee_id, p.name AS payee_name,
           s.account_id, a.name AS account_name, s.amount, a.is_favorite, a.subtype,
           a.is_investment_cash
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
         JOIN transaction_splits s ON s.transaction_id = t.id
         JOIN accounts a ON a.id = s.account_id
         WHERE t.book_id = ",
        )
        .push_bind(book_id)
        .push(" AND s.book_id = ")
        .push_bind(book_id)
        .push(" AND a.book_id = ")
        .push_bind(book_id)
        .push(" AND t.id ")
        .push_in_integers(&ids)
        .push(" ORDER BY date DESC, t.id DESC, s.id ASC");
    let mut grouped: HashMap<i32, Value> = HashMap::new();
    for row in details.query::<Row>(pool)? {
        let id: i32 = row.column("id")?;
        let payee_id: Option<i32> = row.column("payee_id")?;
        let payee_name: Option<String> = row.column("payee_name")?;
        let payee = match (payee_id, payee_name) {
            (Some(id), Some(name)) if !name.is_empty() => json!({ "id": id, "name": name }),
            _ => Value::Null,
        };
        let split = json!({
            "accountId": row.column::<i32>("account_id")?,
            "accountName": row.column::<String>("account_name")?,
            "amount": row.column::<i32>("amount")?,
            "isFavorite": row.column::<bool>("is_favorite")?,
            "subtype": row.column::<Option<String>>("subtype")?,
            "isInvestmentCash": row.column::<bool>("is_investment_cash")?,
        });
        let transaction = match grouped.entry(id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(json!({
                "id": id, "date": row.column::<String>("date")?,
                "description": row.column::<Option<String>>("description")?,
                "notes": row.column::<Option<String>>("notes")?,
                "checkNumber": row.column::<Option<String>>("check_number")?,
                "payee": payee, "splits": [],
            })),
        };
        transaction["splits"]
            .as_array_mut()
            .expect("splits array")
            .push(split);
    }
    Ok(ids
        .into_iter()
        .filter_map(|id| grouped.remove(&id))
        .collect())
}

#[derive(Clone, Copy)]
enum Kind {
    Accounts,
    Payees,
    Rules,
}

fn named_bucket(
    pool: &impl Sql,
    book_id: i32,
    folded: &str,
    pattern: &str,
    prefix: &str,
    kind: Kind,
) -> Result<Value, store::Error> {
    let (rows_sql, count_sql) = match kind {
        Kind::Accounts => (
            r"SELECT id, name, type, subtype, is_active, is_favorite FROM accounts
             WHERE book_id = ?1 AND name_fold LIKE ?2 ESCAPE '\'
             ORDER BY CASE WHEN name_fold = ?3 THEN 0 WHEN name_fold LIKE ?4 ESCAPE '\' THEN 1 ELSE 2 END,
                      name_fold, id DESC LIMIT 25",
            r"SELECT CAST(COUNT(*) AS integer) FROM accounts
             WHERE book_id = ?1 AND name_fold LIKE ?2 ESCAPE '\'",
        ),
        Kind::Payees => (
            r"SELECT id, name FROM payees WHERE book_id = ?1 AND name_fold LIKE ?2 ESCAPE '\'
             ORDER BY CASE WHEN name_fold = ?3 THEN 0 WHEN name_fold LIKE ?4 ESCAPE '\' THEN 1 ELSE 2 END,
                      name_fold, id DESC LIMIT 25",
            r"SELECT CAST(COUNT(*) AS integer) FROM payees
             WHERE book_id = ?1 AND name_fold LIKE ?2 ESCAPE '\'",
        ),
        Kind::Rules => (
            r"SELECT id, name, frequency, next_date, business_days_only, is_active FROM recurring_rules
             WHERE book_id = ?1
               AND (name_fold LIKE ?2 ESCAPE '\' OR template_description_fold LIKE ?2 ESCAPE '\')
             ORDER BY CASE WHEN name_fold = ?3 THEN 0 WHEN name_fold LIKE ?4 ESCAPE '\' THEN 1 ELSE 2 END,
                      name_fold, id DESC LIMIT 25",
            r"SELECT CAST(COUNT(*) AS integer) FROM recurring_rules
             WHERE book_id = ?1
               AND (name_fold LIKE ?2 ESCAPE '\' OR template_description_fold LIKE ?2 ESCAPE '\')",
        ),
    };
    let rows: Vec<Row> = pool.query(rows_sql, &params![book_id, pattern, folded, prefix])?;
    let total: i32 = pool.query_row(count_sql, &params![book_id, pattern])?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(match kind {
                Kind::Accounts => json!({
                    "id": row.column::<i32>("id")?, "name": row.column::<String>("name")?,
                    "type": row.column::<String>("type")?,
                    "subtype": row.column::<Option<String>>("subtype")?,
                    "isActive": row.column::<bool>("is_active")?,
                    "isFavorite": row.column::<bool>("is_favorite")?,
                }),
                Kind::Payees => json!({
                    "id": row.column::<i32>("id")?, "name": row.column::<String>("name")?,
                }),
                Kind::Rules => json!({
                    "id": row.column::<i32>("id")?, "name": row.column::<String>("name")?,
                    "frequency": row.column::<String>("frequency")?,
                    "nextDate": row.column::<String>("next_date")?,
                    "businessDaysOnly": row.column::<bool>("business_days_only")?,
                    "isActive": row.column::<bool>("is_active")?,
                }),
            })
        })
        .collect::<Result<_, store::Error>>()?;
    Ok(bucket(items, total))
}

pub(crate) async fn search(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    let book = authenticate_book(
        &state,
        &headers,
        &raw_book_id,
        AccessLevel::Read,
        "Failed to search",
    )
    .await?;
    let params = first_query_values(raw_query.as_deref());
    let start = query_date_param(&params, "startDate")?;
    let end = query_date_param(&params, "endDate")?;
    let query = params.get("q").map_or("", String::as_str);
    let mut results = search_book(
        &*state.database,
        book.book_id(),
        query,
        start.as_deref(),
        end.as_deref(),
    )
    .map_err(|cause| internal_error(cause, "Failed to search"))?;
    // The route sends neither a transaction's notes nor an account's active
    // flag. The MCP tool sends both.
    for transaction in results["transactions"].as_array_mut().into_iter().flatten() {
        if let Some(object) = transaction.as_object_mut() {
            object.shift_remove("notes");
        }
    }
    for account in results["accounts"]["items"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        if let Some(object) = account.as_object_mut() {
            object.shift_remove("isActive");
        }
    }
    Ok(Json(results))
}

/// `searchBook()`: up to 25 transactions whose description, notes, payee or
/// check number contains the query, or whose split has the query's amount,
/// and the accounts, payees and recurring rules whose name contains it.
/// The query is trimmed; an empty one finds nothing.
pub(crate) fn search_book(
    pool: &impl Sql,
    book_id: i32,
    query: &str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Value, store::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(json!({ "transactions": [], "accounts": empty_bucket(),
            "payees": empty_bucket(), "recurringRules": empty_bucket() }));
    }
    // The query is a LIKE pattern on the folded columns, as it was on
    // PostgreSQL: `%` and `_` match any text and `\` escapes. Both sides are
    // folded, so the built-in LIKE, which folds ASCII case only, compares
    // them as a case-sensitive LIKE would.
    let folded = ledger_db::folds::fold(query);
    let pattern = format!("%{folded}%");
    let prefix = format!("{folded}%");
    let today = local_today();
    let txns = transaction_results(pool, book_id, query, &pattern, start, end, &today)?;
    let accounts = named_bucket(pool, book_id, &folded, &pattern, &prefix, Kind::Accounts)?;
    let payees = named_bucket(pool, book_id, &folded, &pattern, &prefix, Kind::Payees)?;
    let rules = named_bucket(pool, book_id, &folded, &pattern, &prefix, Kind::Rules)?;
    Ok(json!({ "transactions": txns, "accounts": accounts,
        "payees": payees, "recurringRules": rules }))
}

#[cfg(test)]
mod tests {
    use super::amount_cents;
    #[test]
    fn currency_prefix_and_rounding_match_node() {
        assert_eq!(amount_cents("$1,234.50"), Some(123450));
        assert_eq!(amount_cents("$ 50"), Some(5000));
        assert_eq!(amount_cents("$\t12"), Some(1200));
        assert_eq!(amount_cents("75abc"), Some(7500));
        assert_eq!(amount_cents("1e2tail"), Some(10000));
        assert_eq!(amount_cents("1e+tail"), Some(100));
        assert_eq!(amount_cents(".5tail"), Some(50));
        assert_eq!(amount_cents("abc"), None);
        assert_eq!(
            amount_cents(&format!("{}e+tail", "1".repeat(100_000))),
            None
        );
    }
}

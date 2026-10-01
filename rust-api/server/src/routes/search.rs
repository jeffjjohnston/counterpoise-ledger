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
use ledger_db::engine::{Db, DbPool};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Row};
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

async fn transaction_results(
    pool: &DbPool,
    book_id: i32,
    query: &str,
    pattern: &str,
    start: Option<&str>,
    end: Option<&str>,
    today: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut ids_query = QueryBuilder::<Db>::new(
        "WITH matches AS (SELECT DISTINCT t.id, CASE WHEN t.is_floating THEN ",
    );
    ids_query
        .push_bind(today.to_owned())
        .push(
            " ELSE t.date END AS date
         FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
         LEFT JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE t.book_id = ",
        )
        .push_bind(book_id)
        .push(" AND (lower(t.description) LIKE ")
        .push_bind(pattern.to_owned())
        .push(" OR lower(t.notes) LIKE ")
        .push_bind(pattern.to_owned())
        .push(" OR lower(p.name) LIKE ")
        .push_bind(pattern.to_owned())
        .push(" OR lower(t.check_number) LIKE ")
        .push_bind(pattern.to_owned());
    if let Some(amount) = amount_cents(query) {
        ids_query
            .push(" OR s.amount = ")
            .push_bind(amount)
            .push(" OR s.amount = ")
            .push_bind(-amount);
    }
    ids_query.push(")) SELECT id, date FROM matches WHERE TRUE");
    if let Some(start) = start {
        ids_query.push(" AND date >= ").push_bind(start.to_owned());
    }
    if let Some(end) = end {
        ids_query.push(" AND date <= ").push_bind(end.to_owned());
    }
    ids_query.push(" ORDER BY date DESC, id DESC LIMIT 25");
    let ids: Vec<i32> = ids_query
        .build()
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| row.get::<i32, _>("id"))
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut details = QueryBuilder::<Db>::new("SELECT t.id, CASE WHEN t.is_floating THEN ");
    details
        .push_bind(today.to_owned())
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
        .push(" AND t.id IN (");
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            details.push(", ");
        }
        details.push_bind(id);
    }
    details.push(") ORDER BY date DESC, t.id DESC, s.id ASC");
    let mut grouped: HashMap<i32, Value> = HashMap::new();
    for row in details.build().fetch_all(pool).await? {
        let id: i32 = row.get("id");
        let payee_id: Option<i32> = row.get("payee_id");
        let payee_name: Option<String> = row.get("payee_name");
        let payee = match (payee_id, payee_name) {
            (Some(id), Some(name)) if !name.is_empty() => json!({ "id": id, "name": name }),
            _ => Value::Null,
        };
        let transaction = grouped.entry(id).or_insert_with(|| {
            json!({
                "id": id, "date": row.get::<String, _>("date"),
                "description": row.get::<Option<String>, _>("description"),
                "notes": row.get::<Option<String>, _>("notes"),
                "checkNumber": row.get::<Option<String>, _>("check_number"),
                "payee": payee, "splits": [],
            })
        });
        transaction["splits"]
            .as_array_mut()
            .expect("splits array")
            .push(json!({
                "accountId": row.get::<i32, _>("account_id"),
                "accountName": row.get::<String, _>("account_name"),
                "amount": row.get::<i32, _>("amount"),
                "isFavorite": row.get::<bool, _>("is_favorite"),
                "subtype": row.get::<Option<String>, _>("subtype"),
                "isInvestmentCash": row.get::<bool, _>("is_investment_cash"),
            }));
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

async fn named_bucket(
    pool: &DbPool,
    book_id: i32,
    lower: &str,
    pattern: &str,
    prefix: &str,
    kind: Kind,
) -> Result<Value, sqlx::Error> {
    let (rows_sql, count_sql) = match kind {
        Kind::Accounts => (
            "SELECT id, name, type, subtype, is_active, is_favorite FROM accounts
             WHERE book_id = $1 AND lower(name) LIKE $2
             ORDER BY CASE WHEN lower(name) = $3 THEN 0 WHEN lower(name) LIKE $4 THEN 1 ELSE 2 END,
                      lower(name), id DESC LIMIT 25",
            "SELECT CAST(COUNT(*) AS integer) FROM accounts WHERE book_id = $1 AND lower(name) LIKE $2",
        ),
        Kind::Payees => (
            "SELECT id, name FROM payees WHERE book_id = $1 AND lower(name) LIKE $2
             ORDER BY CASE WHEN lower(name) = $3 THEN 0 WHEN lower(name) LIKE $4 THEN 1 ELSE 2 END,
                      lower(name), id DESC LIMIT 25",
            "SELECT CAST(COUNT(*) AS integer) FROM payees WHERE book_id = $1 AND lower(name) LIKE $2",
        ),
        Kind::Rules => (
            "SELECT id, name, frequency, next_date, business_days_only, is_active FROM recurring_rules
             WHERE book_id = $1 AND (lower(name) LIKE $2 OR lower(template_description) LIKE $2)
             ORDER BY CASE WHEN lower(name) = $3 THEN 0 WHEN lower(name) LIKE $4 THEN 1 ELSE 2 END,
                      lower(name), id DESC LIMIT 25",
            "SELECT CAST(COUNT(*) AS integer) FROM recurring_rules
             WHERE book_id = $1 AND (lower(name) LIKE $2 OR lower(template_description) LIKE $2)",
        ),
    };
    let (rows, total): (_, i32) = tokio::try_join!(
        sqlx::query(rows_sql)
            .bind(book_id)
            .bind(pattern)
            .bind(lower)
            .bind(prefix)
            .fetch_all(pool),
        sqlx::query_scalar(count_sql)
            .bind(book_id)
            .bind(pattern)
            .fetch_one(pool),
    )?;
    let items = rows.into_iter().map(|row| match kind {
        Kind::Accounts => json!({
            "id": row.get::<i32, _>("id"), "name": row.get::<String, _>("name"),
            "type": row.get::<String, _>("type"), "subtype": row.get::<Option<String>, _>("subtype"),
            "isActive": row.get::<bool, _>("is_active"),
            "isFavorite": row.get::<bool, _>("is_favorite"),
        }),
        Kind::Payees => json!({
            "id": row.get::<i32, _>("id"), "name": row.get::<String, _>("name"),
        }),
        Kind::Rules => json!({
            "id": row.get::<i32, _>("id"), "name": row.get::<String, _>("name"),
            "frequency": row.get::<String, _>("frequency"),
            "nextDate": row.get::<String, _>("next_date"),
            "businessDaysOnly": row.get::<bool, _>("business_days_only"),
            "isActive": row.get::<bool, _>("is_active"),
        }),
    }).collect();
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
        &state.pool,
        book.book_id,
        query,
        start.as_deref(),
        end.as_deref(),
    )
    .await
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
pub(crate) async fn search_book(
    pool: &DbPool,
    book_id: i32,
    query: &str,
    start: Option<&str>,
    end: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(json!({ "transactions": [], "accounts": empty_bucket(),
            "payees": empty_bucket(), "recurringRules": empty_bucket() }));
    }
    let lower = query.to_lowercase();
    let pattern = format!("%{lower}%");
    let prefix = format!("{lower}%");
    let today = local_today();
    let txns = transaction_results(pool, book_id, query, &pattern, start, end, &today).await?;
    let (accounts, payees, rules) = tokio::try_join!(
        named_bucket(pool, book_id, &lower, &pattern, &prefix, Kind::Accounts),
        named_bucket(pool, book_id, &lower, &pattern, &prefix, Kind::Payees),
        named_bucket(pool, book_id, &lower, &pattern, &prefix, Kind::Rules),
    )?;
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

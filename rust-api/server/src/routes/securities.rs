use super::investments::{EFFECTIVE_DATE, MAX_SAFE_INTEGER, positions};
use crate::{
    body::{NonBlank, Nullable, NullablePositiveInt, present, string_enum, typed_body},
    book_auth::{AccessLevel, authenticate_book},
    error::{ApiError, ApiResult, error, error_owned, internal_error},
    platform,
    state::AppState,
    validation::{
        first_query_values, local_today, parse_int_prefix, parse_js_number, parse_json_body,
    },
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
};
use chrono::{NaiveDateTime, SecondsFormat};
use ledger_core::{accounting::round_js, collation::compare_names, investments::fixed_price_row};
use ledger_db::sql;
use ledger_db::store::{self, Builder, Sql, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json, to_value};
use std::collections::HashMap;
use utoipa::ToSchema;

const SECURITY_COLUMNS: &str =
    "id, book_id, name, symbol, security_type, fetch_prices, created_at, fixed_price_micros";

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SecurityRecord {
    id: i32,
    book_id: i32,
    name: String,
    symbol: String,
    security_type: String,
    fetch_prices: bool,
    #[serde(serialize_with = "serialize_timestamp")]
    created_at: NaiveDateTime,
    fixed_price_micros: Option<i64>,
}

fn serialize_timestamp<S: serde::Serializer>(
    value: &NaiveDateTime,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.and_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn bad_request(message: &'static str) -> ApiError {
    error(StatusCode::BAD_REQUEST, message)
}

fn account_label(account_id: Option<i32>, name: Option<String>) -> String {
    match account_id {
        None => "All Accounts".to_owned(),
        Some(id) => name.unwrap_or_else(|| format!("Account {id}")),
    }
}

/// The security routes read the path with `Number.parseInt(id, 10)`. NaN is
/// a 400. A number outside the int4 range reaches the query, which fails,
/// and the route returns its 500 message.
pub(super) fn security_path_id(raw: &str, failure: &'static str) -> Result<i32, ApiError> {
    let id = parse_int_prefix(raw).ok_or_else(|| bad_request("Invalid security id"))?;
    i32::try_from(id).map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, failure))
}

pub(super) fn find_security(
    pool: &impl Sql,
    book_id: i32,
    security_id: i32,
    failure: &'static str,
) -> Result<SecurityRecord, ApiError> {
    let query = format!("SELECT {SECURITY_COLUMNS} FROM securities WHERE id = $1 AND book_id = $2");
    pool.query_optional(&query, &params![security_id, book_id])
        .map_err(|cause| internal_error(cause, failure))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Security not found"))
}

string_enum! {
    /// The type of a security, as the body and the `security_type` column
    /// hold it.
    pub(crate) enum SecurityType {
        Etf = "etf",
        MutualFund = "mutual_fund",
        Stock = "stock",
    }
}

// The body of `POST /api/b/{bookId}/securities`. This struct is the validator
// and the source of `CreateSecurityBody` in the API contract: see
// `crate::body`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSecurityBody {
    /// Name of the security. Leading and trailing white space is removed. It must not be empty after that.
    #[schema(inline)]
    name: NonBlank,
    /// Ticker symbol. Leading and trailing white space is removed. The book must not have another security with this symbol, compared without case.
    #[schema(inline)]
    symbol: NonBlank,
    #[schema(inline)]
    security_type: SecurityType,
    /// True to fetch prices for this security. The default is true. A fixed price turns it off.
    #[serde(default, deserialize_with = "present")]
    #[schema(nullable = false)]
    fetch_prices: Option<bool>,
    /// A fixed price per share, in micros, for a security that has no price feed, such as a money market fund. It must be at most 9007199254740991. When set, the server stores fetchPrices as false.
    // No `present`: on a create, `null` and a field that is not there both
    // mean no fixed price.
    #[serde(default)]
    #[schema(inline, nullable = false)]
    fixed_price_micros: Option<NullablePositiveInt>,
}

impl CreateSecurityBody {
    fn fixed_price_micros(&self) -> Option<i64> {
        match &self.fixed_price_micros {
            Some(Nullable::Value(price)) => Some(price.get()),
            _ => None,
        }
    }

    /// A fixed price has no feed, so it turns fetching off.
    fn fetch_prices(&self) -> bool {
        self.fixed_price_micros().is_none() && self.fetch_prices.unwrap_or(true)
    }
}

// The body of `PUT /api/b/{bookId}/securities/{id}`, and
// `UpdateSecurityBody` in the API contract.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSecurityBody {
    /// New name. Leading and trailing white space is removed. It must not be empty after that.
    #[serde(default, deserialize_with = "present")]
    #[schema(inline, nullable = false)]
    name: Option<NonBlank>,
    /// New ticker symbol. Leading and trailing white space is removed. Another security of the book must not have it, compared without case.
    #[serde(default, deserialize_with = "present")]
    #[schema(inline, nullable = false)]
    symbol: Option<NonBlank>,
    #[serde(default, deserialize_with = "present")]
    #[schema(inline, nullable = false)]
    security_type: Option<SecurityType>,
    /// True to fetch prices for this security.
    #[serde(default, deserialize_with = "present")]
    #[schema(nullable = false)]
    fetch_prices: Option<bool>,
    /// A new fixed price per share, in micros. It must be at most 9007199254740991. Setting it turns fetchPrices off. Send null to remove the fixed price; fetchPrices stays as it is.
    #[serde(default, deserialize_with = "present")]
    #[schema(inline, nullable = false)]
    fixed_price_micros: Option<NullablePositiveInt>,
}

/// The changes of an update, after the rules across its fields.
#[derive(Debug, Default, PartialEq)]
struct SecurityUpdate {
    name: Option<String>,
    symbol: Option<String>,
    security_type: Option<SecurityType>,
    fetch_prices: Option<bool>,
    /// `Some(None)` removes the fixed price.
    fixed_price_micros: Option<Option<i64>>,
}

impl UpdateSecurityBody {
    fn read(body: &Value) -> Result<SecurityUpdate, ApiError> {
        let body: Self = typed_body(body)?;
        let fixed_price_micros = body
            .fixed_price_micros
            .map(|price| price.into_option().map(|price| price.get()));
        let update = SecurityUpdate {
            name: body.name.map(NonBlank::into_string),
            symbol: body.symbol.map(NonBlank::into_string),
            security_type: body.security_type,
            // Setting a fixed price turns fetching off. Clearing it leaves
            // fetching as it is.
            fetch_prices: match fixed_price_micros {
                Some(Some(_)) => Some(false),
                _ => body.fetch_prices,
            },
            fixed_price_micros,
        };
        if update == SecurityUpdate::default() {
            return Err(bad_request("No fields to update"));
        }
        Ok(update)
    }
}

/// The income of each dividend or capital-gain transaction in
/// `transaction_ids`: the income legs less the expense legs, negated. A
/// dividend `D` that withholds tax `W` gives `D - W`. A reinvested dividend
/// that pays a fee `F` gives `D - F`, whether the cash goes through a cash
/// leg or not, because the read does not look at the asset legs.
pub(crate) fn income_by_transaction(
    pool: &impl Sql,
    transaction_ids: &[i32],
) -> Result<HashMap<i32, i64>, store::Error> {
    if transaction_ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(pool
        .query::<(i32, i64)>(
            &format!(
                "SELECT s.transaction_id, CAST(-SUM(s.amount) AS bigint)
         FROM transaction_splits s JOIN accounts a ON a.id = s.account_id
         WHERE s.transaction_id {} AND a.type IN ('income', 'expense')
         GROUP BY s.transaction_id",
                sql::in_integers("?1")
            ),
            &params![sql::json_array(transaction_ids)],
        )?
        .into_iter()
        .collect())
}

pub(crate) async fn list_securities(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch securities";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    fn failed(cause: impl std::fmt::Display) -> ApiError {
        internal_error(cause, FAILURE)
    }
    let securities: Vec<(i32, String, String, String, bool, Option<i64>)> = state
        .database
        .query(
            "SELECT id, name, symbol, security_type, fetch_prices, fixed_price_micros
         FROM securities WHERE book_id = ?1 ORDER BY name, id",
            &params![book.book_id()],
        )
        .map_err(failed)?;
    // Book-wide, so a holding in an inactive account counts.
    let positions: HashMap<i64, _> = positions(&*state.database, book.book_id(), None)
        .map_err(failed)?
        .into_iter()
        .map(|position| (position.security_id, position))
        .collect();

    let income_splits: Vec<(i32, i32)> = state
        .database
        .query(
            "SELECT transaction_id, security_id FROM investment_splits
         WHERE book_id = ?1 AND action IN ('dividend', 'capGain')",
            &params![book.book_id()],
        )
        .map_err(failed)?;
    let transaction_ids: Vec<i32> = income_splits.iter().map(|(id, _)| *id).collect();
    let cash = income_by_transaction(&*state.database, &transaction_ids).map_err(failed)?;
    let mut income: HashMap<i32, i64> = HashMap::new();
    for (transaction_id, security_id) in income_splits {
        *income.entry(security_id).or_default() += cash.get(&transaction_id).copied().unwrap_or(0);
    }

    let rows: Vec<Value> = securities
        .into_iter()
        .map(
            |(id, name, symbol, security_type, fetch_prices, fixed_price_micros)| {
                let position = positions.get(&i64::from(id));
                json!({
                    "id": id,
                    "name": name,
                    "symbol": symbol,
                    "securityType": security_type,
                    "fetchPrices": fetch_prices,
                    "fixedPriceMicros": fixed_price_micros,
                    "sharesMicros": position.map_or(0, |p| p.shares_micros),
                    "costBasisCents": position.map_or(0, |p| p.cost_basis_cents),
                    "priceMicros": position.and_then(|p| p.price_micros),
                    "priceDate": position.and_then(|p| p.price_date.clone()),
                    "marketValueCents": position.and_then(|p| p.market_value_cents),
                    "incomeCents": income.get(&id).copied().unwrap_or(0),
                })
            },
        )
        .collect();
    Ok(Json(Value::Array(rows)))
}

pub(crate) async fn create_security(
    State(state): State<AppState>,
    Path(raw_book_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to create security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let input: CreateSecurityBody = typed_body(&parse_json_body(&body, FAILURE)?)?;
    let (fixed_price_micros, fetch_prices) = (input.fixed_price_micros(), input.fetch_prices());
    let (name, symbol) = (input.name.into_string(), input.symbol.into_string());
    let existing: Option<i32> = state
        .database
        .query_optional(
            "SELECT id FROM securities WHERE book_id = ?1 AND symbol_fold = ?2 LIMIT 1",
            &params![book.book_id(), ledger_db::folds::fold(&symbol)],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if let Some(existing) = existing {
        return Err(error_owned(
            StatusCode::CONFLICT,
            format!("A security with symbol \"{symbol}\" already exists (id {existing})"),
        ));
    }
    let query = format!(
        "INSERT INTO securities
           (book_id, name, symbol, security_type, fixed_price_micros, fetch_prices, created_at,
            symbol_fold)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {SECURITY_COLUMNS}"
    );
    let created: SecurityRecord = state
        .database
        .query_row(
            &query,
            &params![
                book.book_id(),
                &name,
                &symbol,
                input.security_type.as_str(),
                fixed_price_micros,
                fetch_prices,
                platform::timestamp(),
                ledger_db::folds::fold(&symbol)
            ],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(created).expect("security serializes")))
}

pub(crate) async fn get_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    let security = find_security(&*state.database, book.book_id(), security_id, FAILURE)?;
    Ok(Json(to_value(security).expect("security serializes")))
}

/// The ID of another security in the book that has this symbol, compared
/// without case. The route answers with a 409 that names this ID.
pub(crate) fn clashing_symbol(
    pool: &impl Sql,
    book_id: i32,
    security_id: i32,
    symbol: &str,
) -> Result<Option<i32>, store::Error> {
    pool.query_optional(
        "SELECT id FROM securities
         WHERE book_id = ?1 AND id <> ?2 AND symbol_fold = ?3 LIMIT 1",
        &params![book_id, security_id, ledger_db::folds::fold(symbol)],
    )
}

pub(crate) async fn update_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    const FAILURE: &str = "Failed to update security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    // Node reads the body before it checks the ID, and validates the body
    // before an out-of-range ID fails at the database.
    let body = parse_json_body(&body, FAILURE)?;
    let security_id =
        parse_int_prefix(&raw_id).ok_or_else(|| bad_request("Invalid security id"))?;
    let input = UpdateSecurityBody::read(&body)?;
    let security_id = i32::try_from(security_id)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, FAILURE))?;
    find_security(&*state.database, book.book_id(), security_id, FAILURE)?;
    if let Some(symbol) = &input.symbol {
        // A clash is a 409, as on create.
        let clash = clashing_symbol(&*state.database, book.book_id(), security_id, symbol)
            .map_err(|cause| internal_error(cause, FAILURE))?;
        if let Some(existing) = clash {
            return Err(error_owned(
                StatusCode::CONFLICT,
                format!("A security with symbol \"{symbol}\" already exists (id {existing})"),
            ));
        }
    }
    let mut fields: Vec<(&str, store::Value)> = Vec::new();
    if let Some(name) = &input.name {
        fields.push(("name", name.into()));
    }
    if let Some(symbol) = &input.symbol {
        fields.push(("symbol", symbol.into()));
        fields.push(("symbol_fold", ledger_db::folds::fold(symbol).into()));
    }
    if let Some(security_type) = input.security_type {
        fields.push(("security_type", security_type.as_str().into()));
    }
    if let Some(fetch_prices) = input.fetch_prices {
        fields.push(("fetch_prices", fetch_prices.into()));
    }
    if let Some(fixed_price_micros) = input.fixed_price_micros {
        fields.push(("fixed_price_micros", fixed_price_micros.into()));
    }
    let mut update = Builder::new("UPDATE securities SET ");
    for (index, (column, value)) in fields.into_iter().enumerate() {
        if index > 0 {
            update.push(", ");
        }
        update.push(column).push(" = ").push_bind(value);
    }
    update
        .push(" WHERE id = ")
        .push_bind(security_id)
        .push(" AND book_id = ")
        .push_bind(book.book_id())
        .push(format!(" RETURNING {SECURITY_COLUMNS}"));
    let updated: SecurityRecord = update
        .query_optional(&*state.database)
        .map_err(|cause| internal_error(cause, FAILURE))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Security not found"))?;
    Ok(Json(to_value(updated).expect("security serializes")))
}

pub(crate) async fn delete_security(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to delete security";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Write, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    // Splits, lots, and prices cascade from a security, so a delete would
    // erase its investment history and leave the transactions in place.
    let splits: i32 = state
        .database
        .query_row(
            "SELECT CAST(COUNT(*) AS integer) FROM investment_splits
         WHERE security_id = ?1 AND book_id = ?2",
            &params![security_id, book.book_id()],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if splits > 0 {
        return Err(bad_request(
            "Cannot delete security with investment transactions",
        ));
    }
    let deleted = state
        .database
        .execute(
            "DELETE FROM securities WHERE id = ?1 AND book_id = ?2",
            &params![security_id, book.book_id()],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    if deleted == 0 {
        return Err(error(StatusCode::NOT_FOUND, "Security not found"));
    }
    Ok(Json(json!({ "success": true })))
}

#[derive(ledger_db::store::FromRow)]
struct SecuritySplitRecord {
    id: i32,
    transaction_id: i32,
    transaction_date: String,
    transaction_description: Option<String>,
    account_id: Option<i32>,
    account_name: Option<String>,
    account_is_active: Option<bool>,
    action: String,
    shares_micros: i64,
    price_micros: i64,
    fees_cents: i32,
    split_numerator: Option<i32>,
    split_denominator: Option<i32>,
}

impl SecuritySplitRecord {
    fn json(&self) -> Map<String, Value> {
        let value = json!({
            "id": self.id,
            "transactionId": self.transaction_id,
            "transactionDate": self.transaction_date,
            "transactionDescription": self.transaction_description,
            "accountId": self.account_id,
            "accountName": account_label(self.account_id, self.account_name.clone()),
            "action": self.action,
            "sharesMicros": self.shares_micros,
            "priceMicros": self.price_micros,
            "feesCents": self.fees_cents,
            "splitNumerator": self.split_numerator,
            "splitDenominator": self.split_denominator,
        });
        let Value::Object(map) = value else {
            unreachable!("json! object")
        };
        map
    }

    fn ratio(&self) -> Option<f64> {
        match (self.split_numerator, self.split_denominator) {
            (Some(numerator), Some(denominator)) if numerator != 0 && denominator != 0 => {
                Some(f64::from(numerator) / f64::from(denominator))
            }
            _ => None,
        }
    }
}

fn security_split_query() -> String {
    format!(
        "SELECT s.id, s.transaction_id, {EFFECTIVE_DATE} AS transaction_date,
                t.description AS transaction_description, s.account_id,
                a.name AS account_name, a.is_active AS account_is_active, s.action,
                s.shares_micros, s.price_micros, s.fees_cents, s.split_numerator,
                s.split_denominator
         FROM investment_splits s
         JOIN transactions t ON t.id = s.transaction_id
         LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.security_id = $1 AND s.book_id = $2"
    )
}

/// The detail route's own market value: a floating-point product rounded
/// once, not the exact micros product the rest of the app uses.
fn float_value_cents(shares_micros: i64, price_micros: i64) -> i64 {
    round_js((shares_micros as f64 / 1_000_000.0) * (price_micros as f64 / 1_000_000.0) * 100.0)
}

struct AccountPosition {
    account_id: i32,
    account_name: String,
    is_active: bool,
    shares_micros: i64,
}

pub(crate) async fn security_detail(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security detail";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    fn failed(cause: impl std::fmt::Display) -> ApiError {
        internal_error(cause, FAILURE)
    }
    let security_id = security_path_id(&raw_id, FAILURE)?;
    let security = find_security(&*state.database, book.book_id(), security_id, FAILURE)?;
    let latest: Option<(i64, String)> = state
        .database
        .query_optional(
            "SELECT price_micros, price_date FROM security_prices
         WHERE security_id = ?1 AND book_id = ?2 ORDER BY price_date DESC LIMIT 1",
            &params![security_id, book.book_id()],
        )
        .map_err(failed)?;
    let query = format!(
        "{} ORDER BY {EFFECTIVE_DATE} ASC, s.id ASC",
        security_split_query()
    );
    let splits: Vec<SecuritySplitRecord> = state
        .database
        .query(&query, &params![security_id, book.book_id()])
        .map_err(failed)?;
    let basis: HashMap<i32, i64> = state
        .database
        .query(
            "SELECT account_id, CAST(COALESCE(SUM(remaining_basis_cents), 0) AS integer)
         FROM investment_lots
         WHERE book_id = ?1 AND security_id = ?2 AND remaining_shares_micros > 0
         GROUP BY account_id",
            &params![book.book_id(), security_id],
        )
        .map_err(failed)?
        .into_iter()
        .collect();

    // A fixed price replaces every recorded price.
    let latest = match security.fixed_price_micros {
        Some(price) => {
            let row = fixed_price_row(i64::from(security.id), price, &local_today());
            Some((row.price_micros, row.price_date))
        }
        None => latest,
    };

    // Accounts in first-seen order, which is the order of a JavaScript Map.
    let mut held: Vec<AccountPosition> = Vec::new();
    fn position<'a>(
        held: &'a mut Vec<AccountPosition>,
        split: &SecuritySplitRecord,
        account_id: i32,
    ) -> &'a mut AccountPosition {
        let index = match held.iter().position(|row| row.account_id == account_id) {
            Some(index) => index,
            None => {
                held.push(AccountPosition {
                    account_id,
                    account_name: split
                        .account_name
                        .clone()
                        .unwrap_or_else(|| format!("Account {account_id}")),
                    is_active: split.account_is_active.unwrap_or(true),
                    shares_micros: 0,
                });
                held.len() - 1
            }
        };
        &mut held[index]
    }
    for split in &splits {
        if split.action == "split" {
            let Some(ratio) = split.ratio() else { continue };
            match split.account_id {
                None => {
                    for row in &mut held {
                        row.shares_micros = round_js(row.shares_micros as f64 * ratio);
                    }
                }
                Some(account_id) => {
                    let row = position(&mut held, split, account_id);
                    row.shares_micros = round_js(row.shares_micros as f64 * ratio);
                }
            }
            continue;
        }
        let Some(account_id) = split.account_id else {
            continue;
        };
        let delta = match split.action.as_str() {
            "buy" => split.shares_micros,
            "sell" => -split.shares_micros,
            _ => continue,
        };
        position(&mut held, split, account_id).shares_micros += delta;
    }
    let mut held: Vec<AccountPosition> = held
        .into_iter()
        .filter(|row| row.shares_micros > 0)
        .collect();
    held.sort_by(|a, b| compare_names(&a.account_name, &b.account_name));
    let positions: Vec<Value> = held
        .iter()
        .map(|row| {
            json!({
                "accountId": row.account_id,
                "accountName": row.account_name,
                "isActive": row.is_active,
                "sharesMicros": row.shares_micros,
                "costBasisCents": basis.get(&row.account_id).copied().unwrap_or(0),
                "marketValueCents": latest
                    .as_ref()
                    .map(|(price, _)| float_value_cents(row.shares_micros, *price)),
            })
        })
        .collect();

    let mut newest_first: Vec<&SecuritySplitRecord> = splits.iter().collect();
    newest_first.sort_by(|a, b| {
        b.transaction_date
            .cmp(&a.transaction_date)
            .then(b.id.cmp(&a.id))
    });
    let mut security_json = to_value(&security).expect("security serializes");
    security_json["latestPriceMicros"] = json!(latest.as_ref().map(|(price, _)| *price));
    security_json["latestPriceDate"] = json!(latest.as_ref().map(|(_, date)| date));
    Ok(Json(json!({
        "security": security_json,
        "positionsByAccount": positions,
        "splits": newest_first.iter().map(|split| Value::Object(split.json())).collect::<Vec<_>>(),
    })))
}

#[derive(ledger_db::store::FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct LotRow {
    lot_id: i32,
    account_id: i32,
    account_name: String,
    acquired_date: String,
    shares_micros: i64,
    basis_cents: i32,
}

pub(crate) async fn security_lots(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch lots";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&*state.database, book.book_id(), security_id, FAILURE)?;
    let rows: Vec<LotRow> = state
        .database
        .query(
            "SELECT l.id AS lot_id, l.account_id, a.name AS account_name, l.acquired_date,
                l.remaining_shares_micros AS shares_micros, l.remaining_basis_cents AS basis_cents
         FROM investment_lots l JOIN accounts a ON a.id = l.account_id
         WHERE l.book_id = ?1 AND l.security_id = ?2 AND l.remaining_shares_micros > 0
         ORDER BY l.acquired_date ASC, l.id ASC",
            &params![book.book_id(), security_id],
        )
        .map_err(|cause| internal_error(cause, FAILURE))?;
    Ok(Json(to_value(rows).expect("lots serialize")))
}

/// `securitySplitListQuery`: a malformed value falls back to the default and
/// never fails. `Number()` reads the value; zod's `int()` rejects a value
/// beyond the safe-integer range.
pub(super) fn page_param(raw: Option<&String>, minimum: f64) -> Option<i64> {
    let value = parse_js_number(raw.filter(|raw| !raw.is_empty())?)?;
    (value.is_finite()
        && value.fract() == 0.0
        && value.abs() <= MAX_SAFE_INTEGER
        && value >= minimum)
        .then_some(value as i64)
}

pub(crate) async fn security_splits(
    State(state): State<AppState>,
    Path((raw_book_id, raw_id)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
    headers: HeaderMap,
) -> ApiResult {
    const FAILURE: &str = "Failed to fetch security splits";
    let book =
        authenticate_book(&state, &headers, &raw_book_id, AccessLevel::Read, FAILURE).await?;
    fn failed(cause: impl std::fmt::Display) -> ApiError {
        internal_error(cause, FAILURE)
    }
    let security_id = security_path_id(&raw_id, FAILURE)?;
    find_security(&*state.database, book.book_id(), security_id, FAILURE)?;
    let params = first_query_values(raw_query.as_deref());
    let limit = page_param(params.get("limit"), 1.0).map_or(50, |limit| limit.min(200));
    let offset = page_param(params.get("offset"), 0.0).unwrap_or(0);

    let query = format!(
        "{} ORDER BY {EFFECTIVE_DATE} DESC, s.id DESC LIMIT COALESCE($3, -1) OFFSET COALESCE($4, 0)",
        security_split_query()
    );
    let splits: Vec<SecuritySplitRecord> = state
        .database
        .query(&query, &params![security_id, book.book_id(), limit, offset])
        .map_err(failed)?;
    let total: i32 = state
        .database
        .query_row(
            "SELECT CAST(COUNT(*) AS integer) FROM investment_splits
         WHERE security_id = ?1 AND book_id = ?2",
            &params![security_id, book.book_id()],
        )
        .map_err(failed)?;

    let is_income =
        |split: &SecuritySplitRecord| matches!(split.action.as_str(), "dividend" | "capGain");
    let income_ids: Vec<i32> = splits
        .iter()
        .filter(|split| is_income(split))
        .map(|split| split.transaction_id)
        .collect();
    let cash = income_by_transaction(&*state.database, &income_ids).map_err(failed)?;
    let has_more = offset + (splits.len() as i64) < i64::from(total);
    let rows: Vec<Value> = splits
        .iter()
        .map(|split| {
            let mut row = split.json();
            if is_income(split) {
                row.insert(
                    "cashAmountCents".to_owned(),
                    json!(cash.get(&split.transaction_id).copied().unwrap_or(0)),
                );
            }
            Value::Object(row)
        })
        .collect();
    Ok(Json(json!({
        "splits": rows,
        "totalCount": total,
        "hasMore": has_more,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};

    async fn message(result: Result<impl std::fmt::Debug, ApiError>) -> String {
        let response = result.unwrap_err().into_response();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        body["error"].as_str().unwrap().to_owned()
    }

    #[test]
    fn a_create_reads_its_fields_and_a_fixed_price_turns_fetching_off() {
        let create = |body: Value| typed_body::<CreateSecurityBody>(&body).unwrap();
        let fixed = create(json!({
            "name": "\u{feff} Fund ", "symbol": " VTI", "securityType": "mutual_fund",
            "fixedPriceMicros": 1_000_000, "fetchPrices": true, "bookId": 9
        }));
        assert_eq!(fixed.security_type.as_str(), "mutual_fund");
        assert_eq!(fixed.fixed_price_micros(), Some(1_000_000));
        assert!(!fixed.fetch_prices());
        assert_eq!(
            (fixed.name.into_string(), fixed.symbol.into_string()),
            ("Fund".to_owned(), "VTI".to_owned())
        );
        // Fetching is on unless the body turns it off. A null price is no price.
        let plain = create(
            json!({"name": "A", "symbol": "B", "securityType": "etf", "fixedPriceMicros": null}),
        );
        assert_eq!(plain.fixed_price_micros(), None);
        assert!(plain.fetch_prices());
        let off = create(
            json!({"name": "A", "symbol": "B", "securityType": "stock", "fetchPrices": false}),
        );
        assert!(!off.fetch_prices());
    }

    #[tokio::test]
    async fn an_update_applies_the_rules_across_its_fields() {
        let read = |body: Value| UpdateSecurityBody::read(&body);
        assert_eq!(message(read(json!({}))).await, "No fields to update");
        // A key that the body does not name is not a change.
        assert_eq!(
            message(read(json!({"bookId": 2}))).await,
            "No fields to update"
        );
        let update = read(json!({"fixedPriceMicros": 5, "fetchPrices": true})).unwrap();
        assert_eq!(update.fetch_prices, Some(false));
        assert_eq!(update.fixed_price_micros, Some(Some(5)));
        let cleared = read(json!({"fixedPriceMicros": null})).unwrap();
        assert_eq!(cleared.fixed_price_micros, Some(None));
        assert_eq!(cleared.fetch_prices, None);
        let renamed = read(json!({"name": " New ", "securityType": "stock"})).unwrap();
        assert_eq!(renamed.name.as_deref(), Some("New"));
        assert_eq!(renamed.security_type, Some(SecurityType::Stock));
        assert_eq!(renamed.fixed_price_micros, None);
    }

    #[test]
    fn page_params_fall_back_like_zod_catch() {
        let param = |raw: &str, minimum| page_param(Some(&raw.to_owned()), minimum);
        assert_eq!(param("1e2", 1.0), Some(100));
        assert_eq!(param(" 7 ", 1.0), Some(7));
        assert_eq!(param("0x10", 0.0), Some(16));
        assert_eq!(param("-0", 0.0), Some(0));
        for raw in ["-1", "1e300", "9007199254740993", "Infinity", "abc"] {
            assert_eq!(param(raw, 0.0), None, "{raw}");
        }
        assert_eq!(param("0", 1.0), None);
    }

    #[test]
    fn detail_value_uses_the_floating_point_product() {
        assert_eq!(float_value_cents(1_000_000, 10_005_000), 1001);
        assert_eq!(float_value_cents(3_000_000, 333_333), 100);
    }
}

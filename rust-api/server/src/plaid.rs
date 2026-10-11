//! The Plaid HTTP API, as `lib/plaid.ts` calls it. There is no SDK: each call
//! is a JSON POST with the client ID and secret in the body.
//!
//! Each failure message is the one the Node function reports. The routes
//! give a message that names a Plaid variable the status 500, and every other
//! message the status 502. A body that is not JSON gets a different message
//! from the Node SyntaxError.

use crate::validation::{from_json_bytes, js_string, js_truthy};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;

/// The origin of each Plaid environment. Plaid retired the Development
/// environment, so `PLAID_ENV=development` is refused.
fn environment_url(environment: &str) -> Option<&'static str> {
    match environment {
        "sandbox" => Some("https://sandbox.plaid.com"),
        "production" => Some("https://production.plaid.com"),
        _ => None,
    }
}

/// One page of `/transactions/sync`. Each added or modified item is the JSON
/// object as Plaid sent it, in its key order, so that it can be stored as
/// `JSON.stringify(item)` writes it.
pub(crate) struct SyncPage {
    pub(crate) added: Vec<Value>,
    pub(crate) modified: Vec<Value>,
    pub(crate) removed: Vec<String>,
    pub(crate) has_more: bool,
    pub(crate) next_cursor: Option<String>,
}

/// `isSyncItem`: the fields that the staging code reads without a check.
fn is_sync_item(item: &Value) -> bool {
    let has = |key: &str, check: fn(&Value) -> bool| item.get(key).is_some_and(check);
    item.is_object()
        && has("transaction_id", Value::is_string)
        && has("account_id", Value::is_string)
        && has("amount", Value::is_number)
        && has("date", Value::is_string)
        && has("name", Value::is_string)
        && has("pending", Value::is_boolean)
}

#[derive(Clone)]
pub(crate) struct Plaid {
    client: Client,
    client_id: Option<String>,
    secret: Option<String>,
    environment: Option<String>,
    base_url: Option<String>,
}

struct Credentials<'a> {
    client_id: &'a str,
    secret: &'a str,
    base_url: &'a str,
}

/// `isPlaidConfigurationError`: the message names a Plaid variable, so the
/// installation is at fault, not the bank.
pub(crate) fn is_configuration_error(message: &str) -> bool {
    ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"]
        .iter()
        .any(|name| message.contains(name))
}

/// True when Plaid refused the request itself, for example an expired or a
/// used token (`INVALID_PUBLIC_TOKEN`, `INVALID_LINK_TOKEN`): another try
/// gives the same answer. A network failure, a rate limit or a Plaid server
/// error is not definitive, and a later try can work.
pub(crate) fn is_definitive_error(message: &str) -> bool {
    message.contains("(INVALID_")
}

/// `formatPlaidError`: the prefix, then the error message and code of a
/// Plaid error body when it has a message.
fn format_error(prefix: &str, payload: Option<&Value>) -> String {
    let field = |name: &str| {
        payload
            .and_then(Value::as_object)
            .and_then(|body| body.get(name))
    };
    match field("error_message").filter(|message| js_truthy(message)) {
        None => prefix.to_owned(),
        Some(message) => {
            let code = field("error_code")
                .filter(|code| js_truthy(code))
                .map(|code| format!(" ({})", js_string(code)))
                .unwrap_or_default();
            format!("{prefix}: {}{code}", js_string(message))
        }
    }
}

impl Plaid {
    pub(crate) fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self::new(
            read("PLAID_CLIENT_ID"),
            read("PLAID_SECRET"),
            read("PLAID_ENV"),
            read("PLAID_API_URL"),
        )
    }

    /// `PLAID_API_URL` replaces the origin of the selected environment. The
    /// HTTP parity tests point it at a local mock.
    pub(crate) fn new(
        client_id: Option<String>,
        secret: Option<String>,
        environment: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        let set = |value: Option<String>| value.filter(|value| !value.is_empty());
        Self {
            // Node's fetch has no deadline of its own. This one stops a
            // stalled request from holding the route open.
            client: Client::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .expect("HTTP client"),
            client_id: set(client_id),
            secret: set(secret),
            environment: set(environment),
            base_url: set(base_url),
        }
    }

    /// The first of the three variables that is not set, in the order that
    /// `credentials` checks them. `None` when Plaid is configured
    /// (`isPlaidConfigured`). The value of `PLAID_ENV` is not checked here.
    pub(crate) fn missing_setting(&self) -> Option<&'static str> {
        if self.client_id.is_none() {
            Some("PLAID_CLIENT_ID")
        } else if self.secret.is_none() {
            Some("PLAID_SECRET")
        } else if self.environment.is_none() {
            Some("PLAID_ENV")
        } else {
            None
        }
    }

    /// `getPlaidConfig`: the variables are checked in this order.
    fn credentials(&self) -> Result<Credentials<'_>, String> {
        let client_id = self
            .client_id
            .as_deref()
            .ok_or("PLAID_CLIENT_ID environment variable not configured")?;
        let secret = self
            .secret
            .as_deref()
            .ok_or("PLAID_SECRET environment variable not configured")?;
        let environment_url = self
            .environment
            .as_deref()
            .and_then(environment_url)
            .ok_or("PLAID_ENV environment variable must be one of sandbox or production")?;
        Ok(Credentials {
            client_id,
            secret,
            base_url: self.base_url.as_deref().unwrap_or(environment_url),
        })
    }

    /// Sends one request. `Ok` holds the parsed body of a 2xx response; `Err`
    /// holds the message that the Node function throws.
    async fn post(&self, path: &str, fields: Value) -> Result<Value, String> {
        let credentials = self.credentials()?;
        let mut body = json!({
            "client_id": credentials.client_id,
            "secret": credentials.secret,
        });
        body.as_object_mut()
            .expect("an object")
            .extend(fields.as_object().expect("an object").clone());
        // `fetch` rejects every network failure with this message.
        let response = self
            .client
            .post(format!("{}{path}", credentials.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|_| "fetch failed".to_owned())?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "fetch failed".to_owned())?;
        if !status.is_success() {
            let payload = from_json_bytes::<Value>(&bytes).ok();
            return Err(format_error(
                &format!("Plaid {path} request failed"),
                payload.as_ref(),
            ));
        }
        from_json_bytes(&bytes)
            .map_err(|cause| format!("Plaid {path} sent a body that is not JSON: {cause}"))
    }

    /// `fetchPlaidTransactionsSync`: one page of `/transactions/sync`. Items
    /// that lack a required field are dropped, as Node drops them.
    pub(crate) async fn fetch_transactions_sync(
        &self,
        access_token: &str,
        cursor: Option<&str>,
        count: u32,
        days_requested: Option<u32>,
    ) -> Result<SyncPage, String> {
        let mut fields = json!({ "access_token": access_token });
        let object = fields.as_object_mut().expect("an object");
        if let Some(days) = days_requested {
            object.insert("options".into(), json!({ "days_requested": days }));
        }
        if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
            object.insert("cursor".into(), json!(cursor));
        }
        object.insert("count".into(), json!(count));
        let payload = self.post("/transactions/sync", fields).await?;
        if payload.is_null() {
            return Err("Cannot read properties of null (reading 'added')".to_owned());
        }
        let list = |key: &str| -> Vec<Value> {
            payload
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let added = list("added").into_iter().filter(is_sync_item).collect();
        let modified = list("modified").into_iter().filter(is_sync_item).collect();
        let removed = list("removed")
            .into_iter()
            .filter_map(|item| {
                item.get("transaction_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        let has_more = payload
            .get("has_more")
            .and_then(Value::as_bool)
            .ok_or("Plaid /transactions/sync returned invalid has_more")?;
        let next_cursor = match payload.get("next_cursor") {
            Some(Value::Null) => None,
            Some(Value::String(cursor)) => Some(cursor.clone()),
            _ => return Err("Plaid /transactions/sync returned invalid next_cursor".to_owned()),
        };
        Ok(SyncPage {
            added,
            modified,
            removed,
            has_more,
            next_cursor,
        })
    }

    /// `fetchPlaidAccounts`: the accounts of one Item, as Plaid sent them.
    pub(crate) async fn fetch_accounts(&self, access_token: &str) -> Result<Vec<Value>, String> {
        let payload = self
            .post("/accounts/get", json!({ "access_token": access_token }))
            .await?;
        match payload {
            // `payload.accounts` on a JSON null body.
            Value::Null => Err("Cannot read properties of null (reading 'accounts')".to_owned()),
            Value::Object(mut body) => match body.remove("accounts") {
                Some(Value::Array(accounts)) => Ok(accounts),
                _ => Err("Plaid /accounts/get returned an invalid accounts payload".to_owned()),
            },
            _ => Err("Plaid /accounts/get returned an invalid accounts payload".to_owned()),
        }
    }
}

/// A Hosted Link session that `/link/token/create` started.
pub(crate) struct HostedLink {
    pub(crate) link_token: String,
    pub(crate) hosted_link_url: String,
    /// The `expiration` of the link token, when Plaid sent one that parses.
    pub(crate) expiration: Option<chrono::DateTime<chrono::Utc>>,
}

/// The result of a Hosted Link session, as `/link/token/get` reports it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LinkOutcome {
    /// The user has not finished the session yet. A session that the user
    /// closed is also here: the user can open the URL again until the link
    /// token expires.
    Pending,
    /// The user finished the session. A new Item has a public token. An
    /// update-mode session can finish without one.
    Success {
        public_token: Option<String>,
        institution: Option<String>,
    },
}

/// A text field of a JSON object, when it is a string that is not empty.
fn text_field(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Reads the result of a Hosted Link session from a `/link/token/get` body.
///
/// The function is total: it runs in a poll loop, and an error on a body of
/// an unexpected shape would abandon a session that the user possibly
/// finished. Plaid adds a session to `link_sessions` each time the user
/// opens the URL, so the function reads each session, newest last.
///
/// A session finished with success when `results.item_add_results` has a
/// public token (a new Item), when it has `on_success` (the older field),
/// or when it has `finished_at` and no exit (update mode, which needs no
/// public token).
pub(crate) fn link_outcome(payload: &Value) -> LinkOutcome {
    let Some(sessions) = payload.get("link_sessions").and_then(Value::as_array) else {
        return LinkOutcome::Pending;
    };
    for session in sessions.iter().rev() {
        let adds = session
            .get("results")
            .and_then(|results| results.get("item_add_results"))
            .and_then(Value::as_array);
        // A session can record results that are not item adds, so each
        // entry is read.
        for add in adds.into_iter().flatten() {
            if let Some(public_token) = text_field(Some(add), "public_token") {
                return LinkOutcome::Success {
                    public_token: Some(public_token),
                    institution: text_field(add.get("institution"), "name"),
                };
            }
        }
        if let Some(success) = session.get("on_success").filter(|value| value.is_object()) {
            return LinkOutcome::Success {
                public_token: text_field(Some(success), "public_token"),
                institution: text_field(
                    success
                        .get("metadata")
                        .and_then(|metadata| metadata.get("institution")),
                    "name",
                ),
            };
        }
        let present = |key: &str| session.get(key).is_some_and(|value| !value.is_null());
        if present("finished_at") && !present("on_exit") && !present("exit") {
            return LinkOutcome::Success {
                public_token: None,
                institution: None,
            };
        }
    }
    LinkOutcome::Pending
}

impl Plaid {
    /// `/link/token/create` for a Hosted Link session. Without an access
    /// token, the session adds a new Item with the transactions product.
    /// With one, it is update mode for that Item: the user signs in again,
    /// and can select more accounts. Update mode keeps the access token.
    pub(crate) async fn create_hosted_link(
        &self,
        client_user_id: &str,
        access_token: Option<&str>,
    ) -> Result<HostedLink, String> {
        let mut fields = json!({
            "client_name": "Counterpoise",
            "language": "en",
            "country_codes": ["US"],
            "user": { "client_user_id": client_user_id },
            // This object makes the session Hosted Link, and it makes
            // `hosted_link_url` appear in the response.
            "hosted_link": {},
        });
        let object = fields.as_object_mut().expect("an object");
        match access_token {
            None => {
                object.insert("products".into(), json!(["transactions"]));
            }
            Some(access_token) => {
                object.insert("access_token".into(), json!(access_token));
                object.insert(
                    "update".into(),
                    json!({ "account_selection_enabled": true }),
                );
            }
        }
        let payload = self.post("/link/token/create", fields).await?;
        let link_token = text_field(Some(&payload), "link_token");
        let hosted_link_url = text_field(Some(&payload), "hosted_link_url");
        let (Some(link_token), Some(hosted_link_url)) = (link_token, hosted_link_url) else {
            return Err(
                "Plaid /link/token/create returned no hosted_link_url. Hosted Link \
                        may not be enabled for this client ID: check the Plaid dashboard."
                    .to_owned(),
            );
        };
        let expiration = text_field(Some(&payload), "expiration")
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(&text).ok())
            .map(|time| time.with_timezone(&chrono::Utc));
        Ok(HostedLink {
            link_token,
            hosted_link_url,
            expiration,
        })
    }

    /// `/link/token/get`: the result of the Hosted Link session so far.
    pub(crate) async fn link_session_outcome(
        &self,
        link_token: &str,
    ) -> Result<LinkOutcome, String> {
        let payload = self
            .post("/link/token/get", json!({ "link_token": link_token }))
            .await?;
        Ok(link_outcome(&payload))
    }

    /// `/item/public_token/exchange`: the access token and the Item ID. The
    /// caller writes the access token into `plaid_tokens` and must not log
    /// it or send it to a client.
    pub(crate) async fn exchange_public_token(
        &self,
        public_token: &str,
    ) -> Result<(String, String), String> {
        let payload = self
            .post(
                "/item/public_token/exchange",
                json!({ "public_token": public_token }),
            )
            .await?;
        match (
            text_field(Some(&payload), "access_token"),
            text_field(Some(&payload), "item_id"),
        ) {
            (Some(access_token), Some(item_id)) => Ok((access_token, item_id)),
            _ => Err("Plaid /item/public_token/exchange returned an incomplete payload".to_owned()),
        }
    }

    /// `/item/remove`: ends an Item at Plaid. The caller uses it when it
    /// cannot keep the access token of a new Item, so that no connection is
    /// left at Plaid that the book cannot use or remove.
    pub(crate) async fn remove_item(&self, access_token: &str) -> Result<(), String> {
        self.post("/item/remove", json!({ "access_token": access_token }))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_refusal_by_plaid_is_definitive() {
        assert!(is_definitive_error(
            "Plaid /item/public_token/exchange request failed: public token expired (INVALID_PUBLIC_TOKEN)"
        ));
        assert!(!is_definitive_error("fetch failed"));
        assert!(!is_definitive_error(
            "Plaid /link/token/get request failed: internal error (INTERNAL_SERVER_ERROR)"
        ));
        assert!(!is_definitive_error(
            "Plaid /link/token/get request failed: too many requests (RATE_LIMIT_EXCEEDED)"
        ));
    }

    #[test]
    fn a_link_session_is_pending_until_it_finishes_with_success() {
        assert_eq!(link_outcome(&json!(null)), LinkOutcome::Pending);
        assert_eq!(link_outcome(&json!({})), LinkOutcome::Pending);
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [] })),
            LinkOutcome::Pending
        );
        // Started, not finished.
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [
                { "link_session_id": "a", "started_at": "2026-10-09T10:00:00Z", "finished_at": null }
            ] })),
            LinkOutcome::Pending
        );
        // Closed by the user. The URL stays good until the link token expires.
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [
                { "finished_at": "2026-10-09T10:05:00Z", "on_exit": { "error": null } }
            ] })),
            LinkOutcome::Pending
        );
        // A new Item: a result that is not an item add comes first.
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [
                { "finished_at": "2026-10-09T10:05:00Z", "on_exit": {} },
                { "finished_at": "2026-10-09T10:09:00Z", "results": { "item_add_results": [
                    { "public_token": "" },
                    { "public_token": "public-sandbox-1", "institution": { "name": "First Platypus Bank" } }
                ] } }
            ] })),
            LinkOutcome::Success {
                public_token: Some("public-sandbox-1".into()),
                institution: Some("First Platypus Bank".into()),
            }
        );
        // The older on_success field.
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [
                { "on_success": { "public_token": "public-2", "metadata": { "institution": { "name": "Tartan" } } } }
            ] })),
            LinkOutcome::Success {
                public_token: Some("public-2".into()),
                institution: Some("Tartan".into()),
            }
        );
        // Update mode can finish without a public token.
        assert_eq!(
            link_outcome(&json!({ "link_sessions": [
                { "finished_at": "2026-10-09T10:05:00Z", "results": { "item_add_results": [] } }
            ] })),
            LinkOutcome::Success {
                public_token: None,
                institution: None,
            }
        );
    }

    #[test]
    fn plaid_errors_and_configuration_match_node() {
        let prefix = "Plaid /accounts/get request failed";
        assert_eq!(format_error(prefix, None), prefix);
        assert_eq!(
            format_error(prefix, Some(&json!({ "error_message": "" }))),
            prefix
        );
        assert_eq!(format_error(prefix, Some(&json!([1]))), prefix);
        assert_eq!(
            format_error(
                prefix,
                Some(
                    &json!({ "error_message": "bad token", "error_code": "INVALID_ACCESS_TOKEN" })
                )
            ),
            "Plaid /accounts/get request failed: bad token (INVALID_ACCESS_TOKEN)"
        );
        assert_eq!(
            format_error(
                prefix,
                Some(&json!({ "error_message": 5, "error_code": 0 }))
            ),
            "Plaid /accounts/get request failed: 5"
        );
        let missing = Plaid::new(Some("id".into()), Some(String::new()), None, None);
        assert_eq!(
            missing.credentials().err(),
            Some("PLAID_SECRET environment variable not configured".to_owned())
        );
        let retired = Plaid::new(
            Some("id".into()),
            Some("secret".into()),
            Some("development".into()),
            None,
        );
        let message = retired.credentials().err().unwrap();
        assert!(is_configuration_error(&message));
        assert!(!is_configuration_error("fetch failed"));
        let sandbox = Plaid::new(
            Some("id".into()),
            Some("secret".into()),
            Some("sandbox".into()),
            None,
        );
        assert_eq!(
            sandbox.credentials().unwrap().base_url,
            "https://sandbox.plaid.com"
        );
    }

    #[tokio::test]
    async fn a_network_failure_reads_as_fetch_does() {
        // Nothing listens on the discard port of the loopback address.
        let plaid = Plaid::new(
            Some("id".into()),
            Some("secret".into()),
            Some("sandbox".into()),
            Some("http://127.0.0.1:9".into()),
        );
        assert_eq!(
            plaid.fetch_accounts("token").await.err(),
            Some("fetch failed".to_owned())
        );
    }
}

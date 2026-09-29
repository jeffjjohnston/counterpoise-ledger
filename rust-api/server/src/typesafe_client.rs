//! The TypeSafe HTTP API, as `lib/typesafe/client.ts` calls it: one request
//! asks every Choice question. A missing or inconsistent answer rejects the
//! whole response, because code must not act on part of a bad response.
//! Request bodies never enter logs.

use crate::{
    typesafe::is_configured,
    typesafe_questions::TYPESAFE_MODEL,
    validation::{from_json_bytes, is_js_whitespace, js_number, js_stringify},
};
use reqwest::Client;
use serde_json::{Map, Value, json};
use std::{sync::OnceLock, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The answers to the asked questions, in the order asked, and the token
/// usage when TypeSafe returned it.
pub(crate) struct Evaluated {
    pub(crate) answers: Map<String, Value>,
    pub(crate) usage: Option<Value>,
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        // `redirect: "error"`: a redirect is a network error.
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the TypeSafe HTTP client builds")
    })
}

/// A finite number from 0 to 1, as `z.number().finite().min(0).max(1)`.
fn probability(value: &Value) -> Option<f64> {
    let number = js_number(value.as_number()?);
    (number.is_finite() && (0.0..=1.0).contains(&number)).then_some(number)
}

/// `answerSchema`. The answer keeps only its checked fields.
fn answer(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.get("type")?.as_str()? != "choice" {
        return None;
    }
    let choice = object.get("choice")?.as_str()?;
    let probabilities = object.get("probabilities")?.as_object()?;
    if !probabilities
        .values()
        .all(|value| probability(value).is_some())
    {
        return None;
    }
    let confidence = object.get("confidence")?;
    probability(confidence)?;
    Some(json!({
        "choice": choice,
        "probabilities": probabilities,
        "confidence": confidence,
    }))
}

/// `z.number().int().nonnegative()`.
fn token_count(value: Option<&Value>) -> Option<&Value> {
    let number = js_number(value?.as_number()?);
    (number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number)).then_some(value?)
}

/// `responseSchema`: the model, every answer, and the optional usage.
fn parse_response(body: &Value) -> Option<(Map<String, Value>, Option<Value>)> {
    let object = body.as_object()?;
    if object.get("model")?.as_str()? != TYPESAFE_MODEL {
        return None;
    }
    let answers = object
        .get("answers")?
        .as_object()?
        .iter()
        .map(|(id, value)| Some((id.clone(), answer(value)?)))
        .collect::<Option<Map<String, Value>>>()?;
    let usage = match object.get("usage") {
        None => None,
        Some(usage) => Some(json!({
            "input_tokens": token_count(get(usage, "input_tokens"))?,
            "output_tokens": token_count(get(usage, "output_tokens"))?,
        })),
    };
    Some((answers, usage))
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

/// `consistent`: the distribution covers exactly the asked options, sums to
/// 1, and the choice is the most probable option.
fn consistent(answer: &Value, criteria: &Map<String, Value>) -> bool {
    let Some(probabilities) = get(answer, "probabilities").and_then(Value::as_object) else {
        return false;
    };
    let Some(choice) = get(answer, "choice").and_then(Value::as_str) else {
        return false;
    };
    let values: Vec<f64> = probabilities
        .values()
        .filter_map(|value| value.as_number().map(js_number))
        .collect();
    let chosen = probabilities
        .get(choice)
        .and_then(Value::as_number)
        .map(js_number);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    probabilities.len() == criteria.len()
        && criteria.keys().all(|key| probabilities.contains_key(key))
        && criteria.contains_key(choice)
        && (values.iter().sum::<f64>() - 1.0).abs() <= 0.001
        && chosen.is_some_and(|chosen| chosen >= max)
}

/// `evaluate`. Each failure is the error code that Node stores.
pub(crate) async fn evaluate(
    state: &Value,
    questions: &[(&'static str, Value)],
) -> Result<Evaluated, &'static str> {
    if !is_configured() {
        return Err("unavailable");
    }
    let key = std::env::var("TYPESAFE_API_KEY").unwrap_or_default();
    // TYPESAFE_API_URL replaces the origin. The HTTP parity tests point it at
    // a local mock, so no test calls TypeSafe.
    let origin = std::env::var("TYPESAFE_API_URL")
        .ok()
        .filter(|origin| !origin.is_empty())
        .unwrap_or_else(|| "https://api.typesafe.ai".to_owned());
    let body = json!({
        "model": TYPESAFE_MODEL,
        "state": state,
        "questions": questions
            .iter()
            .map(|(id, question)| {
                let mut typed = Map::new();
                typed.insert("type".into(), json!("choice"));
                if let Some(fields) = question.as_object() {
                    typed.extend(fields.clone());
                }
                ((*id).to_owned(), Value::Object(typed))
            })
            .collect::<Map<String, Value>>(),
    });
    // AbortSignal.timeout(5000) covers the request and the body.
    let exchange = async {
        let response = client()
            .post(format!("{origin}/v1/systemone"))
            .header(
                "Authorization",
                format!("Bearer {}", key.trim_matches(is_js_whitespace)),
            )
            .header("Content-Type", "application/json")
            .body(js_stringify(&body))
            .send()
            .await
            .map_err(|_| "network_error")?;
        let status = response.status();
        if status.is_redirection() {
            return Err("network_error");
        }
        if !status.is_success() {
            return Err(if status.as_u16() == 429 {
                "rate_limited"
            } else {
                "provider_error"
            });
        }
        response.bytes().await.map_err(|_| "network_error")
    };
    let bytes = tokio::time::timeout(TIMEOUT, exchange)
        .await
        .map_err(|_| "timeout")??;
    let parsed: Value = from_json_bytes(&bytes).map_err(|_| "invalid_response")?;
    let (answers, usage) = parse_response(&parsed).ok_or("invalid_response")?;
    let mut asked = Map::new();
    for (id, question) in questions {
        let criteria = get(question, "criteria")
            .and_then(Value::as_object)
            .ok_or("invalid_response")?;
        let answer = answers
            .get(*id)
            .filter(|answer| consistent(answer, criteria))
            .ok_or("invalid_response")?;
        asked.insert((*id).to_owned(), answer.clone());
    }
    Ok(Evaluated {
        answers: asked,
        usage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn criteria(keys: &[&str]) -> Map<String, Value> {
        keys.iter()
            .map(|key| ((*key).to_owned(), json!("x")))
            .collect()
    }

    #[test]
    fn answers_must_cover_exactly_the_options_and_choose_the_most_probable() {
        let asked = criteria(&["candidate_1", "none"]);
        let good = json!({ "choice": "candidate_1", "probabilities": { "candidate_1": 0.7, "none": 0.3 } });
        assert!(consistent(&good, &asked));
        for bad in [
            json!({ "choice": "none", "probabilities": { "candidate_1": 0.7, "none": 0.3 } }),
            json!({ "choice": "candidate_1", "probabilities": { "candidate_1": 0.7, "none": 0.2 } }),
            json!({ "choice": "candidate_1", "probabilities": { "candidate_1": 1 } }),
            json!({ "choice": "other", "probabilities": { "candidate_1": 0.5, "other": 0.5 } }),
        ] {
            assert!(!consistent(&bad, &asked), "{bad}");
        }
    }

    #[test]
    fn the_response_schema_checks_model_answers_and_usage() {
        let answer = json!({ "type": "choice", "choice": "a", "probabilities": { "a": 1 }, "confidence": 1, "extra": true });
        let (answers, usage) = parse_response(&json!({
            "model": TYPESAFE_MODEL, "answers": { "match": answer },
            "usage": { "input_tokens": 3, "output_tokens": 1, "cached": 0 },
        }))
        .unwrap();
        assert_eq!(
            js_stringify(&answers["match"]),
            r#"{"choice":"a","probabilities":{"a":1},"confidence":1}"#
        );
        assert_eq!(
            js_stringify(&usage.unwrap()),
            r#"{"input_tokens":3,"output_tokens":1}"#
        );
        for bad in [
            json!({ "model": "other", "answers": {} }),
            json!({ "model": TYPESAFE_MODEL, "answers": { "x": { "type": "choice", "choice": "a", "probabilities": { "a": 2 }, "confidence": 1 } } }),
            json!({ "model": TYPESAFE_MODEL, "answers": {}, "usage": null }),
            json!({ "model": TYPESAFE_MODEL, "answers": {}, "usage": { "input_tokens": 1.5, "output_tokens": 0 } }),
        ] {
            assert!(parse_response(&bad).is_none(), "{bad}");
        }
    }
}

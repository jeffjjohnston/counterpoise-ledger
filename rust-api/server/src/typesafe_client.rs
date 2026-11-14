//! Cloudflare's Clef model through the Workers AI REST API: one request
//! asks every Choice question. A missing or inconsistent answer rejects the
//! whole response, because code must not act on part of a bad response.
//! Request bodies never enter logs.

use crate::{
    platform,
    typesafe::{clef_account, clef_token, is_configured},
    typesafe_questions::CLEF_MODEL,
    validation::{from_json_bytes, js_number, js_stringify},
};
use serde_json::{Map, Value, json};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// Clef writes each probability with four decimal places, so the sum can be
/// wrong by this much for each option.
const ROUNDING: f64 = 0.00005;

/// The answers to the asked questions, in the order asked, and the token
/// usage when the answer has it.
pub(crate) struct Evaluated {
    pub(crate) answers: Map<String, Value>,
    pub(crate) usage: Option<Value>,
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
    if object.get("model")?.as_str()? != CLEF_MODEL {
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
/// 1, and the choice is the most probable option. A failure names the check
/// that failed, so that a stored error tells which part of the answer was
/// wrong.
fn check_answer(answer: &Value, criteria: &Map<String, Value>) -> Result<(), &'static str> {
    let (Some(probabilities), Some(choice)) = (
        get(answer, "probabilities").and_then(Value::as_object),
        get(answer, "choice").and_then(Value::as_str),
    ) else {
        return Err("invalid_response_schema");
    };
    if probabilities.len() != criteria.len()
        || !criteria.keys().all(|key| probabilities.contains_key(key))
    {
        return Err("invalid_response_options");
    }
    let values: Vec<f64> = probabilities
        .values()
        .filter_map(|value| value.as_number().map(js_number))
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let tolerance = 0.001 + ROUNDING * values.len() as f64;
    if (values.iter().sum::<f64>() - 1.0).abs() > tolerance {
        return Err("invalid_response_sum");
    }
    let chosen = probabilities
        .get(choice)
        .and_then(Value::as_number)
        .map(js_number);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !criteria.contains_key(choice) || !chosen.is_some_and(|chosen| chosen >= max) {
        return Err("invalid_response_choice");
    }
    Ok(())
}

/// The request URL. `TYPESAFE_CLEF_API_URL` replaces the origin: the HTTP
/// parity tests point it at a local mock, so no test calls Cloudflare.
fn url() -> Option<String> {
    let origin = ledger_db::env::var("TYPESAFE_CLEF_API_URL")
        .ok()
        .filter(|origin| !origin.is_empty())
        .unwrap_or_else(|| "https://api.cloudflare.com".to_owned());
    Some(format!(
        "{origin}/client/v4/accounts/{}/ai/run/@cf/cloudflare/{CLEF_MODEL}",
        clef_account()?
    ))
}

/// `evaluate`. Each failure is the error code that the record stores.
pub(crate) async fn evaluate(
    state: &Value,
    questions: &[(&'static str, Value)],
) -> Result<Evaluated, &'static str> {
    if !is_configured() {
        return Err("unavailable");
    }
    let (Some(url), Some(token)) = (url(), clef_token()) else {
        return Err("unavailable");
    };
    let body = json!({
        "model": CLEF_MODEL,
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
    // `redirect: "error"`: a redirect is a network error.
    let authorization = format!("Bearer {token}");
    let exchange = platform::outbound(async {
        let answer = platform::post_without_redirects(
            &url,
            &[
                ("Authorization", &authorization),
                ("Content-Type", "application/json"),
            ],
            js_stringify(&body),
        )
        .await
        .map_err(|_| "network_error")?;
        if (300..400).contains(&answer.status) {
            return Err("network_error");
        }
        if !(200..300).contains(&answer.status) {
            return Err(if answer.status == 429 {
                "rate_limited"
            } else {
                "provider_error"
            });
        }
        Ok(answer.body)
    });
    let bytes = platform::timeout(TIMEOUT, exchange)
        .await
        .ok_or("timeout")??;
    // Each refusal of the answer has its own code, all starting with
    // `invalid_response`, so that the stored records tell which check failed.
    let parsed: Value = from_json_bytes(&bytes).map_err(|_| "invalid_response_json")?;
    // The Cloudflare API puts the answer in `result`, with `success`.
    if get(&parsed, "success").and_then(Value::as_bool) != Some(true) {
        return Err("provider_error");
    }
    let parsed = get(&parsed, "result").ok_or("invalid_response_schema")?;
    if get(parsed, "model").and_then(Value::as_str) != Some(CLEF_MODEL) {
        return Err("invalid_response_model");
    }
    let (answers, usage) = parse_response(parsed).ok_or("invalid_response_schema")?;
    let mut asked = Map::new();
    for (id, question) in questions {
        let criteria = get(question, "criteria")
            .and_then(Value::as_object)
            .ok_or("invalid_question")?;
        let answer = answers.get(*id).ok_or("invalid_response_missing")?;
        check_answer(answer, criteria)?;
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
        assert_eq!(check_answer(&good, &asked), Ok(()));
        for (bad, code) in [
            (
                json!({ "choice": "none", "probabilities": { "candidate_1": 0.7, "none": 0.3 } }),
                "invalid_response_choice",
            ),
            (
                json!({ "choice": "candidate_1", "probabilities": { "candidate_1": 0.7, "none": 0.2 } }),
                "invalid_response_sum",
            ),
            (
                json!({ "choice": "candidate_1", "probabilities": { "candidate_1": 1 } }),
                "invalid_response_options",
            ),
            (
                json!({ "choice": "other", "probabilities": { "candidate_1": 0.5, "other": 0.5 } }),
                "invalid_response_options",
            ),
            (
                json!({ "choice": "other", "probabilities": { "candidate_1": 0.5, "none": 0.5 } }),
                "invalid_response_choice",
            ),
            (
                json!({ "probabilities": { "candidate_1": 0.5, "none": 0.5 } }),
                "invalid_response_schema",
            ),
        ] {
            assert_eq!(check_answer(&bad, &asked), Err(code), "{bad}");
        }
    }

    /// Clef writes four decimal places, so with many options the sum is
    /// not 1 within 0.001. The check allows that error and no more.
    #[test]
    fn the_sum_allows_the_rounding_of_each_option() {
        let keys: Vec<String> = (0..255).map(|index| format!("o{index}")).collect();
        let asked: Map<String, Value> = keys.iter().map(|key| (key.clone(), Value::Null)).collect();
        // 254 options at 0.0039 and one at 0.0199: the sum is 1.0105.
        let mut probabilities: Map<String, Value> = keys
            .iter()
            .map(|key| (key.clone(), json!(0.0039)))
            .collect();
        probabilities.insert("o0".into(), json!(0.0199));
        let answer = json!({ "choice": "o0", "probabilities": probabilities.clone() });
        assert_eq!(check_answer(&answer, &asked), Ok(()));
        // 0.0299 makes the sum 1.0205, more than the rounding of 255 options.
        probabilities.insert("o0".into(), json!(0.0299));
        let answer = json!({ "choice": "o0", "probabilities": probabilities });
        assert_eq!(check_answer(&answer, &asked), Err("invalid_response_sum"));
        let far = json!({ "choice": "a", "probabilities": { "a": 0.7, "none": 0.2 } });
        assert_eq!(
            check_answer(&far, &criteria(&["a", "none"])),
            Err("invalid_response_sum")
        );
    }

    #[test]
    fn the_response_schema_checks_model_answers_and_usage() {
        let answer = json!({ "type": "choice", "choice": "a", "probabilities": { "a": 1 }, "confidence": 1, "extra": true });
        let (answers, usage) = parse_response(&json!({
            "model": CLEF_MODEL, "answers": { "match": answer },
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
            json!({ "model": CLEF_MODEL, "answers": { "x": { "type": "choice", "choice": "a", "probabilities": { "a": 2 }, "confidence": 1 } } }),
            json!({ "model": CLEF_MODEL, "answers": {}, "usage": null }),
            json!({ "model": CLEF_MODEL, "answers": {}, "usage": { "input_tokens": 1.5, "output_tokens": 0 } }),
        ] {
            assert!(parse_response(&bad).is_none(), "{bad}");
        }
    }
}

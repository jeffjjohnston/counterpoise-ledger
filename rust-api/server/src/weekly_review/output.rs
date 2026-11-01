//! The answer of a weekly review: its JSON schema, and the checks that the
//! server runs before it stores the items. The model can name an ID that is
//! not in the book. The checks remove that ID.

use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

pub(crate) const KINDS: [&str; 2] = ["check", "insight"];
pub(crate) const CATEGORIES: [&str; 7] = [
    "duplicate",
    "missed_payment",
    "unusual_amount",
    "price_change",
    "new_recurring",
    "spending_change",
    "other",
];
pub(crate) const MAX_ITEMS: usize = 12;

/// The schema of `output_config.format`. Structured outputs need each
/// object to list all of its properties as required and to allow no other
/// property. The limit of 12 items is in the prompt and in `checked`.
pub(crate) fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "items"],
        "properties": {
            "summary": { "type": "string" },
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind", "category", "title", "detail", "transactionIds", "recurringRuleId"],
                    "properties": {
                        "kind": { "type": "string", "enum": KINDS },
                        "category": { "type": "string", "enum": CATEGORIES },
                        "title": { "type": "string" },
                        "detail": { "type": "string" },
                        "transactionIds": { "type": "array", "items": { "type": "integer" } },
                        "recurringRuleId": { "type": ["integer", "null"] }
                    }
                }
            }
        }
    })
}

/// One item as the model gave it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawItem {
    pub(crate) kind: String,
    pub(crate) category: String,
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) transaction_ids: Vec<i64>,
    pub(crate) recurring_rule_id: Option<i64>,
}

/// The parsed answer: the summary and the items, in the order of the model.
#[derive(Debug, PartialEq)]
pub(crate) struct Answer {
    pub(crate) summary: String,
    pub(crate) items: Vec<RawItem>,
}

/// Parses the text of the answer. `None` when the text does not match the
/// schema: the whole answer is then `invalid_response`.
pub(crate) fn parse(text: &str) -> Option<Answer> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let summary = object.get("summary")?.as_str()?.trim().to_owned();
    let items = object
        .get("items")?
        .as_array()?
        .iter()
        .map(raw_item)
        .collect::<Option<Vec<_>>>()?;
    Some(Answer { summary, items })
}

fn raw_item(value: &Value) -> Option<RawItem> {
    let object = value.as_object()?;
    let text = |key: &str| Some(object.get(key)?.as_str()?.trim().to_owned());
    let kind = text("kind")?;
    let category = text("category")?;
    let title = text("title")?;
    if !KINDS.contains(&kind.as_str())
        || !CATEGORIES.contains(&category.as_str())
        || title.is_empty()
    {
        return None;
    }
    let transaction_ids = object
        .get("transactionIds")?
        .as_array()?
        .iter()
        .map(Value::as_i64)
        .collect::<Option<Vec<_>>>()?;
    let recurring_rule_id = match object.get("recurringRuleId")? {
        Value::Null => None,
        other => Some(other.as_i64()?),
    };
    Some(RawItem {
        kind,
        category,
        title,
        detail: text("detail")?,
        transaction_ids,
        recurring_rule_id,
    })
}

/// Every transaction ID and every rule ID that the items name, sorted and
/// once each, to look up in the book.
pub(crate) fn named_ids(items: &[RawItem]) -> (Vec<i64>, Vec<i64>) {
    let transactions: BTreeSet<i64> = items
        .iter()
        .flat_map(|item| item.transaction_ids.iter().copied())
        .collect();
    let rules: BTreeSet<i64> = items
        .iter()
        .filter_map(|item| item.recurring_rule_id)
        .collect();
    (
        transactions.into_iter().collect(),
        rules.into_iter().collect(),
    )
}

/// An item that passed the checks.
#[derive(Debug, PartialEq)]
pub(crate) struct Item {
    pub(crate) kind: String,
    pub(crate) category: String,
    pub(crate) title: String,
    pub(crate) detail: String,
    pub(crate) transaction_ids: Vec<i64>,
    pub(crate) recurring_rule_id: Option<i64>,
    pub(crate) fingerprint: String,
}

/// The kind, the category, the sorted transaction IDs and the rule ID. Two
/// items about the same transactions have the same fingerprint.
pub(crate) fn fingerprint(
    kind: &str,
    category: &str,
    transaction_ids: &[i64],
    recurring_rule_id: Option<i64>,
) -> String {
    let ids: BTreeSet<i64> = transaction_ids.iter().copied().collect();
    let ids = ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let rule = recurring_rule_id
        .map(|id| id.to_string())
        .unwrap_or_default();
    format!("{kind}|{category}|{ids}|{rule}")
}

/// The checks before the save, in the order of the spec:
/// 1. remove each ID that is not in `transactions` or `rules` (the IDs of
///    this book);
/// 2. drop a `check` item that names no valid ID;
/// 3. drop an item that names an ID and has the fingerprint of an item that
///    a user dismissed (an item with no ID cannot be matched, so it stays);
/// 4. keep the first `MAX_ITEMS`.
pub(crate) fn checked(
    items: Vec<RawItem>,
    transactions: &HashSet<i64>,
    rules: &HashSet<i64>,
    dismissed: &HashSet<String>,
) -> Vec<Item> {
    items
        .into_iter()
        .filter_map(|item| {
            let ids: BTreeSet<i64> = item
                .transaction_ids
                .into_iter()
                .filter(|id| transactions.contains(id))
                .collect();
            let ids: Vec<i64> = ids.into_iter().collect();
            let rule = item.recurring_rule_id.filter(|id| rules.contains(id));
            let names_an_id = !ids.is_empty() || rule.is_some();
            if item.kind == "check" && !names_an_id {
                return None;
            }
            let fingerprint = fingerprint(&item.kind, &item.category, &ids, rule);
            if names_an_id && dismissed.contains(&fingerprint) {
                return None;
            }
            Some(Item {
                kind: item.kind,
                category: item.category,
                title: item.title,
                detail: item.detail,
                transaction_ids: ids,
                recurring_rule_id: rule,
                fingerprint,
            })
        })
        .take(MAX_ITEMS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(kind: &str, category: &str, ids: &[i64], rule: Option<i64>) -> RawItem {
        RawItem {
            kind: kind.into(),
            category: category.into(),
            title: "Title".into(),
            detail: "Detail.".into(),
            transaction_ids: ids.to_vec(),
            recurring_rule_id: rule,
        }
    }

    fn set(ids: &[i64]) -> HashSet<i64> {
        ids.iter().copied().collect()
    }

    #[test]
    fn parses_an_answer_that_matches_the_schema() {
        let text = json!({
            "summary": " A normal week. ",
            "items": [{
                "kind": "check", "category": "duplicate", "title": "Costco twice",
                "detail": "Two equal rows.", "transactionIds": [3, 2], "recurringRuleId": null
            }]
        })
        .to_string();
        let answer = parse(&text).expect("a valid answer");
        assert_eq!(answer.summary, "A normal week.");
        assert_eq!(
            answer.items,
            vec![RawItem {
                kind: "check".into(),
                category: "duplicate".into(),
                title: "Costco twice".into(),
                detail: "Two equal rows.".into(),
                transaction_ids: vec![3, 2],
                recurring_rule_id: None,
            }]
        );
    }

    #[test]
    fn refuses_an_answer_that_does_not_match_the_schema() {
        for text in [
            "not json",
            r#"{"items": []}"#,
            r#"{"summary": "s", "items": [{"kind": "note", "category": "other", "title": "t", "detail": "d", "transactionIds": [], "recurringRuleId": null}]}"#,
            r#"{"summary": "s", "items": [{"kind": "check", "category": "fraud", "title": "t", "detail": "d", "transactionIds": [], "recurringRuleId": null}]}"#,
            r#"{"summary": "s", "items": [{"kind": "check", "category": "other", "title": "t", "detail": "d", "transactionIds": ["7"], "recurringRuleId": null}]}"#,
            r#"{"summary": "s", "items": [{"kind": "check", "category": "other", "title": "  ", "detail": "d", "transactionIds": [], "recurringRuleId": null}]}"#,
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn removes_unknown_ids_and_drops_a_check_item_with_none_left() {
        let items = vec![
            item("check", "duplicate", &[1, 99], None),
            item("check", "duplicate", &[98], None),
            item("check", "missed_payment", &[], Some(5)),
            item("check", "missed_payment", &[], Some(77)),
            item("insight", "spending_change", &[], None),
        ];
        let kept = checked(items, &set(&[1, 2]), &set(&[5]), &HashSet::new());
        let ids: Vec<(&str, Vec<i64>, Option<i64>)> = kept
            .iter()
            .map(|item| {
                (
                    item.category.as_str(),
                    item.transaction_ids.clone(),
                    item.recurring_rule_id,
                )
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                ("duplicate", vec![1], None),
                ("missed_payment", vec![], Some(5)),
                ("spending_change", vec![], None),
            ]
        );
    }

    #[test]
    fn keeps_at_most_twelve_items() {
        let items = (0..20)
            .map(|_| item("insight", "other", &[], None))
            .collect();
        assert_eq!(
            checked(items, &set(&[]), &set(&[]), &HashSet::new()).len(),
            MAX_ITEMS
        );
    }

    #[test]
    fn the_fingerprint_ignores_the_order_and_repeats_of_ids() {
        assert_eq!(
            fingerprint("check", "duplicate", &[3, 2, 3], None),
            "check|duplicate|2,3|"
        );
        assert_eq!(
            fingerprint("check", "missed_payment", &[], Some(5)),
            "check|missed_payment||5"
        );
    }

    #[test]
    fn drops_an_item_that_the_user_dismissed_before() {
        let dismissed: HashSet<String> = [fingerprint("check", "duplicate", &[1, 2], None)].into();
        let items = vec![
            item("check", "duplicate", &[2, 1], None),
            item("check", "duplicate", &[1], None),
        ];
        let kept = checked(items, &set(&[1, 2]), &set(&[]), &dismissed);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].transaction_ids, vec![1]);
    }

    #[test]
    fn a_dismissed_item_without_ids_does_not_hide_later_items() {
        let dismissed: HashSet<String> =
            [fingerprint("insight", "spending_change", &[], None)].into();
        let kept = checked(
            vec![item("insight", "spending_change", &[], None)],
            &set(&[]),
            &set(&[]),
            &dismissed,
        );
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn named_ids_lists_every_id_once() {
        let items = vec![
            item("check", "duplicate", &[3, 1], Some(4)),
            item("insight", "other", &[1], Some(4)),
        ];
        assert_eq!(named_ids(&items), (vec![1, 3], vec![4]));
    }

    #[test]
    fn the_schema_requires_every_property_and_allows_no_other() {
        let schema = schema();
        assert_eq!(schema["required"], json!(["summary", "items"]));
        assert_eq!(schema["additionalProperties"], json!(false));
        let item = &schema["properties"]["items"]["items"];
        assert_eq!(item["additionalProperties"], json!(false));
        assert_eq!(item["required"].as_array().map(Vec::len), Some(6));
        assert_eq!(item["properties"]["category"]["enum"], json!(CATEGORIES));
    }
}

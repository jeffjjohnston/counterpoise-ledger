//! Generic account tree and label helpers. JSON values retain caller-specific fields.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};

use crate::{collation::compare_names, formatters::account_short_name};

pub const ACCOUNT_TYPE_ORDER: [&str; 5] = ["asset", "liability", "equity", "income", "expense"];
pub const BALANCE_SHEET_TYPES: [&str; 3] = ["asset", "liability", "equity"];
pub const INCOME_STATEMENT_TYPES: [&str; 2] = ["income", "expense"];
const MAX_HIERARCHY_DEPTH: usize = 32;
const MAX_ICON_DEPTH: usize = 32;

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key)?.as_i64()
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn children(value: &Value) -> &[Value] {
    value
        .get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn with_children(value: &Value, nested: Vec<Value>) -> Value {
    let mut clone = value.clone();
    if let Value::Object(object) = &mut clone {
        object.insert("children".into(), Value::Array(nested));
    }
    clone
}

pub fn group_accounts_by_type(accounts: &[Value]) -> Value {
    let mut grouped = Map::new();
    for account in accounts {
        grouped
            .entry(string(account, "type").to_owned())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("array inserted")
            .push(account.clone());
    }
    Value::Object(grouped)
}

pub fn flatten_accounts(accounts: &[Value]) -> Vec<Value> {
    fn walk(nodes: &[Value], output: &mut Vec<Value>) {
        for node in nodes {
            output.push(with_children(node, vec![]));
            walk(children(node), output);
        }
    }
    let mut output = Vec::new();
    walk(accounts, &mut output);
    output
}

pub fn build_account_tree(accounts: &[Value]) -> Vec<Value> {
    let nodes: HashMap<i64, Value> = accounts
        .iter()
        .filter_map(|row| Some((number(row, "id")?, row.clone())))
        .collect();
    let mut children_by_parent: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut roots = Vec::new();
    for row in accounts {
        let Some(id) = number(row, "id") else {
            continue;
        };
        let parent = number(row, "parentId").filter(|id| *id != 0);
        if let Some(parent) = parent.filter(|id| nodes.contains_key(id)) {
            children_by_parent.entry(parent).or_default().push(id);
        } else {
            roots.push(id);
        }
    }
    fn build(
        id: i64,
        nodes: &HashMap<i64, Value>,
        edges: &HashMap<i64, Vec<i64>>,
        seen: &mut HashSet<i64>,
    ) -> Option<Value> {
        if !seen.insert(id) {
            return None;
        }
        let row = nodes.get(&id)?;
        let mut children = edges
            .get(&id)
            .into_iter()
            .flatten()
            .filter_map(|child| build(*child, nodes, edges, seen))
            .collect::<Vec<_>>();
        children.sort_by(|a, b| compare_names(string(a, "name"), string(b, "name")));
        Some(with_children(row, children))
    }
    let mut seen = HashSet::new();
    let mut output = roots
        .into_iter()
        .filter_map(|id| build(id, &nodes, &children_by_parent, &mut seen))
        .collect::<Vec<_>>();
    output.sort_by(|a, b| compare_names(string(a, "name"), string(b, "name")));
    output
}

pub fn flatten_account_tree_with_depth(accounts: &[Value], depth: usize) -> Vec<Value> {
    fn walk(nodes: &[Value], depth: usize, output: &mut Vec<Value>) {
        for node in nodes {
            output.push(json!({ "account": node, "depth": depth }));
            walk(children(node), depth + 1, output);
        }
    }
    let mut output = Vec::new();
    walk(accounts, depth, &mut output);
    output
}

pub fn is_descendant_of(candidate: &Value, ancestor_id: i64, accounts: &[Value]) -> bool {
    let mut current = Some(candidate);
    for _ in 0..MAX_HIERARCHY_DEPTH {
        let Some(row) = current else {
            return false;
        };
        let Some(parent) = number(row, "parentId") else {
            return false;
        };
        if parent == ancestor_id {
            return true;
        }
        current = accounts
            .iter()
            .find(|row| number(row, "id") == Some(parent));
    }
    false
}

pub fn build_account_hierarchy_name(account: &Value, accounts: &[Value]) -> String {
    fn walk(account: &Value, accounts: &[Value], depth: usize) -> String {
        let name = string(account, "name");
        let Some(parent_id) = number(account, "parentId").filter(|id| *id != 0) else {
            return name.into();
        };
        if depth >= MAX_HIERARCHY_DEPTH {
            return name.into();
        }
        let Some(parent) = accounts
            .iter()
            .find(|row| number(row, "id") == Some(parent_id))
        else {
            return name.into();
        };
        if account.get("isInvestmentCash").and_then(Value::as_bool) == Some(true) {
            return walk(parent, accounts, depth + 1);
        }
        format!(
            "{} : {}",
            walk(parent, accounts, depth + 1),
            account_short_name(name)
        )
    }
    walk(account, accounts, 0)
}

fn icon_source<'a>(account: &'a Value, accounts: &'a [Value]) -> Option<&'a Value> {
    let mut current = Some(account);
    for _ in 0..MAX_ICON_DEPTH {
        let row = current?;
        if !string(row, "icon").is_empty() {
            return Some(row);
        }
        let parent = number(row, "parentId")?;
        current = accounts
            .iter()
            .find(|candidate| number(candidate, "id") == Some(parent));
    }
    None
}

pub fn resolve_account_icon(account: &Value, accounts: &[Value]) -> Option<String> {
    icon_source(account, accounts).map(|source| string(source, "icon").to_owned())
}

pub fn resolve_account_icon_source(account: &Value, accounts: &[Value]) -> Value {
    icon_source(account, accounts).map_or(Value::Null, |source| {
        json!({
            "icon": string(source, "icon"), "sourceName": account_short_name(string(source, "name"))
        })
    })
}

pub fn build_category_label_map(accounts: &[Value]) -> Value {
    let mut labels = Map::new();
    for account in accounts {
        if !matches!(string(account, "type"), "income" | "expense") {
            continue;
        }
        let Some(id) = number(account, "id") else {
            continue;
        };
        let title = build_account_hierarchy_name(account, accounts);
        let icon = resolve_account_icon(account, accounts);
        let text = icon.as_ref().map_or_else(
            || title.clone(),
            |_| account_short_name(string(account, "name")).to_owned(),
        );
        labels.insert(
            id.to_string(),
            json!({ "icon": icon, "text": text, "title": title }),
        );
    }
    Value::Object(labels)
}

//! A fake GitHub REST API on a local port, for the tests of this module. It
//! keeps issues in memory and records each request.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(crate) struct World {
    pub(crate) private: bool,
    /// Issue number -> issue JSON, as GitHub returns it.
    pub(crate) issues: Vec<Value>,
    /// Labels that GitHub drops on create (a token that cannot set them).
    pub(crate) drop_labels: bool,
    /// Numbers that answer 404 on GET.
    pub(crate) deleted: Vec<i64>,
    /// When set, every request answers this status.
    pub(crate) fail_with: Option<u16>,
    /// "METHOD path" of each request, in order.
    pub(crate) requests: Vec<String>,
    pub(crate) authorization: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct FakeGitHub {
    pub(crate) world: Arc<Mutex<World>>,
    pub(crate) base_url: String,
}

impl FakeGitHub {
    pub(crate) async fn start(private: bool) -> Self {
        let world = Arc::new(Mutex::new(World {
            private,
            ..World::default()
        }));
        let app = Router::new()
            .route("/repos/{owner}/{name}", get(repo))
            .route("/repos/{owner}/{name}/issues", get(list).post(create))
            .route("/repos/{owner}/{name}/issues/{number}", get(one))
            .with_state(world.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(axum::serve(listener, app).into_future());
        Self { world, base_url }
    }

    pub(crate) fn client(&self) -> super::github::GitHub {
        super::github::GitHub::new(
            Some("owner/repo".into()),
            Some("test-token".into()),
            Some(self.base_url.clone()),
        )
    }

    /// Adds an issue as GitHub stores it and returns its number.
    pub(crate) fn add_issue(
        &self,
        state: &str,
        reason: Option<&str>,
        body: &str,
        labels: &[&str],
    ) -> i64 {
        let mut world = self.world.lock().unwrap();
        let number = world.issues.len() as i64 + 1;
        world
            .issues
            .push(issue_json(number, state, reason, body, labels));
        number
    }

    pub(crate) fn requests(&self) -> Vec<String> {
        self.world.lock().unwrap().requests.clone()
    }
}

fn issue_json(
    number: i64,
    state: &str,
    reason: Option<&str>,
    body: &str,
    labels: &[&str],
) -> Value {
    json!({
        "number": number,
        "state": state,
        "state_reason": reason,
        "body": body,
        "labels": labels.iter().map(|name| json!({"name": name})).collect::<Vec<_>>(),
    })
}

type Shared = State<Arc<Mutex<World>>>;
type Reply = (StatusCode, Json<Value>);

fn record(world: &mut World, headers: &HeaderMap, line: String) -> Option<Reply> {
    world.requests.push(line);
    world.authorization.push(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned(),
    );
    world.fail_with.map(|code| {
        (
            StatusCode::from_u16(code).unwrap(),
            Json(json!({"message": "fake failure"})),
        )
    })
}

async fn repo(
    State(world): Shared,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
) -> Reply {
    let mut world = world.lock().unwrap();
    if let Some(reply) = record(&mut world, &headers, format!("GET /repos/{owner}/{name}")) {
        return reply;
    }
    (StatusCode::OK, Json(json!({"private": world.private})))
}

async fn list(
    State(world): Shared,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Reply {
    let mut world = world.lock().unwrap();
    let page: usize = query.get("page").and_then(|p| p.parse().ok()).unwrap_or(1);
    let per_page: usize = query
        .get("per_page")
        .and_then(|p| p.parse().ok())
        .unwrap_or(30);
    if let Some(reply) = record(
        &mut world,
        &headers,
        format!("GET /repos/{owner}/{name}/issues?page={page}"),
    ) {
        return reply;
    }
    let label = query.get("labels").cloned().unwrap_or_default();
    let matching: Vec<Value> = world
        .issues
        .iter()
        .filter(|issue| issue["state"] == "open")
        .filter(|issue| {
            issue["labels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|l| l["name"] == label.as_str())
        })
        .cloned()
        .collect();
    let start = (page - 1) * per_page;
    let slice = matching
        .into_iter()
        .skip(start)
        .take(per_page)
        .collect::<Vec<_>>();
    (StatusCode::OK, Json(Value::Array(slice)))
}

async fn create(
    State(world): Shared,
    headers: HeaderMap,
    Path((owner, name)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> Reply {
    let mut world = world.lock().unwrap();
    if let Some(reply) = record(
        &mut world,
        &headers,
        format!("POST /repos/{owner}/{name}/issues"),
    ) {
        return reply;
    }
    let number = world.issues.len() as i64 + 1;
    let labels: Vec<&str> = if world.drop_labels {
        Vec::new()
    } else {
        input["labels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap())
            .collect()
    };
    let mut issue = issue_json(
        number,
        "open",
        None,
        input["body"].as_str().unwrap(),
        &labels,
    );
    issue["title"] = input["title"].clone();
    world.issues.push(issue.clone());
    (StatusCode::CREATED, Json(issue))
}

async fn one(
    State(world): Shared,
    headers: HeaderMap,
    Path((owner, name, number)): Path<(String, String, i64)>,
) -> Reply {
    let mut world = world.lock().unwrap();
    if let Some(reply) = record(
        &mut world,
        &headers,
        format!("GET /repos/{owner}/{name}/issues/{number}"),
    ) {
        return reply;
    }
    if world.deleted.contains(&number) {
        return (StatusCode::NOT_FOUND, Json(json!({"message": "Not Found"})));
    }
    match world.issues.iter().find(|issue| issue["number"] == number) {
        Some(issue) => (StatusCode::OK, Json(issue.clone())),
        None => (StatusCode::NOT_FOUND, Json(json!({"message": "Not Found"}))),
    }
}

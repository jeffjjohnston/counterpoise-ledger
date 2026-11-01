//! The issue-sync job: posts new issue reports to a private GitHub repo and
//! reads the state of each issue back (guides/issue-sync.md).
//!
//! One run: check that the repo is private, link the issues that a lost
//! update left without a number, post at most `MAX_POSTS` new reports, then
//! set `resolved` or `wontfix` from the closed issues. A GitHub error stops
//! the run. The next run continues. The marker in each body lets the recover
//! step link an issue that a lost update left without a number. Recover reads
//! only open issues with the label `from-app`. Thus a lost update, followed by
//! a close of that issue (or a removed label) before the next run, gives a
//! second issue for the report.

#[cfg(test)]
mod fake_github;
pub(crate) mod format;
pub(crate) mod github;

use crate::{
    error::{ApiResult, error_owned},
    state::AppState,
};
use axum::{Json, http::StatusCode};
use chrono::{NaiveDateTime, SecondsFormat};
use format::LABEL;
use github::{GitHub, NewIssue};
use ledger_db::{
    Database, Sql,
    store::{self, params},
};
use serde_json::json;

/// Each new issue starts a workflow run. The cap spreads a backlog over
/// hours, so that the runs do not all start at the same time.
const MAX_POSTS: i64 = 3;

#[derive(Default)]
struct Counts {
    linked: u64,
    posted: u64,
    resolved: u64,
    wontfix: u64,
    missing: u64,
}

pub(crate) async fn run_issue_sync(state: &AppState) -> ApiResult {
    if let Some(setting) = state.issue_sync.missing_setting() {
        return Ok(Json(json!({
            "success": true, "skipped": true, "reason": "Issue sync not configured",
            "missingSetting": setting,
        })));
    }
    match sync(&state.database, &state.issue_sync).await {
        Ok(counts) => Ok(Json(json!({
            "success": true,
            "linked": counts.linked,
            "posted": counts.posted,
            "resolved": counts.resolved,
            "wontfix": counts.wontfix,
            "missing": counts.missing,
        }))),
        Err(failure) => {
            tracing::error!(error = %failure, "Issue sync failed");
            Err(error_owned(StatusCode::BAD_GATEWAY, failure))
        }
    }
}

fn database(cause: store::Error) -> String {
    format!("Issue sync database error: {cause}")
}

async fn sync(database: &Database, github: &GitHub) -> Result<Counts, String> {
    github.require_private_repo().await?;
    let mut counts = Counts::default();
    recover(database, github, &mut counts).await?;
    post(database, github, &mut counts).await?;
    sync_back(database, github, &mut counts).await?;
    Ok(counts)
}

/// Links each open issue whose marker names a report with no number. A
/// crash between the POST and the UPDATE leaves such an issue.
async fn recover(database: &Database, github: &GitHub, counts: &mut Counts) -> Result<(), String> {
    for issue in github.open_issues(LABEL).await? {
        let Some(id) = issue.body.as_deref().and_then(format::marker_id) else {
            continue;
        };
        counts.linked += database
            .execute(
                "UPDATE issue_reports SET github_issue_number = ?1 \
                 WHERE id = ?2 AND github_issue_number IS NULL",
                &params![issue.number, id],
            )
            .map_err(self::database)?;
    }
    Ok(())
}

#[derive(ledger_db::store::FromRow)]
struct Pending {
    id: i32,
    description: String,
    r#type: String,
    page: String,
    created_at: NaiveDateTime,
}

async fn post(database: &Database, github: &GitHub, counts: &mut Counts) -> Result<(), String> {
    let pending: Vec<Pending> = database
        .query(
            "SELECT id, description, type, page, created_at FROM issue_reports \
             WHERE status = 'new' AND github_issue_number IS NULL \
             ORDER BY created_at, id LIMIT ?1",
            &params![MAX_POSTS],
        )
        .map_err(self::database)?;
    for row in pending {
        let filed = row
            .created_at
            .and_utc()
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        let report = format::Report {
            id: row.id,
            kind: &row.r#type,
            page: &row.page,
            description: &row.description,
            filed: &filed,
        };
        let issue = github
            .create_issue(&NewIssue {
                title: format::title(&report),
                body: format::body(&report),
                labels: vec![LABEL.to_owned(), row.r#type.clone()],
            })
            .await?;
        database
            .execute(
                "UPDATE issue_reports SET github_issue_number = ?1 WHERE id = ?2",
                &params![issue.number, row.id],
            )
            .map_err(self::database)?;
        counts.posted += 1;
        if !issue.labels.iter().any(|label| label.name == LABEL) {
            return Err(format!(
                "GitHub did not set the label {LABEL} on issue {}. Create the label in the repo, \
                 and give the token permission to set it",
                issue.number
            ));
        }
    }
    Ok(())
}

async fn sync_back(
    database: &Database,
    github: &GitHub,
    counts: &mut Counts,
) -> Result<(), String> {
    let linked: Vec<(i32, i64)> = database
        .query(
            "SELECT id, github_issue_number FROM issue_reports \
             WHERE status = 'new' AND github_issue_number IS NOT NULL ORDER BY id",
            &[],
        )
        .map_err(self::database)?;
    for (id, number) in linked {
        let Some(issue) = github.issue(number).await? else {
            tracing::warn!(report = id, issue = number, "Issue sync: the issue is gone");
            counts.missing += 1;
            continue;
        };
        let status = match (issue.state.as_str(), issue.state_reason.as_deref()) {
            ("closed", Some("completed")) => "resolved",
            ("closed", Some("not_planned")) => "wontfix",
            _ => continue,
        };
        database
            .execute(
                "UPDATE issue_reports SET status = ?1 WHERE id = ?2 AND status = 'new'",
                &params![status, id],
            )
            .map_err(self::database)?;
        if status == "resolved" {
            counts.resolved += 1;
        } else {
            counts.wontfix += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue_sync::fake_github::FakeGitHub;

    async fn state_with(fake: &FakeGitHub) -> AppState {
        let mut state = AppState::in_memory();
        state
            .database
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'h', '2026-01-01 00:00:00')",
                &[],
            )
            .unwrap();
        state.issue_sync = fake.client();
        state
    }

    async fn add_report(state: &AppState, id: i32, at: &str, status: &str, number: Option<i64>) {
        state.database.execute("INSERT INTO issue_reports (id, user_id, description, type, page, status, created_at, github_issue_number) \
             VALUES (?1, 1, ?2, 'bug', '/p', ?3, ?4, ?5)",&params![id, format!("report {id}"), status, at, number])
        .unwrap();
    }

    async fn report(state: &AppState, id: i32) -> (String, Option<i64>) {
        state
            .database
            .query_row(
                "SELECT status, github_issue_number FROM issue_reports WHERE id = ?1",
                &params![id],
            )
            .unwrap()
    }

    fn posts(fake: &FakeGitHub) -> usize {
        fake.requests()
            .iter()
            .filter(|line| line.starts_with("POST "))
            .count()
    }

    #[tokio::test]
    async fn without_settings_it_skips_and_names_the_setting() {
        let fake = FakeGitHub::start(true).await;
        let mut state = state_with(&fake).await;
        state.issue_sync = github::GitHub::new(None, None, Some(fake.base_url.clone()));
        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(body["skipped"], true);
        assert_eq!(body["missingSetting"], "ISSUE_SYNC_GITHUB_REPO");
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn it_posts_new_reports_oldest_first_three_per_run() {
        let fake = FakeGitHub::start(true).await;
        let state = state_with(&fake).await;
        for (id, at) in [
            (5, "2026-10-05"),
            (1, "2026-10-01"),
            (3, "2026-10-03"),
            (2, "2026-10-02"),
        ] {
            add_report(&state, id, &format!("{at} 09:00:00"), "new", None).await;
        }
        add_report(&state, 9, "2026-09-01 09:00:00", "resolved", None).await;

        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(body["posted"], 3);
        assert_eq!(report(&state, 1).await.1, Some(1));
        assert_eq!(report(&state, 2).await.1, Some(2));
        assert_eq!(report(&state, 3).await.1, Some(3));
        assert_eq!(report(&state, 5).await.1, None);
        assert_eq!(report(&state, 9).await.1, None);

        let issue = fake.world.lock().unwrap().issues[0].clone();
        assert_eq!(issue["title"], "App report 1 (bug) on /p");
        assert!(
            issue["body"]
                .as_str()
                .unwrap()
                .ends_with("<!-- counterpoise-report:1 -->\n")
        );
        assert!(
            issue["body"]
                .as_str()
                .unwrap()
                .contains("**Filed:** 2026-10-01T09:00:00Z\n")
        );
        assert_eq!(
            issue["labels"],
            serde_json::json!([{"name": "from-app"}, {"name": "bug"}])
        );

        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(body["posted"], 1);
        assert_eq!(report(&state, 5).await.1, Some(4));
        assert_eq!(posts(&fake), 4);
    }

    #[tokio::test]
    async fn an_issue_from_a_lost_update_is_linked_and_not_posted_again() {
        let fake = FakeGitHub::start(true).await;
        let state = state_with(&fake).await;
        add_report(&state, 7, "2026-10-01 09:00:00", "new", None).await;
        let number = fake.add_issue(
            "open",
            None,
            "x\n<!-- counterpoise-report:7 -->\n",
            &["from-app"],
        );

        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(body["linked"], 1);
        assert_eq!(body["posted"], 0);
        assert_eq!(report(&state, 7).await.1, Some(number));
        assert_eq!(posts(&fake), 0);
    }

    #[tokio::test]
    async fn closed_issues_set_the_report_status() {
        let fake = FakeGitHub::start(true).await;
        let state = state_with(&fake).await;
        let done = fake.add_issue("closed", Some("completed"), "b", &["from-app"]);
        let dropped = fake.add_issue("closed", Some("not_planned"), "b", &["from-app"]);
        let open = fake.add_issue("open", None, "b", &["from-app"]);
        let reopened = fake.add_issue("open", Some("reopened"), "b", &["from-app"]);
        let already = fake.add_issue("closed", Some("completed"), "b", &["from-app"]);
        add_report(&state, 1, "2026-10-01 09:00:00", "new", Some(done)).await;
        add_report(&state, 2, "2026-10-01 09:00:00", "new", Some(dropped)).await;
        add_report(&state, 3, "2026-10-01 09:00:00", "new", Some(open)).await;
        add_report(&state, 4, "2026-10-01 09:00:00", "new", Some(reopened)).await;
        add_report(&state, 5, "2026-10-01 09:00:00", "wontfix", Some(already)).await;

        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(
            (body["resolved"].clone(), body["wontfix"].clone()),
            (1.into(), 1.into())
        );
        assert_eq!(report(&state, 1).await.0, "resolved");
        assert_eq!(report(&state, 2).await.0, "wontfix");
        assert_eq!(report(&state, 3).await.0, "new");
        assert_eq!(report(&state, 4).await.0, "new");
        assert_eq!(report(&state, 5).await.0, "wontfix");
        assert!(
            !fake
                .requests()
                .contains(&format!("GET /repos/owner/repo/issues/{already}"))
        );
    }

    #[tokio::test]
    async fn a_deleted_issue_is_skipped_and_the_run_succeeds() {
        let fake = FakeGitHub::start(true).await;
        let state = state_with(&fake).await;
        let gone = fake.add_issue("open", None, "b", &[]);
        fake.world.lock().unwrap().deleted.push(gone);
        add_report(&state, 1, "2026-10-01 09:00:00", "new", Some(gone)).await;
        let body = run_issue_sync(&state).await.unwrap().0;
        assert_eq!(body["missing"], 1);
        assert_eq!(report(&state, 1).await, ("new".to_owned(), Some(gone)));
    }

    #[tokio::test]
    async fn a_public_repo_stops_the_run_before_any_post() {
        let fake = FakeGitHub::start(false).await;
        let state = state_with(&fake).await;
        add_report(&state, 1, "2026-10-01 09:00:00", "new", None).await;
        let failure = run_issue_sync(&state).await.unwrap_err();
        assert_eq!(
            failure.message(),
            "ISSUE_SYNC_GITHUB_REPO must name a private repo"
        );
        assert_eq!(posts(&fake), 0);
    }

    #[tokio::test]
    async fn a_dropped_label_keeps_the_number_and_fails_the_run() {
        let fake = FakeGitHub::start(true).await;
        let state = state_with(&fake).await;
        fake.world.lock().unwrap().drop_labels = true;
        add_report(&state, 1, "2026-10-01 09:00:00", "new", None).await;
        add_report(&state, 2, "2026-10-02 09:00:00", "new", None).await;
        let failure = run_issue_sync(&state).await.unwrap_err();
        assert_eq!(
            failure.message(),
            "GitHub did not set the label from-app on issue 1. Create the label in the repo, and give the token permission to set it"
        );
        assert_eq!(report(&state, 1).await.1, Some(1));
        assert_eq!(report(&state, 2).await.1, None);
        assert_eq!(posts(&fake), 1);
    }

    #[tokio::test]
    async fn a_github_error_stops_the_run_and_keeps_earlier_numbers() {
        for code in [401, 403, 404, 500] {
            let fake = FakeGitHub::start(true).await;
            let state = state_with(&fake).await;
            add_report(&state, 1, "2026-10-01 09:00:00", "new", None).await;
            let _ = run_issue_sync(&state).await.unwrap();
            add_report(&state, 2, "2026-10-02 09:00:00", "new", None).await;
            fake.world.lock().unwrap().fail_with = Some(code);
            let failure = run_issue_sync(&state).await.unwrap_err();
            assert_eq!(
                failure.message(),
                format!("GitHub answered {code} for GET /repos/owner/repo")
            );
            assert_eq!(report(&state, 1).await.1, Some(1));
            assert_eq!(report(&state, 2).await.1, None);
        }
    }
}

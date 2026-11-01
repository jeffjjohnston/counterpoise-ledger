//! A small client for the GitHub REST API: the four calls that the
//! issue-sync job makes. Settings: `ISSUE_SYNC_GITHUB_REPO` (`owner/name`)
//! and `ISSUE_SYNC_GITHUB_TOKEN`. An error message never holds the token.

use reqwest::{Client, Method, RequestBuilder};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://api.github.com";
/// How long one GitHub request may take.
const TIMEOUT: Duration = Duration::from_secs(30);
const PER_PAGE: usize = 100;
/// A stop for a list that does not end: 50 pages are 5,000 open issues.
const MAX_PAGES: usize = 50;

#[derive(Clone)]
pub(crate) struct GitHub {
    client: Client,
    repo: Option<String>,
    token: Option<String>,
    base_url: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Label {
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Issue {
    pub(crate) number: i64,
    pub(crate) state: String,
    pub(crate) state_reason: Option<String>,
    pub(crate) body: Option<String>,
    #[serde(default)]
    pub(crate) labels: Vec<Label>,
    /// Set when the item is a pull request: the issues list returns both.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Serialize)]
pub(crate) struct NewIssue {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) labels: Vec<String>,
}

#[derive(Deserialize)]
struct Repo {
    private: bool,
}

impl GitHub {
    pub(crate) fn from_env() -> Self {
        Self::new(
            ledger_db::env::var("ISSUE_SYNC_GITHUB_REPO").ok(),
            ledger_db::env::var("ISSUE_SYNC_GITHUB_TOKEN").ok(),
            None,
        )
    }

    /// `base_url` replaces `https://api.github.com`. Only the tests set it.
    pub(crate) fn new(
        repo: Option<String>,
        token: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        Self {
            client: crate::platform::http_client(),
            repo: repo.filter(|repo| !repo.is_empty()),
            token: token.filter(|token| !token.is_empty()),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_owned()),
        }
    }

    /// The first setting that is not set, or `None` when the job can run.
    pub(crate) fn missing_setting(&self) -> Option<&'static str> {
        if self.repo.is_none() {
            Some("ISSUE_SYNC_GITHUB_REPO")
        } else if self.token.is_none() {
            Some("ISSUE_SYNC_GITHUB_TOKEN")
        } else {
            None
        }
    }

    /// Fails unless the repo exists and is private. Issue text can hold
    /// financial details, so the job never posts to a public repo.
    pub(crate) async fn require_private_repo(&self) -> Result<(), String> {
        let path = format!("/repos/{}", self.repo()?);
        let repo: Repo = self.send(Method::GET, &path, |request| request).await?;
        if repo.private {
            Ok(())
        } else {
            Err("ISSUE_SYNC_GITHUB_REPO must name a private repo".to_owned())
        }
    }

    /// The open issues with `label`, oldest number first. Pull requests are
    /// left out.
    pub(crate) async fn open_issues(&self, label: &str) -> Result<Vec<Issue>, String> {
        let path = format!("/repos/{}/issues", self.repo()?);
        let mut all = Vec::new();
        for page in 1..=MAX_PAGES {
            let batch: Vec<Issue> = self
                .send(Method::GET, &path, |request| {
                    request.query(&[
                        ("state", "open"),
                        ("labels", label),
                        ("sort", "created"),
                        ("direction", "asc"),
                        ("per_page", &PER_PAGE.to_string()),
                        ("page", &page.to_string()),
                    ])
                })
                .await?;
            let last = batch.len() < PER_PAGE;
            all.extend(
                batch
                    .into_iter()
                    .filter(|issue| issue.pull_request.is_none()),
            );
            if last {
                break;
            }
        }
        Ok(all)
    }

    pub(crate) async fn create_issue(&self, issue: &NewIssue) -> Result<Issue, String> {
        let path = format!("/repos/{}/issues", self.repo()?);
        self.send(Method::POST, &path, |request| request.json(issue))
            .await
    }

    /// The issue, or `None` when GitHub answers 404 or 410 (the issue was
    /// deleted or moved).
    pub(crate) async fn issue(&self, number: i64) -> Result<Option<Issue>, String> {
        let path = format!("/repos/{}/issues/{number}", self.repo()?);
        match self.send(Method::GET, &path, |request| request).await {
            Ok(issue) => Ok(Some(issue)),
            Err(failure)
                if failure.starts_with("GitHub answered 404 ")
                    || failure.starts_with("GitHub answered 410 ") =>
            {
                Ok(None)
            }
            Err(failure) => Err(failure),
        }
    }

    fn repo(&self) -> Result<&str, String> {
        let repo = self.repo.as_deref().unwrap_or("");
        let part = |text: &str| {
            !text.is_empty()
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        match repo.split_once('/') {
            Some((owner, name)) if part(owner) && part(name) => Ok(repo),
            _ => Err("ISSUE_SYNC_GITHUB_REPO must be owner/name".to_owned()),
        }
    }

    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        build: impl FnOnce(RequestBuilder) -> RequestBuilder + Send,
    ) -> Result<T, String> {
        crate::platform::outbound(async {
            let request = self
                .client
                .request(method.clone(), format!("{}{path}", self.base_url))
                .timeout(TIMEOUT)
                .bearer_auth(self.token.as_deref().unwrap_or(""))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "counterpoise-issue-sync");
            let response = build(request).send().await.map_err(|cause| {
                format!(
                    "GitHub request failed for {method} {path}: {}",
                    cause.without_url()
                )
            })?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!(
                    "GitHub answered {} for {method} {path}",
                    status.as_u16()
                ));
            }
            response.json::<T>().await.map_err(|cause| {
                format!(
                    "GitHub sent an unexpected body for {method} {path}: {}",
                    cause.without_url()
                )
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue_sync::fake_github::FakeGitHub;

    #[test]
    fn each_missing_setting_is_named() {
        let both = GitHub::new(None, None, None);
        assert_eq!(both.missing_setting(), Some("ISSUE_SYNC_GITHUB_REPO"));
        let token = GitHub::new(Some("o/r".into()), Some(String::new()), None);
        assert_eq!(token.missing_setting(), Some("ISSUE_SYNC_GITHUB_TOKEN"));
        let ok = GitHub::new(Some("o/r".into()), Some("t".into()), None);
        assert_eq!(ok.missing_setting(), None);
    }

    #[tokio::test]
    async fn a_repo_that_is_not_owner_slash_name_is_refused_without_a_request() {
        let fake = FakeGitHub::start(true).await;
        for repo in ["owner", "owner/", "/repo", "a/b/c", "owner/re po"] {
            let client = GitHub::new(
                Some(repo.into()),
                Some("t".into()),
                Some(fake.base_url.clone()),
            );
            let failure = client.require_private_repo().await.unwrap_err();
            assert!(failure.contains("ISSUE_SYNC_GITHUB_REPO"), "{failure}");
        }
        assert!(fake.requests().is_empty());
    }

    #[tokio::test]
    async fn a_public_repo_is_refused() {
        let fake = FakeGitHub::start(false).await;
        let failure = fake.client().require_private_repo().await.unwrap_err();
        assert_eq!(failure, "ISSUE_SYNC_GITHUB_REPO must name a private repo");
    }

    #[tokio::test]
    async fn requests_carry_the_token_and_the_api_headers() {
        let fake = FakeGitHub::start(true).await;
        fake.client().require_private_repo().await.unwrap();
        assert_eq!(
            fake.world.lock().unwrap().authorization,
            ["Bearer test-token"]
        );
    }

    #[tokio::test]
    async fn open_issues_reads_every_page_and_skips_pull_requests() {
        let fake = FakeGitHub::start(true).await;
        for _ in 0..150 {
            fake.add_issue("open", None, "b", &["from-app"]);
        }
        fake.add_issue("open", None, "b", &["other"]);
        {
            let mut world = fake.world.lock().unwrap();
            world.issues[0]["pull_request"] = serde_json::json!({"url": "x"});
        }
        let issues = fake.client().open_issues("from-app").await.unwrap();
        assert_eq!(issues.len(), 149);
        assert_eq!(
            fake.requests(),
            [
                "GET /repos/owner/repo/issues?page=1",
                "GET /repos/owner/repo/issues?page=2",
            ]
        );
    }

    #[tokio::test]
    async fn a_deleted_issue_reads_as_none() {
        let fake = FakeGitHub::start(true).await;
        let number = fake.add_issue("open", None, "b", &[]);
        fake.world.lock().unwrap().deleted.push(number);
        assert!(fake.client().issue(number).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn an_error_names_the_status_and_the_request_but_not_the_token() {
        let fake = FakeGitHub::start(true).await;
        fake.world.lock().unwrap().fail_with = Some(401);
        let failure = fake.client().require_private_repo().await.unwrap_err();
        assert_eq!(failure, "GitHub answered 401 for GET /repos/owner/repo");
        assert!(!failure.contains("test-token"));
    }
}

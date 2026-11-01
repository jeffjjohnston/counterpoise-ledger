-- The number of the GitHub issue that the issue-sync job opened for this
-- report (guides/issue-sync.md). NULL until the job posts the report, and on
-- every install that does not configure the job.
ALTER TABLE issue_reports ADD COLUMN github_issue_number INTEGER;

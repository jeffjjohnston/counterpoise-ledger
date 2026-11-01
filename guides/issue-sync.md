# Issue sync

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

## What it does

Each hour at :30, the `issue-sync` job of the server:

1. Reads the configured repo. If the repo is not private, the run stops.
2. Links each open issue with the label `from-app` whose marker names a
   report without an issue number. This repairs a run that stopped between
   the POST and the database write.
3. Posts at most 3 reports with status `new` and no issue number, oldest
   first, as issues with the labels `from-app` and the report type.
4. For each linked report with status `new`, reads the issue. Closed as
   completed sets `resolved`. Closed as not planned sets `wontfix`.

A GitHub error stops the run, and `/api/system/status` shows it. The next run
continues. The marker on the last line of each body,
`<!-- counterpoise-report:<id> -->`, lets step 2 link an issue that a lost
database write left without a number. Step 2 reads only open issues with the
label `from-app`. If such an issue closes, or loses the label, before the
next run, the job posts a second issue for the report.

The body holds at most 60,000 characters of the description and 500 of the
page, because GitHub refuses a body over 65,536 characters. The full body is
at most 65,000 characters. A long backtick run in the description makes a
long fence, so the job can then post less than 60,000 characters. A cut
description gets a line that says so. Read the full text in the app. The
title replaces each control character and line break in the page with a
space.

The code is in `rust-api/server/src/issue_sync/`. The column is
`issue_reports.github_issue_number`.

## Settings

| Setting | Value |
| --- | --- |
| `ISSUE_SYNC_GITHUB_REPO` | `owner/name` of a **private** repo |
| `ISSUE_SYNC_GITHUB_TOKEN` | A fine-grained personal access token: this one repo, Issues read and write |

Without both, the job does nothing and the status page shows "not
configured". An install that does not use GitHub needs no action.

## Data posted

Each issue holds the report ID, the type, the page, the time of the report
and the description. It does not name the reporter: find the user from the
report ID. The description is in a fenced code block and the page in a code
span, so that `@name` does not notify a GitHub user. No report ID has `#`
before it, because GitHub links `#17` to issue 17.

The description can hold financial details. Never point the job at a public
repo. The job refuses one, but the setting is the first defence.

The run logs of the workflow that fixes the issues show the full output of
both Claude sessions, so they hold the description too. They are as private
as the repo.

## Before the first run

1. Create the labels `from-app`, `needs-owner`, `bug`, `improvement` and
   `other` in the repo. GitHub drops a label that the token cannot create,
   and the job then fails with a message that says so. The workflow adds
   `needs-owner` with a command that fails on a label that does not exist.
   The last three are the report types.
2. Set the two settings in the production environment file and restart the
   server.
3. Expect a backlog: the first runs post the old `new` reports, 3 an hour.

**After a database restore:** a snapshot can be older than the open issues.
New reports then get IDs that open `from-app` issues already name, and step 2
links each new report to the old issue. After a restore, close the old open
`from-app` issues, or remove their label, before the next run.

## From an issue to a merged pull request

A private workflow of the repo acts on each issue from the job. It has five
jobs.

1. **fix.** Claude follows the `issue-triage` skill, section "From a GitHub
   issue". It has a read-only token and no git credentials. It commits a fix
   and writes its outcome: `fix`, `needs_input` (a question for the owner) or
   `no_fix`.
   The job builds the CLI and the WASM bindings first, so that Claude can
   run tsc and the tests.
2. **open-pr.** Plain steps, no Claude, with the owner's token. A script from
   `dev` (`open`) decides from the outcome. For a
   fix, the job pushes the branch `issue-fix/<issue>`, opens the pull request
   to `dev` without auto-merge, and comments `@codex review`. If an earlier
   run left auto-merge on, the job turns it off before the push. It records
   the commit that it pushed, and the ID and the time of the request.
3. **await-codex.** Plain steps, read-only. The Codex reply script
   polls the pull request every 30 seconds until Codex replies, or until the
   timeout. Only the first review or comment by the Codex bot after the
   request counts. A review counts only when it is a review of the commit
   that open-pr pushed. The script ignores a review of another commit, and
   continues to wait. An earlier run can have a request with no reply yet.
   Then a comment from Codex can be the reply to that request, so the
   comment does not count: the status is `unavailable`. A review is
   `reviewed`. The comment that says Codex found no major issues is `clean`.
   Any other comment, or no reply, is `unavailable`.
   When a review starts, Codex posts a status comment (it starts with
   `<!-- codex-pull-request-review-summary -->`) and edits it while the
   review runs. The state in it names the commit. This comment is not the
   reply: the script continues to wait. When the state says that the review
   of the pushed commit completed with no findings, the status is `clean`.
   With findings, the review comes after the status comment. Run 38969791604
   stopped for the owner on this comment, before the script knew it, about
   90 seconds before the review came.
4. **address.** A separate Claude session follows the `issue-triage` skill,
   section "Address a Codex review". It runs only for `reviewed` or `clean`.
   It judges each Codex finding: it fixes it with a commit, or rejects it with
   a reason. It also checks the fix: the cause, a regression test, the rules,
   the scope and no secrets. It writes a verdict: `approve`, `reject` or
   `needs_input`. Before it starts, the job applies the fix, then resets
   `CLAUDE.md`, `AGENTS.md`, the guides, `.claude/`, the agent instruction
   directory and the issue-tracking page that the session hook reads to their
   `dev` versions, in a commit of its own. It deletes each `.mcp.json` and
   each `CLAUDE.local.md`, and gets the issue from GitHub again. The workflow
   never pushes the reset commit. After the session, the job fails when the
   session left a change that it did not commit, or moved HEAD off the fix.
5. **publish.** Plain steps, no Claude, with the owner's token. It applies the
   follow-up commits on the commit that open-pr pushed. A script from `dev`
   (`publish`) decides from the Codex reply, the
   verdict and the changed files. The job posts the judgments on the pull
   request as one comment.

Both Claude sessions use Opus 5.5 (`--model claude-opus-5-5`) at high
effort, in auto mode. The workflow sets the model, so the default model of
the account does not apply. In auto mode, a classifier decides each tool call
that the allow list does not name. Nobody can answer a prompt, so a call that
would prompt is refused (`--permission-prompts none`). The address session
has the same tools as the fix session. That does not reach the pull request
directly: the publish job applies only the follow-up patch, and reads only the
verdict, by the artifact ID of the address job. But code from the fix runs in
the address job: the build, the tests, and programs from the Rust cache. That
code can change the verdict or the follow-up. The check that the verdict
judges each Codex finding, the protected paths and CI still apply.

Codex reviews on the owner's ChatGPT plan, through the Codex GitHub app. It
reports only P0 and P1 issues. Codex reviews once: it does not review the
follow-up commits. A deeper local Codex review happens at release.

The fix job records the commit of `dev` that it checked out, before any other
step runs. The later jobs use that commit only when it is a full commit ID on
`dev`. If not, the address job fails, and the jobs that write do not apply a
patch and stop for the owner.

The decision of publish is one of three:

- **Auto-merge.** Codex replied with `reviewed` or `clean`. The verdict is
  valid and says `approve`. It judges each Codex finding exactly once. The
  follow-up applied. No protected path changed, in the fix or in the
  follow-up. The job pushes the follow-up, turns on auto-merge (squash), and
  removes the label `needs-owner`. With `--match-head-commit`, GitHub turns
  on auto-merge only when the head of the pull request is the commit that
  the job pushed. This does not stop a later push. open-pr turns auto-merge
  off before each push, and only the workflow pushes to the branch. The pull
  request merges when CI passes.
- **Pull request for the owner.** The verdict is valid, but it says `reject`
  or `needs_input`, or a finding has no judgment, or a protected path changed
  (not under `.github/`). The job pushes the follow-up without auto-merge. The
  issue gets the label `needs-owner` and a comment with the reasons.
- **Comment for the owner.** No push of the follow-up. The issue gets the
  label `needs-owner` and a comment with the reason and a link to the run.
  This is the decision when Codex is `unavailable` (the comment quotes the
  Codex text), when the address job failed or its verdict is not valid, when
  the follow-up does not apply, when the follow-up changes a path under
  `.github/`, and when the base is not on `dev`.

open-pr stops for the owner without a push for `needs_input`, `no_fix`, a
failed fix job, a missing or invalid result, a base commit that is not on
`dev`, a fix that changes no file, a patch that does not apply, and a fix that
changes a path under `.github/`.

Protected paths: migrations, `.github/`, `.claude/`, `scripts/`, the Docker
files, the npm and Cargo manifests and lock files, the auth and OAuth code,
the files that gate what the public mirror gets, the agent instruction
directory, `.gitleaks.toml`, and in each directory `CLAUDE.md`,
`CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.npmrc`, `.cargo/`, `build.rs`
and `rust-toolchain*`. A moved file counts at its old path and at its new
path. A path with non-ASCII characters counts as it is. A change there always waits
for the owner. A change under `.github/` is never pushed. `guides/` and
`hooks/` are not protected.

**To answer or restart:** reply on the issue. A comment by the owner on an
issue with `needs-owner` runs the workflow again, with the comments as
context. The workflow's own comments end with `<!-- issue-fix-bot -->`, and
they do not start it.

**The branch belongs to the workflow:** the open-pr job of each run
force-pushes `issue-fix/<issue>`, and replaces what is there. Do not push
your own commits to that branch. Merge the pull request, or edit it after
the last run.

**Known limit:** if two owner replies arrive while a run is busy, one can be
lost. Reply again.

**A newer run:** a reply by the owner can start a new run while a run waits
for Codex. The new run force-pushes the branch. The publish job of the older
run then sees that the branch is not at its own push, and does nothing.

**Codex did not reply:** reply on the issue, for example "try again". The
workflow then runs from the start: a new fix, a new push and a new
`@codex review`.

**Open pull request:** open-pr opens the pull request before the review, so a
run that stops for the owner leaves the pull request open without auto-merge.
Close it by hand if it is no longer wanted.

**When CI fails:** auto-merge does not happen, and GitHub notifies the owner.
The issue does not have the label `needs-owner`, so a reply does not start
the workflow. Add the label `needs-owner` to the issue, then reply.

**Which copy runs:** GitHub runs a workflow for `issues` and `issue_comment`
events from the default branch, `main`. The workflow does nothing until a
release puts it on `main`. After that, GitHub runs the `main` copy of the
workflow, and the jobs check out `dev` for the decision script, the
instructions and the code. A change to the workflow takes effect at the next
release.

The squash merge into `dev` keeps the commit messages, and the release merge
into `main` keeps the commits. The issue closes when the release reaches
`main`, and the next run sets the report to `resolved`. Releases and deploys
stay manual.

## Repo setup for the workflow

- A ruleset on `dev`: require a pull request with 0 approvals (the pull
  requests come from the owner's token, and the owner cannot approve their
  own), and require the CI checks.
- The account of `ISSUE_FIX_TOKEN` must not be a bypass actor on that
  ruleset. For a bypass actor, auto-merge can merge the pull request before
  the CI checks pass. If the owner must push to `dev` directly,
  and thus is a bypass actor, use a separate account or a GitHub App for
  `ISSUE_FIX_TOKEN`. Otherwise accept that auto-merge can merge before CI.
- "Allow auto-merge" on.
- Secret `CLAUDE_CODE_OAUTH_TOKEN`, from `claude setup-token`. The runs use
  the owner's Claude subscription limits.
- Secret `ISSUE_FIX_TOKEN`: a fine-grained token of the owner, this repo
  only, Contents, Pull requests and Issues read and write. It must never have
  the Workflows permission.
- Variable `ISSUE_SYNC_AUTHOR`: the owner's login.
- The repo connected to Codex cloud, with code review on and automatic
  review off. The workflow asks for each review with `@codex review`, from
  the account of `ISSUE_FIX_TOKEN`. Codex must accept a request from that
  account.
- Variable `CODEX_BOT_LOGIN`: the login of the Codex bot. Without it, the
  workflow uses `chatgpt-codex-connector[bot]`.
- Optional variable `ISSUE_FIX_CODEX_TIMEOUT`: the minutes that await-codex
  waits for Codex. Default 20, at most 30.

Each run uses Actions minutes of the private repo. A Rust build cache keeps
later runs shorter. The await-codex job waits while Codex works, often 5 to 15
minutes.

The fix job saves that cache, and the fix job runs code from the fix. A bad
fix can thus put bad files in the cache, and later fix runs read them.
The address job reads it and does not save it. No other workflow reads it.
This risk is accepted. To clear the cache, run `gh cache delete --all` in the
repo, or delete the caches on the Actions page.

Three risks are accepted because only trusted people file reports: CI for
these pull requests runs before a person reads the code, code in the fix job
can read the Claude token, and code from the fix runs in the address job (the
build, the tests, and programs from the Rust cache), where it can change the
verdict or the follow-up. The check that the verdict judges each Codex
finding, the protected paths and CI still apply.

## Check it end to end

Do this once after each release that changes the workflow, on production,
with a real report:

1. File a report with a clear, small bug.
2. Wait for the issue (the issue-sync job runs at :30).
3. Check the pull request: it opens without auto-merge, and has the comment
   `@codex review`.
4. Check the await-codex job: the status, and the login of the Codex reply.
   If the login is not `chatgpt-codex-connector[bot]`, set `CODEX_BOT_LOGIN`.
   If Codex found nothing, check that its status comment says `completed`
   with `"has_any_findings":false`, or that its text matches the clean
   pattern of the Codex reply script. For a review, confirm that the commit of the
   review (its `commit_id`) is the commit that open-pr pushed.
5. Check the address job: the verdict and the follow-up commits.
6. Check the comment with the judgments on the pull request, and that
   auto-merge waits for CI.
7. The paths that real reports prove later: Codex `unavailable` (the comment
   quotes Codex), a `needs-owner` reply that runs the workflow again, and an
   issue closed as not planned, which sets the report to `wontfix`.

# Release & Deploy Workflow

One of the guides [CLAUDE.md](../CLAUDE.md) points to. Read that file first;
it carries the rules that apply everywhere and says when to come here.

Uses semantic versioning. Feature PRs are **squash-merged into `dev`**; the
release PR is **merge-committed into `main`**, and `main` is then merged back
into `dev`.

```
dev branch (daily work)
    │
    │  cut a release checkout at the exact dev commit you are releasing
    ▼
./scripts/release.sh patch     ← run IN THAT CHECKOUT: bumps the version there,
    │                            names and pushes release/vX.Y.Z, opens the PR
    ▼
GitHub PR: release/vX.Y.Z → main   ← CI runs; review; fix on the release branch
    │
    ▼
MERGE the PR (a merge commit)   ← never squash: the release commits have to stay
    │                             in the ancestry of main
    ▼
./scripts/deploy.sh --ref <the merge commit>
    │                          ← target docker: publishes tag vX.Y.Z once, at
    │                            that commit, builds the image and restarts the
    │                            container; the server applies the migrations as
    │                            it starts. Target worker: the merge already
    │                            started worker-release.yml, which publishes the
    │                            tag and deploys; deploy.sh waits for that run
    ▼
PR: main → dev, merged (not squashed)   ← carries the bump and any release fix
                                          back without rewriting dev
```

**Why it is shaped like this.** The previous flow squash-merged the release into
`main` and then rebased `dev` onto that replacement history and force-pushed it.
A squash lands a NEW commit whose parents do not include the release commits,
so nothing on `main` descends from them. The shared history further back
remains, and an ordinary merge still works; what it produces is the same
conflicts over and over, because the squashed content keeps arriving as
unrelated changes. The team reached for a rebase instead — at the cost of
changing every commit id under every agent holding a
branch off `dev`. Merging preserves the ancestry, so the reconciliation is an
ordinary merge and nothing is rewritten. GitHub documents the repeated-conflict
problem that squash-merging a long-running branch produces:
[pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges).

**Key details:**

- **Version semantics**: `patch` (bug fixes), `minor` (new features), `major` (breaking changes)
- **`release.sh` runs in a release checkout, never on `dev` or `main`.** It reads
  the current branch and refuses on either of those by name, naming the
  `git worktree add` command as the remedy. The refusal comes before the checks
  and before the bump, so a run from the wrong branch changes nothing. A
  detached HEAD is the expected starting state: the branch name carries the
  version, which is not knowable until the bump has written `package.json`, so
  `release.sh` names the branch itself afterwards.
- **The release checkout needs the Rust and WASM toolchains.** The pre-release
  checks first run `npm run core:wasm:build` so a fresh checkout has the ignored
  browser bindings before lint and TypeScript checking. See
  [testing.md](testing.md) for the WASM tools. `--skip-checks` skips this build
  along with the checks the caller already ran. After the bump,
  `release.sh` runs `npm run openapi:generate`, which builds and runs
  `counterpoise-rust-api openapi` with `cargo`. The document carries the
  package version, so the release commit includes the regenerated
  `openapi/openapi.json`.
- **The version tag is published once, and never moves.** `release.sh` creates
  no tag at all. On the Docker target `deploy.sh` creates it; on the Worker
  target `scripts/release-tag.sh` in `worker-release.yml` does. Each creates
  it annotated, against the commit the PR actually merged, and pushes it
  **without `--force`**. A re-deploy of the same commit leaves it alone; a tag already
  pointing somewhere else is a refusal, not a force-push. So a clone that
  fetched the tag is never contradicted, and a plain `git fetch` is the whole
  of catching up.
- **Reading a tag is not reading a commit.** `git rev-parse v1.2.3` on an
  *annotated* tag returns the tag **object**, not the commit — so comparing it
  against a branch reports "not on main" for a reason that has nothing to do
  with the release. Peel it: `git rev-parse 'v1.2.3^{}'`, and check the type
  with `git cat-file -t v1.2.3`. This conflation has produced one wrong bug
  report already, and `%(contents)` has the matching trap — on a lightweight tag
  it returns the *commit* message.
- **`deploy.sh` deploys one named commit and touches nothing else.** It requires
  `--ref`, and refuses a commit that is not on `origin/main`. Then it
  publishes the tag and rebuilds (target `docker`), or waits for the
  `worker-release.yml` run that publishes the tag and deploys (target
  `worker`). The version is read out of the commit with `git show`, not out
  of a checkout. **The early refusals run before anything moves**, but not all
  of them: production's `main` is fast-forwarded to the deploy commit before
  the tree check and the Compose validation, so a refusal from either of those
  leaves that checkout advanced. Nothing is published or restarted, and the
  next run fast-forwards to the same commit, but the checkout is not restored. It does **not** rebase `dev`, force-push, keep a resume file, or take a fork
  point. If `.git/DEPLOY_FORK_POINT` exists, it refuses: that file marks a deploy
  that expects a `dev` rebase, which this script does not perform.
- **`COUNTERPOISE_DEPLOY_TARGET` says where production runs.** The value is
  `docker` (the default) or `worker`. Set it in the environment, or in one
  line of the gitignored `.env.deploy.local` at the dev checkout root:
  `COUNTERPOISE_DEPLOY_TARGET=worker`. The environment wins. The script reads
  only that one key and does not source the file. Any other value is a
  refusal. `scripts/lib/deploy-target.sh` holds the rule, one time, so a
  script that calls `deploy.sh` can read the same target. An install on its
  own machine keeps `docker`, and everything below about the production
  checkout, Compose and the volume is for that target. For `worker`, see
  [The Cloudflare Worker deploy](#the-cloudflare-worker-deploy).
- **Production owns its checkout and configuration.** Builds and production
  Compose run in a separate checkout on `main`. The default is
  `~/counterpoise-production`. `COUNTERPOISE_BUILD_DIR` can name another
  directory. Set it in the environment. Or set it in the gitignored
  `.env.deploy.local` at the dev checkout root, in one line:
  `COUNTERPOISE_BUILD_DIR=~/path`. The environment wins. The directory must
  already be a clone of the same origin. It must have its own
  `.env.production.local` and `backups/`.
  No credentials are copied from development. Development needs no Docker;
  production uses `docker-compose.yml`, with its data in the external volume
  `counterpoise_data`.
- **The deploy refuses an install that has not converted to SQLite.** It
  refuses when the `counterpoise_data` volume does not exist, and when
  `.env.production.local` still sets `DATABASE_URL` and the volume holds no
  `counterpoise.db` (the test of the upgrade script of v1.50.0). The check
  runs before the production checkout moves and before the tag is published,
  so a refusal changes nothing. Convert the data with v1.50.0 in the
  production checkout first: this release does not have the converter (see
  [upgrade-to-sqlite.md](upgrade-to-sqlite.md)).
  A new install creates the volume once with
  `docker volume create counterpoise_data`.
- **The requested SHA must fast-forward production's `main`.** The deploy
  validates that the SHA landed on `origin/main`, then fast-forwards to that
  exact commit. It refuses another branch, a rewind or divergent history.
  An advancing `origin/main` does not change the requested deploy SHA.
- **Unexpected production files are refused and preserved.** This includes
  tracked changes and ignored nested checkouts that would contaminate the Docker
  context. The env file and `backups/` are permitted; deployment never runs a
  destructive clean. A missing or invalid production configuration stops the
  deploy before a version tag is published or containers are restarted.
- **Backups default to the production checkout's `backups/`.** The deploy passes
  the resolved absolute path to the `rust-api` service, which mounts it
  read-write at `/backups`. The server writes the hourly snapshots
  (`counterpoise-*.db`) there. An older release also kept the job status
  records in `status/`; the server copies them into its database once. The
  directory must be writable by uid 1000, the user of the image.
  `COUNTERPOISE_BACKUPS_DIR` can
  name another existing absolute directory; a missing directory is refused so
  Docker cannot silently create an empty backup destination.
- **Resuming a failed deploy**: run the same command again. Every stage is
  idempotent — the tag is already at the right commit or is created, and the
  production checkout remains on `main` at the selected commit and its files
  are checked again. This checkout is never moved at all, so there is no
  branch to restore and a crash cannot strand it; the failed stage is named. `--yes`
  skips the confirmation a *repeat* deploy asks for; without a terminal, an
  unanswered prompt exits non-zero rather than reporting a deploy that did not
  happen.
- **`dev` is reconciled by merging, never by rewriting.** After the deploy, merge
  `main` into `dev` through an ordinary PR. **Do not squash it**: recording the
  shared ancestry is the point, and a squash would put the two branches back
  into the state that required the rebase. A conflict there is expected whenever
  `dev` moved during the release, and it is resolved by hand — never by rebasing
  or force-pushing `dev`.
- **A deploy that succeeded and a back-merge that is blocked is a real state.**
  Production is running the new version and `dev` does not have it yet. The two
  are reported apart, and the recovery for the second is resolving the pull
  request, not repeating the first.
- **Merge commits must be enabled on the repository.** `gh pr merge --merge`
  fails outright otherwise, and it would fail at the merge — after the bump, the
  push and the whole CI run. `gh repo edit --enable-merge-commit` turns it on;
  `gh repo view --json mergeCommitAllowed` reports it.
- **CI** (the workflow file itself is maintainer tooling and is not published;
  a fork supplies its own). It runs on every PR to **main
  and to dev** — lint, type-check, the tests (each on its own SQLite files),
  and a `static-checks` job whose build step runs `npm run build` (the Vite
  client build) with **no database service**, as `docker build` does. That
  job also runs lint, the type check and the vacuity pass, each as its own
  step, so the short checks share one machine and one setup. The build step was
  added when a page that queried the database at build time passed E2E (which
  has one) and failed `docker build` (which does not). The back-merge PR targets `dev`, so it is
  checked as a feature PR is, with one difference. Its head is the release
  merge on `main`, so it also shows the checks of the `worker-release.yml`
  run on that commit. The back-merge does not count those checks: that run
  deploys and does not test the merge into `dev`. On v1.60.2 its failed
  deploy blocked a back-merge whose CI passed. A CI job that only the release
  run reports is missing, and a missing job still refuses.
- **CI keeps its build output and downloads on the CI machine.** The CI
  machines keep their home directory from job to job. Each job that runs Cargo
  links `rust-api/target` to a directory there, keyed by machine, toolchain and
  checkout path, because the checkout clean deletes `rust-api/target` before
  each job. Cargo still checks every crate and builds again what changed. npm
  and Playwright use their own caches in the home directory; no job restores a
  remote cache, and E2E installs only Chromium's headless shell. A machine
  with an empty home directory downloads and builds everything, and takes
  longer, but runs the same checks. The fork example
  (`.github/workflows/ci.yml.example`) runs on hosted machines that start empty, so it keeps
  `cache: npm`.
- **Third-party code changes only through a reviewed commit.** Each `uses:`
  in a workflow names a commit SHA, with the version as a comment, because a
  tag or a branch can move to new code. Each image in the `Dockerfile`,
  and its `# syntax=` frontend, names a digest. Dependabot updates the SHAs and
  the digests, after a 7-day cooldown. `dtolnay/rust-toolchain` is the
  exception: Dependabot ignores it, so when you change the Rust version, take
  the SHA of its version branch by hand. The
  `rust-workspace` job runs `cargo deny` (`rust-api/deny.toml`: RustSec
  advisories, crates.io as the only source, and a license allow list). The
  `static-checks` job runs `npm audit --omit=dev --audit-level=high`. A new
  advisory can therefore fail a pull request that did not change a
  dependency. Update the crate, or add the advisory ID to `ignore` in
  `deny.toml` with the reason and the date.
- **Why dev is a CI branch too**: dev is where day-to-day work lands and what
  releases are cut from, so CI on dev checks work before it reaches the release path. dev gets the **same
  jobs** main gets; no *job* is conditioned on the target branch, so adding a job
  covers both branches at once (the `concurrency` block below is keyed to the
  base branch, but it decides only whether a superseded run is cancelled — never
  which jobs run)
- **CI cancels a superseded run only on a PR to dev.** The workflow carries a
  workflow-level `concurrency` block grouped by
  `${{ github.workflow }}-${{ github.ref }}`, so each PR gets its own group.
  `cancel-in-progress` is `${{ github.base_ref == 'dev' }}`, not `true`: a
  cancelled check is a concluded non-pass, and required status checks can refuse on it, so
  cancelling a release run would report a branch that broke nothing as having
  broken CI. It is written "is the base dev" rather than "is the base not main"
  because `github.base_ref` is empty outside a pull request —
  `workflow_dispatch`, and any trigger added later, cancels nothing by default.
  Not cancelling on main costs a wait (the second run stays pending), never a
  refusal. For the current check status, `gh pr checks` reads
  the rollup of the PR's *current* head commit, and the cancelled run's checks
  are attached to the commit it ran against
- **A workflow edit gates the very PR that makes it.** For `pull_request`
  events, Actions reads the workflow from the PR's merge ref (base merged with
  head), not from the base branch — so a PR editing the workflow runs under its own
  new version, the trigger included. Two runs in this repo prove the two halves:
  the PR that **created** the workflow had its own run execute it, though main then
  held no workflow for a trigger to match against (so trigger *matching* reads
  the merge ref); the PR that **added** the `production-build` job had its own
  run execute that job, absent from main at the time (so job *contents* do too).
  `pull_request_target` is the event that reads the base branch instead — which
  is why it, not `pull_request`, is the one with the fork-security caveat
- **After release.sh, before merging**: additional commits can be pushed **to the
  release branch** to address PR feedback. They are part of the merge, and the
  tag is created against the merge commit afterwards, so it always names exactly
  what shipped. Pushing them to `dev` instead does not reach the release — not
  because a pull request's head is frozen (pushing to its head branch updates
  it) but because `dev` is not that branch. The release PR's head is
  `release/vX.Y.Z`, and only pushes there become part of the merge.
- When `API_CONTRACT` in `lib/api-contract.ts` increased since the last tag, the
  release pull request body must say so and name the minimum iOS client version
  that supports the new contract. See guides/api-contract.md.
- **A migration that renames or drops a column cannot be rolled back by
  redeploying the previous image.** The previous code queries a column that no
  longer exists and returns 500. For example, after `sessions.token` became
  `token_hash`, the old image failed every authenticated request. Roll back with
  a forward migration or a fix-forward deploy. On the Worker it is worse:
  `wrangler rollback` past any migration that succeeded gives a build that has
  no file for the applied version, and the object refuses to start, so every
  request gets 503. A migration that failed rolled back its own transaction,
  so a rollback to the build before it is safe (see
  [database-management.md](database-management.md#making-schema-changes)).
- **The move to SQLite is not undone by a revert.** After an install converts,
  its data is in `counterpoise_data`. A release of the PostgreSQL code would
  start on the old `counterpoise_pgdata` volume, without the changes made
  since. Fix forward instead. The owner of an install can still go back by
  hand, as [upgrade-to-sqlite.md](upgrade-to-sqlite.md) says.
- **A bad release is undone by a new release, not by a redeploy.**
  `scripts/deploy.sh` only fast-forwards production's `main`, so it refuses
  an older commit. Revert the release's changes on `dev` with `git revert`
  (never a reset or a force-push), and ship the revert as the next release.
  The move of the client from Next to Vite is such a change. Reverting it
  restores the Next app, `proxy.ts` and the `app` service. Revert it before
  any older change below, because the older trees need the Next app.
  The retirement of the Node API handlers is such a change too. Reverting the
  retirement commits, the health gate below and the later edits of this text,
  newest first, restores the pre-retirement
  routing: the Next handlers exist again, and the proxy retries a safe read on
  Node only after a transport error or a 502, 503 or 504. Login and writes get
  no automatic fallback. To send routes to Node, remove their entries from
  `rust-api/routes.json` in the same release; that works for login and
  writes too, and for a Rust handler that answers wrongly (for example an
  incorrect 200). Follow the manifest rules in the reverted tree's
  `guides/architecture.md`: a `[param]` entry also captures its static
  siblings, so overlapping entries leave together, and the manifest and
  contract checks (`every_operation_is_a_rust_route` among them) change in
  the same release. With every entry removed, the whole API except
  `/api/mcp` and WebMCP, which have no Next handler, runs on Node, and the
  reverted health gate lets the app start while Rust is down.
- **The deploy fails unless the migrations succeed and the server comes up
  healthy.** `deploy.sh` runs `docker compose up -d --wait --wait-timeout 300
  --build --force-recreate --remove-orphans rust-api`. The image has no
  entrypoint script: the server takes the server lock, applies the embedded
  migrations and runs the lot backfill guard before it serves. A failed
  migration stops the process, and `up --wait` exits 1, so a new server never
  runs against the old schema. The healthcheck (`counterpoise-rust-api
  health`, which calls `/health`) also fails the deploy step when the server
  does not answer. After the step, check `/api/health` before you report the
  release as a success.
- **`rust-api` is the only service.** One image, one container, one process.
  It serves the UI, the API and MCP, and publishes
  `${APP_BIND:-127.0.0.1}:3000:4000`. The host port is still 3000, so a
  reverse proxy needs no change. The server runs every scheduled job itself,
  the backups included. `--remove-orphans` removes the container of a service
  that the compose file no longer has: the Next `app` service before, and the
  `postgres` and `scheduler` services since the move to SQLite. Their volumes
  stay.

## The Cloudflare Worker deploy

The Worker (`rust-api/worker/`) is a second target beside the Docker image
(see [architecture.md](architecture.md#deployment-targets)). The owner's
production runs on it, so on the owner's machine `.env.deploy.local` sets
`COUNTERPOISE_DEPLOY_TARGET=worker` and the repository sets
`WORKER_TAG_TARGET=production`. `.github/workflows/worker-deploy.yml`
deploys it:

- **A release merge into `main` deploys it.** `.github/workflows/worker-release.yml`
  runs when `main` moves. `scripts/release-tag.sh` compares the version in
  `package.json` with the version before the merge. A changed version is a
  release: the script publishes the tag at the merge commit, and the
  workflow calls `worker-deploy.yml` (`workflow_call`) for that commit and
  the target `production`. A change to `main` that keeps the version is not
  a release and deploys nothing. A tag already at the merge commit is a
  re-run and deploys again; a tag at another commit is a refusal. The
  workflow runs only when `WORKER_DEPLOY` is `true` and `WORKER_TAG_TARGET`
  is `production`. A manual run of it (on `main`) does the same for the tip
  of `main`.
- **The call passes `secrets: inherit`.** Without it, the called deploy job
  got every secret of the `worker` environment empty, although it sets
  `environment:`. The environment variables did arrive. The first release
  through the workflow, v1.60.2, failed in `wrangler deploy` for this reason.
- **A run that fails because of the workflow file cannot be fixed by a
  re-run.** A re-run reads the workflow file of the merge commit again. Deploy
  that release with a manual run of `worker-deploy.yml` (`target:
  production`, `ref:` the merge commit), fix the file on `dev`, and the next
  release carries the fix. `deploy.sh` then reports the failed run; record
  the deploy from the manual run, and go on with the back-merge. The failed
  release run does not block the back-merge PR (see CI above).
- **The tag that the workflow pushes starts nothing.** It is pushed with
  `GITHUB_TOKEN`, and a push with that token starts no workflow. So the tag
  trigger of `worker-deploy.yml` does not deploy the release a second time.
  That trigger stays for the Docker target: there `deploy.sh` pushes the tag
  with the owner's credentials, and the tag deploys to `WORKER_TAG_TARGET`
  (staging). A manual run of `worker-deploy.yml` (`workflow_dispatch`)
  deploys the ref it names to the target it names (`staging` by default),
  for a check before a release.
- **The gate is the merge of the release PR.** It merges after CI and the
  release review. To also approve each production deploy, add a required
  reviewer to the `worker` environment. The deploy job then waits for the
  approval, and so does `deploy.sh`.
- **With `COUNTERPOISE_DEPLOY_TARGET=worker`, `deploy.sh` waits for that
  run.** It keeps the checks that do not need Docker: a clean tree, `--ref`
  on `origin/main`, the version read from the commit, and the refusal of a
  tag at another commit. It does not publish the tag, and does not touch the
  production checkout, the Docker volume or `docker`. First it reads the
  repository variables with `gh variable get`. It refuses unless
  `WORKER_DEPLOY` is `true` and `WORKER_TAG_TARGET` is `production`, because
  otherwise the workflow deploys nothing, and production does not get the
  release. Then it looks for the `worker-release.yml` run at the merge
  commit. A new run takes some seconds to appear, so it looks again every
  `DEPLOY_RUN_POLL_SECONDS` (5) until `DEPLOY_RUN_WAIT_SECONDS` (120) have
  gone. Then it waits for the run with `gh run watch --exit-status`, and
  fails when the run fails. Last, it fetches the tag and refuses unless the
  tag is at the merge commit: a run that passed without a tag there did not
  deploy this release. The probe of the run checks `/health` and
  `/api/version`, so a passed deploy needs no other health check: do not
  look for the Docker container or port 3000.
- **A re-run waits for the same run again.** `deploy.sh` publishes nothing
  and asks nothing, because nothing restarts. If the run failed, fix the
  cause, run `gh run rerun <id> --failed`, then run `deploy.sh` again. If no
  run appeared (for example, the workflow was off), start one with
  `gh workflow run worker-release.yml --ref main` while `main` is still at
  the merge commit.
- **While production is on the Worker, the Docker target refuses.** When
  `gh variable get WORKER_TAG_TARGET` answers `production`, `deploy.sh` with
  target `docker` stops before anything moves. A Docker deploy would start the
  old server on old data beside the Worker: two live databases. The stopped
  container stays stopped. When `gh` is not installed or the call fails (an
  install on its own machine has no such variable), the Docker deploy goes
  on as before.
- **Two targets, each its own Worker.** `staging` deploys `[env.staging]` in
  `wrangler.toml`, the Worker `counterpoise-staging`, with its own Durable
  Object and its own export bucket, so its daily dump never overwrites the
  other Worker's. `production` deploys the top-level Worker. A pushed tag
  deploys to the repository variable `WORKER_TAG_TARGET` (`staging` when
  unset); a manual run and a call from `worker-release.yml` never read it,
  so a staging check cannot land on production by accident. The job fails
  on any other value.
- **It is off until the repository turns it on.** The job runs only when the
  repository variable `WORKER_DEPLOY` is `true`. Until then a tag or a
  release merge deploys nothing and fails nothing.
- **One deploy at a time, and none cancelled.** The deploy job of
  `worker-deploy.yml` holds the concurrency group `worker-deploy`, on the job
  so that it also holds when `worker-release.yml` calls it.
  `worker-release.yml` holds `worker-release`, so the tag and the deploy of
  one release finish before the next. A cancelled `wrangler deploy` can leave
  the Worker and its assets at different versions, and a cancelled release
  run gets no tag and no deploy. So both groups set `cancel-in-progress:
  false` and `queue: max`: with the default, `single`, a newly queued run
  replaces the run that waits, whatever `cancel-in-progress` says.
- **The account lives in GitHub environments, not in the tree.** The
  public mirror ships `wrangler.toml` and the workflow, so neither names an
  account, a hostname or a token. Each target has an environment,
  `worker-staging` and `worker`, and each holds the secrets
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `WORKER_DOMAIN` (the
  custom domain the Worker serves), the Access service
  token `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` when Access is in
  front. The Worker's own secrets (`CRON_SECRET`, the Plaid and other integration keys)
  are set once with `scripts/wrangler.sh secret put` (adding `--env staging` for
  the staging Worker); a deploy keeps them.
- **The deploy does not attach the custom domain.** The domain, its DNS
  record and its certificate are managed outside this repository. Do not pass
  `--domain` or add `routes` to `wrangler.toml`: a deploy with a custom domain
  replaces the Worker's domains. A new target needs its domain made before
  its first deploy is reachable there.
- **Logs and traces are in `wrangler.toml`.** Both Workers have them: the
  top-level `[observability]` block for production and
  `[env.staging.observability]` for staging. Each keeps Workers Logs and
  traces for 7 days, with the query string removed from the URLs. Set them in
  the file, not in the dashboard, so the file stays the record. The data is
  production data, so do not add log lines that write request bodies or
  amounts.
- **The job builds the client, then deploys.** `wrangler deploy` runs the
  build command in `wrangler.toml` (`worker-build`), uploads the Worker and
  the client build as its assets, and applies the Durable Object migrations
  in `wrangler.toml`. The database migrations run when the object starts.
- **The deploy sets `COUNTERPOISE_PUBLIC_URL`** to `https://` and the
  environment's `WORKER_DOMAIN`, so OAuth for MCP is on wherever the Worker
  runs. It is a deploy variable and not a secret: a `wrangler deploy`
  replaces the plain variables set in the dashboard, and the hostname must
  stay out of `wrangler.toml`.
- **A probe stands in for `up --wait`.** The deploy sets the Worker's
  variable `BUILD_COMMIT` to the commit, and the Durable Object names it on
  `/health` in `x-build-commit`. `scripts/worker-probe.sh` retries `/health`
  until it answers 200 from that commit, which means the new version's
  object opened its database, then `/api/version` until it names the version
  in `package.json`. Commits between releases share a version, so the
  commit is what tells the new deploy from the one before it. The object
  adds the header, not the front Worker, because the two can run different
  versions after a deploy. In v1.63.0 (2026-11-07) the front Worker named
  the new commit at once, while the object answered from the old code for
  the full two minutes. The header then came from the front Worker, so
  `/health` passed and only `/api/version` showed the old code. A re-run
  of the failed job deployed again, and the object ran the new code at
  once. A probe that runs out of retries fails the job. The previous version
  keeps serving until the new one is live, so a failed probe needs a re-run
  of the failed job (when the object still runs the old build, as above), a
  fix and a new deploy, or a rollback of the Worker that failed, in
  `rust-api/worker/`:
  `../../scripts/wrangler.sh rollback --env staging` for staging, and
  `../../scripts/wrangler.sh rollback` for production. Without `--env
  staging` the command rolls back production, at once.

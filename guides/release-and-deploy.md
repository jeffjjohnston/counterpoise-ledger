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
    │                          ← publishes tag vX.Y.Z once, at that commit, then
    │                            builds the image and restarts the container;
    │                            the server applies the migrations as it starts
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
- **The release checkout needs the Rust toolchain.** After the bump,
  `release.sh` runs `npm run openapi:generate`, which builds and runs
  `counterpoise-rust-api openapi` with `cargo`. The document carries the
  package version, so the release commit includes the regenerated
  `openapi/openapi.json`.
- **The version tag is published once, and never moves.** `release.sh` creates
  no tag at all. `deploy.sh` creates it, annotated, against the commit named by
  `--ref` — the commit the PR actually merged — and pushes it **without
  `--force`**. A re-deploy of the same commit leaves it alone; a tag already
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
  `--ref`, refuses a commit that is not on `origin/main`, publishes the tag,
  and rebuilds. The version is read out of the commit with `git show`, not out
  of a checkout. **The early refusals run before anything moves**, but not all
  of them: production's `main` is fast-forwarded to the deploy commit before
  the tree check and the Compose validation, so a refusal from either of those
  leaves that checkout advanced. Nothing is published or restarted, and the
  next run fast-forwards to the same commit, but the checkout is not restored. It does **not** rebase `dev`, force-push, keep a resume file, or take a fork
  point. If `.git/DEPLOY_FORK_POINT` exists, it refuses: that file marks a deploy
  that expects a `dev` rebase, which this script does not perform.
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
  `counterpoise.db` (the test of `scripts/upgrade-to-sqlite.sh`). The check
  runs before the production checkout moves and before the tag is published,
  so a refusal changes nothing. Run `scripts/upgrade-to-sqlite.sh` in the
  production checkout first (see [upgrade-to-sqlite.md](upgrade-to-sqlite.md)).
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
  (`counterpoise-*.db`) there, and the job status records in `status/`. The
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
  and a `production-build` job that runs `npm run build` (the Vite client
  build) with **no database service**, as `docker build` does. The job was
  added when a page that queried the database at build time passed E2E (which
  has one) and failed `docker build` (which does not). The back-merge PR targets `dev`, so it is
  checked exactly as a feature PR is.
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
  a forward migration or a fix-forward deploy.
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

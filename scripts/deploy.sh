#!/usr/bin/env bash
set -euo pipefail

# Deploy a landed release SHA. Publish its version tag, then deploy it to the
# target that COUNTERPOISE_DEPLOY_TARGET names (scripts/lib/deploy-target.sh):
#
#   docker   the default. Build and restart the container from the permanent
#            production clone on main. Credentials and backups belong to that
#            clone; the dev checkout supplies neither.
#   worker   the push of the merge to main starts worker-release.yml, which
#            publishes the tag and deploys the production Worker. Wait for
#            that run. Do not publish the tag here, and do not touch the
#            production clone, its Docker volume or Docker.
#
# Usage: ./scripts/deploy.sh --ref <commit-ish> [--yes]

REF_ARG=""
ASSUME_YES=0

# `while`/`shift` rather than `for arg in "$@"`, because `--ref <sha>` spans two
# arguments and a per-argument loop cannot consume the second. An earlier
# version paired a `for` loop with a second pass that read the two-word form
# afterwards, and the two-word form never reached it: the FIRST loop had already
# rejected `--ref` through its catch-all and exited 2.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --ref=*) REF_ARG="${1#*=}"; shift ;;
    --ref)
      [[ $# -ge 2 ]] || { echo "Error: --ref needs a commit" >&2; exit 2; }
      REF_ARG="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 --ref <commit-ish> [--yes]"
      exit 2
      ;;
  esac
done

"$(dirname "$0")/check-compose-cwd.sh"
# shellcheck source=lib/deploy-target.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/deploy-target.sh"

STAGE="preflight"
DEPLOY_TAG=""
DEPLOY_SHA=""
TAG_PUBLISHED=0
ENV_FILE=".env.production.local"
LEGACY_RESUME_FILE="$(git rev-parse --git-dir)/DEPLOY_FORK_POINT"

on_error() {
  local code=$?
  set +e
  trap - ERR

  echo ""
  echo "Deploy failed during: $STAGE"
  echo ""
  echo "  ✗ $STAGE"
  if [[ -n "$DEPLOY_TAG" ]]; then
    if [[ $TAG_PUBLISHED == 1 ]]; then
      echo "  ✓ tag $DEPLOY_TAG published at ${DEPLOY_SHA:0:7}"
    else
      echo "  ⋯ tag $DEPLOY_TAG (not published)"
    fi
  fi

  echo "Re-run $0 --ref ${REF_ARG:-<commit>} to resume."
  exit "$code"
}
trap on_error ERR

if [[ -z "$REF_ARG" ]]; then
  echo "Error: --ref is required. Name the commit the release PR merged onto main." >&2
  exit 2
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi
if [[ -f "$LEGACY_RESUME_FILE" ]]; then
  echo "Error: $LEGACY_RESUME_FILE exists; resolve the previous flow's pending sync before deploying." >&2
  exit 1
fi
canonical_path() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}
SOURCE_ROOT=$(canonical_path "$(git rev-parse --show-toplevel)")

# docker or worker. scripts/lib/deploy-target.sh holds the rule, one time, so
# a script that calls this one and reads the target cannot disagree with it.
DEPLOY_TARGET=$(deploy_target "$SOURCE_ROOT") || exit 1
echo "==> Deploy target: $DEPLOY_TARGET"

# The repository variable WORKER_TAG_TARGET tells the workflows which Worker
# a release deploys. Prints it, or nothing when gh cannot read it.
worker_tag_target() {
  gh variable get WORKER_TAG_TARGET 2>/dev/null || true
}

if [[ "$DEPLOY_TARGET" == worker ]]; then
  # worker-release.yml deploys the release only when these two variables
  # say that production is on the Worker. Prove it before the wait. Without
  # them, the run deploys nothing, and production does not get the release.
  command -v gh >/dev/null 2>&1 || {
    echo "Error: the deploy target is worker, and gh is not installed. The deploy waits for the workflow run with gh." >&2
    exit 1
  }
  WORKER_DEPLOY_VAR=$(gh variable get WORKER_DEPLOY 2>/dev/null || true)
  if [[ "$WORKER_DEPLOY_VAR" != true ]]; then
    echo "Error: the repository variable WORKER_DEPLOY is '${WORKER_DEPLOY_VAR:-<not readable>}', not 'true'." >&2
    echo "worker-release.yml would deploy nothing. Nothing was changed." >&2
    exit 1
  fi
  TAG_TARGET=$(worker_tag_target)
  if [[ "$TAG_TARGET" != production ]]; then
    echo "Error: the repository variable WORKER_TAG_TARGET is '${TAG_TARGET:-<not readable>}', not 'production'." >&2
    echo "worker-release.yml would deploy nothing, and production would not get this release." >&2
    echo "Nothing was changed." >&2
    exit 1
  fi
  RUN_WAIT_SECONDS="${DEPLOY_RUN_WAIT_SECONDS:-120}"
  RUN_POLL_SECONDS="${DEPLOY_RUN_POLL_SECONDS:-5}"
  [[ "$RUN_WAIT_SECONDS" =~ ^[0-9]+$ && "$RUN_POLL_SECONDS" =~ ^[0-9]+$ ]] || {
    echo "Error: DEPLOY_RUN_WAIT_SECONDS and DEPLOY_RUN_POLL_SECONDS must be whole numbers of seconds." >&2
    exit 1
  }
  RUN_WAIT_SECONDS=$((10#$RUN_WAIT_SECONDS))
  RUN_POLL_SECONDS=$((10#$RUN_POLL_SECONDS))
elif command -v gh >/dev/null 2>&1 && [[ "$(worker_tag_target)" == production ]]; then
  # Production is on the Worker. A Docker deploy would start the old server on
  # old data beside it: two live databases. An install on its own machine has
  # no such variable, or no gh, and goes on as before.
  echo "Error: the repository variable WORKER_TAG_TARGET is 'production', so production runs on the Worker." >&2
  echo "A Docker deploy would start a second live database. Nothing was changed." >&2
  echo "To deploy the Worker, set COUNTERPOISE_DEPLOY_TARGET=worker in .env.deploy.local at the root of this checkout." >&2
  exit 1
fi

if [[ "$DEPLOY_TARGET" == docker ]]; then
  BUILD_DIR="${COUNTERPOISE_BUILD_DIR:-}"
  BUILD_DIR_SOURCE="the COUNTERPOISE_BUILD_DIR environment variable"
  # The owner can keep the directory in a gitignored file at the checkout root.
  # Read only that one key. Do not source the file. An environment value wins.
  DEPLOY_LOCAL_FILE="$SOURCE_ROOT/.env.deploy.local"
  if [[ -z "$BUILD_DIR" ]] && BUILD_DIR=$(deploy_local_value "$SOURCE_ROOT" COUNTERPOISE_BUILD_DIR); then
    BUILD_DIR_SOURCE="$DEPLOY_LOCAL_FILE"
    if [[ "$BUILD_DIR" == "~/"* ]]; then
      [[ -n "${HOME:-}" ]] || {
        echo "Error: $DEPLOY_LOCAL_FILE uses ~/ but HOME is not set." >&2
        exit 1
      }
      BUILD_DIR="$HOME/${BUILD_DIR#"~/"}"
    fi
  fi
  if [[ -z "$BUILD_DIR" ]]; then
    [[ -n "${HOME:-}" ]] || {
      echo "Error: neither COUNTERPOISE_BUILD_DIR nor HOME names a production directory." >&2
      exit 1
    }
    BUILD_DIR="$HOME/counterpoise-production"
    BUILD_DIR_SOURCE="the built-in default"
  fi
  [[ "$BUILD_DIR" == /* ]] || {
    echo "Error: COUNTERPOISE_BUILD_DIR '$BUILD_DIR' is not an absolute path." >&2
    exit 1
  }
  BUILD_DIR=$(canonical_path "$BUILD_DIR")
  if [[ "$BUILD_DIR" == "$SOURCE_ROOT"/* ]]; then
    echo "Error: the production directory is inside this checkout ($SOURCE_ROOT)." >&2
    exit 1
  fi
  [[ -d "$BUILD_DIR/.git" ]] || {
    echo "Error: '$BUILD_DIR' must be an existing production clone on main, with $ENV_FILE and backups/." >&2
    echo "The directory came from $BUILD_DIR_SOURCE." >&2
    echo "To use another directory, set COUNTERPOISE_BUILD_DIR in .env.deploy.local at the root of this checkout." >&2
    exit 1
  }
  ORIGIN_URL=$(git remote get-url origin)
  BUILD_DIR_ORIGIN=$(git -C "$BUILD_DIR" remote get-url origin)
  [[ "$BUILD_DIR_ORIGIN" == "$ORIGIN_URL" ]] || {
    echo "Error: '$BUILD_DIR' is not a clone of this repository's origin." >&2
    exit 1
  }
  [[ "$(git -C "$BUILD_DIR" branch --show-current)" == main ]] || {
    echo "Error: production checkout must be on main. Refusing to switch its branch." >&2
    exit 1
  }

  # Never clean production automatically: it owns credentials and persistent dumps.
  # Refuse unexpected build-context files, including ignored nested checkouts.
  #
  # .DS_Store is the one exception. Finder writes it in every folder it opens,
  # at any depth, and it carries no project data. The build copies it into the
  # context, but nothing reads it. Refusing it only made someone delete the files
  # by hand before every deploy that followed a look in Finder.
  check_production_tree() {
    local extra modified
    # Both halves must skip .DS_Store. `status` lists an untracked file unless an
    # ignore rule hides it, and the rule that hides .DS_Store is often only in a
    # user's global git config. List untracked files one by one, so the exclude
    # also works inside a directory that holds nothing else.
    modified=$(git -C "$BUILD_DIR" status --porcelain --untracked-files=all -- . ':(exclude,glob)**/.DS_Store')
    extra=$(git -C "$BUILD_DIR" clean -nffdx -e "/$ENV_FILE" -e /backups/ -e .DS_Store)
    if [[ -n "$modified" || -n "$extra" ]]; then
      echo "Error: production checkout has unexpected files or changes. Resolve them before deploying:" >&2
      printf '%s\n%s\n' "$modified" "$extra" >&2
      return 1
    fi
  }
  check_production_tree
  [[ -f "$BUILD_DIR/$ENV_FILE" ]] || {
    echo "Error: no $ENV_FILE in production directory $BUILD_DIR. Dev credentials are never copied." >&2
    exit 1
  }

  BACKUPS_DIR="${COUNTERPOISE_BACKUPS_DIR:-$BUILD_DIR/backups}"
  [[ "$BACKUPS_DIR" == /* ]] || {
    echo "Error: COUNTERPOISE_BACKUPS_DIR '$BACKUPS_DIR' is not an absolute path." >&2
    exit 1
  }
  BACKUPS_DIR=$(canonical_path "$BACKUPS_DIR")
  [[ -d "$BACKUPS_DIR" && "$BACKUPS_DIR" != "$BUILD_DIR" ]] || {
    echo "Error: the backups directory '$BACKUPS_DIR' does not exist or names the production checkout itself." >&2
    exit 1
  }
  export COUNTERPOISE_BACKUPS_DIR="$BACKUPS_DIR"
fi

STAGE="fetch origin"
echo "==> Fetching latest from origin..."
git fetch origin

STAGE="resolve deploy commit"
DEPLOY_SHA=$(git rev-parse --verify "${REF_ARG}^{commit}" 2>/dev/null) \
  || { echo "Error: --ref '$REF_ARG' does not resolve to a commit." >&2; exit 1; }

# The commit has to be one main actually holds. Deploying anything else puts
# code into production that no release PR landed — and the tag published below
# would then name it as a release.
if ! git merge-base --is-ancestor "$DEPLOY_SHA" origin/main; then
  echo "Error: ${DEPLOY_SHA:0:7} is not on origin/main ($(git rev-parse --short origin/main))." >&2
  echo "Only a commit that has landed on main can be deployed. Land the release PR first." >&2
  exit 1
fi

if [[ "$DEPLOY_TARGET" == docker ]]; then
  git -C "$BUILD_DIR" fetch --quiet origin
  if ! git -C "$BUILD_DIR" merge-base --is-ancestor HEAD "$DEPLOY_SHA"; then
    echo "Error: production main cannot fast-forward to $DEPLOY_SHA. Refusing to rewind or discard commits." >&2
    exit 1
  fi
fi

echo "==> Deploy commit: $(git log -1 --oneline "$DEPLOY_SHA")"

# ---------------------------------------------------------------------------
# Still preflight — the tag is READ and validated here, before anything moves
# ---------------------------------------------------------------------------

STAGE="read the deployed version"
# Read OUT OF THE COMMIT, not out of a checkout. Nothing below this needs the
# working tree, and everything below it can REFUSE — so validating first is what
# keeps a refusal from leaving the shared checkout somewhere the operator did
# not put it. An earlier version checked out first and then refused a
# conflicting tag with a bare `exit 1`, which does not fire the ERR trap and so
# never restored the branch: the repository was left detached at the deploy
# target, and every dev-only phase downstream then refused.
DEPLOY_VERSION=$(git show "$DEPLOY_SHA:package.json" \
  | node -p "JSON.parse(require('fs').readFileSync(0)).version") \
  || { echo "Error: cannot read package.json at ${DEPLOY_SHA:0:7}." >&2; exit 1; }
[[ -n "$DEPLOY_VERSION" && "$DEPLOY_VERSION" != "undefined" ]] \
  || { echo "Error: ${DEPLOY_SHA:0:7} declares no version." >&2; exit 1; }
DEPLOY_TAG="v$DEPLOY_VERSION"

STAGE="check tag $DEPLOY_TAG"
# PUBLISHED ONCE, AND NEVER MOVED. Three cases, and only the third writes:
#
#   already here   the tag peels to this commit; a re-run of a finished deploy,
#                  so there is nothing to do and nothing to force
#   somewhere else the tag names a different commit. That is either this version
#                  released twice or the wrong --ref, and both are refusals: a
#                  force-push here would silently re-point a tag that clones and
#                  release notes already reference
#   absent         create it, annotated, and push it without --force
#
# Peeled with ^{commit} throughout. On an annotated tag a bare rev-parse returns
# the TAG OBJECT, so an unpeeled comparison reports "different commit" for every
# annotated tag and would turn every clean re-run into a refusal.
tag_commit() {
  git rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null || true
}

LOCAL_TAG_AT="$(tag_commit "$DEPLOY_TAG")"
# `ls-remote` and not the local ref: a clone that has never fetched this tag
# would otherwise create a second object under a name origin already publishes.
# The `^{}` line is the peeled commit an annotated tag advertises; the bare line
# is a lightweight tag pointing straight at one, so both are read and the peeled
# one wins where both appear. BOTH PATTERNS ARE PASSED: `ls-remote` matches them
# against ref names, and it does not advertise the peeled line unless it is
# asked for — measured against git 2.5x on 2026-09-06.
REMOTE_TAG_LINES="$(git ls-remote --tags origin "refs/tags/$DEPLOY_TAG" "refs/tags/$DEPLOY_TAG^{}" || true)"
REMOTE_TAG_AT="$(printf '%s\n' "$REMOTE_TAG_LINES" | awk '$2 ~ /\^\{\}$/ {print $1}' | tail -1)"
if [[ -z "$REMOTE_TAG_AT" ]]; then
  REMOTE_TAG_AT="$(printf '%s\n' "$REMOTE_TAG_LINES" | awk 'NF {print $1}' | tail -1)"
fi

for existing in "$LOCAL_TAG_AT" "$REMOTE_TAG_AT"; do
  [[ -n "$existing" ]] || continue
  if [[ "$existing" != "$DEPLOY_SHA" ]]; then
    echo "Error: tag $DEPLOY_TAG already points at ${existing:0:7}, not at ${DEPLOY_SHA:0:7}." >&2
    echo "" >&2
    echo "The version tag is published once and never moved, so this is either" >&2
    echo "v$DEPLOY_VERSION released a second time or the wrong --ref. Resolve which" >&2
    echo "commit is v$DEPLOY_VERSION before deploying." >&2
    exit 1
  fi
done

# The volume, the confirmation, the production checkout and Compose are for
# the Docker target only. The worker target does not restart anything here,
# so a re-run only waits for the run again, and asks nothing.
if [[ "$DEPLOY_TARGET" == docker ]]; then
  # The database volume is external. Without it, `up` below fails, but only
  # after the tag is published. An install that still holds its data in
  # PostgreSQL has no such volume: it must run the one-time upgrade first.
  #
  # CHECKED BEFORE THE PRODUCTION CHECKOUT MOVES, so that a refusal changes
  # nothing. An earlier version checked after the fast-forward, and a refusal
  # left production on the new commit with the old containers still running.
  STAGE="check the database volume"
  # The upgrade script is only in v1.50.0 to v1.53.0: later releases do not
  # have the converter. So the production checkout goes to v1.50.0, the script
  # runs there, the checkout goes back, and this deploy runs again.
  upgrade_first() {
    echo "The data is still in PostgreSQL. Convert it once with v1.50.0, then run this deploy again:" >&2
    echo "  git -C $BUILD_DIR fetch origin --tags" >&2
    echo "  git -C $BUILD_DIR checkout v1.50.0" >&2
    echo "  (cd $BUILD_DIR && scripts/upgrade-to-sqlite.sh)" >&2
    echo "  git -C $BUILD_DIR checkout -" >&2
    echo "See guides/upgrade-to-sqlite.md." >&2
  }
  docker volume inspect counterpoise_data >/dev/null 2>&1 || {
    echo "Error: the volume counterpoise_data does not exist." >&2
    upgrade_first
    echo "A new install, with no PostgreSQL data, creates the volume instead:" >&2
    echo "  docker volume create counterpoise_data" >&2
    exit 1
  }
  # The same test as the upgrade script of v1.50.0: an environment file that
  # still names the PostgreSQL database, and a volume with no SQLite file, is
  # an install that has not converted. The new server would create an empty
  # database there.
  if grep -q '^DATABASE_URL=.' "$BUILD_DIR/$ENV_FILE"; then
    # `|| ...` and not `set +e`: the ERR trap fires without errexit too.
    DB_STATUS=0
    docker run --rm -v counterpoise_data:/data alpine:3.22 test -e /data/counterpoise.db || DB_STATUS=$?
    if [[ $DB_STATUS == 1 ]]; then
      echo "Error: $ENV_FILE sets DATABASE_URL, and the volume counterpoise_data holds no counterpoise.db." >&2
      upgrade_first
      exit 1
    elif [[ $DB_STATUS != 0 ]]; then
      echo "Error: cannot look for counterpoise.db in the volume counterpoise_data (docker exit $DB_STATUS)." >&2
      echo "Nothing was changed." >&2
      exit 1
    fi
  fi

  STAGE="confirm"
  # A re-deploy restarts the live application and can re-run migrations, so it is
  # confirmed rather than assumed. The tag being already published is what makes
  # this a repeat: nothing else in the repository records what is running.
  #
  # ASKED BEFORE THE CHECKOUT, for the same reason the tag check is: declining
  # must leave the repository exactly as it was found.
  if [[ -n "$LOCAL_TAG_AT" && -n "$REMOTE_TAG_AT" && $ASSUME_YES == 0 ]]; then
    echo "$DEPLOY_TAG is already published, so this is a re-deploy of the same commit."
    if [[ -t 0 ]]; then
      read -r -n 1 -p "Rebuild and restart anyway? [y/N] " REPLY
      echo
      [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; trap - ERR; exit 0; }
    else
      # Non-zero, unlike the interactive "n" above: there, a human declined and
      # nothing is wrong. Here nobody was asked, so reporting success would tell
      # an automated caller a deploy happened when none did.
      echo "Not a terminal and --yes was not given. Aborted."
      exit 1
    fi
  fi

  STAGE="prepare the production checkout"
  git -C "$BUILD_DIR" fetch --quiet origin
  # Fast-forward main to the exact reviewed merge, even if origin/main advanced.
  # No reset, force checkout, detached HEAD, clean, or environment-file copying.
  git -C "$BUILD_DIR" merge --ff-only "$DEPLOY_SHA"
  [[ "$(git -C "$BUILD_DIR" rev-parse HEAD)" == "$DEPLOY_SHA" ]] || {
    echo "Error: production HEAD does not match the requested deploy commit." >&2
    exit 1
  }
  check_production_tree

  # Validate the production configuration before publishing a tag or restarting.
  # --quiet prevents resolved secrets from reaching logs.
  STAGE="validate production Compose configuration"
  cd "$BUILD_DIR"
  docker compose -f docker-compose.yml --env-file "$ENV_FILE" config --quiet
  cd "$SOURCE_ROOT"
fi

if [[ "$DEPLOY_TARGET" == worker ]]; then
  # The push of the merge to main started worker-release.yml at this commit.
  # That run publishes the tag, deploys the Worker and probes it. This script
  # does not push the tag: a second publisher could race the run. A run takes
  # some seconds to appear, so look for it again until the time runs out. A
  # re-run of this script finds the same run; after `gh run rerun`, the run
  # keeps its ID.
  STAGE="find the worker-release.yml run at ${DEPLOY_SHA:0:7}"
  echo "==> Looking for the worker-release.yml run at ${DEPLOY_SHA:0:7}..."
  RUN_ID=""
  WAITED=0
  while :; do
    RUN_ID=$(gh run list --workflow worker-release.yml --commit "$DEPLOY_SHA" --limit 20 \
      --json databaseId,headSha \
      --jq "[.[] | select(.headSha == \"$DEPLOY_SHA\")][0].databaseId // empty" || true)
    [[ -z "$RUN_ID" ]] || break
    (( WAITED < RUN_WAIT_SECONDS )) || break
    sleep "$RUN_POLL_SECONDS"
    WAITED=$((WAITED + RUN_POLL_SECONDS))
  done
  if [[ -z "$RUN_ID" ]]; then
    echo "Error: no worker-release.yml run at ${DEPLOY_SHA:0:7} appeared within ${RUN_WAIT_SECONDS}s." >&2
    echo "Look for it with: gh run list --workflow worker-release.yml" >&2
    echo "A run that was cancelled or failed: gh run rerun <id>" >&2
    echo "If there is no run and main is still at ${DEPLOY_SHA:0:7}, start one: gh workflow run worker-release.yml --ref main" >&2
    echo "Then run this command again. It waits for that run." >&2
    false
  fi

  # The run publishes the tag, then deploys and probes /health and
  # /api/version of the Worker, so a run that passes is a Worker that serves
  # this commit and this version. If the environment needs an approval, the
  # run waits for it, and so does this.
  STAGE="wait for the worker-release.yml run $RUN_ID"
  echo "==> Waiting for the worker-release.yml run $RUN_ID..."
  if ! gh run watch "$RUN_ID" --exit-status; then
    echo "Error: the worker-release.yml run $RUN_ID did not pass." >&2
    echo "Read its log: gh run view $RUN_ID --log-failed" >&2
    echo "After a fix, run its failed jobs again (gh run rerun $RUN_ID --failed), then run this command again to wait for it." >&2
    echo "See \"The Cloudflare Worker deploy\" in guides/release-and-deploy.md for a rollback." >&2
    false
  fi

  # A run that passed but published no tag here did not deploy this release:
  # it found no version change at this commit.
  STAGE="check tag $DEPLOY_TAG after the run"
  git fetch --quiet origin "refs/tags/$DEPLOY_TAG:refs/tags/$DEPLOY_TAG" 2>/dev/null || true
  if [[ "$(tag_commit "$DEPLOY_TAG")" != "$DEPLOY_SHA" ]]; then
    echo "Error: the run $RUN_ID passed, but tag $DEPLOY_TAG is not at ${DEPLOY_SHA:0:7}, so it did not deploy this release." >&2
    echo "Read its log: gh run view $RUN_ID --log" >&2
    false
  fi
  TAG_PUBLISHED=1

  trap - ERR
  echo "Deployed $DEPLOY_TAG (${DEPLOY_SHA:0:7}) to the production Worker. The run's probe passed."
  echo "Synchronize main back into dev with an ordinary merge PR."
  exit 0
fi

STAGE="publish tag $DEPLOY_TAG"
if [[ -n "$LOCAL_TAG_AT" && -n "$REMOTE_TAG_AT" ]]; then
  echo "==> Tag $DEPLOY_TAG is already published at ${DEPLOY_SHA:0:7}"
else
  echo "==> Tagging $DEPLOY_TAG at ${DEPLOY_SHA:0:7}..."
  # -f is safe here and only here: every path that reaches it has proved the
  # local tag either does not exist or already names this same commit, so there
  # is no other commit for it to be moved off. It covers the resume where the
  # local tag was made and the push then failed.
  git tag -f -a "$DEPLOY_TAG" "$DEPLOY_SHA" -m "release: $DEPLOY_TAG" >/dev/null
  # No --force. A tag that origin holds at a different commit was already
  # refused above, so the only push that can be rejected here is one this script
  # must not win.
  git push origin "refs/tags/$DEPLOY_TAG"
fi
TAG_PUBLISHED=1

STAGE="build image"
echo "==> Deploying $DEPLOY_TAG from $BUILD_DIR on main..."
cd "$BUILD_DIR"
# Recreate the service so a changed bind path cannot retain deleted inodes.
# The server applies the migrations before it serves. --wait makes this
# command fail unless the service is running and its healthcheck passes, so a
# release whose migration fails or whose server does not come up fails the
# deploy here.
#
# --remove-orphans removes the container of a service that the compose file no
# longer has: the Next `app` service before, and the `postgres` and
# `scheduler` services since the move to SQLite. Their volumes stay.
docker compose -f docker-compose.yml --env-file "$ENV_FILE" up -d --wait --wait-timeout 300 --build --force-recreate --remove-orphans rust-api

trap - ERR
echo "Deployed $DEPLOY_TAG (${DEPLOY_SHA:0:7}); verify /api/health before reporting release success."
echo "Synchronize main back into dev with an ordinary merge PR."

#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy.sh [--yes] [--fork-point=<sha>]
#
# Deploys main to local Docker, then reconciles dev after the squash merge.
#
# Resumable by design. If a step fails, the branch you started on is restored
# and the pending dev fork point stays in .git/DEPLOY_FORK_POINT; re-running
# finishes the job. A previous version failed at the build, left the repo on
# main, and then silently skipped the dev sync on re-run — dev kept nine commits
# that main held as one squash commit, surfacing as conflicts days later.

ASSUME_YES=0
FORK_POINT_ARG=""

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --fork-point=*) FORK_POINT_ARG="${arg#*=}" ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--yes] [--fork-point=<sha>]"
      exit 2
      ;;
  esac
done

RESUME_FILE="$(git rev-parse --git-dir)/DEPLOY_FORK_POINT"
ORIGINAL_BRANCH=$(git branch --show-current)
STAGE="preflight"
DEPLOY_TAG=""
TAG_MOVED=0
DEV_SYNCED=0

rebase_in_progress() {
  local dir
  dir=$(git rev-parse --git-dir)
  [[ -d "$dir/rebase-merge" || -d "$dir/rebase-apply" ]]
}

# Every path that stops early owes the caller their branch back, not just the
# trap: the no-fork-point exit below is a partial completion too.
restore_branch() {
  local current
  current=$(git branch --show-current)
  if [[ -n "$ORIGINAL_BRANCH" && "$current" != "$ORIGINAL_BRANCH" ]]; then
    if git checkout "$ORIGINAL_BRANCH" >/dev/null 2>&1; then
      echo ""
      echo "Restored branch: $ORIGINAL_BRANCH"
    fi
  fi
}

on_error() {
  local code=$?
  set +e
  trap - ERR

  echo ""
  echo "Deploy failed during: $STAGE"
  echo ""
  echo "  ✗ $STAGE"
  if [[ -n "$DEPLOY_TAG" ]]; then
    if [[ $TAG_MOVED == 1 ]]; then
      echo "  ✓ tag $DEPLOY_TAG moved"
    else
      echo "  ⋯ tag $DEPLOY_TAG (not moved)"
    fi
  fi
  if [[ $DEV_SYNCED == 1 ]]; then
    echo "  ✓ dev rebased onto main"
  elif [[ -f "$RESUME_FILE" ]]; then
    echo "  ⋯ dev not rebased (fork point $(cut -c1-7 "$RESUME_FILE") saved)"
  fi

  # Never try to switch branches mid-rebase; git will refuse and the real
  # instruction is to finish or abort the rebase.
  if rebase_in_progress; then
    echo ""
    echo "A rebase is in progress. Resolve conflicts, then:"
    echo "  git rebase --continue && git push origin dev --force-with-lease"
    echo "The deploy itself succeeded; this is only the dev sync."
    exit "$code"
  fi

  restore_branch

  echo "Re-run $0 to resume."
  exit "$code"
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Preflight — nothing is mutated here
# ---------------------------------------------------------------------------

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

STAGE="fetch origin"
echo "==> Fetching latest from origin..."
git fetch origin

LOCAL_MAIN=$(git rev-parse main 2>/dev/null || echo "none")
REMOTE_MAIN=$(git rev-parse origin/main)
RESUMING=0
[[ -f "$RESUME_FILE" ]] && RESUMING=1

# A resume is by definition a case where main is already current, so it does
# not need confirming.
if [[ "$LOCAL_MAIN" == "$REMOTE_MAIN" && $RESUMING == 0 && $ASSUME_YES == 0 ]]; then
  echo "Local main is already up to date with origin/main."
  if [[ -t 0 ]]; then
    read -r -n 1 -p "Deploy anyway? [y/N] " REPLY
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  else
    # Non-zero, unlike the interactive "n" above: there, a human declined and
    # nothing is wrong. Here nobody was asked, so reporting success would tell
    # an automated caller a deploy happened when none did.
    echo "Not a terminal and --yes was not given. Aborted."
    exit 1
  fi
fi

STAGE="resolve fork point"
FORK_POINT=""
if [[ -n "$FORK_POINT_ARG" ]]; then
  FORK_POINT=$(git rev-parse "$FORK_POINT_ARG")
elif [[ $RESUMING == 1 ]]; then
  FORK_POINT=$(cat "$RESUME_FILE")
  echo "==> Resuming: dev sync pending from ${FORK_POINT:0:7}"
elif [[ "$ORIGINAL_BRANCH" == "dev" ]]; then
  # Unpushed dev commits were not in the squash merge, so treating them as the
  # fork point would drop them.
  LOCAL_DEV=$(git rev-parse HEAD)
  REMOTE_DEV=$(git rev-parse origin/dev)
  if [[ "$LOCAL_DEV" != "$REMOTE_DEV" ]]; then
    echo "Error: Local dev (${LOCAL_DEV:0:7}) differs from origin/dev (${REMOTE_DEV:0:7})."
    echo "Push or pull before deploying so the fork point is accurate."
    exit 1
  fi
  FORK_POINT="$LOCAL_DEV"
fi

# Written before any mutation: its existence is what tells a later run that a
# dev sync is still owed.
if [[ -n "$FORK_POINT" ]]; then
  echo "$FORK_POINT" > "$RESUME_FILE"
  echo "==> Fork point: ${FORK_POINT:0:7}"
fi

# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------

STAGE="checkout main"
echo "==> Switching to main..."
git checkout main
git pull origin main

DEPLOY_VERSION=$(node -p "require('./package.json').version")
DEPLOY_TAG="v$DEPLOY_VERSION"

STAGE="build image"
echo "==> Deploying $DEPLOY_TAG — building and restarting containers..."
# --force-recreate app scheduler is load-bearing. `git checkout main` above can
# delete a directory the outgoing main lacked, and `git pull` recreates it with
# a new inode; a bind-mounted directory is resolved at container creation, so a
# container Compose decides not to recreate stays attached to the deleted inode
# and sees an empty directory. That is how /scheduler went missing after v1.14.0.
# Postgres is excluded deliberately: its data is a named volume, so it has no
# such exposure and does not need the restart.
docker compose --env-file .env.production.local up -d --build --force-recreate app scheduler

STAGE="move tag"
echo "==> Tagging $DEPLOY_TAG at $(git rev-parse --short HEAD)..."
git tag -f "$DEPLOY_TAG"
git push origin "$DEPLOY_TAG" --force
TAG_MOVED=1

STAGE="rebase dev onto main"
if [[ -z "$FORK_POINT" ]]; then
  trap - ERR
  echo ""
  echo "Deployed $DEPLOY_TAG, but the dev sync was NOT performed."
  echo "No fork point could be determined. Re-run from dev, or pass"
  echo "  $0 --fork-point=<dev sha that was squash-merged>"
  restore_branch
  exit 1
fi

echo "==> Rebasing dev onto main (fork point: ${FORK_POINT:0:7})..."
git rebase --onto main "$FORK_POINT" dev
git push origin dev --force-with-lease
DEV_SYNCED=1
rm -f "$RESUME_FILE"

STAGE="return to ${ORIGINAL_BRANCH:-main}"
if [[ -n "$ORIGINAL_BRANCH" && "$(git branch --show-current)" != "$ORIGINAL_BRANCH" ]]; then
  git checkout "$ORIGINAL_BRANCH"
fi

trap - ERR
echo ""
echo "============================================"
echo "Deployed $DEPLOY_TAG successfully!"
echo "Verify: docker compose logs -f app"
echo "============================================"

#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major] [--skip-checks] [--no-pr]
# Default: patch
#
# RUN THIS IN A RELEASE CHECKOUT, NOT ON dev. HEAD must already be the commit
# you mean to release — cut a worktree at it and run this there:
#
#   git worktree add --detach <path> <the dev commit to release>
#   cd <path> && /path/to/scripts/release.sh patch
#
# Release workflow (merge-commit PRs into main):
#   1. Run this script in a release checkout → bumps the version, names and
#      pushes release/vX.Y.Z, opens the PR
#   2. Review PR on GitHub (CI runs automatically). Fix issues with new commits
#      ON THE RELEASE BRANCH.
#   3. MERGE the PR on GitHub — a merge commit, never a squash. The release
#      commits stay in main's ancestry, which is what lets dev keep its own
#      commit ids.
#   4. Run ./scripts/deploy.sh --ref <the merge commit> → publishes the version
#      tag once, at that commit, and builds and restarts the containers
#   5. Merge main back into dev through an ordinary PR
#
# WHY THIS NO LONGER RUNS ON dev. The old flow bumped on dev, squash-merged
# that into main, and then rebased dev onto the replacement history and
# force-pushed it — rewriting commits under every agent holding a branch off
# dev. Preserving the release commits in main's ancestry is what removes the
# need for that rebase, and it starts here: the bump belongs to the release
# branch, so dev is never written by a release at all.
#
# NO TAG IS CREATED HERE. `npm version` used to make the version tag, which
# release.sh pushed and deploy.sh then force-moved onto whatever main ended up
# holding. A tag that moves is not a release marker. The tag is now published
# once, by deploy.sh, against the commit the PR actually merged.

# Sourced, not duplicated. The release pipeline that can drive this script
# reads the same state, to decide whether the checks it already ran still cover
# HEAD. Two copies of the rule would drift, and the two disagreeing about what
# HEAD is is the failure this guard exists to prevent.
# shellcheck source=lib/release-commit.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/release-commit.sh"

# One loop parses and validates, so an unknown argument cannot reach the
# version bump as a bump type.
BUMP_TYPE="patch"
SKIP_CHECKS=0
# Whether to open the pull request, which is what a human running this script
# by hand wants. --no-pr is for a caller that opens its own.
CREATE_PR=1
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=1 ;;
    --no-pr) CREATE_PR=0 ;;
    patch|minor|major) BUMP_TYPE="$arg" ;;
    *)
      echo "Usage: $0 [patch|minor|major] [--skip-checks] [--no-pr]"
      exit 1
      ;;
  esac
done

# The shared branches are refused by name rather than a release branch being
# required by name, and the difference matters on a RESUME: the first run of
# this script is detached, and it is this script that gives the branch its
# name, so a `release/*`-only test would refuse the very state it creates.
#
# `git branch --show-current` prints nothing on a detached HEAD, which is the
# expected starting state and must not read as "no branch, refuse".
BRANCH=$(git branch --show-current)
case "$BRANCH" in
  dev|main)
    echo "Error: release.sh runs in a release checkout, not on $BRANCH."
    echo ""
    echo "The bump belongs to the release branch: a release must not write to a"
    echo "shared branch. Cut a worktree at the commit you are releasing and run"
    echo "this there:"
    echo ""
    echo "  git worktree add --detach <path> $BRANCH"
    echo "  cd <path> && $0 $BUMP_TYPE"
    exit 1
    ;;
esac

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

if [[ $SKIP_CHECKS == 0 ]]; then
  echo "==> Running pre-release checks..."
  npm run lint

  # tsc --noEmit reads tsconfig.tsbuildinfo, and a cache written before a
  # compiler-option change replays the diagnostics recorded under the old options
  # rather than re-checking. Changing `target` is the known trigger: the v1.19.1
  # release failed on six phantom TS2737 "BigInt literals are not available when
  # targeting lower than ES2020" errors while tsconfig already said ES2020, and
  # the cache itself already recorded ES2020.
  #
  # Deleting the cache rather than passing --incremental false: both give this
  # gate a cold, honest check, but only deleting leaves a correct cache behind, so
  # the next plain `npx tsc --noEmit` on this machine is right too. The flag would
  # let the release pass while every later local check stayed poisoned.
  #
  # The file is gitignored, so CI's fresh checkout never had one — this failure is
  # local-only, which is exactly why the release gate is where it has to be caught.
  rm -f tsconfig.tsbuildinfo
  npx tsc --noEmit

  # Both the unit suite and browser checks must pass before the version bump.
  npm run test
  CI=true npx playwright test
else
  # The caller already ran these and passed --skip-checks to say so.
  echo "==> Skipping pre-release checks (--skip-checks)"
fi

echo ""
# The bump commits, so a run that died between the commit and a successful push
# leaves a clean tree — and the clean-tree guard above accepts it. Bumping again
# there is a second version for one release, so resume at the push instead.
RELEASE_HEAD_STATE=$(release_head_state)
case "$RELEASE_HEAD_STATE" in
  resume)
    NEW_VERSION="v$(release_declared_version)"
    echo "==> HEAD is already the release commit for $NEW_VERSION"
    echo "    A previous run bumped and did not finish. Resuming at the push;"
    echo "    bumping again would number a second release."
    ;;
  published)
    # release_head_state has already written what is wrong and how to resolve
    # it. Naming the stage here is this script's own half.
    echo "Error: cannot bump the version from this state." >&2
    exit 1
    ;;
  *)
    echo "==> Bumping $BUMP_TYPE version..."
    # --no-git-tag-version, then commit by hand. npm's own bump makes the commit
    # AND the tag in one step and offers no way to take only the commit, and the
    # tag is the half that must not exist yet: it is published against the merge
    # commit once the PR lands, and a tag made here would be a second object
    # under the same name for a different commit.
    #
    # The subject is `release: v%s` because release_head_state reads it to
    # recognise this commit on a retry. Changing the wording here without
    # changing it there turns every resume back into a double bump.
    npm version "$BUMP_TYPE" --no-git-tag-version >/dev/null
    # info.version in the contract tracks package.json. Regenerate so the release
    # commit carries a current openapi.json and CI's openapi:check stays green.
    npm run openapi:generate
    git add openapi/openapi.json
    NEW_VERSION="v$(release_declared_version)"
    git commit --quiet --all --message "release: $NEW_VERSION"
    echo "New version: $NEW_VERSION"
    ;;
esac

# The branch carries the version, which is not knowable until the bump has
# written package.json — so a run that starts detached names its branch HERE,
# after the bump, and a resume finds itself already on it.
RELEASE_BRANCH="release/$NEW_VERSION"
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" == "$RELEASE_BRANCH" ]]; then
  echo "==> Already on $RELEASE_BRANCH"
elif [[ -n "$CURRENT_BRANCH" ]]; then
  # A checkout that is on some OTHER named branch is not a release checkout
  # this script can finish: switching would leave the bump commit it just made
  # on a branch nothing releases.
  echo "Error: the bump is on branch $CURRENT_BRANCH, but this release is $RELEASE_BRANCH." >&2
  echo "Run this in a checkout that is detached or already on $RELEASE_BRANCH." >&2
  exit 1
elif git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  # A branch by this name from an earlier attempt. Refused rather than reused:
  # reusing it would move a branch that a pull request may already track, and
  # that is the "someone pushed after the review" case the merge gate refuses.
  echo "Error: branch $RELEASE_BRANCH already exists." >&2
  echo "Check whether that release is still in flight before cutting it again." >&2
  exit 1
else
  echo "==> Naming this checkout $RELEASE_BRANCH"
  git switch --quiet --create "$RELEASE_BRANCH"
fi

echo "==> Pushing $RELEASE_BRANCH..."
# No --tags. Nothing here makes one, and pushing the whole tag namespace from a
# release checkout would publish whatever else happens to be lying about.
git push origin "$RELEASE_BRANCH"

if [[ $CREATE_PR == 0 ]]; then
  echo "==> Skipping PR creation (--no-pr); the caller opens its own"
  echo ""
  echo "============================================"
  echo "Release $NEW_VERSION bumped and pushed on $RELEASE_BRANCH."
  echo "============================================"
  exit 0
fi

echo "==> Creating PR to main..."
# NO APOSTROPHES IN THE BODY BELOW. It is a heredoc inside a command
# substitution inside another command substitution, and bash scans that
# nesting for quote pairs before it recognises the heredoc: a lone ' in the
# text ends the scan at "unexpected EOF while looking for matching". Write
# "the ancestry of main", never "main's ancestry".
PR_URL=$(gh pr create \
  --base main \
  --head "$RELEASE_BRANCH" \
  --title "Release $NEW_VERSION" \
  --body "$(cat <<EOF
## Release $NEW_VERSION

### Changes since last release
$(git log $(git describe --tags --abbrev=0 main 2>/dev/null || echo main)..$RELEASE_BRANCH --oneline --no-decorate | head -30)

---
*Created by \`scripts/release.sh\`*

**Merge this with a merge commit, not a squash.** The release commits have to
stay in the ancestry of main: that is what lets dev be synchronized by an
ordinary merge afterwards instead of being rebased onto a replacement history.
EOF
)" 2>&1) || {
  # PR may already exist — update it instead
  echo "PR may already exist. Checking..."
  EXISTING_PR=$(gh pr list --base main --head "$RELEASE_BRANCH" --json number --jq '.[0].number')
  if [[ -n "$EXISTING_PR" ]]; then
    echo "Updating existing PR #$EXISTING_PR"
    gh pr edit "$EXISTING_PR" --title "Release $NEW_VERSION"
    PR_URL="https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pull/$EXISTING_PR"
  else
    echo "Error creating PR"
    exit 1
  fi
}

echo ""
echo "============================================"
echo "Release $NEW_VERSION ready for review!"
echo "PR: $PR_URL"
echo ""
echo "Next steps:"
echo "  1. Review the PR on GitHub"
echo "  2. Merge it with a MERGE COMMIT (not a squash)"
echo "  3. Run: ./scripts/deploy.sh --ref <the merge commit>"
echo "  4. Merge main back into dev through an ordinary PR"
echo "============================================"

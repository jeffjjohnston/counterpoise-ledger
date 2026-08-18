#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Default: patch
#
# Release workflow (GitHub squash-merge):
#   1. Run this script on dev → bumps version, tags, pushes, creates PR
#   2. Review PR on GitHub (CI runs automatically). Fix issues with new commits.
#   3. Squash-merge the PR on GitHub
#   4. Run ./scripts/deploy.sh → pulls main, moves tag, rebuilds Docker, rebases dev
#
# The version tag is created here but may not be final — deploy.sh moves
# it to the actual squash commit on main (accounting for post-release PR fixes).

BUMP_TYPE="${1:-patch}"

# Validate bump type
if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Must be on dev branch
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "dev" ]]; then
  echo "Error: Must be on dev branch (currently on $BRANCH)"
  exit 1
fi

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

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

npx vitest run
CI=true npx playwright test

echo ""
echo "==> Bumping $BUMP_TYPE version..."
# npm version creates the commit and tag automatically
NEW_VERSION=$(npm version "$BUMP_TYPE" -m "release: v%s")
echo "New version: $NEW_VERSION"

echo "==> Pushing dev branch and tags..."
git push origin dev --tags

echo "==> Creating PR to main..."
PR_URL=$(gh pr create \
  --base main \
  --head dev \
  --title "Release $NEW_VERSION" \
  --body "$(cat <<EOF
## Release $NEW_VERSION

### Changes since last release
$(git log $(git describe --tags --abbrev=0 main 2>/dev/null || echo main)..dev --oneline --no-decorate | head -30)

---
*Created by \`scripts/release.sh\`*
EOF
)" 2>&1) || {
  # PR may already exist — update it instead
  echo "PR may already exist. Checking..."
  EXISTING_PR=$(gh pr list --base main --head dev --json number --jq '.[0].number')
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
echo "  2. Merge it"
echo "  3. Run: ./scripts/deploy.sh"
echo "============================================"
